import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { EventBus, IngestQueue, loadConfig, migrate, createUlidFactory, isRec } from "@crow/core";
import type { BoundAdapter, HookInput, HookResult, LanesStatus } from "@crow/core";
import { LaneMonitor } from "./lanes";
import { MAX_HOOK_BODY_BYTES, routeIngest } from "./ingest-route";
import type { IngestContext } from "./ingest-route";
import { createRequestHandler } from "./server";

const T0 = 1_700_000_000_000;

function fromHook(input: HookInput): HookResult {
  const body = input.body;
  if (!isRec(body) || typeof body.session !== "string") {
    return { ok: false, reason: "bad-shape", sessionId: null, agentId: null };
  }
  return {
    ok: true,
    events: [
      {
        sessionId: body.session,
        agentId: null,
        parentAgentId: null,
        kind: "prompt",
        ts: T0,
        cwd: "/tmp/proj",
      },
    ],
  };
}

const withHooks = { id: "claude", fromHook } as unknown as BoundAdapter;
const withoutHooks = { id: "codex" } as unknown as BoundAdapter;

interface Rig {
  db: Database;
  queue: IngestQueue;
  monitor: LaneMonitor;
  ctx: IngestContext;
  server: ReturnType<typeof Bun.serve>;
  base: string;
}

const rigs: Rig[] = [];

function rig(token: string | null = null): Rig {
  const db = new Database(":memory:");
  migrate(db);
  const monitor = new LaneMonitor(["claude", "codex"], () => T0);
  const queue = new IngestQueue({
    db,
    bus: new EventBus(),
    nextId: createUlidFactory("00000000000000000000000000", () => T0),
    now: () => T0,
    idleMs: 300_000,
    adapters: [withHooks, withoutHooks],
    onDrop: (engine) => monitor.hookRejected(engine, "queue-overflow"),
    onStored: (engine) => monitor.hookStored(engine),
  });
  const ctx: IngestContext = { adapters: [withHooks, withoutHooks], queue, monitor, token };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createRequestHandler([], undefined, ctx),
  });
  const r = { db, queue, monitor, ctx, server, base: `http://127.0.0.1:${server.port}` };
  rigs.push(r);
  return r;
}

afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.queue.stop();
    r.server.stop(true);
    r.db.close();
  }
});

function post(r: Rig, path: string, body: BodyInit | null, headers: HeadersInit = {}) {
  return fetch(`${r.base}${path}`, { method: "POST", body, headers });
}

function prompts(db: Database): number {
  return (
    db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'prompt'").get()
      ?.n ?? 0
  );
}

