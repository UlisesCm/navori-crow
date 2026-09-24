/**
 * Claude transcript line → `PartialCrowEvent[]` (design.md § Mapeo Claude,
 * R11–R13, R16). Pure: never throws, never reads the clock or the disk.
 *
 * State shape (design.md, verbatim): `{ v, started, cwd, lastTs, openCalls,
 * spawned, meta }`. `openCalls` is capped at 256 entries (design.md § Mapeo
 * Claude) so a session with many never-closed tool calls can't grow the
 * persisted `state_json` without bound.
 */
import type {
  CrowEventAgent,
  CrowEventUsage,
  JsonValue,
  LinePos,
  LineResult,
  PartialCrowEvent,
  Rec,
} from "@crow/core";
import { arr, isRec, num, str } from "@crow/core";

/** Cap on `ClaudeState.openCalls`/`seenMessageIds` entries (design.md § Mapeo Claude). */
const MAX_OPEN_CALLS = 256;

/** Persisted, round-tripped adapter state (design.md § Mapeo Claude). `S extends JsonValue`. */
export interface ClaudeState {
  [key: string]: JsonValue;
  v: number;
  started: boolean;
  cwd: string | null;
  lastTs: number;
  /** `callId -> { name, ts, subagentType }`, open `tool_use` calls awaiting their `tool_result`. */
  openCalls: { [callId: string]: JsonValue };
  /** `toolUseId (spawn call) -> agentId`, filled on `async_launched`, consumed on the task-notification. */
  spawned: { [toolUseId: string]: JsonValue };
  /** `message.id -> true`, scoped to this file (session+agent), for the "first line of its id" rule. */
  seenMessageIds: { [messageId: string]: JsonValue };
  /** Sidecar-derived metadata, read once at `initialState` (agent files only). */
  meta: JsonValue;
}

/** Fresh state for a newly-seen file; `meta` is parsed from the sidecar text the tailer read at file-open. */
export function initialClaudeState(meta: JsonValue): ClaudeState {
  return {
    v: 1,
    started: false,
    cwd: null,
    lastTs: 0,
    openCalls: {},
    spawned: {},
    seenMessageIds: {},
    meta,
  };
}

/** `restoreState`: rejects anything that isn't shaped like a {@link ClaudeState} (D5: re-ingest from 0). */
export function restoreClaudeState(json: unknown): ClaudeState | null {
  if (!isRec(json)) return null;
  if (typeof json.v !== "number" || typeof json.started !== "boolean") return null;
  if (typeof json.lastTs !== "number") return null;
  if (!isRec(json.openCalls) || !isRec(json.spawned) || !isRec(json.seenMessageIds)) return null;
  return {
    v: json.v,
    started: json.started,
    cwd: str(json.cwd),
    lastTs: json.lastTs,
    openCalls: json.openCalls as ClaudeState["openCalls"],
    spawned: json.spawned as ClaudeState["spawned"],
    seenMessageIds: json.seenMessageIds as ClaudeState["seenMessageIds"],
    meta: (json.meta ?? null) as JsonValue,
  };
}

/** Inserts `key: value`, evicting the oldest entry first once the map is at {@link MAX_OPEN_CALLS}. */
function capInsert(
  map: { [key: string]: JsonValue },
  key: string,
  value: JsonValue,
): { [key: string]: JsonValue } {
  if (key in map) return { ...map, [key]: value };
  const keys = Object.keys(map);
  if (keys.length < MAX_OPEN_CALLS) return { ...map, [key]: value };
  const { [keys[0]!]: _oldest, ...rest } = map;
  return { ...rest, [key]: value };
}

function dropKey(map: { [key: string]: JsonValue }, key: string): { [key: string]: JsonValue } {
  const { [key]: _dropped, ...rest } = map;
  return rest;
}

/** Extracts `<tag>value</tag>` from a task-notification's XML-ish string content (design.md § Mapeo Claude). */
function extractXmlTag(text: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(text);
  return match !== null ? match[1]!.trim() : null;
}

