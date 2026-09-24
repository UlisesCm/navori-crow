import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { isInside, startServer } from "./server";

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
