/** Pure hash-route parsing (D16): `#/`, `#/split/<k1>,<k2>[,<k3>[,<k4>]]`, `#/session/<id>`. */
export type Route =
  | { name: "home" }
  | { name: "split"; keys: string[] }
  | { name: "session"; id: string }
  | { name: "not-found" };

export function parseRoute(hash: string): Route {
  try {
    return parseDecoded(hash);
  } catch {
    return { name: "not-found" }; // malformed %-escape (URIError)
  }
}

function parseDecoded(hash: string): Route {
  const path = hash.replace(/^#/, "");
  if (path === "" || path === "/") return { name: "home" };
  const split = /^\/split\/([^/]+)$/.exec(path);
  if (split !== null) {
    const keys = decodeURIComponent(split[1]!)
      .split(",")
      .filter((k) => k !== "");
    return keys.length >= 2 && keys.length <= 4 ? { name: "split", keys } : { name: "not-found" };
  }
  const session = /^\/session\/([^/]+)$/.exec(path);
  if (session !== null) return { name: "session", id: decodeURIComponent(session[1]!) };
  return { name: "not-found" };
}
