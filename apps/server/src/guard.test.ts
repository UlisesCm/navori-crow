// Covers: R28
import { describe, expect, test } from "bun:test";
import { checkRequest } from "./guard";
import { isIngestPath } from "./ingest-route";

const PORT = 7777;

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

describe("checkRequest (D14)", () => {
  test("allowed host without a port passes", () => {
    expect(checkRequest(headers({ host: "127.0.0.1" }), PORT, [])).toBeNull();
  });

  test("allowed host with a port passes", () => {
    expect(checkRequest(headers({ host: "127.0.0.1:7777" }), PORT, [])).toBeNull();
  });

  test("localhost host passes", () => {
    expect(checkRequest(headers({ host: "localhost:7777" }), PORT, [])).toBeNull();
  });

  test("bracketed IPv6 loopback host passes", () => {
    expect(checkRequest(headers({ host: "[::1]:7777" }), PORT, [])).toBeNull();
  });

  test("bracketed IPv6 loopback host without a port passes", () => {
    expect(checkRequest(headers({ host: "[::1]" }), PORT, [])).toBeNull();
  });

  test("a foreign host is rejected (DNS rebinding)", () => {
    const res = checkRequest(headers({ host: "evil.example.com" }), PORT, []);
    expect(res).not.toBeNull();
    expect(res?.status).toBe(403);
  });

  test("a missing Host header is rejected", () => {
    const res = checkRequest(headers({}), PORT, []);
    expect(res?.status).toBe(403);
  });

  test("a foreign Origin is rejected", () => {
    const res = checkRequest(
      headers({ host: "127.0.0.1:7777", origin: "http://evil.example.com" }),
      PORT,
      [],
    );
    expect(res?.status).toBe(403);
  });

  test("Origin: null is rejected", () => {
    const res = checkRequest(headers({ host: "127.0.0.1:7777", origin: "null" }), PORT, []);
    expect(res?.status).toBe(403);
  });

  test("no Origin header is allowed", () => {
    expect(checkRequest(headers({ host: "127.0.0.1:7777" }), PORT, [])).toBeNull();
  });

  test("an Origin matching the default same-origin set passes", () => {
    expect(
      checkRequest(headers({ host: "127.0.0.1:7777", origin: "http://127.0.0.1:7777" }), PORT, []),
    ).toBeNull();
  });

  test("an Origin listed in CROW_ALLOWED_ORIGINS passes", () => {
    expect(
      checkRequest(headers({ host: "127.0.0.1:7777", origin: "http://localhost:5173" }), PORT, [
        "http://localhost:5173",
      ]),
    ).toBeNull();
  });
});

describe("the guard on /ingest/* (F2a D3, R4)", () => {
  test("a curl-style hook client (Host only, no Origin, Authorization ignored) passes", () => {
    // Covers: R4
    const req = headers({ host: "127.0.0.1:7777", authorization: "Bearer t" });
    expect(checkRequest(req, PORT, [])).toBeNull();
  });

  test("a foreign Host or Origin is rejected exactly like /api/*", () => {
    // Covers: R4
    expect(checkRequest(headers({ host: "evil.example.com" }), PORT, [])?.status).toBe(403);
    const foreign = headers({ host: "127.0.0.1:7777", origin: "http://evil.example.com" });
    expect(checkRequest(foreign, PORT, [])?.status).toBe(403);
  });

  test("isIngestPath is the case-sensitive /ingest/ prefix (bare /ingest and /INGEST/x are not ingest)", () => {
    // Covers: R4
    expect(isIngestPath("/ingest/hook/claude")).toBe(true);
    expect(isIngestPath("/ingest")).toBe(false);
    expect(isIngestPath("/INGEST/hook/claude")).toBe(false);
  });
});
