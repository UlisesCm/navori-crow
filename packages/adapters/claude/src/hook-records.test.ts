/**
 * Transcript hook execution records → `hook` events (F2a D18, R33), plus the reconciliation and
 * usage keys the F1 map now carries (design.md § Claves nuevas en los mapas de línea de F1).
 */
import { describe, expect, test } from "bun:test";
import type { PartialCrowEvent } from "@crow/core";
import { initialClaudeState, mapClaudeLine, usageCallKey } from "./map-line";

const POS = { path: "/t/s.jsonl", offset: 0, line: 1 };

function attachmentLine(
  attachment: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: "attachment",
    uuid: "u1",
    sessionId: "s1",
    timestamp: "2026-01-01T00:00:01.000Z",
    cwd: "/tmp/p",
    attachment,
    ...extra,
  });
}

/** Maps one line on a started state (so no `session.start` is added) and returns its events. */
function map(line: string): PartialCrowEvent[] {
  const state = { ...initialClaudeState(null), started: true };
  const result = mapClaudeLine(line, state, POS);
  if (!result.ok) throw new Error(`line did not map: ${result.reason}`);
  return result.events;
}

const SUCCESS = {
  type: "hook_success",
  hookName: "PostToolUse:Bash",
  hookEvent: "PostToolUse",
  toolUseID: "toolu_1",
  content: "SECRET-CONTENT",
  stdout: "SECRET-STDOUT",
  stderr: "SECRET-STDERR",
  command: "/usr/local/bin/audit-log.sh --token SECRET-ARG",
  exitCode: 0,
  durationMs: 264,
};