describe("POST /ingest/hook/:engine", () => {
  test("204 immediately with the drainer paused; the event appears after resume", async () => {
    // Covers: R1
    const r = rig();
    r.queue.pause();
    const res = await post(r, "/ingest/hook/claude", JSON.stringify({ session: "s1" }));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(prompts(r.db)).toBe(0);
    r.queue.resume();
    await r.queue.idle();
    expect(prompts(r.db)).toBe(1);
  });

  test("an engine without fromHook, or unknown, is 404 and nothing is enqueued", async () => {
    // Covers: R2
    const r = rig();
    r.queue.pause();
    expect((await post(r, "/ingest/hook/codex", "{}")).status).toBe(404);
    expect((await post(r, "/ingest/hook/nope", "{}")).status).toBe(404);
    expect(r.queue.hookDepth).toBe(0);
    expect(r.monitor.snapshot().engines.codex?.hook.rejected["unknown-engine"]).toBe(1);
  });

  test("other methods are 405 and unknown ingest paths 404", async () => {
    // Covers: R1
    const r = rig();
    expect((await fetch(`${r.base}/ingest/hook/claude`)).status).toBe(405);
    expect((await post(r, "/ingest/other", "{}")).status).toBe(404);
    expect((await post(r, "/ingest", "{}")).status).toBe(404);
  });

  test("with a token: missing or wrong → 401 and not enqueued; correct → 204", async () => {
    // Covers: R3
    const r = rig("s3cret");
    r.queue.pause();
    expect((await post(r, "/ingest/hook/claude", "{}")).status).toBe(401);
    const wrong = { Authorization: "Bearer nope" };
    expect((await post(r, "/ingest/hook/claude", "{}", wrong)).status).toBe(401);
    expect((await post(r, "/ingest/hook/claude", "{}", { Authorization: "s3cret" })).status).toBe(
      401,
    );
    expect(r.queue.hookDepth).toBe(0);
    const ok = { Authorization: "Bearer s3cret" };
    expect((await post(r, "/ingest/hook/claude", "{}", ok)).status).toBe(204);
    expect(r.queue.hookDepth).toBe(1);
    expect(r.monitor.snapshot().engines.claude?.hook.rejected.unauthorized).toBe(3);
  });

  test("the token is resolved from CROW_TOKEN and from $CROW_HOME/token (config)", () => {
    // Covers: R3
    const dir = mkdtempSync(join(tmpdir(), "crow-token-"));
    try {
      writeFileSync(join(dir, "token"), "from-file\n", { mode: 0o600 });
      expect(loadConfig({ CROW_HOME: dir }, dir).token).toBe("from-file");
      expect(loadConfig({ CROW_HOME: dir, CROW_TOKEN: "from-env" }, dir).token).toBe("from-env");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("curl-style (no Origin) → 204; foreign Host or Origin → 403; /INGEST/x → 404", async () => {
    // Covers: R4
    const r = rig();
    r.queue.pause();
    expect((await post(r, "/ingest/hook/claude", "{}")).status).toBe(204);
    const foreignOrigin = { Origin: "http://evil.example.com" };
    expect((await post(r, "/ingest/hook/claude", "{}", foreignOrigin)).status).toBe(403);
    expect((await post(r, "/ingest/hook/claude", "{}", { Origin: "null" })).status).toBe(403);
    const foreignHost = await fetch(`${r.base}/ingest/hook/claude`, {
      method: "POST",
      body: "{}",
      headers: { Host: "evil.example.com" },
    });
    expect(foreignHost.status).toBe(403);
    expect((await post(r, "/INGEST/hook/claude", "{}")).status).toBe(404);
    expect(r.queue.hookDepth).toBe(1);
  });

  test("exactly 1 MiB → 204; 1 MiB + 1 with Content-Length → 413 not enqueued", async () => {
    // Covers: R5
    const r = rig();
    r.queue.pause();
    const exact = "x".repeat(MAX_HOOK_BODY_BYTES);
    expect((await post(r, "/ingest/hook/claude", exact)).status).toBe(204);
    const over = "x".repeat(MAX_HOOK_BODY_BYTES + 1);
    expect((await post(r, "/ingest/hook/claude", over)).status).toBe(413);
    expect(r.queue.hookDepth).toBe(1);
    expect(r.monitor.snapshot().engines.claude?.hook.rejected["too-large"]).toBe(1);
  });

  test("1 MiB + 1 chunked (no Content-Length) → 413 over the wire", async () => {
    // Covers: R5
    const r = rig();
    r.queue.pause();
    const chunk = new Uint8Array(64 * 1024).fill(120);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
    });
    const res = await fetch(`${r.base}/ingest/hook/claude`, {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(r.queue.hookDepth).toBe(0);
  });

  test("the reader is cancelled at 1 MiB + 1 (chunked) and on a declared oversize", async () => {
    // Covers: R5
    const r = rig();
    const url = new URL("http://127.0.0.1/ingest/hook/claude");
    const chunk = new Uint8Array(MAX_HOOK_BODY_BYTES / 4).fill(120);

    let pulled = 0;
    let cancelled = false;
    const chunked = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const req = new Request(url, { method: "POST", body: chunked, duplex: "half" } as RequestInit);
    expect((await routeIngest(req, url, r.ctx)).status).toBe(413);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10); // stopped reading right past the cap

    let declaredCancelled = false;
    const declared = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel() {
        declaredCancelled = true;
      },
    });
    const req2 = new Request(url, {
      method: "POST",
      body: declared,
      headers: { "Content-Length": String(MAX_HOOK_BODY_BYTES + 1) },
      duplex: "half",
    } as RequestInit);
    expect((await routeIngest(req2, url, r.ctx)).status).toBe(413);
    expect(declaredCancelled).toBe(true);
  });

  test("the body-read slot is released after each request", async () => {
    // Covers: R7
    const r = rig();
    r.queue.pause();
    for (let n = 0; n < 20; n++) {
      expect(
        (await post(r, "/ingest/hook/claude", JSON.stringify({ session: `s${n}` }))).status,
      ).toBe(204);
    }
    expect(r.monitor.snapshot().engines.claude?.hook.rejected["queue-overflow"]).toBeUndefined();
  });
});

describe("read deadline", () => {
  test("a stalled body → 408, reader cancelled, slot released and counted", async () => {
    // Covers: R5, R7
    const r = rig();
    r.ctx.readTimeoutMs = 30;
    const url = new URL("http://127.0.0.1/ingest/hook/claude");
    let cancelled = false;
    const stalled = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined), // never delivers
      cancel() {
        cancelled = true;
      },
    });
    const req = new Request(url, { method: "POST", body: stalled, duplex: "half" } as RequestInit);
    expect((await routeIngest(req, url, r.ctx)).status).toBe(408);
    expect(cancelled).toBe(true);
    expect(r.queue.hookDepth).toBe(0);
    expect(r.monitor.snapshot().engines.claude?.hook.rejected["bad-request"]).toBe(1);
    // All 16 slots are free again: 16 acquisitions succeed.
    const slots = Array.from({ length: 16 }, () => r.queue.acquireBody("claude"));
    expect(slots.every((slot) => slot !== null)).toBe(true);
  });
});

describe("/api/stats.lanes (hook lane)", () => {
  test("exposes received, rejected counters and last received/stored timestamps", async () => {
    // Covers: R7, R28
    const r = rig();
    await post(r, "/ingest/hook/claude", JSON.stringify({ session: "s1" }));
    await post(r, "/ingest/hook/codex", "{}"); // 404: counted as unknown-engine
    await r.queue.idle();
    const lanes: LanesStatus = r.monitor.snapshot();
    const claude = lanes.engines.claude?.hook;
    expect(claude?.received).toBe(1);
    expect(claude?.lastReceivedAt).toBe(T0);
    expect(claude?.lastStoredAt).toBe(T0);
    expect(lanes.engines.codex?.hook.rejected["unknown-engine"]).toBe(1);
    expect(lanes.engines.codex?.hook.lastReceivedAt).toBeNull();
    expect(lanes.since).toBe(T0);
  });
});
