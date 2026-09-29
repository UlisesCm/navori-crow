#!/usr/bin/env bun
/**
 * Scratch receiver for F2a batch B0 (evidence capture, design.md § Evidence
 * gaps G1-G5a). NOT part of crow: it records what Claude Code / Codex send.
 *
 *   bun scripts/capture-receiver.ts --out <dir> [--port 7790] [--otlp-port 4319] [--mode ok|hang|401|413]
 *
 * Every request is written verbatim to `--out`: `NNNNNN.json` (method, path,
 * headers with credential values redacted, sizes), `NNNNNN.body` (raw bytes,
 * gzip kept as-is) and, for gzip bodies, `NNNNNN.body.decoded`. Bodies may
 * hold prompts: stdout only ever shows counters and paths.
 *
 * Responses: hooks -> 204; OTLP `/v1/{logs,traces,metrics}` -> 200 with an empty
 * OTLP response in the request's content type. `--mode` simulates a bad crow:
 * `hang` (holds the response for 30 s), `401`, `413`. "Down" = don't run this.
 */
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type ReceiverMode = "ok" | "hang" | "401" | "413";

export interface ReceiverOptions {
  out: string;
  /** Hook port; 0 picks an ephemeral one. */
  port: number;
  /** OTLP port; 0 picks an ephemeral one. */
  otlpPort: number;
  mode: ReceiverMode;
  /** How long `hang` mode holds a request. */
  hangMs?: number;
  log?: (line: string) => void;
}

export interface RunningReceiver {
  port: number;
  otlpPort: number;
  /** Number of requests recorded so far. */
  count(): number;
  stop(): Promise<void>;
}

/** Header values kept verbatim; every other header keeps its name only. */
const ALLOWED_HEADER_VALUES = new Set([
  "content-type",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "user-agent",
  "accept",
  "accept-encoding",
  "host",
  "connection",
]);

const OTLP_PATHS = new Set(["/v1/logs", "/v1/traces", "/v1/metrics"]);

/** Header map keeping values only for the allowlist; the rest become `[redacted]`. */
export function redactHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers) {
    out[name] = ALLOWED_HEADER_VALUES.has(name.toLowerCase()) ? value : "[redacted]";
  }
  return out;
}

/** Query string keeping parameter names, values replaced by `[redacted]`. */
export function redactQuery(search: string): string {
  const names = [...new URLSearchParams(search).keys()];
  return names.length === 0
    ? ""
    : `?${names.map((n) => `${encodeURIComponent(n)}=[redacted]`).join("&")}`;
}

/** Nearest ancestor (inclusive) of `path` that holds a version-control dir, or null. Resolves symlinks. */
export function findRepoRoot(path: string): string | null {
  let dir = resolve(path);
  while (!existsSync(dir)) dir = dirname(dir);
  dir = realpathSync(dir);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function otlpResponse(req: Request): Response {
  const type = req.headers.get("content-type") ?? "application/json";
  if (type.includes("protobuf")) {
    // An empty Export*ServiceResponse is zero bytes in protobuf.
    return new Response(new Uint8Array(0), { status: 200, headers: { "content-type": type } });
  }
  return new Response("{}", { status: 200, headers: { "content-type": type } });
}

/** Starts both listeners on 127.0.0.1. */
export function startReceiver(opts: ReceiverOptions): RunningReceiver {
  const repoRoot = findRepoRoot(opts.out);
  if (repoRoot !== null) {
    throw new Error(
      `--out resolves inside a git worktree (${repoRoot}); raw captures must live outside any repo`,
    );
  }
  mkdirSync(opts.out, { recursive: true });
  const holds = new Set<{ timer: ReturnType<typeof setTimeout>; release: () => void }>();
  const log = opts.log ?? (() => {});
  const hangMs = opts.hangMs ?? 30_000;
  let counter = 0;

  const handle = async (req: Request, kind: "hook" | "otlp"): Promise<Response> => {
    counter += 1;
    const n = String(counter).padStart(6, "0");
    const url = new URL(req.url);
    const body = new Uint8Array(await req.arrayBuffer());
    const gzip = (req.headers.get("content-encoding") ?? "").toLowerCase().includes("gzip");
    const base = join(opts.out, n);
    let decodedFile: string | null = null;
    let decodeError = false;
    await Bun.write(`${base}.body`, body);
    if (gzip) {
      try {
        await Bun.write(`${base}.body.decoded`, Bun.gunzipSync(body));
        decodedFile = `${n}.body.decoded`;
      } catch {
        decodeError = true;
      }
    }
    await Bun.write(
      `${base}.json`,
      JSON.stringify(
        {
          n: counter,
          receivedAt: new Date().toISOString(),
          kind,
          method: req.method,
          path: url.pathname,
          query: redactQuery(url.search),
          headers: redactHeaders(req.headers),
          bodyBytes: body.byteLength,
          bodyFile: `${n}.body`,
          decodedFile,
          decodeError,
          mode: opts.mode,
        },
        null,
        2,
      ),
    );
    log(`#${n} ${req.method} ${url.pathname} ${body.byteLength}B mode=${opts.mode}`);

    if (opts.mode === "hang") {
      await new Promise<void>((release) => {
        const hold = {
          timer: setTimeout(() => {
            holds.delete(hold);
            release();
          }, hangMs),
          release,
        };
        holds.add(hold);
      });
      return new Response(null, { status: 204 });
    }
    if (opts.mode === "401") return new Response("unauthorized", { status: 401 });
    if (opts.mode === "413") return new Response("too large", { status: 413 });
    if (kind === "otlp") {
      return OTLP_PATHS.has(url.pathname) ? otlpResponse(req) : new Response(null, { status: 404 });
    }
    return new Response(null, { status: 204 });
  };

  const hookServer = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port,
    idleTimeout: 60,
    maxRequestBodySize: 64 * 1024 * 1024,
    fetch: (req) => handle(req, "hook"),
  });
  const otlpServer = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.otlpPort,
    idleTimeout: 60,
    maxRequestBodySize: 64 * 1024 * 1024,
    fetch: (req) => handle(req, "otlp"),
  });

  return {
    port: hookServer.port ?? opts.port,
    otlpPort: otlpServer.port ?? opts.otlpPort,
    count: () => counter,
    stop: async () => {
      for (const h of holds) {
        clearTimeout(h.timer);
        h.release();
      }
      holds.clear();
      await hookServer.stop(true);
      await otlpServer.stop(true);
    },
  };
}

function parseArgs(argv: string[]): ReceiverOptions {
  const get = (name: string): string | null => {
    const idx = argv.indexOf(`--${name}`);
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1]! : null;
  };
  const out = get("out");
  if (!out) throw new Error("--out <dir> is required");
  const mode = get("mode") ?? "ok";
  if (mode !== "ok" && mode !== "hang" && mode !== "401" && mode !== "413") {
    throw new Error(`--mode must be ok|hang|401|413 (got ${mode})`);
  }
  return {
    out,
    port: Number(get("port") ?? 7790),
    otlpPort: Number(get("otlp-port") ?? 4319),
    mode,
    log: (line) => console.log(line),
  };
}

if (import.meta.main) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const r = startReceiver(opts);
    console.log(
      `capture-receiver: hooks http://127.0.0.1:${r.port}  otlp http://127.0.0.1:${r.otlpPort}  mode=${opts.mode}  out=${opts.out}`,
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}
