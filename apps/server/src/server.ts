import { join, normalize, sep } from "node:path";

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

/** Handles a single HTTP request: `/healthz`, then static files, then 404. */
async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/healthz") {
    return Response.json({ ok: true });
  }

  const staticPath = resolveStaticPath(url.pathname);
  if (staticPath !== null) {
    const file = Bun.file(staticPath);
    if (await file.exists()) {
      return new Response(file);
    }
  }

  return new Response("Not Found", { status: 404 });
}

/** Starts the crow server bound to loopback only, never `0.0.0.0`. */
export function startServer(port: number): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: handleRequest,
  });
}
