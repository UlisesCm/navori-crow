/**
 * `fromHook` for Codex (design.md § Mapeo de hooks, Codex; R9, R10, R13). Pure and stateless: the body is
 * the JSON Codex writes to a hook's stdin, whatever the transport that delivered it.
 *
 * G2 (b0-bitacora.md): `session_id` is always the root thread, even for hooks that fire inside a
 * subagent (`SubagentStart` carries the child in `agent_id`, its rollout in `transcript_path`), so no
 * `transcript_path` resolution is needed. Command tools use `tool_use_id = exec-<item.id>`, which is
 * what the rollout's `item_completed` exposes; collaboration tools use the real `call_id`.
 */
import type { HookInput, HookResult, MatchSpec, PartialCrowEvent } from "@crow/core";
import { isRec, str } from "@crow/core";
import { createHash } from "node:crypto";

/** Caps mirror map-line.ts (prompt text) and D5 (input trimmed, error <= 1 KiB). */
const MAX_TEXT = 8192;
const MAX_INPUT_JSON = 4096;
const MAX_ERROR = 1024;

const COMPACT_WINDOW_MS = 10 * 60_000;
const PROMPT_WINDOW_MS = 10_000;

/** Non-empty string, or `undefined`. */
function nonEmpty(v: unknown): string | undefined {
  const s = str(v);
  return s !== null && s !== "" ? s : undefined;
}

/** Keeps small tool inputs as-is; a larger one becomes a truncated JSON string (never the full payload). */
function trimInput(input: unknown): unknown {
  if (input === undefined) return undefined;
  let json: string | undefined;
  try {
    json = JSON.stringify(input);
  } catch {
    return undefined;
  }
  if (json === undefined || json.length <= MAX_INPUT_JSON) return input;
  return json.slice(0, MAX_INPUT_JSON);
}

/** Same fingerprint as the rollout's prompt (`map-line.ts` `matchFor`), so both lanes fuse (R13). */
function promptMatch(text: string | undefined): MatchSpec {
  return {
    key: "prompt@main",
    mode: "nearest",
    windowMs: PROMPT_WINDOW_MS,
    ...(text !== undefined
      ? { fingerprint: createHash("sha1").update(text.trim()).digest("hex") }
      : {}),
  };
}

/** Codex tool payloads: an `error` string marks a failed call (field not captured in B0; doc-only). */
function errorMessage(body: Record<string, unknown>): string | undefined {
  const e = body.error;
  const msg = typeof e === "string" ? e : isRec(e) ? str(e.message) : null;
  return msg !== null && msg !== "" ? msg.slice(0, MAX_ERROR) : undefined;
}

