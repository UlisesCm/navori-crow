/**
 * Hand-written protobuf wire vectors for the `@crow/otlp` decoder (design.md
 * D9). The interesting bytes are literal hex written by hand from the wire
 * format spec — the oracle (`protobufjs`) does NOT generate them. Only the
 * fixed outer envelope (request → resource → scope → item) is wrapped by
 * `wrap`, which computes single/double-byte length prefixes.
 *
 * Tags: `key = field << 3 | wire`; e.g. `09` is field 1 fixed64, `12` is
 * field 2 length-delimited, `18` is field 3 varint, `21` is field 4 fixed64.
 */
import type { OtlpJson, OtlpSignal } from "../../../packages/otlp/src/types";

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Length prefix (varint) + payload, in hex. */
export function lp(hex: string): string {
  const clean = hex.replace(/\s+/g, "");
  let n = clean.length / 2;
  let prefix = "";
  do {
    const low = n & 0x7f;
    n = Math.floor(n / 128);
    prefix += (n > 0 ? low | 0x80 : low).toString(16).padStart(2, "0");
  } while (n > 0);
  return prefix + clean;
}

/** request → resource(1) → scope(2) → item(2), item given as hex. */
export function wrap(itemHex: string): string {
  return `0a${lp(`12${lp(`12${lp(itemHex)}`)}`)}`;
}

export interface Vector {
  name: string;
  signal: OtlpSignal;
  hex: string;
  expected: OtlpJson;
}

const logs = (record: OtlpJson): OtlpJson => ({
  resourceLogs: [{ scopeLogs: [{ logRecords: [record] }] }],
});
const metrics = (metric: OtlpJson): OtlpJson => ({
  resourceMetrics: [{ scopeMetrics: [{ metrics: [metric] }] }],
});
const body = (v: OtlpJson): OtlpJson => ({ attributes: [], body: v });