/** D15: recursively trims a tool's `input` — strings to 1 KiB, depth to 3, and 30 entries per level. */
function trimInput(value: unknown, depth = 0): unknown {
  if (depth >= 3) return typeof value === "object" && value !== null ? "[truncated]" : value;
  if (typeof value === "string") return value.slice(0, 1024);
  if (Array.isArray(value)) return value.slice(0, 30).map((v) => trimInput(v, depth + 1));
  if (isRec(value)) {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [k, v] of Object.entries(value)) {
      if (count >= 30) break;
      out[k] = trimInput(v, depth + 1);
      count += 1;
    }
    return out;
  }
  return value;
}

/** Known line types that carry no mappable event (design.md § Evidencia, "de estado, sin evento"). */
const KNOWN_NO_EVENT_TYPES = new Set([
  "attachment",
  "last-prompt",
  "mode",
  "ai-title",
  "permission-mode",
  "bridge-session",
  "atis-latch",
  "pr-link",
  "queue-operation",
  "file-history-snapshot",
  "file-history-delta",
  "frame-link",
  "agent-name",
  "relocated",
  "worktree-state",
  "cost-state",
  "artifact-comment-monitor",
  "artifact-autoreact-ledger",
  "fork-context-ref", // subagents only, harmless to allow everywhere
]);

/** One event this line contributes, before `sessionId`/`agentId`/`cwd`/`semanticKey` are filled in uniformly. */
type Push = Partial<Pick<PartialCrowEvent, "agentId">> &
  Omit<PartialCrowEvent, "sessionId" | "agentId" | "parentAgentId" | "cwd" | "semanticKey">;

/** Reads `message.usage` into a {@link CrowEventUsage}, or `null` if it's absent/malformed. */
function readUsage(usageRaw: unknown, model: string | null): CrowEventUsage | null {
  if (!isRec(usageRaw)) return null;
  const cacheCreation = num(usageRaw.cache_creation_input_tokens);
  const detail = usageRaw.cache_creation;
  // 100% of Claude's cache writes are billed at the 1h TTL (design.md § Evidencia); without the
  // detailed breakdown, the whole write is assumed 1h.
  const cacheCreation1h = isRec(detail) ? num(detail.ephemeral_1h_input_tokens) : cacheCreation;
  return {
    input: num(usageRaw.input_tokens),
    output: num(usageRaw.output_tokens),
    cacheRead: num(usageRaw.cache_read_input_tokens),
    cacheCreation,
    cacheCreation1h,
    model: model ?? undefined,
  };
}

function mapAssistant(
  message: Rec,
  agentId: string | null,
  state: ClaudeState,
  ts: number,
  push: (ev: Push) => void,
): Pick<ClaudeState, "openCalls" | "seenMessageIds"> {
  const messageId = str(message.id);
  const model = str(message.model);
  const contentBlocks = arr(message.content).filter(isRec);
  const hasText = contentBlocks.some(
    (b) =>
      (b.type === "text" || b.type === "thinking") && typeof b.text === "string" && b.text !== "",
  );
  const alreadySeen = messageId !== null && messageId in state.seenMessageIds;
  const isFirstOfId = messageId !== null && !alreadySeen;

  if (hasText || isFirstOfId) {
    const textParts = contentBlocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string);
    const text = textParts.length > 0 ? textParts.join("").slice(0, 8192) : undefined;
    const usage = readUsage(message.usage, model) ?? undefined;
    const usageKey =
      usage !== undefined && messageId !== null ? `u:${agentId ?? "main"}:${messageId}` : undefined;
    push({ kind: "assistant.message", ts, text, usage, usageKey });
  }

  let openCalls = state.openCalls;
  for (const block of contentBlocks) {
    if (block.type !== "tool_use") continue;
    const callId = str(block.id);
    if (callId === null) continue;
    const name = str(block.name) ?? "unknown";
    const input = block.input;
    const subagentType = isRec(input) ? str(input.subagent_type) : null;
    openCalls = capInsert(openCalls, callId, { name, ts, subagentType });
    push({ kind: "tool.pre", ts, tool: { name, callId, input: trimInput(input) } });
  }

  const seenMessageIds =
    messageId !== null ? { ...state.seenMessageIds, [messageId]: true } : state.seenMessageIds;
  return { openCalls, seenMessageIds };
}

