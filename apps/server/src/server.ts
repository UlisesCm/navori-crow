import { join, normalize, sep } from "node:path";
import type { Server } from "bun";
import type { Database } from "bun:sqlite";
import type { ClockFn, EventBus, IntervalScheduler } from "@crow/core";
import { routeApi } from "./api";
import { checkRequest } from "./guard";
import { createStreamResponse, StreamRegistry } from "./sse";

/** Directory holding the web app's build output (see apps/web/vite.config.ts). */
const PUBLIC_DIR = join(import.meta.dir, "..", "public");

/**
 * Checks whether `candidate` is `root` itself or a path nested inside it,
 * using the platform separator as a boundary so sibling directories that
 * merely share a string prefix (e.g. `public-evil` vs `public`) don't match.
 */
export function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * Resolves a request pathname to an absolute path inside {@link PUBLIC_DIR},
 * guarding against path traversal (`..`). Returns `null` if the resolved
 * path would escape the public directory.
 */
function resolveStaticPath(pathname: string): string | null {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = normalize(join(PUBLIC_DIR, relative));
  return isInside(PUBLIC_DIR, resolved) ? resolved : null;
}

/**
 * The single predicate deciding whether a pathname is `/api/*` (D14): both
 * the guard dispatch below and B5.T2's future route table must share this
 * exact check, so no path can ever reach an API handler without first
 * passing `checkRequest`. Case-sensitive: `/API/x` falls through to the
 * static branch below instead (harmless today, since it only 404s; B5.T2
 * must route through this same `isApiPath`, not redefine its own prefix
 * check). A doubled leading slash (`//api/x`) is *not* a bypass — Bun's
 * server normalizes it to `/api/x` before `fetch` ever sees the request.
 */
export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * Everything `/api/*` needs to actually serve a request (B5.T2): the store,
 * the bus for `/api/stream`, and the knobs REST/SSE need but must not read
 * for themselves (testability, same rationale as `IngestBatchDeps`).
 */
export interface ApiContext {
  db: Database;
  bus: EventBus;
  now: ClockFn;
  idleMinutes: number;
  backfillHours: number;
  scheduleInterval: IntervalScheduler;
  registry: StreamRegistry;
  heartbeatMs?: number;
  streamPageSize?: number;
}

/**
 * Dispatches an already-guarded `/api/*` request: `/api/stream` goes to
 * `sse.ts`, everything else to `api.ts`'s REST router.
 */
function handleApi(req: Request, server: Server<unknown>, url: URL, api: ApiContext): Response {
  if (url.pathname === "/api/stream") {
    return createStreamResponse(req, server, url, {
      db: api.db,
      bus: api.bus,
      scheduleInterval: api.scheduleInterval,
      registry: api.registry,
      heartbeatMs: api.heartbeatMs,
      pageSize: api.streamPageSize,
    });
  }
  return routeApi(req, url, {
    db: api.db,
    now: api.now,
    idleMinutes: api.idleMinutes,
    backfillHours: api.backfillHours,
  });
}

/**
 * Builds `handleRequest`, closed over the server's `allowedOrigins` (D14) and
 * an optional `ApiContext`. `port` is read from `server.port` on each call
 * rather than captured here, since tests may bind an OS-assigned port
 * (`startServer(0)`). `api` is omitted by `startServer`'s own tests, which
 * only exercise the guard/static paths — `/api/*` then falls back to a plain
 * 404, same as before B5.T2 wired it in `app.ts`.
 */
export function createRequestHandler(
  allowedOrigins: readonly string[],
  api?: ApiContext,
): (req: Request, server: Server<unknown>) => Promise<Response> {
  return async function handleRequest(req: Request, server: Server<unknown>): Promise<Response> {
    const url = new URL(req.url);

    // `/healthz` and static files stay outside the guard (D14): they carry
    // no state and a health probe or asset request shouldn't need to spoof
    // an allowed Host/Origin.
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true });
    }

    if (isApiPath(url.pathname)) {
      // `port` is `undefined` only for unix-socket servers (bun-types); this
      // app always binds `hostname` + `port` (D14), so it's set in practice.
      const rejection = checkRequest(req.headers, server.port ?? 0, allowedOrigins);
      if (rejection !== null) return rejection;
      if (api === undefined) return new Response("Not Found", { status: 404 });
      return handleApi(req, server, url, api);
    }

    const staticPath = resolveStaticPath(url.pathname);
    if (staticPath !== null) {
      const file = Bun.file(staticPath);
      if (await file.exists()) {
        return new Response(file);
      }
    }

    return new Response("Not Found", { status: 404 });
  };
}

/** Starts the crow server bound to loopback only, never `0.0.0.0`. */
export function startServer(
  port: number,
  allowedOrigins: readonly string[] = [],
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: createRequestHandler(allowedOrigins),
  });
}
