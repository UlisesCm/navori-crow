/**
 * `anonymizeOtlp` on SYNTHETIC OTLP/JSON bodies (never real captures): allowlisted names, attribute
 * keys and enums survive; identity/content attributes become markers; ids share pseudonyms with the
 * hook and transcript anonymizers; trace/span ids stay valid, consistent hex; instants shift by one
 * offset; value types and numbers are untouched; `verifyOtlpBody` flags anything else.
 */
import { describe, expect, test } from "bun:test";
import type { Rec } from "@crow/core";
import { anonymizeHookPayload } from "./hooks";
import {
  anonymizeOtlp,
  mergeAndTrimLogs,
  mergeFirstPerName,
  minOtlpTimeMs,
  verifyOtlpBody,
} from "./otlp";
import { FixtureContext, IdRegistry, offsetToEpoch } from "./shared";

const SECRET = "SENTINEL_secret_text with spaces";
const T0 = 1_800_000_000_000; // ms

const s = (key: string, v: string): Rec => ({ key, value: { stringValue: v } });
const i = (key: string, v: number): Rec => ({ key, value: { intValue: String(v) } });

function logRecord(event: string, attrs: Rec[], ms = T0): Rec {
  return {
    timeUnixNano: `${BigInt(ms) * 1_000_000n + 123n}`,
    observedTimeUnixNano: `${BigInt(ms) * 1_000_000n + 456n}`,
    body: { stringValue: `claude_code.${event}` },
    attributes: [
      s("event.name", event),
      s("event.timestamp", new Date(ms).toISOString()),
      s("user.email", "someone@example.com"),
      s("user.id", "raw-user"),
      s("terminal.type", "SecretTerminal"),
      s("session.id", "raw-session-1"),
      i("event.sequence", 3),
      ...attrs,
    ],
    droppedAttributesCount: 0,
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "0123456789abcdef",
  };
}

function logsBody(records: Rec[]): Rec {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            s("service.name", "claude-code"),
            s("service.version", "2.1.285"),
            s("host.arch", "arm64"),
          ],
        },
        scopeLogs: [
          {
            scope: { name: "com.anthropic.claude_code.events", version: "2.1.285" },
            logRecords: records,
          },
        ],
      },
    ],
  };
}

const toolResult = (): Rec =>
  logRecord("tool_result", [
    s("prompt.id", "raw-prompt-1"),
    s("tool_name", "Bash"),
    s("tool_use_id", "raw-tool-1"),
    s("success", "true"),
    s("duration_ms", "42"),
    s("tool_input", SECRET),
    s("bash_argv0", SECRET),
    s(SECRET, SECRET),
  ]);

function anon(body: Rec, ctx = new FixtureContext("demo")): Rec {
  return anonymizeOtlp(body, ctx);
}

function attrsOf(record: unknown): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (const kv of (record as Rec).attributes as Rec[]) m.set(kv.key as string, kv.value);
  return m;
}

function firstRecord(body: Rec): Rec {
  const rl = (body.resourceLogs as Rec[])[0]!;
  return ((rl.scopeLogs as Rec[])[0]!.logRecords as Rec[])[0]!;
}

