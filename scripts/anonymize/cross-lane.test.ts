/**
 * Property: with ONE shared id registry and ONE time offset, the same raw id maps to the same
 * pseudonym in the transcript (`claude.ts`), the hook payload (`hooks.ts`) and the OTLP body
 * (`otlp.ts`) — the G5a equality survives anonymization. SYNTHETIC data only.
 */
import { describe, expect, test } from "bun:test";
import { claudeAdapter } from "@crow/adapter-claude";
import type { Rec } from "@crow/core";
import { anonymizeClaudeFixture } from "./claude";
import { anonymizeHookPayload } from "./hooks";
import { anonymizeOtlp } from "./otlp";
import { FixtureContext, IdRegistry } from "./shared";

const ROOT = "/Users/dev/.claude/projects";
const SLUG_DIR = `${ROOT}/-Users-dev-projA`;
const RAW = {
  session: "raw-session-1",
  prompt: "raw-prompt-1",
  tool: "toolu_rawTool1",
  req: "raw-req-1",
};

function transcript(): string {
  const base = { sessionId: RAW.session, cwd: "/Users/dev/projA", gitBranch: "x" };
  return `${[
    {
      type: "user",
      timestamp: "2024-03-01T09:00:00.000Z",
      ...base,
      uuid: "u0",
      promptId: RAW.prompt,
      message: { role: "user", content: "hi" },
    },
    {
      type: "assistant",
      timestamp: "2024-03-01T09:00:01.000Z",
      ...base,
      uuid: "u1",
      requestId: RAW.req,
      wireToolInputs: { [RAW.tool]: { command: "SENTINEL_text" } },
      message: {
        id: "m1",
        role: "assistant",
        content: [{ type: "tool_use", id: RAW.tool, name: "Bash", input: {} }],
      },
    },
  ]
    .map((l) => JSON.stringify(l))
    .join("\n")}\n`;
}

const attr = (key: string, v: string): Rec => ({ key, value: { stringValue: v } });

describe("shared registry across transcript, hook and OTLP", () => {
  test("same raw id → same pseudonym in all three lanes; nothing raw survives", () => {
    // Covers: B0.T3 (G5a)
    const ids = new IdRegistry();
    const ctx = new FixtureContext("demo", ids, 0);
    const path = `${SLUG_DIR}/${RAW.session}.jsonl`;
    const match = claudeAdapter.matches(path, ROOT);
    expect(match).not.toBeNull();
    const [tr] = anonymizeClaudeFixture(
      [{ match: match!, relPath: `-Users-dev-projA/${RAW.session}.jsonl`, content: transcript() }],
      { repo: "demo", ids, tsOffsetMs: 0 },
    );
    const hook = anonymizeHookPayload(
      {
        session_id: RAW.session,
        prompt_id: RAW.prompt,
        tool_use_id: RAW.tool,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: {},
      },
      ctx,
    );
    const otlp = anonymizeOtlp(
      {
        resourceLogs: [
          {
            resource: { attributes: [] },
            scopeLogs: [
              {
                scope: { name: "com.anthropic.claude_code.events" },
                logRecords: [
                  {
                    body: { stringValue: "claude_code.api_request" },
                    attributes: [
                      attr("session.id", RAW.session),
                      attr("prompt.id", RAW.prompt),
                      attr("request_id", RAW.req),
                      attr("tool_use_id", RAW.tool),
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      ctx,
    );

    const lines = tr!.content
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Rec);
    const otlpAttrs = new Map<string, string>();
    const rec = (((otlp.resourceLogs as Rec[])[0]!.scopeLogs as Rec[])[0]!.logRecords as Rec[])[0]!;
    for (const kv of rec.attributes as Rec[])
      otlpAttrs.set(kv.key as string, (kv.value as Rec).stringValue as string);

    expect(lines[0]!.sessionId).toBe(hook.session_id as string);
    expect(lines[0]!.sessionId).toBe(otlpAttrs.get("session.id") as string);
    expect(lines[0]!.promptId).toBe(hook.prompt_id as string);
    expect(lines[0]!.promptId).toBe(otlpAttrs.get("prompt.id") as string);
    const toolBlock = ((lines[1]!.message as Rec).content as Rec[])[0] as Rec;
    expect(toolBlock.id).toBe(hook.tool_use_id as string);
    expect(toolBlock.id).toBe(otlpAttrs.get("tool_use_id") as string);
    // a tool-call id in KEY position (wireToolInputs) gets the same pseudonym as in value position
    expect(Object.keys(lines[1]!.wireToolInputs as Rec)).toEqual([toolBlock.id as string]);
    expect(lines[1]!.requestId).toBe(otlpAttrs.get("request_id") as string);

    const all = JSON.stringify([tr, hook, otlp]);
    for (const raw of Object.values(RAW)) expect(all).not.toContain(raw);
  });

  test("without a shared registry the pseudonyms are independent (guards against accidental sharing)", () => {
    // Covers: B0.T3
    const a = anonymizeHookPayload(
      { session_id: "s", hook_event_name: "Stop" },
      new FixtureContext("d"),
    );
    const ctx = new FixtureContext("d");
    ctx.ids.pseudonymize("other");
    const b = anonymizeHookPayload({ session_id: "s", hook_event_name: "Stop" }, ctx);
    expect(a.session_id).not.toBe(b.session_id);
  });
});
