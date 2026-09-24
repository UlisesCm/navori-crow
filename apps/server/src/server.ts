import { join, normalize, sep } from "node:path";
import type { Server } from "bun";
import { checkRequest } from "./guard";

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
 * `/api/*` routing lands in B5.T2 (REST + SSE): until then, any request that
 * clears the guard falls through to a plain 404 here.
 */
function handleApi(): Response {
  return new Response("Not Found", { status: 404 });
}

/**
 * Builds `handleRequest`, closed over the server's `allowedOrigins` (D14).
 * `port` is read from `server.port` on each call rather than captured here,
 * since tests may bind an OS-assigned port (`startServer(0)`).
 */
export function createRequestHandler(
  allowedOrigins: readonly string[],
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
      return handleApi();
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
