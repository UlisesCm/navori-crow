import { describe, expect, test } from "bun:test";
import { flattenOtlp } from "./flatten";
import { OtlpJsonError, parseOtlpJson } from "./json";

const NOW = 1_700_000_000_000;

const str = (key: string, value: string) => ({ key, value: { stringValue: value } });

/** One-record logs envelope with resource attrs and a session. */
function logs(record: object, resource: object[] = [str("service.name", "claude-code")]): unknown {
  return {
    resourceLogs: [{ resource: { attributes: resource }, scopeLogs: [{ logRecords: [record] }] }],
  };
}

describe("flattenOtlp: logs (ported from collect.ts)", () => {
  // Covers: R16
  test("flattens resource and record attributes; record wins over resource", () => {
    const body = logs(
      {
        attributes: [
          str("event.name", "tool_decision"),
          str("session.id", "s1"),
          str("host", "record"),
        ],
      },
      [str("service.name", "claude-code"), str("host", "resource"), str("os", "darwin")],
    );
    const { records } = flattenOtlp("logs", body, { now: NOW })!;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      signal: "log",
      name: "tool_decision",
      service: "claude-code",
      scope: null,
      attrs: { host: "record", os: "darwin", "session.id": "s1" },
    });
  });

  // Covers: R16
  test("keeps the raw name: the claude_code. prefix is not stripped", () => {
    const { records } = flattenOtlp(
      "logs",
      logs({ attributes: [str("event.name", "claude_code.api_request")] }),
      { now: NOW },
    )!;
    expect(records[0]!.name).toBe("claude_code.api_request");
  });

  // Covers: R16
  test("name falls back to eventName, then to a string body; trims", () => {
    const byField = flattenOtlp("logs", logs({ eventName: "  e1 " }), { now: NOW })!;
    const byBody = flattenOtlp("logs", logs({ body: { stringValue: "b1" } }), { now: NOW })!;
    const none = flattenOtlp("logs", logs({}), { now: NOW })!;
    expect(byField.records[0]!.name).toBe("e1");
    expect(byBody.records[0]!.name).toBe("b1");
    expect(none.records[0]!.name).toBe("");
  });

  // Covers: R16
  test("records without a session are kept, not dropped (R17 is the router's call)", () => {
    const { records, discarded } = flattenOtlp(
      "logs",
      logs({ attributes: [str("event.name", "x")] }),
      { now: NOW },
    )!;
    expect(records).toHaveLength(1);
    expect(discarded).toBe(0);
  });

  // Covers: R16
  test("ts: event.timestamp attribute, then timeUnixNano, then observedTimeUnixNano, then now", () => {
    const declared = flattenOtlp(
      "logs",
      logs({
        timeUnixNano: "5000000",
        attributes: [str("event.timestamp", "2026-01-01T00:00:00.000Z")],
      }),
      { now: NOW },
    )!;
    const time = flattenOtlp(
      "logs",
      logs({ timeUnixNano: "5000000", observedTimeUnixNano: "9000000" }),
      { now: NOW },
    )!;
    const observed = flattenOtlp("logs", logs({ observedTimeUnixNano: "9000000" }), { now: NOW })!;
    const zero = flattenOtlp("logs", logs({ timeUnixNano: "0" }), { now: NOW })!;
    expect(declared.records[0]!.ts).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
    expect(time.records[0]!.ts).toBe(5);
    expect(observed.records[0]!.ts).toBe(9);
    expect(zero.records[0]!.ts).toBe(NOW);
  });

  // Covers: R16
  test("timeUnixNano as a string above 2^53 loses nothing", () => {
    const { records } = flattenOtlp("logs", logs({ timeUnixNano: "1767225600123456789" }), {
      now: NOW,
    })!;
    expect(records[0]!.ts).toBe(1767225600123);
  });

  // Covers: R16
  test("timeUnixNano as a number (exporters that emit JSON numbers)", () => {
    const { records } = flattenOtlp("logs", logs({ timeUnixNano: 1_767_225_600_000_000_000 }), {
      now: NOW,
    })!;
    expect(records[0]!.ts).toBe(1767225600000);
  });

  // Covers: R16
  test("attribute scalars keep their type; int64 beyond 2^53 stays a string; containers and bytes are skipped", () => {
    const { records } = flattenOtlp(
      "logs",
      logs({
        attributes: [
          { key: "s", value: { stringValue: "v" } },
          { key: "i", value: { intValue: "42" } },
          { key: "n", value: { intValue: 7 } },
          { key: "big", value: { intValue: "9007199254740993" } },
          { key: "neg", value: { intValue: "-9007199254740993" } },
          { key: "b", value: { boolValue: false } },
          { key: "d", value: { doubleValue: 0.5 } },
          { key: "arr", value: { arrayValue: { values: [{ stringValue: "x" }] } } },
          { key: "kv", value: { kvlistValue: { values: [] } } },
          { key: "bytes", value: { bytesValue: "AAEC" } },
          { key: "bad", value: { intValue: "12x" } },
          { value: { stringValue: "no key" } },
        ],
      }),
      { now: NOW },
    )!;
    const attrs = records[0]!.attrs;
    expect(attrs.s).toBe("v");
    expect(attrs.i).toBe(42);
    expect(attrs.n).toBe(7);
    expect(attrs.big).toBe("9007199254740993");
    expect(attrs.neg).toBe("-9007199254740993");
    expect(attrs.b).toBe(false);
    expect(attrs.d).toBe(0.5);
    for (const k of ["arr", "kv", "bytes", "bad"]) expect(k in attrs).toBe(false);
  });

  // Covers: R16
  test("scope name and attributes: resource < scope < record", () => {
    const body = {
      resourceLogs: [
        {
          resource: { attributes: [str("a", "res"), str("b", "res")] },
          scopeLogs: [
            {
              scope: { name: "my.scope", attributes: [str("b", "scope"), str("c", "scope")] },
              logRecords: [{ attributes: [str("c", "record")] }],
            },
          ],
        },
      ],
    };
    const { records } = flattenOtlp("logs", body, { now: NOW })!;
    expect(records[0]).toMatchObject({
      scope: "my.scope",
      service: null,
      attrs: { a: "res", b: "scope", c: "record" },
    });
  });

  // Covers: R16
  test("non-envelope bodies return null; malformed entries are discarded, not thrown", () => {
    expect(flattenOtlp("logs", null)).toBeNull();
    expect(flattenOtlp("logs", [])).toBeNull();
    expect(flattenOtlp("logs", { resourceSpans: [] })).toBeNull();
    expect(flattenOtlp("logs", { resourceLogs: "no" })).toBeNull();
    const body = { resourceLogs: [7, { scopeLogs: [null, { logRecords: [1, "x", {}] }] }] };
    expect(flattenOtlp("logs", body, { now: NOW })).toMatchObject({ discarded: 2 });
    expect(flattenOtlp("logs", { resourceLogs: [] })).toEqual({ records: [], discarded: 0 });
  });

  // Covers: R16
  test("hash is stable, order-insensitive over attributes, and differs when the record differs", () => {
    const a = flattenOtlp(
      "logs",
      logs({ timeUnixNano: "5000000", attributes: [str("x", "1"), str("y", "2")] }),
      { now: NOW },
    )!.records[0]!;
    const b = flattenOtlp(
      "logs",
      logs({ timeUnixNano: "5000000", attributes: [str("y", "2"), str("x", "1")] }),
      { now: NOW },
    )!.records[0]!;
    const c = flattenOtlp(
      "logs",
      logs({ timeUnixNano: "5000000", attributes: [str("x", "1"), str("y", "3")] }),
      { now: NOW },
    )!.records[0]!;
    expect(a.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
  });

  // Covers: R16
  test("__proto__ as an attribute key does not pollute", () => {
    const { records } = flattenOtlp("logs", logs({ attributes: [str("__proto__", "x")] }), {
      now: NOW,
    })!;
    expect(Object.getPrototypeOf(records[0]!.attrs)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(records[0]!.attrs)).toContain("__proto__");
  });
});

