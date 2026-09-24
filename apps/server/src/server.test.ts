import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { isApiPath, isInside, startServer } from "./server";

describe("server", () => {
  let server: ReturnType<typeof startServer>;

  beforeAll(() => {
    server = startServer(0); // let the OS pick a free port
  });

  afterAll(() => {
    server.stop(true);
  });

  test("GET /healthz returns 200 with { ok: true }", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("GET on an unknown path returns 404", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/does-not-exist`);
    expect(res.status).toBe(404);
  });

  test("/API/x bypasses the guard (pinned, case-sensitive isApiPath) while //api/x stays guarded", async () => {
    const badHost = { headers: { host: "evil.example.com" } };

    // Not matched by `isApiPath` (case-sensitive): falls through to the
    // static branch and 404s — never reaches `handleApi`, but also never a
    // 403, since it was never treated as `/api/*` in the first place.
    const upper = await fetch(`http://127.0.0.1:${server.port}/API/x`, badHost);
    expect(upper.status).toBe(404);

    // A doubled leading slash is not a real bypass: Bun's server normalizes
    // it to `/api/x` before `fetch` sees the request, so the guard still runs.
    const doubleSlash = await fetch(`http://127.0.0.1:${server.port}//api/x`, badHost);
    expect(doubleSlash.status).toBe(403);
  });
});

describe("isApiPath", () => {
  test("matches /api and /api/* exactly", () => {
    expect(isApiPath("/api")).toBe(true);
    expect(isApiPath("/api/stats")).toBe(true);
  });

  test("does not match a different case or a doubled leading slash", () => {
    expect(isApiPath("/API")).toBe(false);
    expect(isApiPath("/API/stats")).toBe(false);
    expect(isApiPath("//api/stats")).toBe(false);
  });

  test("does not match an unrelated path", () => {
    expect(isApiPath("/apix")).toBe(false);
    expect(isApiPath("/healthz")).toBe(false);
  });
});

describe("isInside", () => {
  test("same directory is inside", () => {
    expect(isInside("/x/public", "/x/public")).toBe(true);
  });

  test("child path is inside", () => {
    expect(isInside("/x/public", "/x/public/index.html")).toBe(true);
  });

  test("sibling with shared prefix is not inside", () => {
    expect(isInside("/x/public", "/x/public-evil")).toBe(false);
  });

  test("parent directory is not inside", () => {
    expect(isInside("/x/public", "/x")).toBe(false);
  });
});
