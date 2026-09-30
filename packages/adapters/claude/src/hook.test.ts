/**
 * `fromHook` of Claude (F2a B2.T3, R8, R10, R32) over the real B0 captures in
 * `fixtures/claude/hooks/`. `PermissionDenied` has no capture (B0 § Deuda): its case is SYNTHETIC.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HookResult, PartialCrowEvent } from "@crow/core";
import { claudeAdapter } from "./adapter";

const DIR = join(import.meta.dir, "../../../../fixtures/claude/hooks");
const T = 1_700_000_000_000;

function capture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")) as Record<string, unknown>;
}

function run(body: unknown): HookResult {
  const fromHook = claudeAdapter.fromHook;
  if (fromHook === undefined) throw new Error("claude adapter has no fromHook");
  return fromHook({ body, receivedAt: T });
}

function events(body: unknown): PartialCrowEvent[] {
  const r = run(body);
  if (!r.ok) throw new Error(`rejected: ${r.reason} ${r.detail ?? ""}`);
  return r.events;
}

function one(body: unknown): PartialCrowEvent {
  const list = events(body);
  expect(list).toHaveLength(1);
  return list[0]!;
}

describe("Claude fromHook, real B0 captures (R8)", () => {
  test("SessionStart/SessionEnd map to session.start (keyed) and session.end on main", () => {
    // Covers: R8
    const start = one(capture("SessionStart"));
    expect(start.kind).toBe("session.start");
    expect(start.agentId).toBeNull();
    expect(start.ts).toBe(T);
    expect(start.cwd).toBe("/tmp/crow-fixture/b0-toy");
    expect(start.match).toEqual({ key: "session-start@main", mode: "exact", role: "hook" });
    expect(one(capture("SessionEnd")).kind).toBe("session.end");
  });

  test("SessionStart resume gets a row without key; compact yields nothing", () => {
    // Covers: R8
    const resume = one({ ...capture("SessionStart"), source: "resume" });
    expect(resume.kind).toBe("session.start");
    expect(resume.match).toBeUndefined();
    expect(events({ ...capture("SessionStart"), source: "compact" })).toEqual([]);
  });

  test("UserPromptSubmit keys by prompt_id; without id there is no key", () => {
    // Covers: R8
    const e = one(capture("UserPromptSubmit"));
    expect(e.kind).toBe("prompt");
    expect(e.text).toBe("«str:1»");
    expect(e.match).toEqual({ key: "prompt@main:id1", mode: "exact", role: "hook" });
    const { prompt_id: _drop, ...noId } = capture("UserPromptSubmit");
    expect(one(noId).match).toBeUndefined();
  });

  test("PreToolUse / PostToolUse / PostToolUseFailure carry call id, keys, engine ms and never the response", () => {
    // Covers: R8
    const pre = one(capture("PreToolUse"));
    expect(pre.kind).toBe("tool.pre");
    expect(pre.tool).toMatchObject({
      name: "Read",
      callId: "id2",
      input: { file_path: "«str:2»" },
    });
    expect(pre.match?.key).toBe("tool-pre:id2");

    const post = one(capture("PostToolUse"));
    expect(post.kind).toBe("tool.post");
    expect(post.tool).toMatchObject({ ok: true, verdict: "allow", ms: 12, msSource: "engine" });
    expect(post.match?.key).toBe("tool-post:id2");
    expect(JSON.stringify(post)).not.toContain("tool_response");
    expect(JSON.stringify(post)).not.toContain("«str:6»");

    const fail = one(capture("PostToolUseFailure"));
    expect(fail.kind).toBe("tool.error");
    expect(fail.tool).toMatchObject({ ok: false, verdict: "error", ms: 4, msSource: "engine" });
    expect(fail.error?.message).toBe("«str:8»");
    expect(fail.match?.key).toBe("tool-post:id3");
  });

  test("PermissionRequest maps to permission ask; the capture has no tool_use_id so no key", () => {
    // Covers: R8
    const e = one(capture("PermissionRequest"));
    expect(e.kind).toBe("permission");
    expect(e.permission).toEqual({ decision: "ask" });
    expect(e.tool?.name).toBe("Bash");
    expect(e.match).toBeUndefined();
    const keyed = one({ ...capture("PermissionRequest"), tool_use_id: "tu1" });
    expect(keyed.match).toEqual({ key: "permission:tu1", mode: "exact", role: "hook:request" });
  });

  test("PermissionDenied (SYNTHETIC: no B0 capture) maps to permission deny plus tool.error deny", () => {
    // Covers: R8
    const list = events({
      session_id: "s1",
      cwd: "/tmp/p",
      hook_event_name: "PermissionDenied",
      tool_name: "Bash",
      tool_input: { command: "rm x" },
      tool_use_id: "tu9",
      reason: "denied by rule",
    });
    expect(list.map((e) => e.kind)).toEqual(["permission", "tool.error"]);
    expect(list[0]!.permission).toEqual({ decision: "deny", reason: "denied by rule" });
    expect(list[0]!.match).toEqual({ key: "permission:tu9", mode: "exact", role: "hook:denied" });
    expect(list[1]!.tool?.verdict).toBe("deny");
    expect(list[1]!.match?.key).toBe("tool-post:tu9");
  });

  test("SubagentStart/Stop attribute to the child; stop prefers the transcript basename", () => {
    // Covers: R8, R10
    const start = one(capture("SubagentStart"));
    expect(start).toMatchObject({
      kind: "agent.start",
      agentId: "id4",
      agent: { type: "general-purpose" },
    });
    expect(start.match?.key).toBe("agent-start:id4");

    const stop = one(capture("SubagentStop"));
    expect(stop).toMatchObject({ kind: "agent.stop", agentId: "id4" });
    expect(stop.match?.key).toBe("agent-stop:id4");
    expect(JSON.stringify(stop)).not.toContain("«str:11»");

    const renamed = one({ ...capture("SubagentStop"), agent_id: "other" });
    expect(renamed.agentId).toBe("id4");
    const { agent_transcript_path: _drop, ...noPath } = capture("SubagentStop");
    expect(one({ ...noPath, agent_id: "fallback" }).agentId).toBe("fallback");
  });

  test("PreCompact/PostCompact map to compact with started/ended and a nearest key per role", () => {
    // Covers: R8
    const pre = one(capture("PreCompact"));
    expect(pre.compact).toEqual({ trigger: "manual", startedAt: T });
    expect(pre.match).toEqual({
      key: "compact@main",
      mode: "nearest",
      windowMs: 600_000,
      role: "hook:pre",
    });
    const post = one(capture("PostCompact"));
    expect(post.compact).toEqual({ trigger: "manual", endedAt: T });
    expect(post.match?.role).toBe("hook:post");
    expect(JSON.stringify(post)).not.toContain("«str:13»");
  });

  test("InstructionsLoaded maps to instructions.loaded with the file path as text", () => {
    // Covers: R8
    const e = one(capture("InstructionsLoaded"));
    expect(e).toMatchObject({ kind: "instructions.loaded", text: "«str:0»", agentId: null });
    expect(e.match).toBeUndefined();
  });

  test("an unknown event name is unknown-type, attributed to its session", () => {
    // Covers: R8
    const r = run({ ...capture("SessionStart"), hook_event_name: "Whatever" });
    expect(r).toMatchObject({ ok: false, reason: "unknown-type", sessionId: "id0" });
  });
});

describe("Claude fromHook turn.end (R32)", () => {
  test("Stop is a normal turn end and never stores last_assistant_message", () => {
    // Covers: R32
    const e = one(capture("Stop"));
    expect(e.kind).toBe("turn.end");
    expect(e.turn).toEqual({ ok: true });
    expect(e.agentId).toBeNull();
    expect(e.match).toBeUndefined();
    expect(JSON.stringify(e)).not.toContain("«str:9»");
  });

  test("StopFailure carries the engine's error category", () => {
    // Covers: R32
    const e = one(capture("StopFailure"));
    expect(e.kind).toBe("turn.end");
    expect(e.turn).toEqual({ ok: false, category: "model_not_found" });
    expect(JSON.stringify(e)).not.toContain("«str:14»");
  });
});

describe("Claude fromHook attribution and rejection (R10)", () => {
  test("session and project come from the payload (session_id, cwd)", () => {
    // Covers: R10
    const e = one(capture("StopFailure"));
    expect(e.sessionId).toBe("id7");
    expect(e.cwd).toBe("/tmp/crow-fixture/b0-toy");
  });

  test("tools inside a subagent use agent_id, else subagent_id, else main", () => {
    // Covers: R10
    expect(one({ ...capture("PreToolUse"), agent_id: "a1" }).agentId).toBe("a1");
    expect(one({ ...capture("PreToolUse"), subagent_id: "a2" }).agentId).toBe("a2");
    expect(one({ ...capture("PreToolUse"), agent_id: "", subagent_id: "a3" }).agentId).toBe("a3");
    expect(one(capture("PreToolUse")).agentId).toBeNull();
  });

  test("a payload without session_id is unattributable; a non-object is bad-shape", () => {
    // Covers: R10
    const { session_id: _drop, ...noSession } = capture("PreToolUse");
    expect(run({ ...noSession, agent_id: "a1" })).toMatchObject({
      ok: false,
      reason: "unattributable",
      sessionId: null,
      agentId: "a1",
    });
    expect(run("nope")).toMatchObject({ ok: false, reason: "bad-shape" });
    expect(run({ session_id: "s" })).toMatchObject({
      ok: false,
      reason: "bad-shape",
      sessionId: "s",
    });
  });

  test("every mapped capture is main-thread or child-attributed without parent and never throws on junk", () => {
    // Covers: R8, R10
    for (const junk of [
      null,
      1,
      [],
      {},
      { session_id: 3 },
      { session_id: "s", hook_event_name: 4 },
    ]) {
      expect(run(junk).ok).toBe(false);
    }
  });
});