function mapUser(
  parsed: Rec,
  ts: number,
  state: ClaudeState,
  push: (ev: Push) => void,
): Pick<ClaudeState, "openCalls" | "spawned"> {
  const message = parsed.message;
  const contentVal = isRec(message) ? message.content : undefined;
  const blocks = arr(contentVal).filter(isRec);
  const toolResultBlocks = blocks.filter((b) => b.type === "tool_result");

  // Kept before the block loop mutates `openCalls`: `toolUseResult`'s own type/name lookup below
  // needs the call's pre-drop entry (it's the same call whose `tool_result` block this line carries).
  const openCallsBeforeResults = state.openCalls;

  let openCalls = state.openCalls;
  for (const block of toolResultBlocks) {
    const callId = str(block.tool_use_id) ?? "unknown";
    const openCall = openCalls[callId];
    const openRec = isRec(openCall) ? openCall : null;
    const name = openRec !== null ? (str(openRec.name) ?? "unknown") : "unknown";
    const startTs = openRec !== null ? num(openRec.ts) : ts;
    const ms = Math.max(0, ts - startTs);
    if (block.is_error === true) {
      const contentText =
        typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
      push({
        kind: "tool.error",
        ts,
        tool: { name, callId, ms, ok: false },
        error: { message: contentText.slice(0, 1024) },
      });
    } else {
      push({ kind: "tool.post", ts, tool: { name, callId, ms, ok: true } });
    }
    openCalls = dropKey(openCalls, callId);
  }

  let spawned = state.spawned;
  const toolUseResult = parsed.toolUseResult;
  if (isRec(toolUseResult)) {
    // Real Claude's `toolUseResult` carries no call id of its own (verified against ~150 real
    // transcripts): the spawn call id is the `tool_use_id` of this same line's `tool_result`
    // block — the Agent-tool call this line reports the result of (design.md § Mapeo Claude).
    const spawnCallId = toolResultBlocks.length > 0 ? str(toolResultBlocks[0]!.tool_use_id) : null;
    const subAgentId = str(toolUseResult.agentId);
    const status = str(toolUseResult.status);
    if (subAgentId !== null && status === "completed") {
      const openRec =
        spawnCallId !== null && isRec(openCallsBeforeResults[spawnCallId])
          ? openCallsBeforeResults[spawnCallId]
          : null;
      const outcomeType = isRec(openRec) ? (str(openRec.subagentType) ?? str(openRec.name)) : null;
      const agent: CrowEventAgent = { outcome: "completed" };
      if (outcomeType !== null) agent.type = outcomeType;
      push({ kind: "agent.stop", ts, agentId: subAgentId, agent });
    } else if (subAgentId !== null && status === "async_launched" && spawnCallId !== null) {
      spawned = { ...spawned, [spawnCallId]: subAgentId };
    }
  }

  const origin = parsed.origin;
  const isTaskNotification = isRec(origin) && origin.kind === "task-notification";
  if (isTaskNotification && typeof contentVal === "string") {
    // Real Claude's task-notification line carries its payload as an XML-ish string inside
    // `message.content` (design.md § Mapeo Claude: "<tool-use-id>" + "<status>"), not as
    // top-level fields.
    const toolUseId = extractXmlTag(contentVal, "tool-use-id");
    const status = extractXmlTag(contentVal, "status");
    const spawnedAgentId = toolUseId !== null ? spawned[toolUseId] : undefined;
    if (toolUseId !== null && status !== null && typeof spawnedAgentId === "string") {
      const outcome =
        status === "completed" ? "completed" : status === "killed" ? "killed" : "failed";
      push({ kind: "agent.stop", ts, agentId: spawnedAgentId, agent: { outcome } });
      spawned = dropKey(spawned, toolUseId);
    }
  }

  const handled = toolResultBlocks.length > 0 || isRec(toolUseResult) || isTaskNotification;
  if (!handled) {
    const promptSource = str(parsed.promptSource);
    const originKind = isRec(origin) ? str(origin.kind) : null;
    const isMeta = isRec(message) && message.isMeta === true;
    const isCompactSummary = isRec(message) && message.isCompactSummary === true;
    const contentIsString = typeof contentVal === "string";
    const isPrompt =
      originKind === "human" ||
      (promptSource !== null && promptSource !== "system") ||
      (originKind === null &&
        promptSource === null &&
        contentIsString &&
        !isMeta &&
        !isCompactSummary);
    if (isPrompt) {
      const text = contentIsString ? (contentVal as string).slice(0, 8192) : undefined;
      push({ kind: "prompt", ts, text });
    }
  }

  return { openCalls, spawned };
}

