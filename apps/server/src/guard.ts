/**
 * DNS-rebinding / CSRF guard for `/api/*` (design.md D14, R28).
 *
 * Pure and header-driven: no I/O, so it's trivial to unit test and to reason
 * about — a request only reaches a handler once `checkRequest` returns
 * `null`. Both checks fail closed: a malformed or missing `Host` is rejected,
 * and an `Origin` that isn't recognized (including the literal `"null"`
 * origin some sandboxed contexts send) is rejected too. No `Origin` at all is
 * allowed, since browsers omit it for plain navigations and same-origin
 * requests.
 */

/** Hostnames a request is allowed to target (case-insensitive, port-stripped). */
const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Extracts the hostname from an HTTP `Host` header value, stripping the
 * port and unwrapping IPv6 brackets (`[::1]:7777` -> `::1`). Returns `null`
 * for anything that isn't a well-formed `Host` value.
 */
function parseHostname(hostHeader: string): string | null {
  const trimmed = hostHeader.trim();
  if (trimmed.length === 0) return null;

  if (trimmed.startsWith("[")) {
    const closing = trimmed.indexOf("]");
    if (closing === -1) return null;
    const hostname = trimmed.slice(1, closing);
    return hostname.length > 0 ? hostname.toLowerCase() : null;
  }

  const colonIndex = trimmed.lastIndexOf(":");
  const hostname = colonIndex === -1 ? trimmed : trimmed.slice(0, colonIndex);
  return hostname.length > 0 ? hostname.toLowerCase() : null;
}

/** The default same-origin set for `port` (D14), before `CROW_ALLOWED_ORIGINS` is added in. */
function defaultOrigins(port: number): string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`];
}

/** `true` if `origin` (already known not to be the literal `"null"`) is in the allowed set. */
function isAllowedOrigin(origin: string, port: number, allowedOrigins: readonly string[]): boolean {
  const allowed = new Set(
    [...defaultOrigins(port), ...allowedOrigins].map((entry) => entry.toLowerCase()),
  );
  return allowed.has(origin.toLowerCase());
}

/** A 403 response for a rejected request; the body never echoes request content. */
function forbidden(): Response {
  return new Response("Forbidden", { status: 403 });
}

/**
 * Validates a request against the Host/Origin guard (D14, R28). Returns a
 * 403 {@link Response} to send as-is, or `null` if the request may proceed.
 */
export function checkRequest(
  headers: Headers,
  port: number,
  allowedOrigins: readonly string[],
): Response | null {
  const hostHeader = headers.get("host");
  const hostname = hostHeader !== null ? parseHostname(hostHeader) : null;
  if (hostname === null || !ALLOWED_HOSTNAMES.has(hostname)) {
    return forbidden();
  }

  const origin = headers.get("origin");
  if (origin !== null) {
    if (origin === "null" || !isAllowedOrigin(origin, port, allowedOrigins)) {
      return forbidden();
    }
  }

  return null;
}
