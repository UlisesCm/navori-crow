/**
 * `anonymizeHookPayload` on SYNTHETIC payloads (never real captures): structural allowlist keys and
 * enums survive, ids get pseudonyms shared with the other lanes, paths/cwd are rewritten, free text
 * and `tool_input`/`tool_response` strings become markers, numbers/booleans are untouched, and
 * `verifyHookPayload` flags anything that did not go through the allowlist.
 */
import { describe, expect, test } from "bun:test";
import type { Rec } from "@crow/core";
import { anonymizeHookPayload, firstPerHookEvent, verifyHookPayload } from "./hooks";
import { FixtureContext, IdRegistry } from "./shared";

const SECRET = "SENTINEL_secret_text with spaces";

function base(event: string, extra: Rec = {}): Rec {
  return {
    session_id: "raw-session-1",
    transcript_path: "/Users/dev/.claude/projects/-Users-dev-projA/raw-session-1.jsonl",
    cwd: "/Users/dev/projA",
    prompt_id: "raw-prompt-1",
    hook_event_name: event,
    ...extra,
  };
}

function anon(payload: Rec, ctx = new FixtureContext("demo")): Rec {
  return anonymizeHookPayload(payload, ctx);
}

describe("anonymizeHookPayload", () => {
  test("keeps enumerated values, rewrites ids/cwd/paths, markers for free text", () => {
    // Covers: B0.T1 (R8)
    const out = anon(
      base("PreToolUse", {
        permission_mode: "acceptEdits",
        tool_name: "Bash",
        tool_use_id: "raw-tool-1",
        tool_input: { command: SECRET, timeout: 5, background: false },
        prompt: SECRET,
        duration_ms: 12,
      }),
    );
    expect(out.hook_event_name).toBe("PreToolUse");
    expect(out.permission_mode).toBe("acceptEdits");
    expect(out.tool_name).toBe("Bash");
    expect(out.cwd).toBe("/tmp/crow-fixture/demo");
    expect(out.session_id).toBe("id0");
    expect(out.transcript_path).toBe(
      "/tmp/crow-fixture/claude-home/projects/-tmp-crow-fixture-demo/id0.jsonl",
    );
    expect(out.tool_input).toEqual({ command: "«str:0»", timeout: 5, background: false });
    expect(out.prompt).toMatch(/^«str:\d+»$/);
    expect(out.duration_ms).toBe(12);
    expect(JSON.stringify(out)).not.toContain("SENTINEL");
    expect(JSON.stringify(out)).not.toContain("/Users/");
  });

  test("subagent transcript path is built from the pseudonymized session and agent ids", () => {
    // Covers: B0.T3 (G5a agent_id)
    const out = anon(
      base("SubagentStop", {
        agent_id: "raw-agent-1",
        agent_type: "general-purpose",
        agent_transcript_path:
          "/Users/dev/.claude/projects/x/raw-session-1/subagents/agent-raw-agent-1.jsonl",
        last_assistant_message: SECRET,
        background_tasks: [
          { id: "raw-task", type: "subagent", status: "running", description: SECRET },
        ],
      }),
    );
    expect(out.agent_id).toBe("id2");
    expect(out.agent_transcript_path).toBe(
      "/tmp/crow-fixture/claude-home/projects/-tmp-crow-fixture-demo/id0/subagents/agent-id2.jsonl",
    );
    const task = (out.background_tasks as Rec[])[0]!;
    expect(task.type).toBe("subagent");
    expect(task.status).toBe("running");
    expect(task.id).toMatch(/^id\d+$/);
    expect(task.description).toMatch(/^«str:/);
    expect(out.last_assistant_message).toMatch(/^«str:/);
  });

  test("inside tool_input/tool_response EVERY string is a marker, even under enum-looking keys", () => {
    // Covers: B0.T1
    const out = anon(
      base("PostToolUse", {
        tool_name: "Write",
        tool_input: { type: "SecretType", source: SECRET },
        tool_response: {
          status: "SecretStatus",
          nested: { tool_name: "Bash" },
          ok: true,
          list: ["a"],
        },
      }),
    );
    const s = JSON.stringify(out);
    expect(s).not.toContain("SecretType");
    expect(s).not.toContain("SecretStatus");
    expect(out.tool_name).toBe("Write");
    expect((out.tool_response as Rec).ok).toBe(true);
    expect(verifyHookPayload(out)).toEqual([]);
  });

  test("StopFailure.error is kept only while it is a snake_case category; other events' error is text", () => {
    // Covers: B0.T1
    expect(anon(base("StopFailure", { error: "model_not_found" })).error).toBe("model_not_found");
    expect(anon(base("StopFailure", { error: SECRET })).error).toMatch(/^«str:/);
    expect(anon(base("PostToolUseFailure", { error: "model_not_found" })).error).toMatch(/^«str:/);
  });

  test("an enum key holding a non-token value, or an unknown event name, becomes a marker", () => {
    // Covers: B0.T1
    expect(anon(base("Stop", { reason: SECRET })).reason).toMatch(/^«str:/);
    expect(anon(base("Nope")).hook_event_name).toMatch(/^«str:/);
  });

  test("non-identifier keys become key markers; unknown keys' strings become markers; null/number stay", () => {
    // Covers: B0.T1
    const out = anon(
      base("Stop", { [`key with spaces ${SECRET}`]: "v", custom_instructions: null, n: 3 }),
    );
    expect(Object.keys(out).some((k) => k.includes("SENTINEL"))).toBe(false);
    expect(Object.keys(out)).toContain("«key:0»");
    expect(out.custom_instructions).toBeNull();
    expect(out.n).toBe(3);
  });

  test("same raw id → same pseudonym across payloads (and across lanes through a shared registry)", () => {
    // Covers: B0.T3 (G5a)
    const ctx = new FixtureContext("demo", new IdRegistry());
    const a = anon(
      base("PreToolUse", { tool_use_id: "raw-tool-1", tool_name: "Bash", tool_input: {} }),
      ctx,
    );
    const b = anon(
      base("PostToolUse", { tool_use_id: "raw-tool-1", tool_name: "Bash", tool_input: {} }),
      ctx,
    );
    const c = anon(
      base("PostToolUse", { tool_use_id: "raw-tool-2", tool_name: "Bash", tool_input: {} }),
      ctx,
    );
    expect(a.tool_use_id).toBe(b.tool_use_id);
    expect(a.tool_use_id).not.toBe(c.tool_use_id);
    expect(a.session_id).toBe(c.session_id);
    expect(ctx.ids.pseudonymize("raw-tool-1")).toBe(a.tool_use_id as string);
  });

  test("deterministic", () => {
    // Covers: B0.T1
    const p = base("PostToolUse", {
      tool_name: "Bash",
      tool_input: { command: SECRET },
      tool_use_id: "t",
    });
    expect(anon(p)).toEqual(anon(p));
  });
});

