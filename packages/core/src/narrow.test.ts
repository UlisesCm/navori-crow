import { describe, expect, test } from "bun:test";
import { arr, isRec, num, path, str } from "./narrow";

describe("isRec", () => {
  test("accepts a plain object", () => {
    // Covers: R10
    const v: unknown = { a: 1 };
    expect(isRec(v)).toBe(true);
  });

  test("rejects an array, null and primitives", () => {
    // Covers: R10
    const values: unknown[] = [[], null, "str", 1, true, undefined];
    for (const v of values) expect(isRec(v)).toBe(false);
  });
});

describe("str", () => {
  test("passes through a string and rejects everything else", () => {
    // Covers: R10
    expect(str("hello")).toBe("hello");
    const notStrings: unknown[] = [1, null, undefined, {}, []];
    for (const v of notStrings) expect(str(v)).toBeNull();
  });
});

describe("num", () => {
  test("passes through a finite number and defaults everything else to 0", () => {
    // Covers: R10
    expect(num(42)).toBe(42);
    const notNumbers: unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, "1", null, undefined, {}];
    for (const v of notNumbers) expect(num(v)).toBe(0);
  });
});

describe("arr", () => {
  test("passes through an array and defaults everything else to []", () => {
    // Covers: R10
    expect(arr([1, 2])).toEqual([1, 2]);
    const notArrays: unknown[] = [{}, "str", 1, null, undefined];
    for (const v of notArrays) expect(arr(v)).toEqual([]);
  });
});

describe("path", () => {
  test("walks a chain of keys through nested objects", () => {
    // Covers: R10
    const rec = { a: { b: { c: "deep" } } };
    expect(path(rec, "a", "b", "c")).toBe("deep");
  });

  test("returns undefined off any non-object hop, never throwing", () => {
    // Covers: R10
    const rec = { a: { b: "not an object" } };
    expect(() => path(rec, "a", "b", "c")).not.toThrow();
    expect(path(rec, "a", "b", "c")).toBeUndefined();
    expect(path(rec, "missing", "x")).toBeUndefined();
  });
});
