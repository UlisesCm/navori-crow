import { describe, expect, test } from "bun:test";
import { parseRoute } from "./route";

describe("parseRoute", () => {
  // Covers: R30
  test("home, session and split routes", () => {
    expect(parseRoute("")).toEqual({ name: "home" });
    expect(parseRoute("#/")).toEqual({ name: "home" });
    expect(parseRoute("#/session/claude%3Aabc")).toEqual({ name: "session", id: "claude:abc" });
    expect(parseRoute("#/split/a,b,c")).toEqual({ name: "split", keys: ["a", "b", "c"] });
  });

  // Covers: R30
  test("split needs 2 to 4 keys; unknown paths are not-found", () => {
    expect(parseRoute("#/split/a")).toEqual({ name: "not-found" });
    expect(parseRoute("#/split/a,b,c,d,e")).toEqual({ name: "not-found" });
    expect(parseRoute("#/nope")).toEqual({ name: "not-found" });
  });

  // Covers: R30
  test("malformed percent-escape returns not-found instead of throwing", () => {
    expect(parseRoute("#/p/%E0%A4%A")).toEqual({ name: "not-found" });
    expect(parseRoute("#/session/%E0%A4%A")).toEqual({ name: "not-found" });
    expect(parseRoute("#/split/%E0%A4%A,b")).toEqual({ name: "not-found" });
  });
});