describe("flattenOtlp: traces", () => {
  const span = (extra: object) => ({
    resourceSpans: [
      {
        resource: { attributes: [str("service.name", "svc")] },
        scopeSpans: [
          {
            scope: { name: "sc" },
            spans: [
              {
                name: "claude_code.hook",
                startTimeUnixNano: "1767225600000000000",
                endTimeUnixNano: "1767225600250000000",
                attributes: [str("session.id", "s1")],
                ...extra,
              },
            ],
          },
        ],
      },
    ],
  });

  // Covers: R16
  test("span: name, start/end in ms, attributes, status by number or name", () => {
    const err = flattenOtlp("traces", span({ status: { code: 2 } }), { now: NOW })!.records[0]!;
    const ok = flattenOtlp("traces", span({ status: { code: "STATUS_CODE_OK" } }), { now: NOW })!
      .records[0]!;
    const unset = flattenOtlp("traces", span({}), { now: NOW })!.records[0]!;
    expect(err).toMatchObject({
      signal: "span",
      name: "claude_code.hook",
      ts: 1767225600000,
      endTs: 1767225600250,
      service: "svc",
      scope: "sc",
      status: "error",
      attrs: { "session.id": "s1" },
    });
    expect(ok.status).toBe("ok");
    expect(unset.status).toBe("unset");
  });

  // Covers: R16
  test("span without times falls back to now and has no endTs", () => {
    const body = { resourceSpans: [{ scopeSpans: [{ spans: [{ name: "x" }] }] }] };
    const rec = flattenOtlp("traces", body, { now: NOW })!.records[0]!;
    expect(rec.ts).toBe(NOW);
    expect("endTs" in rec).toBe(false);
  });
});