describe("verifyHookPayload (post-condition)", () => {
  test("accepts anonymizer output and lists paths — never values — for anything else", () => {
    // Covers: B0.T1 ("ningún string fuera de allowlist sobrevive")
    const ok = anon(
      base("PostToolUse", { tool_name: "Bash", tool_input: { c: SECRET }, tool_use_id: "t" }),
    );
    expect(verifyHookPayload(ok)).toEqual([]);

    const raw = base("PostToolUse", {
      tool_name: "Bash",
      tool_use_id: "t",
      last_assistant_message: SECRET,
    });
    const problems = verifyHookPayload(raw);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).not.toContain("SENTINEL");
    expect(problems.join("\n")).not.toContain("/Users/");
    expect(verifyHookPayload({ ...ok, extra: SECRET })).not.toEqual([]);
    expect(verifyHookPayload({ ...ok, cwd: "/Users/dev/x" })).not.toEqual([]);
    expect(verifyHookPayload({ ...ok, [`raw key ${SECRET}`]: 1 })).not.toEqual([]);
  });
});

describe("firstPerHookEvent", () => {
  test("keeps the first payload of each event in input order", () => {
    // Covers: B0.T1
    const a = base("Stop", { n: 1 });
    const b = base("Stop", { n: 2 });
    const c = base("SessionEnd");
    expect(firstPerHookEvent([a, b, c])).toEqual([a, c]);
  });
});