describe("transcript hook records (R33, D18)", () => {
  test("hook_success maps to a hook event with name, phase, ms, exit code and verdict only", () => {
    // Covers: R33
    const events = map(attachmentLine(SUCCESS));

    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.kind).toBe("hook");
    expect(e.hook).toEqual({
      name: "PostToolUse:Bash",
      phase: "PostToolUse",
      verdict: "success",
      ms: 264,
      exitCode: 0,
      blocking: false,
    });
    expect(e.match).toBeUndefined(); // a hook never fuses (N3)
    expect(e.semanticKey).toBe("uuid:u1:0");
  });

  test("allowlist: nothing of stdout, stderr, command, content or the tool id survives anywhere in the event", () => {
    // Covers: R33
    const events = map(attachmentLine(SUCCESS, { rendered: [{ content: "SECRET-RENDERED" }] }));

    const serialized = JSON.stringify(events);
    for (const secret of [
      "SECRET-CONTENT",
      "SECRET-STDOUT",
      "SECRET-STDERR",
      "SECRET-ARG",
      "SECRET-RENDERED",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(Object.keys(events[0]!.hook ?? {}).sort()).toEqual(
      ["blocking", "exitCode", "ms", "name", "phase", "verdict"].sort(),
    );
  });

  test("other hook_* subtypes map with their outcome as the verdict; exit code 2 or a blocking subtype blocks", () => {
    // Covers: R33
    const failed = map(
      attachmentLine({ ...SUCCESS, type: "hook_non_blocking_error", exitCode: 1 }),
    )[0]!;
    expect(failed.hook?.verdict).toBe("non_blocking_error");
    expect(failed.hook?.blocking).toBe(false);

    const blockedByCode = map(attachmentLine({ ...SUCCESS, type: "hook_error", exitCode: 2 }))[0]!;
    expect(blockedByCode.hook?.blocking).toBe(true);

    const blockedBySubtype = map(
      attachmentLine({ ...SUCCESS, type: "hook_blocking_error", exitCode: undefined }),
    )[0]!;
    expect(blockedBySubtype.hook?.blocking).toBe(true);
    expect(blockedBySubtype.hook?.exitCode).toBeUndefined();
  });

  test("a missing duration leaves ms out instead of inventing one", () => {
    // Covers: R33
    const e = map(attachmentLine({ ...SUCCESS, durationMs: undefined }))[0]!;
    expect(e.hook).not.toHaveProperty("ms");
  });

  test("the hook belongs to the line's agent", () => {
    // Covers: R33
    const e = map(attachmentLine(SUCCESS, { agentId: "a7" }))[0]!;
    expect(e.agentId).toBe("a7");
  });

  test("hook_additional_context maps to nothing", () => {
    // Covers: R33
    const events = map(
      attachmentLine({
        type: "hook_additional_context",
        content: ["injected"],
        hookName: "UserPromptSubmit",
        hookEvent: "UserPromptSubmit",
        toolUseID: "t",
      }),
    );
    expect(events).toEqual([]);
  });

  test("a hook_* record without hookName or hookEvent maps to nothing", () => {
    // Covers: R33
    expect(map(attachmentLine({ ...SUCCESS, hookName: undefined }))).toEqual([]);
    expect(map(attachmentLine({ ...SUCCESS, hookEvent: undefined }))).toEqual([]);
    expect(map(attachmentLine({ ...SUCCESS, hookName: "" }))).toEqual([]);
  });

  test("crow's own hooks are excluded: the ingest script or the ingest URL, nothing stored", () => {
    // Covers: R33
    const script = map(
      attachmentLine({ ...SUCCESS, command: "/home/u/.crow/hooks/crow-ingest-hook claude" }),
    );
    const url = map(
      attachmentLine({
        ...SUCCESS,
        command: undefined,
        url: "http://127.0.0.1:7777/ingest/hook/claude",
      }),
    );
    const urlInCommand = map(
      attachmentLine({ ...SUCCESS, command: "curl http://localhost:7777/ingest/hook/claude" }),
    );
    expect(script).toEqual([]);
    expect(url).toEqual([]);
    expect(urlInCommand).toEqual([]);
  });

  test("a user's own hook that merely mentions another script is kept", () => {
    // Covers: R33
    const e = map(attachmentLine({ ...SUCCESS, command: "/opt/audit-log.sh" }));
    expect(e).toHaveLength(1);
  });
});

describe("usage and reconciliation keys on the F1 map (R12, R33 companion)", () => {
  const assistant = (requestId: string | undefined): string =>
    JSON.stringify({
      type: "assistant",
      uuid: "u2",
      sessionId: "s1",
      timestamp: "2026-01-01T00:00:02.000Z",
      ...(requestId !== undefined ? { requestId } : {}),
      message: {
        id: "msg_1",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    });

  test("usageCallKey is req:<requestId>, and undefined without one (G5a: OTel request_id == transcript requestId)", () => {
    // Covers: R12
    expect(usageCallKey("req_abc")).toBe("req:req_abc");
    expect(usageCallKey(null)).toBeUndefined();
  });

  test("assistant lines with usage carry usageCallKey; lines without requestId carry none", () => {
    // Covers: R12
    expect(map(assistant("req_1"))[0]!.usageCallKey).toBe("req:req_1");
    expect(map(assistant(undefined))[0]!.usageCallKey).toBeUndefined();
  });

  test("tool, prompt, compact and agent facts carry their match keys", () => {
    // Covers: R12
    const toolUse = JSON.stringify({
      type: "assistant",
      uuid: "u3",
      sessionId: "s1",
      timestamp: "2026-01-01T00:00:03.000Z",
      message: {
        id: "m2",
        content: [{ type: "tool_use", id: "toolu_9", name: "Bash", input: {} }],
      },
    });
    expect(map(toolUse).find((e) => e.kind === "tool.pre")?.match).toEqual({
      key: "tool-pre:toolu_9",
      mode: "exact",
    });

    const toolResult = JSON.stringify({
      type: "user",
      uuid: "u4",
      sessionId: "s1",
      timestamp: "2026-01-01T00:00:04.000Z",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_9", content: "ok" }] },
    });
    expect(map(toolResult)[0]!.match).toEqual({ key: "tool-post:toolu_9", mode: "exact" });

    const prompt = JSON.stringify({
      type: "user",
      uuid: "u5",
      sessionId: "s1",
      promptId: "p1",
      timestamp: "2026-01-01T00:00:05.000Z",
      message: { content: "hello" },
      origin: { kind: "human" },
    });
    expect(map(prompt)[0]!.match).toEqual({ key: "prompt@main:p1", mode: "exact" });

    const metaPrompt = JSON.stringify({ ...JSON.parse(prompt), isMeta: true });
    expect(map(metaPrompt)[0]!.match).toBeUndefined(); // a meta line never shadows the real prompt

    const compact = JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      uuid: "u6",
      sessionId: "s1",
      timestamp: "2026-01-01T00:00:06.000Z",
    });
    expect(map(compact)[0]!.match).toEqual({
      key: "compact@main",
      mode: "nearest",
      windowMs: 600_000,
    });
  });

  test("session.start and agent.start carry their keys; usage-bearing events carry no match", () => {
    // Covers: R12
    const fresh = initialClaudeState(null);
    const main = mapClaudeLine(assistant("req_1"), fresh, POS);
    if (!main.ok) throw new Error("no map");
    expect(main.events.find((e) => e.kind === "session.start")?.match).toEqual({
      key: "session-start@main",
      mode: "exact",
    });
    expect(main.events.find((e) => e.kind === "assistant.message")?.match).toBeUndefined();

    const agentLine = JSON.stringify({ ...JSON.parse(assistant("req_2")), agentId: "a1" });
    const child = mapClaudeLine(agentLine, fresh, POS);
    if (!child.ok) throw new Error("no map");
    expect(child.events.find((e) => e.kind === "agent.start")?.match).toEqual({
      key: "agent-start:a1",
      mode: "exact",
    });
  });
});
