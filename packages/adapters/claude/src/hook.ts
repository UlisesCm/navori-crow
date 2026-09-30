/**
 * Claude hook payload → `CrowEvent`s (design.md § Mapeo de hooks, R8, R10, R32). Pure and
 * transport-agnostic: the body is the same JSON whether it came by `http` or by the `command`
 * shim's stdin (B0 chose `command` + `async`).
 *
 * Attribution is by payload fields only (D4), never by time window: `session_id`, `cwd`, and
 * `agent_id`/`subagent_id`. `ts` is the receipt time — no Claude hook payload carries a timestamp
 * (B0). Content is never stored: no `tool_response`, no `last_assistant_message`, no
 * `compact_summary`.
 */
import type { HookInput, HookResult, MatchSpec, PartialCrowEvent } from "@crow/core";
import { isRec, num, str } from "@crow/core";
import { trimInput } from "./map-line";

const MAX_PROMPT = 8192;
const MAX_MESSAGE = 1024;
const MAX_CATEGORY = 64;
const COMPACT_WINDOW_MS = 10 * 60_000;

type Rec = Record<string, unknown>;

/** The fields every event of one payload shares. */
interface Base {
  sessionId: string;
  cwd: string | undefined;
  ts: number;
}

/** A non-empty string, else `null`. */
function nonEmpty(v: unknown): string | null {
  const s = str(v);
  return s !== null && s !== "" ? s : null;
}

/** `agent-<id>.jsonl` basename → `<id>` (the id the transcript lane uses for the agent). */
function agentIdFromTranscript(path: string | null): string | null {
  if (path === null) return null;
  const file = path.split("/").pop() ?? "";
  const m = /^agent-(.+)\.jsonl$/.exec(file);
  return m?.[1] ?? null;
}

const exact = (key: string, role: string): MatchSpec => ({ key, mode: "exact", role });

/** Maps one Claude hook delivery. Never throws. */
export function claudeFromHook(input: HookInput): HookResult {
  const body = input.body;
  if (!isRec(body)) {
    return {
      ok: false,
      reason: "bad-shape",
      detail: "hook body is not an object",
      sessionId: null,
      agentId: null,
    };
  }
  const sessionId = nonEmpty(body.session_id);
  const agentField = nonEmpty(body.agent_id) ?? nonEmpty(body.subagent_id);
  if (sessionId === null) {
    return {
      ok: false,
      reason: "unattributable",
      detail: "hook payload has no session_id",
      sessionId: null,
      agentId: agentField,
    };
  }
  const name = nonEmpty(body.hook_event_name);
  if (name === null) {
    return {
      ok: false,
      reason: "bad-shape",
      detail: "hook payload has no hook_event_name",
      sessionId,
      agentId: agentField,
    };
  }

  const base: Base = { sessionId, cwd: nonEmpty(body.cwd) ?? undefined, ts: input.receivedAt };
  const events = mapEvent(name, body, base, agentField);
  if (events === null) {
    return {
      ok: false,
      reason: "unknown-type",
      detail: name.slice(0, 128),
      sessionId,
      agentId: agentField,
    };
  }
  return { ok: true, events };
}

/** One event of this payload, with the shared identity filled in. */
function ev(
  base: Base,
  agentId: string | null,
  rest: Omit<PartialCrowEvent, "sessionId" | "agentId" | "parentAgentId" | "cwd" | "ts">,
): PartialCrowEvent {
  return {
    sessionId: base.sessionId,
    agentId,
    parentAgentId: null,
    ts: base.ts,
    ...(base.cwd !== undefined ? { cwd: base.cwd } : {}),
    ...rest,
  };
}

