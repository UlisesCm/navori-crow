/**
 * `POST /ingest/hook/:engine` (design.md D3). The guard (403) runs in `server.ts` before this.
 * Order: path (404) → method (405) → token (401) → engine (404, R2) → in-flight cap (204, counted)
 * → size/time while reading (413, R5; 408 on a stalled body) → enqueue (204, R1; a full queue or engine quota is also 204 and
 * counted, R7). Nothing is processed here: the drainer does it after the response. Overflow
 * counting lives in the queue (`onDrop`), so this file never counts it twice.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { BoundAdapter, IngestQueue } from "@crow/core";
import type { LaneMonitor } from "./lanes";

/** Body cap of a hook delivery (R5). */
export const MAX_HOOK_BODY_BYTES = 1024 * 1024;

/**
 * Total time a body may take to arrive. The design fixes none; hook clients give up after 1-2 s
 * (D14), so 5 s only ever cuts off a stalled or slow-drip client that would otherwise hold one of
 * the 16 body slots until Bun's idle timeout.
 */
export const HOOK_READ_TIMEOUT_MS = 5000;

const HOOK_PATH = /^\/ingest\/hook\/([^/]+)$/;

/** What the ingest route needs; built once in `app.ts`. */
export interface IngestContext {
  adapters: readonly BoundAdapter[];
  queue: IngestQueue;
  monitor: LaneMonitor;
  /** R3: `null` = no token configured, so none is required. */
  token: string | null;
  /** Read deadline override (tests); default {@link HOOK_READ_TIMEOUT_MS}. */
  readTimeoutMs?: number;
}

/** The single predicate for `/ingest/*` (case-sensitive, like `isApiPath`): shares the guard. */
export function isIngestPath(pathname: string): boolean {
  return pathname.startsWith("/ingest/");
}

function status(code: number, headers?: Record<string, string>): Response {
  return new Response(code === 204 ? null : String(code), { status: code, headers });
}

/** Constant-time comparison of `Authorization: Bearer <token>` against the configured token. */
function tokenMatches(header: string | null, token: string): boolean {
  const match = header === null ? null : /^Bearer (.+)$/i.exec(header);
  if (match === null || match[1] === undefined) return false;
  const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(match[1]), digest(token));
}

/**
 * Reads the body counting bytes within `timeoutMs`; cancels the reader and reports `too-large` as
 * soon as it passes {@link MAX_HOOK_BODY_BYTES}, or `timeout` when the deadline hits (never
 * `arrayBuffer()`).
 */
async function readBounded(
  req: Request,
  timeoutMs: number,
): Promise<{ ok: true; text: string } | { ok: false; why: "too-large" | "timeout" }> {
  if (req.body === null) return { ok: true, text: "" };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === "timeout") {
        void reader.cancel().catch(() => undefined);
        return { ok: false, why: "timeout" };
      }
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_HOOK_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, why: "too-large" };
      }
      chunks.push(next.value);
    }
  } finally {
    clearTimeout(timer);
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

/** Handles an already-guarded `/ingest/*` request. */
export async function routeIngest(req: Request, url: URL, ctx: IngestContext): Promise<Response> {
  const engine = HOOK_PATH.exec(url.pathname)?.[1];
  if (engine === undefined) return status(404);
  if (req.method !== "POST") return status(405, { Allow: "POST" });

  if (ctx.token !== null && !tokenMatches(req.headers.get("authorization"), ctx.token)) {
    ctx.monitor.hookRejected(engine, "unauthorized");
    return status(401);
  }

  if (!ctx.adapters.some((a) => a.id === engine && a.fromHook !== undefined)) {
    ctx.monitor.hookRejected(engine, "unknown-engine");
    return status(404);
  }

  const release = ctx.queue.acquireBody(engine);
  if (release === null) return status(204);
  try {
    const declared = Number(req.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_HOOK_BODY_BYTES) {
      await req.body?.cancel().catch(() => undefined);
      ctx.monitor.hookRejected(engine, "too-large");
      return status(413);
    }
    const body = await readBounded(req, ctx.readTimeoutMs ?? HOOK_READ_TIMEOUT_MS);
    if (!body.ok) {
      // A stalled body is a client problem, not data: 408 (hook clients are fail-open anyway).
      ctx.monitor.hookRejected(engine, body.why === "timeout" ? "bad-request" : "too-large");
      return status(body.why === "timeout" ? 408 : 413);
    }
    ctx.monitor.hookReceived(engine);
    ctx.queue.enqueueHook(engine, body.text);
    return status(204);
  } finally {
    release();
  }
}