/** Successful decodes. */
export const VECTORS: Vector[] = [
  {
    name: "empty body is an empty request",
    signal: "logs",
    hex: "",
    expected: { resourceLogs: [] },
  },
  {
    name: "fixed64 time_unix_nano = 1",
    signal: "logs",
    hex: wrap("09 0100000000000000"),
    expected: logs({ attributes: [], timeUnixNano: "1" }),
  },
  {
    name: "fixed64 keeps 2^64-1 without precision loss",
    signal: "logs",
    hex: wrap("09 ffffffffffffffff"),
    expected: logs({ attributes: [], timeUnixNano: "18446744073709551615" }),
  },
  {
    name: "observed_time_unix_nano is field 11",
    signal: "logs",
    hex: wrap("59 0200000000000000"),
    expected: logs({ attributes: [], observedTimeUnixNano: "2" }),
  },
  {
    name: "int_value multi-byte varint 300",
    signal: "logs",
    hex: wrap("2a 03 18ac02"),
    expected: logs(body({ intValue: "300" })),
  },
  {
    name: "int_value -1 is a 10-byte varint and is sign-wrapped to int64",
    signal: "logs",
    hex: wrap("2a 0b 18ffffffffffffffffff01"),
    expected: logs(body({ intValue: "-1" })),
  },
  {
    name: "int_value 2^63 wraps to int64 min",
    signal: "logs",
    hex: wrap("2a 0b 1880808080808080808001"),
    expected: logs(body({ intValue: "-9223372036854775808" })),
  },
  {
    name: "double_value 1.5 little-endian",
    signal: "logs",
    hex: wrap("2a 09 21 000000000000f83f"),
    expected: logs(body({ doubleValue: 1.5 })),
  },
  {
    name: "bool_value true",
    signal: "logs",
    hex: wrap("2a 02 1001"),
    expected: logs(body({ boolValue: true })),
  },
  {
    name: "string_value",
    signal: "logs",
    hex: wrap("2a 04 0a026869"),
    expected: logs(body({ stringValue: "hi" })),
  },
  {
    name: "invalid UTF-8 is replaced, not fatal",
    signal: "logs",
    hex: wrap("2a 03 0a01ff"),
    expected: logs(body({ stringValue: "�" })),
  },
  {
    name: "bytes_value is base64",
    signal: "logs",
    hex: wrap("2a 05 3a 03 000102"),
    expected: logs(body({ bytesValue: "AAEC" })),
  },
  {
    name: "the oneof keeps the last value",
    signal: "logs",
    hex: wrap("2a 05 0a01611001"),
    expected: logs(body({ boolValue: true })),
  },
  {
    name: "a repeated non-repeated message field keeps the last occurrence",
    signal: "logs",
    hex: wrap("2a 04 0a026161 2a 04 0a026262"),
    expected: logs(body({ stringValue: "bb" })),
  },
  {
    name: "attribute with a string value, event_name and severity_text",
    signal: "logs",
    // attributes(6){key(1)="k", value(2){string_value(1)="v"}}, event_name(12)="e", severity_text(3)="I"
    hex: wrap("32 08 0a016b 12030a0176 620165 1a0149"),
    expected: logs({
      attributes: [{ key: "k", value: { stringValue: "v" } }],
      eventName: "e",
      severityText: "I",
    }),
  },
  {
    name: "array_value nests one level",
    signal: "logs",
    // body{array_value(5){values(1){string_value(1)="x"}}}
    hex: wrap("2a 07 2a 05 0a 03 0a 01 78"),
    expected: logs(body({ arrayValue: { values: [{ stringValue: "x" }] } })),
  },
  {
    name: "unknown fields of every wire type are skipped at any level",
    signal: "logs",
    // varint f15 | fixed32 f8 | fixed64 f20 | len f30 | packed-looking len f40, then time_unix_nano=1
    hex: wrap(
      "7805 4501000000 a101 1122334455667788 f201 03aabbcc c202 0401020304 090100000000000000",
    ),
    expected: logs({ attributes: [], timeUnixNano: "1" }),
  },
  {
    name: "a known field with the wrong wire type is skipped",
    signal: "logs",
    hex: wrap("0805 090100000000000000"),
    expected: logs({ attributes: [], timeUnixNano: "1" }),
  },
  {
    name: "as_int (field 6) is sfixed64, signed",
    signal: "metrics",
    // metric{sum(7){data_points(1){as_int(6)=-1}}}
    hex: wrap("3a 0b 0a 09 31 ffffffffffffffff"),
    expected: metrics({ sum: { dataPoints: [{ attributes: [], asInt: "-1" }] } }),
  },
  {
    name: "NumberDataPoint flags (field 8, varint) is skipped next to as_double",
    signal: "metrics",
    // metric{gauge(5){data_points(1){as_double(4)=1.5, flags(8)=1}}}
    hex: wrap("2a 0d 0a 0b 21 000000000000f83f 40 01"),
    expected: metrics({ gauge: { dataPoints: [{ attributes: [], asDouble: 1.5 }] } }),
  },
  {
    name: "as_double (field 4) and gauge",
    signal: "metrics",
    hex: wrap("2a 0b 0a 09 21 000000000000f83f"),
    expected: metrics({ gauge: { dataPoints: [{ attributes: [], asDouble: 1.5 }] } }),
  },
  {
    name: "sum temporality and monotonic; time_unix_nano is fixed64 (field 3)",
    signal: "metrics",
    // metric{name(1)="m", sum(7){data_points(1){time(3)=5}, temporality(2)=1, monotonic(3)=1}}
    hex: wrap("0a016d 3a 0f 0a 09 19 0500000000000000 10 01 18 01"),
    expected: metrics({
      name: "m",
      sum: {
        dataPoints: [{ attributes: [], timeUnixNano: "5" }],
        aggregationTemporality: 1,
        isMonotonic: true,
      },
    }),
  },
  {
    name: "histogram (field 9) is skipped as an unknown metric kind",
    signal: "metrics",
    hex: wrap("0a016d 4a 03 0a0100"),
    expected: metrics({ name: "m" }),
  },
];

/** Malformed inputs: each must throw `ProtobufError`. */
export const INVALID: { name: string; signal: OtlpSignal; hex: string }[] = [
  { name: "wire type 3 (start group)", signal: "logs", hex: "0b" },
  { name: "wire type 4 (end group)", signal: "logs", hex: "0c" },
  { name: "wire type 6", signal: "logs", hex: "0e" },
  { name: "wire type 7", signal: "logs", hex: "0f" },
  { name: "field number 0", signal: "logs", hex: "0001" },
  { name: "varint longer than 10 bytes", signal: "logs", hex: "08ffffffffffffffffffff01" },
  { name: "truncated varint", signal: "logs", hex: "0880" },
  { name: "length beyond the buffer", signal: "logs", hex: "0a05aa" },
  { name: "length near 2^64 (no shift overflow)", signal: "logs", hex: "0affffffffffffffffff01" },
  { name: "truncated fixed64 inside a record", signal: "logs", hex: wrap("09 010000") },
  { name: "group inside a nested message", signal: "logs", hex: wrap("0b") },
];