/** `null` = unknown event name. `agentField` = `agent_id ?? subagent_id` (tools, permissions, instructions). */
function mapEvent(
  name: string,
  body: Rec,
  base: Base,
  agentField: string | null,
): PartialCrowEvent[] | null {
  const toolName = str(body.tool_name) ?? "unknown";
  const callId = nonEmpty(body.tool_use_id) ?? undefined;
  const toolBase = { name: toolName, ...(callId !== undefined ? { callId } : {}) };

  switch (name) {
    case "SessionStart": {
      const source = str(body.source);
      if (source === "compact") return [];
      const keyed = source !== "resume";
      return [
        ev(base, null, {
          kind: "session.start",
          ...(keyed ? { match: exact("session-start@main", "hook") } : {}),
        }),
      ];
    }
    case "SessionEnd":
      return [ev(base, null, { kind: "session.end" })];
    case "UserPromptSubmit": {
      const promptId = nonEmpty(body.prompt_id);
      const prompt = str(body.prompt);
      return [
        ev(base, null, {
          kind: "prompt",
          ...(prompt !== null ? { text: prompt.slice(0, MAX_PROMPT) } : {}),
          // No id → no key (the transcript prompt then can't fuse with this one).
          ...(promptId !== null ? { match: exact(`prompt@main:${promptId}`, "hook") } : {}),
        }),
      ];
    }
    case "PreToolUse":
      return [
        ev(base, agentField, {
          kind: "tool.pre",
          tool: { ...toolBase, input: trimInput(body.tool_input) },
          ...(callId !== undefined ? { match: exact(`tool-pre:${callId}`, "hook") } : {}),
        }),
      ];
    case "PostToolUse": {
      const ms = num(body.duration_ms);
      return [
        ev(base, agentField, {
          kind: "tool.post",
          tool: {
            ...toolBase,
            ok: true,
            verdict: "allow",
            ...(typeof body.duration_ms === "number" ? { ms, msSource: "engine" as const } : {}),
          },
          ...(callId !== undefined ? { match: exact(`tool-post:${callId}`, "hook") } : {}),
        }),
      ];
    }
    case "PostToolUseFailure": {
      const message = str(body.error);
      return [
        ev(base, agentField, {
          kind: "tool.error",
          tool: {
            ...toolBase,
            ok: false,
            verdict: "error",
            ...(typeof body.duration_ms === "number"
              ? { ms: num(body.duration_ms), msSource: "engine" as const }
              : {}),
          },
          error: { message: (message ?? "tool failed").slice(0, MAX_MESSAGE) },
          ...(callId !== undefined ? { match: exact(`tool-post:${callId}`, "hook") } : {}),
        }),
      ];
    }
    case "PermissionRequest":
      // B0: the capture carries no `tool_use_id`, so the permission has no cross-lane key.
      return [
        ev(base, agentField, {
          kind: "permission",
          tool: { ...toolBase, input: trimInput(body.tool_input) },
          permission: { decision: "ask" },
          ...(callId !== undefined ? { match: exact(`permission:${callId}`, "hook:request") } : {}),
        }),
      ];
    case "PermissionDenied": {
      // ⚠ Not captured in B0 (no dialog in `-p`): shape follows the docs (`reason`).
      const reason = nonEmpty(body.reason)?.slice(0, MAX_MESSAGE);
      return [
        ev(base, agentField, {
          kind: "permission",
          tool: { ...toolBase, input: trimInput(body.tool_input) },
          permission: { decision: "deny", ...(reason !== undefined ? { reason } : {}) },
          ...(callId !== undefined ? { match: exact(`permission:${callId}`, "hook:denied") } : {}),
        }),
        ev(base, agentField, {
          kind: "tool.error",
          tool: { ...toolBase, ok: false, verdict: "deny" },
          error: { message: reason ?? "permission denied" },
          ...(callId !== undefined ? { match: exact(`tool-post:${callId}`, "hook") } : {}),
        }),
      ];
    }
    case "SubagentStart": {
      const id = nonEmpty(body.agent_id);
      const type = nonEmpty(body.agent_type);
      return [
        ev(base, id, {
          kind: "agent.start",
          ...(type !== null ? { agent: { type } } : {}),
          ...(id !== null ? { match: exact(`agent-start:${id}`, "hook") } : {}),
        }),
      ];
    }
    case "SubagentStop": {
      const id =
        agentIdFromTranscript(nonEmpty(body.agent_transcript_path)) ?? nonEmpty(body.agent_id);
      return [
        ev(base, id, {
          kind: "agent.stop",
          ...(id !== null ? { match: exact(`agent-stop:${id}`, "hook") } : {}),
        }),
      ];
    }
    case "PreCompact":
    case "PostCompact": {
      const pre = name === "PreCompact";
      const trigger = nonEmpty(body.trigger);
      return [
        ev(base, null, {
          kind: "compact",
          compact: {
            ...(trigger !== null ? { trigger } : {}),
            ...(pre ? { startedAt: base.ts } : { endedAt: base.ts }),
          },
          match: {
            key: "compact@main",
            mode: "nearest",
            windowMs: COMPACT_WINDOW_MS,
            role: pre ? "hook:pre" : "hook:post",
          },
        }),
      ];
    }
    case "InstructionsLoaded": {
      const file = nonEmpty(body.file_path);
      return [
        ev(base, agentField, {
          kind: "instructions.loaded",
          ...(file !== null ? { text: file.slice(0, MAX_MESSAGE) } : {}),
        }),
      ];
    }
    case "Stop":
      return [ev(base, null, { kind: "turn.end", turn: { ok: true } })];
    case "StopFailure": {
      const category = nonEmpty(body.error)?.slice(0, MAX_CATEGORY);
      return [
        ev(base, null, {
          kind: "turn.end",
          turn: { ok: false, ...(category !== undefined ? { category } : {}) },
        }),
      ];
    }
    default:
      return null;
  }
}
