/**
 * Claude OTel map (R18, R24; usage keys per D6, match keys per D5) over the B0 captures in
 * `fixtures/otlp/claude` (flattened with the real `flattenOtlp`) plus synthetic records for the
 * beta hook span, which the capture did not include.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FlatOtelRecord, PartialCrowEvent } from "@crow/core";
import { flattenOtlp, parseOtlpJson } from "../../../otlp/src/index";
import { claudeAdapter } from "./adapter";
import { claudeFromOtel, claudeOwnsOtel } from "./otel";

const DIR = join(import.meta.dir, "../../../../fixtures/otlp/claude");

function load(signal: "logs" | "metrics" | "traces"): FlatOtelRecord[] {
  const body = parseOtlpJson(readFileSync(join(DIR, `${signal}.json`), "utf8"));
  const out = flattenOtlp(signal, body, { now: 0 });
  if (out === null) throw new Error(`fixture ${signal} is not an envelope`);
  return out.records;
}

const LOGS = load("logs");
const METRICS = load("metrics");
const TRACES = load("traces");

function events(r: FlatOtelRecord): PartialCrowEvent[] {
  const res = claudeFromOtel(r);
  if (!res.ok) throw new Error(`record did not map: ${res.reason}`);
  return res.events;
}

const log = (name: string): FlatOtelRecord => LOGS.find((r) => r.name === name)!;

describe("claude fromOtel: logs", () => {
  test("user_prompt maps to a prompt with the prompt@main key and no text", () => {
    // Covers: R18, R24
    const [e, ...rest] = events(log("user_prompt"));
    expect(rest).toHaveLength(0);
    expect(e!.kind).toBe("prompt");
    expect(e!.sessionId).toBe("id0");
    expect(e!.match).toEqual({ key: "prompt@main:id1", mode: "exact", role: "otel" });
    expect(e!.text).toBeUndefined();
    expect(e!.ts).toBe(log("user_prompt").ts);
  });

  test("tool_result maps to tool.post keyed by tool_use_id with the engine ms", () => {
    // Covers: R18
    const [e] = events(log("tool_result"));
    expect(e!.kind).toBe("tool.post");
    expect(e!.tool).toEqual({ name: "Read", callId: "id3", ok: true, ms: 12, msSource: "engine" });
    expect(e!.match).toEqual({ key: "tool-post:id3", mode: "exact", role: "otel" });
  });

  test("a failed tool_result maps to tool.error", () => {
    // Covers: R18
    const r = { ...log("tool_result"), attrs: { ...log("tool_result").attrs, success: "false" } };
    const [e] = events(r);
    expect(e!.kind).toBe("tool.error");
    expect(e!.tool?.ok).toBe(false);
    expect(e!.error?.message).toBe("tool failed");
  });

  test("tool_decision maps to tool.pre and permission with the mapped verdict and source", () => {
    // Covers: R18
    const [pre, perm] = events(log("tool_decision"));
    expect(pre!.kind).toBe("tool.pre");
    expect(pre!.tool).toEqual({
      name: "Read",
      callId: "id3",
      verdict: "allow",
      decisionSource: "config",
    });
    expect(pre!.match).toEqual({ key: "tool-pre:id3", mode: "exact", role: "otel" });
    expect(perm!.kind).toBe("permission");
    expect(perm!.permission).toEqual({ decision: "allow", decisionSource: "config" });
    expect(perm!.match).toEqual({ key: "permission:id3", mode: "exact", role: "otel" });
  });

  test("a rejected decision maps to deny", () => {
    // Covers: R18
    const r = {
      ...log("tool_decision"),
      attrs: { ...log("tool_decision").attrs, decision: "reject" },
    };
    expect(events(r)[0]!.tool?.verdict).toBe("deny");
  });

  test("tool_result and tool_decision without tool_use_id are ignored (D5)", () => {
    // Covers: R18
    for (const name of ["tool_result", "tool_decision"]) {
      const { tool_use_id: _drop, ...attrs } = log(name).attrs;
      expect(events({ ...log(name), attrs })).toEqual([]);
    }
  });

  test("api_request maps to api.request with reported, otelUsage and the req: call key, without a match", () => {
    // Covers: R18, R12
    const [e] = events(log("api_request"));
    expect(e!.kind).toBe("api.request");
    expect(e!.usageCallKey).toBe("req:id4");
    expect(e!.otelUsage).toEqual({
      input: 10,
      output: 1110,
      cacheRead: 25504,
      cacheCreation: 0,
      model: "claude-haiku-4-5-20251001",
    });
    expect(e!.reported).toMatchObject({ costUsd: 0.0081104, ms: 10161, input: 10, output: 1110 });
    expect(e!.usage).toBeUndefined();
    expect(e!.match).toBeUndefined();
  });

  test("api_request without request_id carries no usage candidate", () => {
    // Covers: R12
    const { request_id: _drop, ...attrs } = log("api_request").attrs;
    const [e] = events({ ...log("api_request"), attrs });
    expect(e!.otelUsage).toBeUndefined();
    expect(e!.usageCallKey).toBeUndefined();
    expect(e!.reported?.input).toBe(10);
  });

  test("unmapped Claude logs are owned but map to nothing", () => {
    // Covers: R18
    for (const name of ["assistant_response", "hook_execution_start", "plugin_loaded"]) {
      expect(claudeOwnsOtel(log(name))).toBe(true);
      expect(events(log(name))).toEqual([]);
    }
  });

  test("a record without session.id is unattributable", () => {
    // Covers: R18
    const { "session.id": _drop, ...attrs } = log("user_prompt").attrs;
    const res = claudeFromOtel({ ...log("user_prompt"), attrs });
    expect(res.ok).toBe(false);
  });
});

describe("claude fromOtel: metrics", () => {
  test("token.usage maps to a reported-only usage event by type", () => {
    // Covers: R18, R12
    const points = METRICS.filter((r) => r.name === "claude_code.token.usage");
    const evs = points.map((r) => events(r)[0]!);
    expect(evs.map((e) => e.reported?.byType)).toEqual([
      { input: 44 },
      { output: 2184 },
      { cacheRead: 133519 },
      { cacheCreation: 3143 },
    ]);
    for (const e of evs) {
      expect(e.kind).toBe("usage");
      expect(e.usage).toBeUndefined();
      expect(e.otelUsage).toBeUndefined();
      expect(e.match).toBeUndefined();
      expect(e.reported).toMatchObject({
        metric: "token.usage",
        temporality: "delta",
        model: "claude-haiku-4-5-20251001",
      });
    }
  });

  test("cost.usage maps to reported.costUsd, never to counted usage", () => {
    // Covers: R18, R12
    const [e] = events(METRICS.find((r) => r.name === "claude_code.cost.usage")!);
    expect(e!.kind).toBe("usage");
    expect(e!.reported).toMatchObject({ metric: "cost.usage", costUsd: 0.03052465 });
    expect(e!.usage).toBeUndefined();
    expect(e!.otelUsage).toBeUndefined();
  });

  test("other claude_code metrics and zero points are ignored", () => {
    // Covers: R18
    const count = METRICS.find((r) => r.name === "claude_code.session.count")!;
    expect(claudeOwnsOtel(count)).toBe(true);
    expect(events(count)).toEqual([]);
    const zero = { ...METRICS.find((r) => r.name === "claude_code.cost.usage")!, value: 0 };
    expect(events(zero)).toEqual([]);
  });
});

describe("claude fromOtel: traces", () => {
  const hookSpan = (extra: Record<string, string | number | boolean>): FlatOtelRecord => ({
    signal: "span",
    name: "claude_code.hook",
    ts: 1000,
    endTs: 1250,
    attrs: {
      "session.id": "id7",
      hook_event: "PreToolUse",
      hook_name: "PreToolUse:Write",
      num_hooks: 2,
      duration_ms: 250,
      num_blocking: 1,
      ...extra,
    },
    service: "claude-code",
    scope: "com.anthropic.claude_code.tracing",
    status: "unset",
    hash: "h",
  });

  test("hook span maps to an aggregate hook event", () => {
    // Covers: R18
    const r = hookSpan({});
    expect(claudeOwnsOtel(r)).toBe(true);
    const [e] = events(r);
    expect(e!.kind).toBe("hook");
    expect(e!.hook).toEqual({
      name: "PreToolUse:Write",
      phase: "PreToolUse",
      aggregate: true,
      blocking: true,
      ms: 250,
    });
    expect(e!.match).toBeUndefined();
    expect(events(hookSpan({ num_blocking: "0" }))[0]!.hook?.blocking).toBe(false);
  });

  test("the captured non-hook spans are owned and ignored", () => {
    // Covers: R18
    for (const r of TRACES) {
      expect(claudeOwnsOtel(r)).toBe(true);
      expect(events(r)).toEqual([]);
    }
  });
});

describe("claude fromOtel: ownership and privacy", () => {
  test("foreign records are not owned", () => {
    // Covers: R18
    const foreign: FlatOtelRecord = {
      signal: "log",
      name: "request",
      ts: 0,
      attrs: { "session.id": "x" },
      service: "my-app",
      scope: "app",
      hash: "h",
    };
    expect(claudeOwnsOtel(foreign)).toBe(false);
    expect(claudeOwnsOtel({ ...foreign, signal: "metric", name: "http.requests" })).toBe(false);
    // Session-less Claude log: not owned (R17 handles it as unattributable).
    const { "session.id": _drop, ...attrs } = log("user_prompt").attrs;
    expect(claudeOwnsOtel({ ...log("user_prompt"), attrs })).toBe(false);
  });

  test("content attributes never reach an event, even when a flag leaks them into the record", () => {
    // Covers: R24
    const leak = {
      prompt: "SECRET-PROMPT",
      tool_input: "SECRET-INPUT",
      tool_parameters: "SECRET-PARAMS",
      response: "SECRET-RESPONSE",
      "user.email": "SECRET-EMAIL",
      "organization.id": "SECRET-ORG",
      error: "SECRET-ERROR",
      bash_command_class: "SECRET-CMD",
    };
    const records = [...LOGS, ...METRICS, ...TRACES].map((r) => ({
      ...r,
      attrs: { ...r.attrs, ...leak },
    }));
    const all = records.flatMap((r) => (claudeOwnsOtel(r) ? events(r) : []));
    expect(all.length).toBeGreaterThan(0);
    expect(JSON.stringify(all)).not.toContain("SECRET-");
  });

  test("the adapter exposes ownsOtel and fromOtel", () => {
    // Covers: R18
    expect(claudeAdapter.ownsOtel).toBe(claudeOwnsOtel);
    expect(claudeAdapter.fromOtel).toBe(claudeFromOtel);
  });
});
