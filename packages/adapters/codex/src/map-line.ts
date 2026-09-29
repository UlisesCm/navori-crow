/**
 * Codex rollout line -> `PartialCrowEvent[]` (design.md § Mapeo Codex, R14,
 * R16). Pure: never throws, never reads the clock or the disk.
 *
 * State shape (design.md, verbatim): `{ v, sessionId, agentId, parentAgentId,
 * cwd, model, startOrdinal, historyStart, lastTotal, openCalls }`. `openCalls`
 * is capped (design.md § Mapeo Claude applies the same 256 bound to Codex's
 * equivalent) so a long-running thread can't grow `state_json` without bound.
 */
import type {
  CrowEventAgent,
  CrowEventUsage,
  JsonValue,
  LinePos,
  LineResult,
  LineWarning,
  PartialCrowEvent,
  Rec,
} from "@crow/core";
import { isRec, num, path, str } from "@crow/core";

/** Cap on `CodexState.openCalls` entries (mirrors Claude's `MAX_OPEN_CALLS`, design.md § Mapeo Claude). */
const MAX_OPEN_CALLS = 256;

/** The four components Codex's `total_token_usage`/`last_token_usage` track (design.md § Evidencia).
 * The index signature keeps it a valid {@link JsonValue} so it can sit in `CodexState.lastTotal`. */
interface TokenTotals {
  [key: string]: number;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
}

/** Persisted, round-tripped adapter state (design.md § Mapeo Codex). `S extends JsonValue`. */
export interface CodexState {
  [key: string]: JsonValue;
  v: number;
  started: boolean;
  /** Filename-derived fallback (design.md: "sin `session_meta` previo, `sessionId` sale del nombre del archivo"), overwritten once `session_meta` is seen. */
  sessionId: string;
  /** `null` until a subagent `session_meta` identifies this file as a subagent thread. */
  agentId: string | null;
  /** The thread that spawned this one, from `thread_spawn.parent_thread_id`; `null` when it's the
   * root session or that field is absent/equal to the root's own `session_id` (design.md § Evidencia:
   * "`parent_thread_id` coincide con `session_id` en 123 casos" out of 185 — the rest are nested). */
  parentAgentId: string | null;
  cwd: string | null;
  model: string | null;
  /** `subagent_history_start_ordinal` as read from the first `session_meta`; only a candidate until copied history is seen. */
  startOrdinal: number | null;
  /** The ordinal below which lines are inherited history to skip. Set from `startOrdinal` only when a second
   * `session_meta` (the parent's copy) shows this file really carries copied history; `null` otherwise, so a
   * fork with a single `session_meta` (fixtures 0.145.0 id19/id32, guardian id70) ingests every line. */
  historyStart: number | null;
  /** The last `total_token_usage` seen; `null` before the file's first `token_count` (D7 baseline). */
  lastTotal: TokenTotals | null;
  lastTs: number;
  /** `callId -> { name, ts }`, open `function_call`/`custom_tool_call`s awaiting their `*_call_output`. */
  openCalls: { [callId: string]: JsonValue };
}

/** Fresh state for a newly-seen file; `sessionId` is the filename-derived fallback from `FileMatch`. */
export function initialCodexState(sessionId: string): CodexState {
  return {
    v: 1,
    started: false,
    sessionId,
    agentId: null,
    parentAgentId: null,
    cwd: null,
    model: null,
    startOrdinal: null,
    historyStart: null,
    lastTotal: null,
    lastTs: 0,
    openCalls: {},
  };
}

function isTokenTotals(v: unknown): v is TokenTotals {
  return (
    isRec(v) &&
    typeof v.input === "number" &&
    typeof v.cached === "number" &&
    typeof v.cacheWrite === "number" &&
    typeof v.output === "number"
  );
}