/** `packages/adapters/claude/src/adapter.ts`'s `EngineAdapter.parseLine` — see design.md § Mapeo Claude. */
export function mapClaudeLine(
  rawLine: string,
  state: ClaudeState,
  pos: LinePos,
): LineResult<ClaudeState> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    return { ok: false, reason: "invalid-json", sessionId: "unknown", agentId: null, state };
  }
  if (!isRec(parsed) || typeof parsed.type !== "string") {
    return { ok: false, reason: "bad-shape", sessionId: "unknown", agentId: null, state };
  }

  const type = parsed.type;
  const sessionId = str(parsed.sessionId) ?? "unknown";
  const agentId = str(parsed.agentId);
  const uuid = str(parsed.uuid) ?? `line:${pos.offset}`; // defensive: real Claude lines always have one
  const cwdFromLine = str(parsed.cwd);
  const cwd = cwdFromLine ?? state.cwd;
  const tsRaw = str(parsed.timestamp);
  const parsedTs = tsRaw !== null ? Date.parse(tsRaw) : Number.NaN;
  // Last-resort fallback (design.md § Mapeo Claude): no mapped line has ever been observed
  // without a timestamp, but the chain stays defined either way.
  const ts = Number.isFinite(parsedTs) ? parsedTs : state.lastTs || Date.now();

  const pushed: Push[] = [];
  const push = (ev: Push): void => {
    pushed.push(ev);
  };

  if (!state.started) {
    if (agentId === null) {
      push({ kind: "session.start", ts });
    } else {
      const meta = isRec(state.meta) ? state.meta : null;
      const agent: CrowEventAgent = { depth: typeof meta?.depth === "number" ? meta.depth : 1 };
      const metaType = meta !== null ? str(meta.type) : null;
      const metaDescription = meta !== null ? str(meta.description) : null;
      const metaSpawnCallId = meta !== null ? str(meta.spawnCallId) : null;
      if (metaType !== null) agent.type = metaType;
      if (metaDescription !== null) agent.description = metaDescription;
      if (metaSpawnCallId !== null) agent.spawnCallId = metaSpawnCallId;
      push({ kind: "agent.start", ts, agent });
    }
  }

  let openCalls = state.openCalls;
  let spawned = state.spawned;
  let seenMessageIds = state.seenMessageIds;

  if (type === "assistant") {
    const message = parsed.message;
    if (!isRec(message)) {
      return { ok: false, reason: "bad-shape", sessionId, agentId, state };
    }
    const result = mapAssistant(
      message,
      agentId,
      { ...state, openCalls, seenMessageIds },
      ts,
      push,
    );
    openCalls = result.openCalls;
    seenMessageIds = result.seenMessageIds;
  } else if (type === "user") {
    const result = mapUser(parsed, ts, { ...state, openCalls, spawned }, push);
    openCalls = result.openCalls;
    spawned = result.spawned;
  } else if (type === "system") {
    if (parsed.subtype === "compact_boundary") {
      push({ kind: "compact", ts });
    }
  } else if (!KNOWN_NO_EVENT_TYPES.has(type)) {
    return { ok: false, reason: "unknown-type", detail: type, sessionId, agentId, state };
  }

  const events: PartialCrowEvent[] = pushed.map((ev, index) => ({
    sessionId,
    agentId: ev.agentId !== undefined ? ev.agentId : agentId,
    parentAgentId: null,
    cwd: cwd ?? undefined,
    semanticKey: `uuid:${uuid}:${index}`,
    ...ev,
  }));

  const nextState: ClaudeState = {
    v: state.v,
    started: true,
    cwd: cwd ?? null,
    lastTs: ts,
    openCalls,
    spawned,
    seenMessageIds,
    meta: state.meta,
  };

  return { ok: true, events, state: nextState };
}
