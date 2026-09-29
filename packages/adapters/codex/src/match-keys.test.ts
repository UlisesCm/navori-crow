/**
 * Codex reconciliation and usage keys (F2a D6, § Claves nuevas en los mapas de línea de F1).
 * Codex has no per-call id shared with OTel (G4), so its usage stays session-scoped.
 */
import { describe, expect, test } from "bun:test";
import type { PartialCrowEvent } from "@crow/core";
import { initialCodexState, mapCodexLine, usageCallKey } from "./map-line";

const POS = { path: "/t/rollout.jsonl", offset: 0, line: 1 };

function map(line: object, started = true): PartialCrowEvent[] {
  const state = { ...initialCodexState("s1"), started };
  const result = mapCodexLine(JSON.stringify(line), state, POS);
  if (!result.ok) throw new Error(`line did not map: ${result.reason}`);
  return result.events;
}

const at = "2026-01-01T00:00:01.000Z";

describe("codex keys", () => {
  test("usageCallKey is always undefined: usage is session-scoped (no shared call id)", () => {
    // Covers: R12
    expect(usageCallKey()).toBeUndefined();
    const events = map({
      type: "event_msg",
      timestamp: at,
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
          last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
        },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.usage).toBeDefined();
    expect(events[0]!.usageCallKey).toBeUndefined();
    expect(events[0]!.match).toBeUndefined();
  });

  test("tool calls key on call_id; the session_meta of the root is session-start@main", () => {
    // Covers: R12
    const pre = map({
      type: "response_item",
      timestamp: at,
      payload: { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
    });
    expect(pre[0]!.match).toEqual({ key: "tool-pre:c1", mode: "exact" });

    const post = map({
      type: "response_item",
      timestamp: at,
      payload: { type: "function_call_output", call_id: "c1", output: "" },
    });
    expect(post[0]!.match).toEqual({ key: "tool-post:c1", mode: "exact" });

    const start = map(
      { type: "session_meta", timestamp: at, payload: { id: "s1", cwd: "/tmp/p" } },
      false,
    );
    expect(start[0]!.match).toEqual({ key: "session-start@main", mode: "exact" });
  });

  test("a prompt keys nearest (±10 s) with a fingerprint of its trimmed text", () => {
    // Covers: R12
    const prompt = (text: string): PartialCrowEvent =>
      map({
        type: "event_msg",
        timestamp: at,
        payload: {
          type: "item_completed",
          item: { type: "UserMessage", id: "i1", content: [{ text }] },
        },
      })[0]!;

    const a = prompt("  fix the bug \n");
    const b = prompt("fix the bug");
    const c = prompt("something else");
    expect(a.match).toMatchObject({ key: "prompt@main", mode: "nearest", windowMs: 10_000 });
    expect(a.match?.fingerprint).toMatch(/^[0-9a-f]{40}$/);
    expect(a.match?.fingerprint).toBe(b.match?.fingerprint);
    expect(a.match?.fingerprint).not.toBe(c.match?.fingerprint);
  });
});
