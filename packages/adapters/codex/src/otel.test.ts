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
      // The spawn/send record is mapped (D19 B1, below); its `receive` and `result` siblings are not.
      if (r.name === "codex.agent_communication" && r.attrs.kind === "spawn") continue;
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

/** A `codex.agent_communication` record with only the attributes a test names. */
function comm(attrs: Record<string, string>): FlatOtelRecord {
  const base = records.find((x) => x.name === "codex.agent_communication");
  if (base === undefined) throw new Error("fixture has no codex.agent_communication");
  return { ...base, attrs };
}

describe("codex fromOtel: agent_communication spawn (D19 B1)", () => {
  const spawn = {
    kind: "spawn",
    state: "send",
    sender_thread_id: "rootT",
    receiver_thread_id: "kidT",
  };

  test("spawn/send -> one agent.start routed by the sender, keyed by the receiver", () => {
    // Covers: R19, R35
    const res = codexAdapter.fromOtel!(comm(spawn));
    expect(res).toEqual({
      ok: true,
      events: [
        {
          sessionId: "rootT",
          agentId: "kidT",
          parentAgentId: null,
          kind: "agent.start",
          ts: expect.any(Number),
          match: { key: "agent-start:kidT", mode: "exact" },
        },
      ],
    });
  });

  test("the same record twice maps to the same event (stateless, repeats are the store's dedupe)", () => {
    // Covers: R19, R35
    const r = comm(spawn);
    expect(codexAdapter.fromOtel!(r)).toEqual(codexAdapter.fromOtel!(r));
  });

  test("kind=result, state=receive and other kinds map to nothing", () => {
    // Covers: R19, R35
    for (const attrs of [
      { ...spawn, kind: "result" },
      { ...spawn, state: "receive" },
      { ...spawn, kind: "interrupt" },
      { state: "receive" },
    ]) {
      expect(codexAdapter.fromOtel!(comm(attrs))).toEqual({ ok: true, events: [] });
    }
  });

  test("a spawn without both thread ids is unattributable", () => {
    // Covers: R19, R35
    const { receiver_thread_id: _r, ...noReceiver } = spawn;
    const { sender_thread_id: _s, ...noSender } = spawn;
    for (const attrs of [noReceiver, noSender]) {
      expect(codexAdapter.fromOtel!(comm(attrs))).toMatchObject({
        ok: false,
        reason: "unattributable",
      });
    }
  });

  test("the content attribute never reaches the output (D17)", () => {
    // Covers: R19, R35
    const res = codexAdapter.fromOtel!(comm({ ...spawn, content: "SENTINEL-SECRET-PROMPT" }));
    expect(JSON.stringify(res)).not.toContain("SENTINEL-SECRET-PROMPT");
  });

  test("order tripwire: on the 0.158.0 capture each receiver's spawn precedes its mapped records", () => {
    // Covers: R19, R35
    // [SIN VERIFICAR] one captured export: fails only if the mapper or the fixture changes.
    const body: unknown = JSON.parse(
      readFileSync(join(FIXTURE, "..", "..", "codex", "0.158.0", "otlp-logs.jsonl"), "utf8"),
    );
    const capture = flattenOtlp("logs", body);
    if (capture === null) throw new Error("capture is not an OTLP logs body");
    const all = capture.records;
    const spawns = all
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.attrs.kind === "spawn" && r.attrs.state === "send");
    expect(spawns.length).toBeGreaterThan(0);
    for (const { r, i } of spawns) {
      const receiver = String(r.attrs.receiver_thread_id);
      const firstMapped = all.findIndex((x, j) => {
        if (j === i || x.attrs["conversation.id"] !== receiver) return false;
        const out = codexAdapter.fromOtel!(x);
        return out.ok && out.events.length > 0;
      });
      expect(firstMapped).toBeGreaterThan(i);
    }
  });
});
