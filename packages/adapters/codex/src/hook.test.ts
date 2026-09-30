/**
 * Codex `fromHook` over the real B0 captures (`fixtures/codex/hooks`, G2) plus synthetic cases for the
 * three events B0 could not reproduce (`PermissionRequest`, `PreCompact`, `PostCompact`).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HookResult, PartialCrowEvent } from "@crow/core";
import { codexAdapter } from "./adapter";
import { initialCodexState, mapCodexLine } from "./map-line";

const DIR = join(import.meta.dir, "..", "..", "..", "..", "fixtures", "codex", "hooks");
const RECEIVED = 1_700_000_000_000;

function capture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")) as Record<string, unknown>;
}

function run(body: unknown): HookResult {
  return codexAdapter.fromHook!({ body, receivedAt: RECEIVED });
}

function events(body: unknown): PartialCrowEvent[] {
  const r = run(body);
  if (!r.ok) throw new Error(`hook did not map: ${r.reason} ${r.detail ?? ""}`);
  return r.events;
}

function one(body: unknown): PartialCrowEvent {
  const evs = events(body);
  expect(evs).toHaveLength(1);
  return evs[0]!;
}

describe("codex fromHook: real captures (R9, R10)", () => {
  test("SessionStart -> session.start on the root thread, keyed session-start@main", () => {
    // Covers: R9, R10
    const ev = one(capture("SessionStart"));
    expect(ev).toMatchObject({
      kind: "session.start",
      sessionId: "id0",
      agentId: null,
      cwd: "/tmp/crow-fixture/b0-toy",
      ts: RECEIVED,
      match: { key: "session-start@main", mode: "exact" },
    });
  });

  test("SessionStart with source resume has no key; compact restarts emit nothing", () => {
    // Covers: R9, R13
    expect(one({ ...capture("SessionStart"), source: "resume" }).match).toBeUndefined();
    expect(events({ ...capture("SessionStart"), source: "compact" })).toEqual([]);
  });

  test("SessionEnd -> session.end without a match key", () => {
    // Covers: R9
    const ev = one(capture("SessionEnd"));
    expect(ev.kind).toBe("session.end");
    expect(ev.sessionId).toBe("id0");
    expect(ev.match).toBeUndefined();
  });

  test("UserPromptSubmit -> prompt with nearest match and a text fingerprint", () => {
    // Covers: R9, R13
    const ev = one(capture("UserPromptSubmit"));
    expect(ev.kind).toBe("prompt");
    expect(ev.text).toBe("«str:0»");
    expect(ev.agentId).toBeNull();
    expect(ev.match).toMatchObject({
      key: "prompt@main",
      mode: "nearest",
      windowMs: 10_000,
    });
    expect(ev.match?.fingerprint).toMatch(/^[0-9a-f]{40}$/);
  });

  test("the hook prompt and the rollout prompt carry the same match spec (one fact across lanes)", () => {
    // Covers: R13
    const text = "fix the bug";
    const hook = one({ ...capture("UserPromptSubmit"), prompt: `${text}\n` });
    const line = JSON.stringify({
      type: "event_msg",
      timestamp: "2026-01-01T00:00:01.000Z",
      payload: {
        type: "item_completed",
        item: { type: "UserMessage", id: "i1", content: [{ text }] },
      },
    });
    const mapped = mapCodexLine(
      line,
      { ...initialCodexState("id0"), started: true },
      { path: "/t/r.jsonl", offset: 0, line: 1 },
    );
    if (!mapped.ok) throw new Error("rollout line did not map");
    expect(mapped.events[0]!.match).toEqual(hook.match!);
  });

  test("PreToolUse -> tool.pre keyed by the exec-<id> tool_use_id, agent main", () => {
    // Covers: R9, R10
    const ev = one(capture("PreToolUse"));
    expect(ev).toMatchObject({
      kind: "tool.pre",
      agentId: null,
      tool: { name: "Bash", callId: "id2", input: { command: "«str:1»" } },
      match: { key: "tool-pre:id2", mode: "exact" },
    });
  });

  test("PostToolUse -> tool.post allow, never carrying tool_response", () => {
    // Covers: R9
    const ev = one(capture("PostToolUse"));
    expect(ev.kind).toBe("tool.post");
    expect(ev.tool).toMatchObject({
      name: "Bash",
      callId: "id2",
      ok: true,
      verdict: "allow",
    });
    expect(ev.match).toEqual({ key: "tool-post:id2", mode: "exact" });
    expect(JSON.stringify(ev)).not.toContain("«str:3»");
  });

  test("PostToolUse with an error string -> tool.error, message capped at 1 KiB", () => {
    // Covers: R9
    const ev = one({ ...capture("PostToolUse"), error: "x".repeat(5000) });
    expect(ev.kind).toBe("tool.error");
    expect(ev.tool).toMatchObject({ ok: false, verdict: "error" });
    expect(ev.error?.message).toHaveLength(1024);
    expect(ev.match?.key).toBe("tool-post:id2");
  });

  test("PostToolUse duration_ms becomes the engine's own ms", () => {
    // Covers: R9
    const ev = one({ ...capture("PostToolUse"), duration_ms: 42 });
    expect(ev.tool).toMatchObject({ ms: 42, msSource: "engine" });
  });

  test("a large tool_input is trimmed to a bounded string", () => {
    // Covers: R9
    const ev = one({
      ...capture("PreToolUse"),
      tool_input: { command: "y".repeat(10_000) },
    });
    const trimmed = ev.tool?.input;
    expect(typeof trimmed).toBe("string");
    expect(String(trimmed)).toHaveLength(4096);
  });

  test("SubagentStart -> agent.start for the child, session stays the root (G2)", () => {
    // Covers: R9, R10, R13
    const ev = one(capture("SubagentStart"));
    expect(ev).toMatchObject({
      kind: "agent.start",
      sessionId: "id0",
      agentId: "id4",
      agent: { type: "default" },
      match: { key: "agent-start:id4", mode: "exact" },
    });
  });

  test("SubagentStop -> agent.stop for the child; last_assistant_message is never kept", () => {
    // Covers: R9, R10, R13
    const ev = one(capture("SubagentStop"));
    expect(ev).toMatchObject({
      kind: "agent.stop",
      sessionId: "id0",
      agentId: "id4",
      match: { key: "agent-stop:id4", mode: "exact" },
    });
    expect(JSON.stringify(ev)).not.toContain("«str:4»");
  });

  test("a tool hook fired inside a subagent is attributed to its agent_id", () => {
    // Covers: R10
    expect(one({ ...capture("PreToolUse"), agent_id: "id4" }).agentId).toBe("id4");
  });
});

describe("codex fromHook: synthetic cases (no B0 capture)", () => {
  const base = {
    session_id: "id0",
    cwd: "/tmp/crow-fixture/b0-toy",
    transcript_path: "/tmp/x/rollout-2026-01-01T00-00-00-id0.jsonl",
  };

  test("[synthetic] PermissionRequest -> permission ask, keyed by tool_use_id", () => {
    // Covers: R9
    const ev = one({
      ...base,
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "rm x" },
      tool_use_id: "exec-1",
    });
    expect(ev).toMatchObject({
      kind: "permission",
      permission: { decision: "ask" },
      tool: { name: "Bash", callId: "exec-1" },
      match: { key: "permission:exec-1", mode: "exact", role: "hook:request" },
    });
  });

  test("[synthetic] PermissionRequest without an id has no key", () => {
    // Covers: R9
    const ev = one({
      ...base,
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
    });
    expect(ev.match).toBeUndefined();
  });

  test("[synthetic] PreCompact / PostCompact -> compact with startedAt / endedAt and pre/post roles", () => {
    // Covers: R9, R13
    const pre = one({
      ...base,
      hook_event_name: "PreCompact",
      trigger: "auto",
    });
    expect(pre).toMatchObject({
      kind: "compact",
      compact: { trigger: "auto", startedAt: RECEIVED },
      match: {
        key: "compact@main",
        mode: "nearest",
        windowMs: 600_000,
        role: "hook:pre",
      },
    });
    const post = one({ ...base, hook_event_name: "PostCompact" });
    expect(post).toMatchObject({
      kind: "compact",
      compact: { endedAt: RECEIVED },
      match: { key: "compact@main", role: "hook:post" },
    });
  });
});

describe("codex fromHook: failures (R6)", () => {
  test("an unknown event name is unknown-type with the session attributed", () => {
    // Covers: R6
    const r = run({ session_id: "id0", hook_event_name: "Stop" });
    expect(r).toMatchObject({
      ok: false,
      reason: "unknown-type",
      sessionId: "id0",
    });
  });

  test("non-object bodies and missing names are bad-shape; a missing session is unattributable", () => {
    // Covers: R6
    expect(run("nope")).toMatchObject({
      ok: false,
      reason: "bad-shape",
      sessionId: null,
    });
    expect(run({ session_id: "id0" })).toMatchObject({
      ok: false,
      reason: "bad-shape",
    });
    expect(run({ hook_event_name: "SessionStart" })).toMatchObject({
      ok: false,
      reason: "unattributable",
    });
  });

  test("SubagentStart/Stop without agent_id are bad-shape", () => {
    // Covers: R6
    for (const name of ["SubagentStart", "SubagentStop"]) {
      expect(run({ session_id: "id0", hook_event_name: name })).toMatchObject({
        ok: false,
        reason: "bad-shape",
      });
    }
  });

  test("every mapped event is stamped by the pipeline later: none carries engine, source or id", () => {
    // Covers: R9
    const ev = one(capture("PreToolUse")) as Record<string, unknown>;
    for (const k of ["id", "engine", "source", "projectKey", "projectPath", "seq"])
      expect(k in ev).toBe(false);
  });
});