/** Maps one Codex hook payload to zero or more events with `source = "hook"`. */
export function codexFromHook(input: HookInput): HookResult {
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
  const sessionId = nonEmpty(body.session_id) ?? null;
  const name = nonEmpty(body.hook_event_name);
  const agentField = nonEmpty(body.agent_id);
  if (name === undefined) {
    return {
      ok: false,
      reason: "bad-shape",
      detail: "missing hook_event_name",
      sessionId,
      agentId: agentField ?? null,
    };
  }
  if (sessionId === null) {
    return {
      ok: false,
      reason: "unattributable",
      detail: `${name}: missing session_id`,
      sessionId: null,
      agentId: null,
    };
  }

  const ts = input.receivedAt;
  const cwd = nonEmpty(body.cwd);
  const base = {
    sessionId,
    agentId: null,
    parentAgentId: null,
    ts,
    ...(cwd !== undefined ? { cwd } : {}),
  };
  // Tool/permission hooks inside a subagent carry its id; the parent is unknown here (the rollout supplies it).
  const toolBase = { ...base, agentId: agentField ?? null };
  const toolName = nonEmpty(body.tool_name) ?? "unknown";
  const callId = nonEmpty(body.tool_use_id);
  const toolInput = trimInput(body.tool_input);
  const events: PartialCrowEvent[] = [];

  switch (name) {
    case "SessionStart": {
      const source = nonEmpty(body.source);
      if (source === "compact") break; // a compaction restart is not a new session
      events.push({
        ...base,
        kind: "session.start",
        ...(source === "resume"
          ? {}
          : { match: { key: "session-start@main", mode: "exact" } as const }),
      });
      break;
    }
    case "SessionEnd":
      events.push({ ...base, kind: "session.end" });
      break;
    case "UserPromptSubmit": {
      const raw = str(body.prompt);
      const text = raw !== null ? raw.slice(0, MAX_TEXT) : undefined;
      events.push({
        ...base,
        kind: "prompt",
        ...(text !== undefined ? { text } : {}),
        match: promptMatch(text),
      });
      break;
    }
    case "PreToolUse":
      events.push({
        ...toolBase,
        kind: "tool.pre",
        tool: {
          name: toolName,
          ...(callId !== undefined ? { callId } : {}),
          ...(toolInput !== undefined ? { input: toolInput } : {}),
        },
        ...(callId !== undefined
          ? { match: { key: `tool-pre:${callId}`, mode: "exact" } as const }
          : {}),
      });
      break;
    case "PostToolUse": {
      const error = errorMessage(body);
      const ms = typeof body.duration_ms === "number" ? body.duration_ms : undefined;
      events.push({
        ...toolBase,
        kind: error !== undefined ? "tool.error" : "tool.post",
        tool: {
          name: toolName,
          ...(callId !== undefined ? { callId } : {}),
          ok: error === undefined,
          verdict: error === undefined ? "allow" : "error",
          decisionSource: "hook",
          ...(ms !== undefined ? { ms, msSource: "engine" as const } : {}),
        },
        ...(error !== undefined ? { error: { message: error } } : {}),
        ...(callId !== undefined
          ? { match: { key: `tool-post:${callId}`, mode: "exact" } as const }
          : {}),
      });
      break;
    }
    case "PermissionRequest":
      // Not captured in B0: shape follows the doc (tool_name/tool_input, like PreToolUse).
      events.push({
        ...toolBase,
        kind: "permission",
        permission: { decision: "ask", decisionSource: "hook" },
        tool: {
          name: toolName,
          ...(callId !== undefined ? { callId } : {}),
          ...(toolInput !== undefined ? { input: toolInput } : {}),
        },
        ...(callId !== undefined
          ? {
              match: {
                key: `permission:${callId}`,
                mode: "exact",
                role: "hook:request",
              } as const,
            }
          : {}),
      });
      break;
    case "SubagentStart": {
      if (agentField === undefined) {
        return {
          ok: false,
          reason: "bad-shape",
          detail: "SubagentStart without agent_id",
          sessionId,
          agentId: null,
        };
      }
      const type = nonEmpty(body.agent_type);
      events.push({
        ...base,
        agentId: agentField,
        kind: "agent.start",
        agent: type !== undefined ? { type } : {},
        match: { key: `agent-start:${agentField}`, mode: "exact" },
      });
      break;
    }
    case "SubagentStop": {
      if (agentField === undefined) {
        return {
          ok: false,
          reason: "bad-shape",
          detail: "SubagentStop without agent_id",
          sessionId,
          agentId: null,
        };
      }
      events.push({
        ...base,
        agentId: agentField,
        kind: "agent.stop",
        match: { key: `agent-stop:${agentField}`, mode: "exact" },
      });
      break;
    }
    case "PreCompact": {
      const trigger = nonEmpty(body.trigger);
      events.push({
        ...base,
        kind: "compact",
        compact: {
          startedAt: ts,
          ...(trigger !== undefined ? { trigger } : {}),
        },
        match: {
          key: "compact@main",
          mode: "nearest",
          windowMs: COMPACT_WINDOW_MS,
          role: "hook:pre",
        },
      });
      break;
    }
    case "PostCompact":
      events.push({
        ...base,
        kind: "compact",
        compact: { endedAt: ts },
        match: {
          key: "compact@main",
          mode: "nearest",
          windowMs: COMPACT_WINDOW_MS,
          role: "hook:post",
        },
      });
      break;
    default:
      return {
        ok: false,
        reason: "unknown-type",
        detail: `unknown hook event ${name}`.slice(0, 200),
        sessionId,
        agentId: agentField ?? null,
      };
  }

  return { ok: true, events };
}