/** `restoreState`: rejects anything that isn't shaped like a {@link CodexState} (D5: re-ingest from 0). */
export function restoreCodexState(json: unknown): CodexState | null {
  if (!isRec(json)) return null;
  if (typeof json.v !== "number" || typeof json.started !== "boolean") return null;
  if (typeof json.sessionId !== "string" || typeof json.lastTs !== "number") return null;
  // States persisted before B7.T3 also carry `recentPrompts`: ignored here, dropped on the next save.
  if (!isRec(json.openCalls)) return null;
  const lastTotal = json.lastTotal === null ? null : json.lastTotal;
  if (lastTotal !== null && !isTokenTotals(lastTotal)) return null;
  const historyStart = typeof json.historyStart === "number" ? json.historyStart : null;
  return {
    v: json.v,
    started: json.started,
    sessionId: json.sessionId,
    agentId: str(json.agentId),
    parentAgentId: str(json.parentAgentId),
    cwd: str(json.cwd),
    model: str(json.model),
    // States persisted before `startOrdinal` existed only have `historyStart`: keep it as the candidate too.
    startOrdinal: typeof json.startOrdinal === "number" ? json.startOrdinal : historyStart,
    historyStart,
    lastTotal,
    lastTs: json.lastTs,
    openCalls: json.openCalls as CodexState["openCalls"],
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

/** One event this line contributes, before `sessionId`/`agentId`/`parentAgentId`/`cwd` are filled in
 * uniformly. `semanticKey` is set per-push (design.md § Mapeo Codex), unlike Claude's uniform `uuid:`
 * key; `agentId`/`parentAgentId` are overridden by `agent.start` (the thread's own identity and its
 * real parent), same as everything else defaults to the file's current thread. */
type Push = Partial<Pick<PartialCrowEvent, "agentId" | "parentAgentId" | "semanticKey">> &
  Omit<PartialCrowEvent, "sessionId" | "agentId" | "parentAgentId" | "cwd">;

/** `input_tokens`/`cached_input_tokens`/`cache_write_input_tokens`/`output_tokens` (design.md § Evidencia). */
function readTotals(rec: Rec): TokenTotals {
  return {
    input: num(rec.input_tokens),
    cached: num(rec.cached_input_tokens),
    cacheWrite: num(rec.cache_write_input_tokens),
    output: num(rec.output_tokens),
  };
}

/** design.md § Mapeo Codex: `input = input - cached`, `cacheRead = cached`, `cacheCreation = cacheWrite`. Never negative (D7's regression guard resets the baseline before this runs on a bad delta). */
function toUsage(totals: TokenTotals, model: string | null): CrowEventUsage {
  return {
    input: Math.max(0, totals.input - totals.cached),
    output: totals.output,
    cacheRead: totals.cached,
    cacheCreation: totals.cacheWrite,
    model: model ?? undefined,
  };
}

/** `next - prev` per component; `null` if any component went backwards (D7: "un retroceso produce `usage-anomaly`"). */
function totalsDelta(prev: TokenTotals, next: TokenTotals): TokenTotals | null {
  const delta: TokenTotals = {
    input: next.input - prev.input,
    cached: next.cached - prev.cached,
    cacheWrite: next.cacheWrite - prev.cacheWrite,
    output: next.output - prev.output,
  };
  if (delta.input < 0 || delta.cached < 0 || delta.cacheWrite < 0 || delta.output < 0) return null;
  return delta;
}

function isZeroTotals(t: TokenTotals): boolean {
  return t.input === 0 && t.cached === 0 && t.cacheWrite === 0 && t.output === 0;
}

/**
 * `event_msg.token_count` (design.md D7 "Usage de Codex"): the first `token_count` for this file
 * counts `last_token_usage` and seeds `state.lastTotal` from `total_token_usage` — so a fork's
 * inherited accumulator is never counted. Later lines count only the positive delta of
 * `total_token_usage`; a delta of 0 emits nothing (repeated totals); a component that goes
 * backwards resets the baseline, emits `last_token_usage`, and raises `usage-anomaly`.
 */
function mapTokenCount(
  info: Rec,
  state: CodexState,
  ts: number,
  push: (ev: Push) => void,
  warn: (w: LineWarning) => void,
): TokenTotals | null {
  const totalRaw = info.total_token_usage;
  const lastRaw = info.last_token_usage;
  if (!isRec(totalRaw) || !isRec(lastRaw)) return state.lastTotal;

  const total = readTotals(totalRaw);
  const last = readTotals(lastRaw);
  const model = state.model;

  if (state.lastTotal === null) {
    push({ kind: "assistant.message", ts, usage: toUsage(last, model) });
    return total;
  }

  const delta = totalsDelta(state.lastTotal, total);
  if (delta === null) {
    push({ kind: "assistant.message", ts, usage: toUsage(last, model) });
    warn({
      reason: "usage-anomaly",
      detail: "codex token_count total_token_usage regressed against the tracked baseline",
    });
    return total;
  }
  if (isZeroTotals(delta)) return total;

  push({ kind: "assistant.message", ts, usage: toUsage(delta, model) });
  return total;
}

/** `session_meta` (design.md § Mapeo Codex, first line only — later ones are forks copying the parent's, "Nada"). */
function mapSessionMeta(
  payload: Rec,
  state: CodexState,
  ts: number,
  push: (ev: Push) => void,
): Pick<CodexState, "sessionId" | "agentId" | "parentAgentId" | "cwd" | "startOrdinal"> {
  const id = str(payload.id);
  const cwd = str(payload.cwd);
  const historyStartRaw = payload.subagent_history_start_ordinal;
  const startOrdinal = typeof historyStartRaw === "number" ? historyStartRaw : null;
  const subagent = path(payload, "source", "subagent");

  if (subagent === undefined) {
    const sessionId = id ?? state.sessionId;
    push({ kind: "session.start", ts });
    return { sessionId, agentId: null, parentAgentId: null, cwd: cwd ?? state.cwd, startOrdinal };
  }

  // Threads are agent records *of* the root session (task scope: they don't become separate
  // sessions), but that doesn't force their parent to be the root — 62/185 subagent files in
  // design.md's evidence (§ Evidencia: "parent_thread_id coincide con session_id en 123 casos") are
  // spawned by another thread, not by the root, and their real parent is resolved below.
  const sessionId = str(payload.session_id) ?? state.sessionId;
  const agentId = id ?? state.sessionId;
  const threadSpawn = isRec(subagent) ? subagent.thread_spawn : undefined;
  const roleType = isRec(threadSpawn) ? str(threadSpawn.agent_role) : null;
  const otherType = isRec(subagent) ? str(subagent.other) : null;
  const description = isRec(threadSpawn) ? str(threadSpawn.agent_nickname) : null;

  // JSON path pinned against fixtures/codex/0.155.1 (id30) and 0.145.0 (id19, id32):
  // `payload.source.subagent.thread_spawn.{parent_thread_id,depth}`. A `guardian` has no `thread_spawn`,
  // but fixtures/codex/0.155.1 (id70) carries its parent at the top-level `payload.parent_thread_id`
  // (here a nested thread, not the root), so that field is the fallback.
  const parentThreadIdRaw = isRec(threadSpawn)
    ? (threadSpawn.parent_thread_id ?? payload.parent_thread_id)
    : payload.parent_thread_id;
  const parentThreadId = str(parentThreadIdRaw);
  const parentAgentId =
    parentThreadId !== null && parentThreadId !== sessionId ? parentThreadId : null;
  const depthRaw = isRec(threadSpawn) ? threadSpawn.depth : undefined;
  const depth =
    typeof depthRaw === "number" && Number.isInteger(depthRaw) && depthRaw > 0
      ? depthRaw
      : parentAgentId !== null
        ? 2
        : 1;

  const agent: CrowEventAgent = { depth };
  const type = roleType ?? otherType;
  if (type !== null) agent.type = type;
  if (description !== null) agent.description = description;
  push({ kind: "agent.start", ts, agentId, parentAgentId, agent });
  return { sessionId, agentId, parentAgentId, cwd: cwd ?? state.cwd, startOrdinal };
}

/** `event_msg.item_completed` with `item.type = "UserMessage"` (design.md § Mapeo Codex): one `prompt` per
 * real user turn, `semanticKey = item:<item.id>:0` so a re-emitted line dedupes. Text is the concatenated
 * `content[].text` blocks, capped at 8 KiB; no `item.id` means no key (line-content dedupe only). */
function mapUserMessageItem(item: Rec, ts: number, push: (ev: Push) => void): void {
  const id = str(item.id);
  const blocks = Array.isArray(item.content) ? item.content.filter(isRec) : [];
  const parts = blocks.filter((b) => typeof b.text === "string").map((b) => b.text as string);
  const text = parts.length > 0 ? parts.join("").slice(0, 8192) : undefined;
  push({ kind: "prompt", ts, text, semanticKey: id !== null ? `item:${id}:0` : undefined });
}

/** `response_item` subtypes real rollouts carry that map to no event (design.md § Mapeo Codex, "conocidos sin evento"). */
const KNOWN_NO_EVENT_RESPONSE_ITEMS = new Set([
  "reasoning",
  "agent_message",
  "tool_search_call",
  "tool_search_output",
]);

/** `response_item` (design.md § Mapeo Codex): `message` (assistant only), `function_call`/`custom_tool_call`,
 * and `*_call_output`. Returns `null` for an unrecognized subtype (`ingest.error unknown-type`). */
function mapResponseItem(
  item: Rec,
  ts: number,
  openCalls: CodexState["openCalls"],
  push: (ev: Push) => void,
): CodexState["openCalls"] | null {
  const subtype = str(item.type);
  if (subtype === "message") {
    if (item.role !== "assistant") return openCalls; // other roles: known, no event (table "sin evento")
    const id = str(item.id);
    const blocks = Array.isArray(item.content) ? item.content.filter(isRec) : [];
    const textParts = blocks
      .filter((b) => (b.type === "output_text" || b.type === "text") && typeof b.text === "string")
      .map((b) => b.text as string);
    const text = textParts.length > 0 ? textParts.join("").slice(0, 8192) : undefined;
    const semanticKey = id !== null ? `id:${id}:0` : undefined;
    push({ kind: "assistant.message", ts, text, semanticKey });
    return openCalls;
  }
  if (subtype === "function_call" || subtype === "custom_tool_call") {
    const callId = str(item.call_id);
    if (callId === null) return openCalls;
    const name = str(item.name) ?? "unknown";
    const input = subtype === "function_call" ? item.arguments : item.input;
    push({
      kind: "tool.pre",
      ts,
      tool: { name, callId, input },
      semanticKey: `call:${callId}`,
    });
    return capInsert(openCalls, callId, { name, ts });
  }
  if (subtype !== null && subtype.endsWith("_call_output")) {
    const callId = str(item.call_id);
    if (callId === null) return openCalls;
    const openCall = openCalls[callId];
    const openRec = isRec(openCall) ? openCall : null;
    const name = openRec !== null ? (str(openRec.name) ?? "unknown") : "unknown";
    const startTs = openRec !== null ? num(openRec.ts) : ts;
    const ms = Math.max(0, ts - startTs);
    // Codex doesn't emit tool.error in F1 (design.md § Mapeo Codex, "Limitaciones").
    push({
      kind: "tool.post",
      ts,
      tool: { name, callId, ms, ok: true },
      semanticKey: `out:${callId}`,
    });
    return dropKey(openCalls, callId);
  }
  if (subtype !== null && KNOWN_NO_EVENT_RESPONSE_ITEMS.has(subtype)) return openCalls;
  return null; // unrecognized response_item subtype
}

/** Known top-level types that carry no mappable event (design.md § Mapeo Codex). `event_msg` subtypes
 * other than `item_completed`/`token_count` also carry no event, handled inline in {@link mapCodexLine}. */
const KNOWN_NO_EVENT_TOP_TYPES = new Set([
  "turn_context", // handled separately: updates model/cwd
  "token_usage_record",
  "world_state",
  "inter_agent_communication_metadata",
]);

/** Line-level failure carrying the state's session (`null` while it is still the "unknown" placeholder) and last `cwd`. */
function failure(reason: "invalid-json" | "bad-shape", state: CodexState): LineResult<CodexState> {
  return {
    ok: false,
    reason,
    sessionId: state.sessionId === "unknown" ? null : state.sessionId,
    agentId: state.agentId,
    ...(state.cwd !== null ? { cwd: state.cwd } : {}),
    state,
  };
}

/** `packages/adapters/codex/src/adapter.ts`'s `EngineAdapter.parseLine` — see design.md § Mapeo Codex. */
export function mapCodexLine(
  rawLine: string,
  state: CodexState,
  _pos: LinePos,
): LineResult<CodexState> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    return failure("invalid-json", state);
  }
  if (!isRec(parsed) || typeof parsed.type !== "string") {
    return failure("bad-shape", state);
  }

  const type = parsed.type;
  const tsRaw = str(parsed.timestamp);
  const parsedTs = tsRaw !== null ? Date.parse(tsRaw) : Number.NaN;
  const ts = Number.isFinite(parsedTs) ? parsedTs : state.lastTs || Date.now();
  const ordinalRaw = parsed.ordinal;
  const ordinal = typeof ordinalRaw === "number" ? ordinalRaw : null;

  const pushed: Push[] = [];
  const push = (ev: Push): void => {
    pushed.push(ev);
  };
  const warnings: LineWarning[] = [];
  const warn = (w: LineWarning): void => {
    warnings.push(w);
  };

  let sessionId = state.sessionId;
  let agentId = state.agentId;
  let parentAgentId = state.parentAgentId;
  let cwd = state.cwd;
  let model = state.model;
  let startOrdinal = state.startOrdinal;
  let historyStart = state.historyStart;
  let lastTotal = state.lastTotal;
  let openCalls = state.openCalls;
  let started = state.started;

  if (type === "session_meta") {
    if (!started) {
      const payload = parsed.payload;
      if (!isRec(payload)) {
        return { ok: false, reason: "bad-shape", sessionId, agentId, cwd: cwd ?? undefined, state };
      }
      const result = mapSessionMeta(payload, state, ts, push);
      sessionId = result.sessionId;
      agentId = result.agentId;
      parentAgentId = result.parentAgentId;
      cwd = result.cwd;
      startOrdinal = result.startOrdinal;
      started = true;
    } else {
      // A later `session_meta` is the parent's copy: it emits nothing, but it proves this file carries
      // copied history, so the start ordinal now applies (fixtures 0.155.1 id30: line 2, ordinal 1).
      historyStart = startOrdinal;
    }
  } else if (ordinal !== null && historyStart !== null && ordinal < historyStart) {
    // Inherited history skipped via subagent_history_start_ordinal (design.md § Mapeo Codex): no event.
  } else if (type === "turn_context") {
    const payload = parsed.payload;
    if (!isRec(payload)) {
      return { ok: false, reason: "bad-shape", sessionId, agentId, cwd: cwd ?? undefined, state };
    }
    model = str(payload.model) ?? model;
    cwd = str(payload.cwd) ?? cwd;
  } else if (type === "event_msg") {
    const payload = parsed.payload;
    if (!isRec(payload)) {
      return { ok: false, reason: "bad-shape", sessionId, agentId, cwd: cwd ?? undefined, state };
    }
    const subtype = str(payload.type);
    if (subtype === "item_completed") {
      // Only `UserMessage` maps (prompt); other item types (AgentMessage, tools, Reasoning...) are "Nada".
      const item = payload.item;
      if (isRec(item) && item.type === "UserMessage") mapUserMessageItem(item, ts, push);
    } else if (subtype === "token_count") {
      const info = payload.info;
      if (isRec(info)) {
        lastTotal = mapTokenCount(info, { ...state, model, lastTotal }, ts, push, warn);
      } // token_count without `info`: design.md's evidence shows `info` is how usage arrives; a bare
      // line without it carries nothing to count (round 4-style tolerance, mirrors Claude's stance).
    } // any other event_msg subtype (e.g. agent_message, task_started): design.md "Nada"
  } else if (type === "response_item") {
    const payload = parsed.payload;
    if (!isRec(payload)) {
      return { ok: false, reason: "bad-shape", sessionId, agentId, cwd: cwd ?? undefined, state };
    }
    const result = mapResponseItem(payload, ts, openCalls, push);
    if (result === null) {
      const subtype = str(payload.type) ?? "unknown";
      return {
        ok: false,
        reason: "unknown-type",
        detail: `response_item:${subtype}`,
        sessionId,
        agentId,
        state,
      };
    }
    openCalls = result;
  } else if (type === "compacted") {
    push({ kind: "compact", ts });
  } else if (!KNOWN_NO_EVENT_TOP_TYPES.has(type)) {
    return {
      ok: false,
      reason: "unknown-type",
      detail: type,
      sessionId,
      agentId,
      cwd: cwd ?? undefined,
      state,
    };
  }

  const events: PartialCrowEvent[] = pushed.map((ev) => ({
    sessionId,
    agentId: ev.agentId !== undefined ? ev.agentId : agentId,
    parentAgentId: ev.parentAgentId !== undefined ? ev.parentAgentId : parentAgentId,
    cwd: cwd ?? undefined,
    ...ev,
  }));

  const nextState: CodexState = {
    v: state.v,
    started,
    sessionId,
    agentId,
    parentAgentId,
    cwd,
    model,
    startOrdinal,
    historyStart,
    lastTotal,
    lastTs: ts,
    openCalls,
  };

  return warnings.length > 0
    ? { ok: true, events, warnings, state: nextState }
    : { ok: true, events, state: nextState };
}
