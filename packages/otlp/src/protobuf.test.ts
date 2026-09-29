import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INVALID, VECTORS, hexToBytes, lp, wrap } from "../../../fixtures/otlp/protobuf/vectors";
import { flattenOtlp } from "./flatten";
import { decodeOtlpProtobuf, MAX_ANY_VALUE_DEPTH, ProtobufError } from "./protobuf";
import type { OtlpSignal } from "./types";

const FIXTURES = join(import.meta.dir, "..", "..", "..", "fixtures", "otlp", "protobuf");

/** `n` AnyValues nested through array_value, innermost a string. */
function nestedAnyValue(n: number): string {
  let value = "0a0178";
  for (let i = 1; i < n; i++) value = `2a${lp(`0a${lp(value)}`)}`;
  return value;
}

describe("protobuf decoder: hand-written vectors", () => {
  for (const v of VECTORS) {
    // Covers: R14
    test(v.name, () => {
      expect(decodeOtlpProtobuf(v.signal, hexToBytes(v.hex))).toEqual(v.expected);
    });
  }

  for (const v of INVALID) {
    // Covers: R14
    test(`rejects: ${v.name}`, () => {
      expect(() => decodeOtlpProtobuf(v.signal, hexToBytes(v.hex))).toThrow(ProtobufError);
    });
  }
});

describe("protobuf decoder: limits", () => {
  // Covers: R14
  test("AnyValue depth 32 decodes", () => {
    const hex = wrap(`2a${lp(nestedAnyValue(MAX_ANY_VALUE_DEPTH))}`);
    expect(() => decodeOtlpProtobuf("logs", hexToBytes(hex))).not.toThrow();
  });

  // Covers: R14
  test("AnyValue depth 33 throws ProtobufError", () => {
    const hex = wrap(`2a${lp(nestedAnyValue(MAX_ANY_VALUE_DEPTH + 1))}`);
    expect(() => decodeOtlpProtobuf("logs", hexToBytes(hex))).toThrow(ProtobufError);
  });

  // Covers: R14
  test("a 10,000-deep hostile body is a ProtobufError, not a RangeError", () => {
    const hex = wrap(`2a${lp(nestedAnyValue(10_000))}`);
    expect(() => decodeOtlpProtobuf("logs", hexToBytes(hex))).toThrow(ProtobufError);
  });

  // Covers: R14
  test("the values-per-request cap throws ProtobufError", () => {
    // attributes(6){key(1)="k", value(2){}} — three AnyValues in one record
    const attr = "32 05 0a016b 1200";
    const hex = wrap(`${attr} ${attr} ${attr}`);
    expect(() => decodeOtlpProtobuf("logs", hexToBytes(hex), { maxValues: 2 })).toThrow(
      ProtobufError,
    );
    expect(() => decodeOtlpProtobuf("logs", hexToBytes(hex), { maxValues: 3 })).not.toThrow();
  });
});

describe("protobuf decoder: oracle equality (protobufjs-encoded .bin)", () => {
  const NOW = 1_700_000_000_000;
  for (const signal of ["logs", "traces", "metrics"] as const satisfies readonly OtlpSignal[]) {
    // Covers: R14, R16
    test(`${signal}.bin decodes to what the JSON capture flattens to`, () => {
      const bin = new Uint8Array(readFileSync(join(FIXTURES, `${signal}.bin`)));
      const json: unknown = JSON.parse(readFileSync(join(FIXTURES, `${signal}.json`), "utf8"));
      const fromBin = flattenOtlp(signal, decodeOtlpProtobuf(signal, bin), { now: NOW });
      const fromJson = flattenOtlp(signal, json, { now: NOW });
      expect(fromBin).not.toBeNull();
      expect(fromBin!.records.length).toBeGreaterThan(0);
      expect(fromBin).toEqual(fromJson);
    });
  }

  // Covers: R14
  test("logs.bin: fixed64 nanoseconds survive above 2^53 as decimal strings", () => {
    const bin = new Uint8Array(readFileSync(join(FIXTURES, "logs.bin")));
    const decoded = decodeOtlpProtobuf("logs", bin) as {
      resourceLogs: { scopeLogs: { logRecords: { timeUnixNano?: string }[] }[] }[];
    };
    expect(decoded.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.timeUnixNano).toBe(
      "1767225600123456789",
    );
  });
});

describe("protobuf decoder: strings", () => {
  // Covers: R14
  test("a leading U+FEFF is content, not a BOM to strip", () => {
    const hex = (s: string): string => Buffer.from(s).toString("hex");
    const kv = `0a${lp(hex("k"))}12${lp(`0a${lp(hex("﻿v"))}`)}`;
    const decoded = decodeOtlpProtobuf("logs", hexToBytes(wrap(`32${lp(kv)}`)));
    expect(JSON.stringify(decoded)).toContain("﻿v");
  });
});
