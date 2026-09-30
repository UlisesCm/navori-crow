/**
 * Codex `fromOtel` over the real B0 capture (`fixtures/otlp/codex`): the four R19 events map to
 * `source = "otel"` candidates, everything else is ignored, and no content attribute survives (R24).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FlatOtelRecord, PartialCrowEvent } from "@crow/core";
import { flattenOtlp } from "../../../otlp/src/flatten";
import { codexAdapter } from "./adapter";

const FIXTURE = join(import.meta.dir, "..", "..", "..", "..", "fixtures", "otlp", "codex");

const flat = flattenOtlp("logs", JSON.parse(readFileSync(join(FIXTURE, "logs.json"), "utf8")));
if (flat === null) throw new Error("fixture is not an OTLP logs body");
const records: FlatOtelRecord[] = flat.records;

function named(name: string, kind?: string): FlatOtelRecord {
  const r = records.find(
    (x) => x.name === name && (kind === undefined || x.attrs["event.kind"] === kind),
  );
  if (r === undefined) throw new Error(`fixture has no ${name}`);
  return r;
}

function map(record: FlatOtelRecord): PartialCrowEvent[] {
  const res = codexAdapter.fromOtel!(record);
  if (!res.ok) throw new Error(`did not map: ${res.detail ?? ""}`);
  return res.events;
}

describe("codex fromOtel: R19 events on the B0 capture", () => {
  test("every record of the capture is owned by Codex", () => {
    // Covers: R19
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) expect(codexAdapter.ownsOtel!(r)).toBe(true);
  });

  test("codex.sse_event response.completed -> usage candidate at session scope", () => {
    // Covers: R19
    const [ev, ...rest] = map(named("codex.sse_event", "response.completed"));
    expect(rest).toEqual([]);
    expect(ev).toMatchObject({
      kind: "usage",
      sessionId: "id0",
      otelUsage: { input: 12431, output: 0, cacheRead: 0, cacheCreation: 0, model: "gpt-6-astra" },
    });
    // Session scope: no per-call key (D6), and it is never a counted `usage`.
    expect(ev!.usageCallKey).toBeUndefined();
    expect(ev!.usage).toBeUndefined();
  });

  test("input excludes cached tokens, like the rollout's token_count", () => {
    // Covers: R19
    const r = { ...named("codex.sse_event", "response.completed") };
    const cached = {
      ...r,
      attrs: { ...r.attrs, input_token_count: 14854, cached_token_count: 12288 },
    };
    expect(map(cached)[0]!.otelUsage).toMatchObject({ input: 2566, cacheRead: 12288 });
  });

  test("other sse_event kinds are ignored", () => {
    // Covers: R19
    const r = named("codex.sse_event", "response.completed");
    expect(
      map({ ...r, attrs: { ...r.attrs, "event.kind": "response.output_text.delta" } }),
    ).toEqual([]);
  });

  test("codex.tool_decision -> tool.pre keyed by call_id with the verdict", () => {
    // Covers: R19
    const [ev] = map(named("codex.tool_decision"));
    expect(ev).toMatchObject({
      kind: "tool.pre",
      sessionId: "id0",
      tool: { name: "exec_command", callId: "id1", verdict: "allow", decisionSource: "Config" },
      match: { key: "tool-pre:id1", mode: "exact" },
    });
  });

  test("codex.tool_decision denied -> deny", () => {
    // Covers: R19
    const r = named("codex.tool_decision");
    expect(map({ ...r, attrs: { ...r.attrs, decision: "denied" } })[0]!.tool?.verdict).toBe("deny");
  });

  test("codex.tool_result -> tool.post keyed by call_id with the engine duration", () => {
    // Covers: R19
    const [ev] = map(named("codex.tool_result"));
    expect(ev).toMatchObject({
      kind: "tool.post",
      sessionId: "id0",
      tool: { name: "exec_command", callId: "id1", ok: true, ms: 194, msSource: "engine" },
      match: { key: "tool-post:id1", mode: "exact" },
    });
  });

  test("codex.tool_result with success=false -> tool.error without the output", () => {
    // Covers: R19, R24
    const r = named("codex.tool_result");
    const [ev] = map({ ...r, attrs: { ...r.attrs, success: false } });
    expect(ev!.kind).toBe("tool.error");
    expect(ev!.error?.message).not.toContain("«");
  });

  test("codex.api_request without a conversation (the /models fetch) is ignored, not an error", () => {
    // Covers: R19
    expect(codexAdapter.fromOtel!(named("codex.api_request"))).toEqual({ ok: true, events: [] });
  });

  test("codex.api_request with a conversation -> api.request with reported numbers", () => {
    // Covers: R19
    const r = named("codex.api_request");
    const [ev] = map({
      ...r,
      attrs: { ...r.attrs, "conversation.id": "id0", model: "gpt-6-astra" },
    });
    expect(ev).toMatchObject({
      kind: "api.request",
      sessionId: "id0",
      reported: { metric: "api_request", ms: 501, model: "gpt-6-astra" },
    });
    expect(ev!.otelUsage).toBeUndefined();
  });

  test("a mapped event without conversation.id is unattributable", () => {
    // Covers: R19
    const r = named("codex.tool_result");
    const { "conversation.id": _c, ...attrs } = r.attrs;
    expect(codexAdapter.fromOtel!({ ...r, attrs })).toMatchObject({
      ok: false,
      reason: "unattributable",
    });
  });

  test("known but unmapped records (prompt, ttft, websocket, startup) map to nothing", () => {
    // Covers: R19
    for (const r of records) {
      if (
        [
          "codex.api_request",
          "codex.sse_event",
          "codex.tool_decision",
          "codex.tool_result",
        ].includes(r.name)
      )
        continue;
      expect(codexAdapter.fromOtel!(r)).toEqual({ ok: true, events: [] });
    }
  });
});

describe("codex fromOtel: no content (R24)", () => {
  test("no event carries any string of the record's content attributes", () => {
    // Covers: R24
    const events = records.flatMap((r) => {
      const res = codexAdapter.fromOtel!(r);
      return res.ok ? res.events : [];
    });
    expect(events.length).toBeGreaterThan(0);
    const json = JSON.stringify(events);
    // Anonymized content is a «str:n» marker; ids of the fixture are plain pseudonyms.
    expect(json).not.toContain("«");
    for (const ev of events) expect(ev.text).toBeUndefined();
    for (const key of ["arguments", "prompt", "user.email", "mcp_servers"])
      expect(json).not.toContain(`"${key}"`);
  });

  test("ownership is by signature: foreign records are not owned", () => {
    // Covers: R19
    const foreign: FlatOtelRecord = { ...records[0]!, name: "user_prompt", service: "my-app" };
    expect(codexAdapter.ownsOtel!(foreign)).toBe(false);
  });
});
