/**
 * `ownsOtel` / `fromOtel` for Codex (design.md § Mapeo OTel, R19, R24). Pure and stateless.
 *
 * Allowlist (D17): only the named attributes below are read. `prompt`, `arguments`, `output`,
 * `content`, `user.email`, `user.account_id`... exist in Codex's records but are never touched, so no
 * content can reach an event.
 *
 * `conversation.id` is the session. A subagent's records carry its own conversation id (a stateless
 * mapper cannot link it to its parent), so they land under that id, not under the root thread.
 */
import type { CrowEventUsage, FlatOtelRecord, OtelResult, PartialCrowEvent } from "@crow/core";

const EVENT_PREFIX = "codex.";

/** Numeric attribute: OTLP ints arrive as numbers, but Codex also sends some as strings. */
function numAttr(record: FlatOtelRecord, key: string): number | undefined {
  const v = record.attrs[key];
  const n = typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function strAttr(record: FlatOtelRecord, key: string): string | undefined {
  const v = record.attrs[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** Codex sends `success` as a bool on some events and as the string "true"/"false" on others. */
function boolAttr(record: FlatOtelRecord, key: string): boolean | undefined {
  const v = record.attrs[key];
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

/** D10: a Codex record is recognised by its `codex.*` name, or by `service.name` for non-empty names. */
export function codexOwnsOtel(record: FlatOtelRecord): boolean {
  if (record.name.startsWith(EVENT_PREFIX)) return true;
  return record.name !== "" && record.service !== null && record.service.startsWith("codex");
}

/** `approved`/`approved_for_session` allow; `denied`/`abort` deny; anything else is left unstated. */
function verdictOf(decision: string | undefined): "allow" | "deny" | undefined {
  if (decision === undefined) return undefined;
  if (decision.startsWith("approved")) return "allow";
  if (decision === "denied" || decision === "abort") return "deny";
  return undefined;
}

/** `response_completed` token counts, in the same components the rollout's `token_count` uses. */
function usageOf(record: FlatOtelRecord): CrowEventUsage | undefined {
  const input = numAttr(record, "input_token_count");
  const output = numAttr(record, "output_token_count");
  if (input === undefined || output === undefined) return undefined;
  const cached = numAttr(record, "cached_token_count") ?? 0;
  const model = strAttr(record, "model");
  return {
    input: Math.max(0, input - cached),
    output,
    cacheRead: cached,
    cacheCreation: numAttr(record, "cache_write_token_count") ?? 0,
    ...(model !== undefined ? { model } : {}),
  };
}

/**
 * `codex.agent_communication` with `kind = spawn` and `state = send` is the parent announcing a
 * child thread (D19 B1). Reads only `kind`, `state`, `sender_thread_id` and `receiver_thread_id`
 * (never `content`, D17); the record has no `conversation.id`. The key is the one the `SubagentStart`
 * hook and the rollout use, so D5 fuses the three lanes into one fact.
 */
function spawnOf(record: FlatOtelRecord): OtelResult {
  if (strAttr(record, "kind") !== "spawn" || strAttr(record, "state") !== "send") {
    return { ok: true, events: [] };
  }
  const sender = strAttr(record, "sender_thread_id");
  const receiver = strAttr(record, "receiver_thread_id");
  if (sender === undefined || receiver === undefined) {
    return {
      ok: false,
      reason: "unattributable",
      detail: "codex.agent_communication: missing thread ids",
    };
  }
  return {
    ok: true,
    events: [
      {
        sessionId: sender,
        agentId: receiver,
        parentAgentId: null,
        ts: record.ts,
        kind: "agent.start",
        match: { key: `agent-start:${receiver}`, mode: "exact" },
      },
    ],
  };
}

/** Maps one flattened Codex log record; unknown or unmapped names return `events: []` (`otelIgnored`). */
export function codexFromOtel(record: FlatOtelRecord): OtelResult {
  const name = record.name;
  if (name === "codex.agent_communication") return spawnOf(record);
  const isSse = name === "codex.sse_event";
  if (
    name !== "codex.api_request" &&
    name !== "codex.tool_decision" &&
    name !== "codex.tool_result" &&
    !isSse
  ) {
    return { ok: true, events: [] };
  }
  if (isSse && strAttr(record, "event.kind") !== "response.completed") {
    return { ok: true, events: [] };
  }
  const sessionId = strAttr(record, "conversation.id");
  if (sessionId === undefined) {
    // `codex.api_request` for `/models` is sent before any conversation exists: normal, not an error.
    if (name === "codex.api_request") return { ok: true, events: [] };
    return { ok: false, reason: "unattributable", detail: `${name}: missing conversation.id` };
  }

  const base = { sessionId, agentId: null, parentAgentId: null, ts: record.ts };
  const model = strAttr(record, "model");
  const ms = numAttr(record, "duration_ms");
  const callId = strAttr(record, "call_id");
  const toolName = strAttr(record, "tool_name") ?? "unknown";
  const events: PartialCrowEvent[] = [];

  switch (name) {
    case "codex.api_request":
      events.push({
        ...base,
        kind: "api.request",
        reported: {
          metric: "api_request",
          ...(model !== undefined ? { model } : {}),
          ...(ms !== undefined ? { ms } : {}),
        },
      });
      break;
    case "codex.sse_event": {
      const usage = usageOf(record);
      if (usage === undefined) break;
      // Session scope (D6): Codex has no per-call id shared with the rollout, so no `usageCallKey`.
      events.push({
        ...base,
        kind: "usage",
        otelUsage: usage,
        reported: {
          metric: "sse_event",
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheCreation: usage.cacheCreation,
          ...(model !== undefined ? { model } : {}),
        },
      });
      break;
    }
    case "codex.tool_decision": {
      const verdict = verdictOf(strAttr(record, "decision"));
      const source = strAttr(record, "source");
      events.push({
        ...base,
        kind: "tool.pre",
        tool: {
          name: toolName,
          ...(callId !== undefined ? { callId } : {}),
          ...(verdict !== undefined ? { verdict } : {}),
          ...(source !== undefined ? { decisionSource: source } : {}),
        },
        ...(callId !== undefined
          ? { match: { key: `tool-pre:${callId}`, mode: "exact" } as const }
          : {}),
      });
      break;
    }
    case "codex.tool_result": {
      const ok = boolAttr(record, "success") !== false;
      events.push({
        ...base,
        kind: ok ? "tool.post" : "tool.error",
        tool: {
          name: toolName,
          ...(callId !== undefined ? { callId } : {}),
          ok,
          ...(ms !== undefined ? { ms, msSource: "engine" as const } : {}),
        },
        // Fixed text: the failure's own output is content and stays out (R24).
        ...(ok ? {} : { error: { message: "tool call failed (success=false)" } }),
        ...(callId !== undefined
          ? { match: { key: `tool-post:${callId}`, mode: "exact" } as const }
          : {}),
      });
      break;
    }
  }
  return { ok: true, events };
}