describe("anonymizeOtlp: logs", () => {
  test("keeps allowlisted names/enums, pseudonymizes ids, markers for identity and content", () => {
    // Covers: B0.T2 (G3/G4)
    const out = anon(logsBody([toolResult()]));
    const rec = firstRecord(out);
    const a = attrsOf(rec);
    expect(rec.body).toEqual({ stringValue: "claude_code.tool_result" });
    expect(a.get("event.name")).toEqual({ stringValue: "tool_result" });
    expect(a.get("tool_name")).toEqual({ stringValue: "Bash" });
    expect(a.get("success")).toEqual({ stringValue: "true" });
    expect(a.get("duration_ms")).toEqual({ stringValue: "42" });
    expect(a.get("event.sequence")).toEqual({ intValue: "3" });
    expect(a.get("session.id")).toEqual({ stringValue: "id0" });
    expect((a.get("user.email") as Rec).stringValue).toMatch(/^«str:/);
    expect((a.get("terminal.type") as Rec).stringValue).toMatch(/^«str:/);
    expect((a.get("tool_input") as Rec | undefined)?.stringValue ?? "«str:x»").toMatch(/^«str:/);
    const text = JSON.stringify(out);
    for (const leak of [
      "SENTINEL",
      "someone@example.com",
      "raw-user",
      "SecretTerminal",
      "raw-session-1",
      "raw-tool-1",
    ]) {
      expect(text).not.toContain(leak);
    }
    expect(verifyOtlpBody(out)).toEqual([]);
  });

  test("unknown attribute keys become key markers and their values markers", () => {
    // Covers: B0.T2
    const out = anon(logsBody([toolResult()]));
    const keys = [...attrsOf(firstRecord(out)).keys()];
    expect(keys.some((k) => /^«key:\d+»$/.test(k))).toBe(true);
  });

  test("instants shift by ONE offset: ordering/deltas survive; event.timestamp shifts too", () => {
    // Covers: B0.T2
    const body = logsBody([
      logRecord("api_request", [], T0),
      logRecord("api_request", [], T0 + 2500),
    ]);
    const offset = offsetToEpoch(minOtlpTimeMs(body), "2026-01-01T00:00:00.000Z");
    const out = anon(body, new FixtureContext("demo", new IdRegistry(), offset));
    const recs = ((out.resourceLogs as Rec[])[0]!.scopeLogs as Rec[])[0]!.logRecords as Rec[];
    const t = recs.map((r) => BigInt(r.timeUnixNano as string));
    expect(t[1]! - t[0]!).toBe(2_500_000_000n);
    expect(t[0]).toBe(BigInt(Date.parse("2026-01-01T00:00:00.000Z")) * 1_000_000n + 123n);
    expect(attrsOf(recs[0]).get("event.timestamp")).toEqual({
      stringValue: "2026-01-01T00:00:00.000Z",
    });
    expect(attrsOf(recs[1]).get("event.timestamp")).toEqual({
      stringValue: "2026-01-01T00:00:02.500Z",
    });
  });

  test("trace/span ids map consistently to valid fake hex of the same length", () => {
    // Covers: B0.T2
    const out = anon(logsBody([toolResult(), toolResult()]));
    const recs = ((out.resourceLogs as Rec[])[0]!.scopeLogs as Rec[])[0]!.logRecords as Rec[];
    expect(recs[0]!.traceId).toBe(recs[1]!.traceId);
    expect(recs[0]!.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(recs[0]!.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(recs[0]!.traceId).not.toMatch(/^0+$/);
  });

  test("unknown names and unknown string fields are markers; value types are preserved", () => {
    // Covers: B0.T2
    const rec = logRecord("not_a_known_event", [
      { key: "response_length", value: { intValue: "5" } },
      { key: "cost_usd", value: { doubleValue: 0.25 } },
      { key: "is_plugin", value: { boolValue: true } },
      {
        key: "managed_settings.sources",
        value: { arrayValue: { values: [{ stringValue: SECRET }] } },
      },
    ]);
    rec.body = { stringValue: SECRET };
    rec.someNewField = SECRET;
    const out = anon(logsBody([rec]));
    const r = firstRecord(out);
    const a = attrsOf(r);
    expect((r.body as Rec).stringValue).toMatch(/^«str:/);
    expect(r.someNewField).toMatch(/^«str:/);
    expect((a.get("event.name") as Rec).stringValue).toMatch(/^«str:/);
    expect(a.get("cost_usd")).toEqual({ doubleValue: 0.25 });
    expect(a.get("is_plugin")).toEqual({ boolValue: true });
    expect(a.get("response_length")).toEqual({ intValue: "5" });
    const arr = ((a.get("managed_settings.sources") as Rec).arrayValue as Rec).values as Rec[];
    expect(arr[0]!.stringValue).toMatch(/^«str:/);
    expect(verifyOtlpBody(out)).toEqual([]);
  });

  test("a body that is not an OTLP export request throws", () => {
    // Covers: B0.T2
    expect(() => anon({ hello: "world" })).toThrow();
  });
});

describe("anonymizeOtlp: metrics and traces", () => {
  test("metric names/units kept, description a marker, data-point attributes follow the key policy", () => {
    // Covers: B0.T2
    const body: Rec = {
      resourceMetrics: [
        {
          resource: { attributes: [s("service.name", "claude-code")] },
          scopeMetrics: [
            {
              scope: { name: "com.anthropic.claude_code", version: "2.1.285" },
              metrics: [
                {
                  name: "claude_code.token.usage",
                  description: SECRET,
                  unit: "tokens",
                  sum: {
                    aggregationTemporality: 1,
                    isMonotonic: true,
                    dataPoints: [
                      {
                        attributes: [
                          s("session.id", "raw-session-1"),
                          s("type", "input"),
                          s("user.id", "raw-user"),
                        ],
                        startTimeUnixNano: `${BigInt(T0) * 1_000_000n}`,
                        timeUnixNano: `${BigInt(T0 + 1000) * 1_000_000n}`,
                        asDouble: 7,
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const out = anon(body);
    const m = (((out.resourceMetrics as Rec[])[0]!.scopeMetrics as Rec[])[0]!.metrics as Rec[])[0]!;
    expect(m.name).toBe("claude_code.token.usage");
    expect(m.unit).toBe("tokens");
    expect(m.description).toMatch(/^«str:/);
    const dp = ((m.sum as Rec).dataPoints as Rec[])[0]!;
    expect(dp.asDouble).toBe(7);
    expect(attrsOf(dp).get("type")).toEqual({ stringValue: "input" });
    expect(attrsOf(dp).get("session.id")).toEqual({ stringValue: "id0" });
    expect(JSON.stringify(out)).not.toContain("SENTINEL");
    expect(verifyOtlpBody(out)).toEqual([]);
  });

  test("span names, links and parent ids: allowlisted names kept, ids consistent, events keep their name", () => {
    // Covers: B0.T2
    const body: Rec = {
      resourceSpans: [
        {
          resource: { attributes: [] },
          scopeSpans: [
            {
              scope: { name: "com.anthropic.claude_code.tracing", version: "1.0.0" },
              spans: [
                {
                  traceId: "aa".repeat(16),
                  spanId: "bb".repeat(8),
                  parentSpanId: "",
                  name: "claude_code.interaction",
                  kind: 1,
                  startTimeUnixNano: `${BigInt(T0) * 1_000_000n}`,
                  endTimeUnixNano: `${BigInt(T0 + 5) * 1_000_000n}`,
                  attributes: [
                    s("span.type", "interaction"),
                    s("user_prompt", SECRET),
                    i("user_prompt_length", 9),
                  ],
                  events: [{ name: "gen_ai.request.attempt", timeUnixNano: "5", attributes: [] }],
                  links: [{ traceId: "aa".repeat(16), spanId: "cc".repeat(8) }],
                  status: { code: 0 },
                  flags: 257,
                },
                {
                  traceId: "aa".repeat(16),
                  spanId: "cc".repeat(8),
                  parentSpanId: "bb".repeat(8),
                  name: SECRET,
                },
              ],
            },
          ],
        },
      ],
    };
    const out = anon(body);
    const spans = ((out.resourceSpans as Rec[])[0]!.scopeSpans as Rec[])[0]!.spans as Rec[];
    expect(spans[0]!.name).toBe("claude_code.interaction");
    expect(spans[0]!.parentSpanId).toBe("");
    expect(spans[1]!.parentSpanId).toBe(spans[0]!.spanId);
    expect(((spans[0]!.links as Rec[])[0] as Rec).spanId).toBe(spans[1]!.spanId);
    expect(spans[1]!.name).toMatch(/^«str:/);
    expect(spans[0]!.kind).toBe(1);
    expect(spans[0]!.flags).toBe(257);
    expect(JSON.stringify(out)).not.toContain("SENTINEL");
    expect(verifyOtlpBody(out)).toEqual([]);
  });
});

describe("cross-lane ids (G5a)", () => {
  test("same raw id → same pseudonym between hook and OTLP through one shared registry", () => {
    // Covers: B0.T3
    const ctx = new FixtureContext("demo", new IdRegistry());
    const hook = anonymizeHookPayload(
      {
        session_id: "raw-session-1",
        prompt_id: "raw-prompt-1",
        tool_use_id: "raw-tool-1",
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: {},
      },
      ctx,
    );
    const a = attrsOf(firstRecord(anon(logsBody([toolResult()]), ctx)));
    expect(a.get("tool_use_id")).toEqual({ stringValue: hook.tool_use_id });
    expect(a.get("prompt.id")).toEqual({ stringValue: hook.prompt_id });
    expect(a.get("session.id")).toEqual({ stringValue: hook.session_id });
  });
});

describe("verifyOtlpBody (post-condition)", () => {
  test("flags raw bodies by path, never by value", () => {
    // Covers: B0.T2 ("ningún string fuera de allowlist sobrevive")
    const problems = verifyOtlpBody(logsBody([toolResult()]));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).not.toContain("SENTINEL");
    expect(problems.join("\n")).not.toContain("someone@example.com");
    const ok = anon(logsBody([toolResult()]));
    const tampered = JSON.parse(JSON.stringify(ok).replace("«str:0»", "leaked free text")) as Rec;
    expect(verifyOtlpBody(tampered)).not.toEqual([]);
    expect(verifyOtlpBody({ hello: "x" })).not.toEqual([]);
  });
});

describe("trimming helpers", () => {
  test("mergeAndTrimLogs caps noisy events (or every event) per name and merges bodies", () => {
    // Covers: B0.T2
    const noisy = (): Rec => logRecord("hook_registered", []);
    const b1 = logsBody([noisy(), noisy(), toolResult()]);
    const b2 = logsBody([noisy(), toolResult()]);
    const count = (b: Rec): number =>
      (((b.resourceLogs as Rec[])[0]!.scopeLogs as Rec[])[0]!.logRecords as Rec[]).length;
    expect(count(mergeAndTrimLogs([b1, b2], 2, true))).toBe(4); // 2 noisy + 2 tool_result
    expect(count(mergeAndTrimLogs([b1, b2], 1, false))).toBe(2); // 1 per event
  });

  test("mergeFirstPerName keeps one metric per name and caps data points", () => {
    // Covers: B0.T2
    const metric = (name: string): Rec => ({
      name,
      sum: { dataPoints: [{ asDouble: 1 }, { asDouble: 2 }, { asDouble: 3 }] },
    });
    const body = (m: Rec[]): Rec => ({
      resourceMetrics: [{ resource: {}, scopeMetrics: [{ scope: { name: "x" }, metrics: m }] }],
    });
    const out = mergeFirstPerName(
      [body([metric("a"), metric("a")]), body([metric("b")])],
      "metrics",
      2,
    );
    const ms = ((out.resourceMetrics as Rec[])[0]!.scopeMetrics as Rec[])[0]!.metrics as Rec[];
    expect(ms.map((m) => m.name)).toEqual(["a", "b"]);
    expect((ms[0]!.sum as Rec).dataPoints as unknown[]).toHaveLength(2);
  });
});