describe("flattenOtlp: metrics", () => {
  const body = {
    resourceMetrics: [
      {
        resource: { attributes: [str("service.name", "svc")] },
        scopeMetrics: [
          {
            metrics: [
              {
                name: "claude_code.token.usage",
                sum: {
                  aggregationTemporality: "AGGREGATION_TEMPORALITY_DELTA",
                  dataPoints: [
                    {
                      timeUnixNano: "1767225600000000000",
                      asInt: "1234",
                      attributes: [str("type", "input")],
                    },
                    { timeUnixNano: "1767225600000000000", asInt: "9007199254740993" },
                    { asDouble: "NaN" },
                    "bad",
                  ],
                },
              },
              {
                name: "claude_code.cost.usage",
                gauge: { dataPoints: [{ timeUnixNano: "1767225600000000000", asDouble: 0.0123 }] },
              },
              { name: "some.histogram", histogram: { dataPoints: [{ count: "1" }] } },
            ],
          },
        ],
      },
    ],
  };

  // Covers: R16
  test("one record per gauge/sum number point, with value and temporality; histograms are not flattened", () => {
    const { records, discarded } = flattenOtlp("metrics", body, { now: NOW })!;
    expect(records.map((r) => [r.name, r.value, r.temporality])).toEqual([
      ["claude_code.token.usage", 1234, "delta"],
      ["claude_code.token.usage", 9007199254740992, "delta"], // Number() of an int64 > 2^53 rounds; documented
      ["claude_code.cost.usage", 0.0123, undefined],
    ]);
    expect(records[0]).toMatchObject({
      signal: "metric",
      ts: 1767225600000,
      attrs: { type: "input" },
      service: "svc",
    });
    expect(discarded).toBe(2);
  });

  // Covers: R16
  test("cumulative temporality by number", () => {
    const b = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                { name: "m", sum: { aggregationTemporality: 2, dataPoints: [{ asInt: 1 }] } },
              ],
            },
          ],
        },
      ],
    };
    expect(flattenOtlp("metrics", b, { now: NOW })!.records[0]).toMatchObject({
      temporality: "cumulative",
      value: 1,
      ts: NOW,
    });
  });
});

describe("parseOtlpJson", () => {
  // Covers: R14
  test("parses an object; an empty body is an empty request", () => {
    expect(parseOtlpJson('{"resourceLogs":[]}')).toEqual({ resourceLogs: [] });
    expect(parseOtlpJson("  ")).toEqual({});
  });

  // Covers: R14
  test("rejects invalid JSON and non-objects with OtlpJsonError", () => {
    for (const bad of ["{", "[]", "1", "null", '"s"']) {
      expect(() => parseOtlpJson(bad)).toThrow(OtlpJsonError);
    }
  });
});
