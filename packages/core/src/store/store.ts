import type { Database, SQLQueryBindings } from "bun:sqlite";
import { basename } from "node:path";
import type { AgentMetaPatch, JsonValue, LinePos, PartialCrowEvent } from "../adapter";
import type {
  AgentNode,
  ProjectSummary,
  SessionSummary,
  SessionStatus,
  Totals,
  IngestStats,
} from "../api-types";
import type {
  CrowEvent,
  CrowEventUsage,
  EngineId,
  EventKind,
  EventSource,
  IngestErrorReason,
} from "../crow-event";
import { costUsd as computeCostUsd } from "../pricing";
import { projectKey as resolveProjectKey } from "../project-key";
import { localDay } from "../time";
import type { ClockFn } from "../ulid";
import { weightedTokens } from "../weighted-tokens";

const ZERO_TOTALS: Totals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  cacheCreation1h: 0,
  weightedTokens: 0,
  costUsd: 0,
  unpricedUsages: 0,
};

/** The reserved project key a session gets before its first `cwd`-bearing event (D8). */
const UNRESOLVED_PROJECT = "unresolved";

// ---------------------------------------------------------------------------
// Row shapes (private to this module; DTOs in `api-types.ts` are the public
// surface the API and web layers see).
// ---------------------------------------------------------------------------

interface ProjectRow {
  key: string;
  path: string;
  name: string;
  first_seen: number;
  last_seen: number;
  last_error_json: string | null;
}

interface TotalsRow {
  t_input: number;
  t_output: number;
  t_cache_read: number;
  t_cache_creation: number;
  t_cache_creation_1h: number;
  t_weighted: number;
  t_cost_usd: number;
  t_unpriced: number;
}

interface SessionRow extends TotalsRow {
  id: string;
  engine: string;
  native_id: string;
  project_key: string;
  started_at: number;
  ended_at: number | null;
  last_event_at: number;
  status: SessionStatus;
  model: string | null;
  last_prompt: string | null;
}

interface AgentRow extends TotalsRow {
  id: string;
  session_id: string;
  agent_id: string | null;
  parent_id: string | null;
  type: string | null;
  description: string | null;
  spawn_call_id: string | null;
  depth: number | null;
  model: string | null;
  started_at: number | null;
  ended_at: number | null;
  last_event_at: number | null;
}

function totalsFromRow(row: TotalsRow): Totals {
  return {
    input: row.t_input,
    output: row.t_output,
    cacheRead: row.t_cache_read,
    cacheCreation: row.t_cache_creation,
    cacheCreation1h: row.t_cache_creation_1h,
    weightedTokens: row.t_weighted,
    costUsd: row.t_cost_usd,
    unpricedUsages: row.t_unpriced,
  };
}

/** `agents.id`: `${sessionId}/${agentId ?? 'main'}` (design.md § Esquema v1). */
function agentRowId(sessionId: string, agentId: string | null): string {
  return `${sessionId}/${agentId ?? "main"}`;
}

/** Extracts the native `agentId` (or `null` for the main thread) out of an `agents.id`/`parent_id`. */
function nativeAgentIdFromRowId(rowId: string): string | null {
  const suffix = rowId.slice(rowId.lastIndexOf("/") + 1);
  return suffix === "main" ? null : suffix;
}

/** `sessions.id`: `${engine}:${nativeSessionId}` (design.md § Esquema v1). */
function compositeSessionId(engine: EngineId, nativeSessionId: string): string {
  return `${engine}:${nativeSessionId}`;
}

/**
 * The 5 numeric components a `usageKey` dedupe row tracks (round 4, D7/R13): the component-wise
 * MAX seen so far for that `(agent, message.id)`, not a single fingerprint — real Claude re-emits
 * the same `message.id` across streamed chunks with `output_tokens` (and, in principle, any other
 * component) growing, so "first wins" silently dropped that growth (~21% of `output` undercounted
 * on the real `cc-2.1.281` fixture, `.claude/progress/impl_f1-b4t3-contract.md` round 4).
 */
interface UsageComponents {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  cacheCreation1h: number;
}

function usageComponents(usage: CrowEventUsage): UsageComponents {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheCreation: usage.cacheCreation,
    cacheCreation1h: usage.cacheCreation1h ?? 0,
  };
}

function isZeroUsageDelta(d: UsageComponents): boolean {
  return (
    d.input === 0 &&
    d.output === 0 &&
    d.cacheRead === 0 &&
    d.cacheCreation === 0 &&
    d.cacheCreation1h === 0
  );
}

/**
 * The positive, component-wise delta from `stored` (the previously-tracked max) to `next` (this
 * line's usage) — or `null` if ANY component of `next` is below `stored` (an anomaly: something
 * about this line's usage doesn't fit the "monotonically non-decreasing per component" model, so it
 * isn't trusted at all, not even for its growing components).
 */
function usageDelta(stored: UsageComponents, next: UsageComponents): UsageComponents | null {
  if (
    next.input < stored.input ||
    next.output < stored.output ||
    next.cacheRead < stored.cacheRead ||
    next.cacheCreation < stored.cacheCreation ||
    next.cacheCreation1h < stored.cacheCreation1h
  ) {
    return null;
  }
  return {
    input: next.input - stored.input,
    output: next.output - stored.output,
    cacheRead: next.cacheRead - stored.cacheRead,
    cacheCreation: next.cacheCreation - stored.cacheCreation,
    cacheCreation1h: next.cacheCreation1h - stored.cacheCreation1h,
  };
}

function nextStatus(
  current: SessionStatus,
  kind: EventKind,
  ts: number,
  now: number,
  idleMs: number,
): SessionStatus {
  if (kind === "session.end") return "ended";
  if (ts >= now - idleMs) return "live"; // even from `ended` — resumption (D10)
  return current === "ended" ? "ended" : "idle";
}

// ---------------------------------------------------------------------------
// Low-level statement helpers
// ---------------------------------------------------------------------------

function ensureProject(db: Database, key: string, path: string, name: string, ts: number): void {
  db.query(
    `INSERT INTO projects (key, path, name, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET last_seen = excluded.last_seen`,
  ).run(key, path, name, ts, ts);
}

function projectPathFor(db: Database, key: string): string {
  const row = db
    .query<{ path: string }, [string]>("SELECT path FROM projects WHERE key = ?")
    .get(key);
  return row?.path ?? "";
}

/**
 * Resolves (and lazily creates) the session + project row for an event,
 * applying sticky-project assignment (D8): the session keeps the project
 * of its first `cwd`-bearing event; a session with no `cwd` yet lives under
 * the reserved `unresolved` project until one arrives.
 */
function ensureSession(
  db: Database,
  engine: EngineId,
  nativeSessionId: string,
  cwd: string | undefined,
  ts: number,
): { id: string; projectKey: string } {
  const id = compositeSessionId(engine, nativeSessionId);
  const existing = db
    .query<{ project_key: string }, [string]>("SELECT project_key FROM sessions WHERE id = ?")
    .get(id);

  if (existing === null) {
    const resolved = cwd !== undefined ? resolveProjectKey(cwd) : null;
    const projKey = resolved?.key ?? UNRESOLVED_PROJECT;
    ensureProject(
      db,
      projKey,
      resolved?.path ?? "",
      resolved ? basename(resolved.path) : UNRESOLVED_PROJECT,
      ts,
    );
    db.query(
      `INSERT INTO sessions (id, engine, native_id, project_key, started_at, last_event_at, status)
       VALUES (?, ?, ?, ?, ?, ?, 'live')`,
    ).run(id, engine, nativeSessionId, projKey, ts, ts);
    return { id, projectKey: projKey };
  }

  if (existing.project_key === UNRESOLVED_PROJECT && cwd !== undefined) {
    const resolved = resolveProjectKey(cwd);
    ensureProject(db, resolved.key, resolved.path, basename(resolved.path), ts);
    db.query("UPDATE sessions SET project_key = ? WHERE id = ?").run(resolved.key, id);
    db.query("UPDATE events SET project_key = ? WHERE session_id = ?").run(resolved.key, id);
    return { id, projectKey: resolved.key };
  }

  return { id, projectKey: existing.project_key };
}

function ensureAgent(
  db: Database,
  sessionId: string,
  agentId: string | null,
  parentAgentId: string | null,
  ts: number,
): string {
  const id = agentRowId(sessionId, agentId);
  const existing = db.query<{ id: string }, [string]>("SELECT id FROM agents WHERE id = ?").get(id);
  if (existing === null) {
    const parentId = parentAgentId !== null ? agentRowId(sessionId, parentAgentId) : null;
    db.query(
      `INSERT INTO agents (id, session_id, agent_id, parent_id, started_at, last_event_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, sessionId, agentId, parentId, ts, ts);
  }
  return id;
}

/**
 * Resolves the `agents.id` of whichever agent recorded a `tool.pre` with
 * `call_id = spawnCallId` in this session, or `null` if that call hasn't
 * been ingested yet (design.md ingestBatch step 5: "la resolución del padre
 * para depth > 1"). The Claude adapter never knows this natively — it only
 * knows the call id that spawned it — so depth > 1 parenthood is resolved
 * here, by content, not by the adapter.
 */
function resolveDepthParent(db: Database, sessionId: string, spawnCallId: string): string | null {
  const row = db
    .query<{ agent_id: string | null }, [string, string]>(
      "SELECT agent_id FROM events WHERE session_id = ? AND kind = 'tool.pre' AND call_id = ? LIMIT 1",
    )
    .get(sessionId, spawnCallId);
  return row === null ? null : agentRowId(sessionId, row.agent_id);
}

/**
 * Resolves any agent still pending its depth > 1 parent (B2's pending
 * decision, reconciled here) once a `tool.pre` with a matching `call_id` is
 * ingested — covers the "child before parent" processing order, symmetric
 * with {@link resolveDepthParent}'s "parent before child" lookup at
 * `agent.start` time. Both orders converge on the same final tree.
 */
function resolvePendingChildren(
  db: Database,
  sessionId: string,
  parentRowKey: string,
  callId: string,
): void {
  db.query(
    `UPDATE agents SET parent_id = ?
     WHERE session_id = ? AND depth > 1 AND parent_id IS NULL AND spawn_call_id = ?`,
  ).run(parentRowKey, sessionId, callId);
}

function insertDedupe(
  db: Database,
  source: EventSource,
  sessionId: string,
  key: string,
  fp: string | null,
): boolean {
  const result = db
    .query("INSERT OR IGNORE INTO dedupe (source, session_id, key, fp) VALUES (?, ?, ?, ?)")
    .run(source, sessionId, key, fp);
  return result.changes > 0;
}

/** Inserts a fresh usage-dedupe row for `usageKey`, seeded at `next` (this line's own components,
 * since the running max starts at zero). `INSERT OR IGNORE`: `true` only the first time this
 * `usageKey` is ever seen — same "first insert wins" idiom as {@link insertDedupe}. */
function insertUsageDedupe(
  db: Database,
  source: EventSource,
  sessionId: string,
  key: string,
  next: UsageComponents,
): boolean {
  const result = db
    .query(
      `INSERT OR IGNORE INTO dedupe
         (source, session_id, key, fp, u_input, u_output, u_cache_read, u_cache_creation, u_cache_creation_1h)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(
      source,
      sessionId,
      key,
      next.input,
      next.output,
      next.cacheRead,
      next.cacheCreation,
      next.cacheCreation1h,
    );
  return result.changes > 0;
}

/** The component-wise max currently tracked for `usageKey`. Only called after `insertUsageDedupe`
 * returned `false` (row already exists), so the row is guaranteed present. */
function readUsageDedupe(
  db: Database,
  source: EventSource,
  sessionId: string,
  key: string,
): UsageComponents {
  const row = db
    .query<
      {
        u_input: number;
        u_output: number;
        u_cache_read: number;
        u_cache_creation: number;
        u_cache_creation_1h: number;
      },
      [string, string, string]
    >(
      `SELECT u_input, u_output, u_cache_read, u_cache_creation, u_cache_creation_1h
       FROM dedupe WHERE source = ? AND session_id = ? AND key = ?`,
    )
    .get(source, sessionId, key);
  if (row === null) {
    throw new Error(
      `usage dedupe row missing for ${source}/${sessionId}/${key} (internal invariant)`,
    );
  }
  return {
    input: row.u_input,
    output: row.u_output,
    cacheRead: row.u_cache_read,
    cacheCreation: row.u_cache_creation,
    cacheCreation1h: row.u_cache_creation_1h,
  };
}

/** Advances the tracked max for `usageKey` to `next` (called only when every component of `next`
 * is ≥ the previously stored max, i.e. after {@link usageDelta} returned non-`null`). */
function updateUsageDedupeMax(
  db: Database,
  source: EventSource,
  sessionId: string,
  key: string,
  next: UsageComponents,
): void {
  db.query(
    `UPDATE dedupe SET u_input = ?, u_output = ?, u_cache_read = ?, u_cache_creation = ?, u_cache_creation_1h = ?
     WHERE source = ? AND session_id = ? AND key = ?`,
  ).run(
    next.input,
    next.output,
    next.cacheRead,
    next.cacheCreation,
    next.cacheCreation1h,
    source,
    sessionId,
    key,
  );
}

function incrementStat(db: Database, name: string, by = 1): void {
  db.query(
    "INSERT INTO ingest_stats (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = value + excluded.value",
  ).run(name, by);
}

const TOTALS_INCREMENT_SET = `
  t_input = t_input + ?, t_output = t_output + ?, t_cache_read = t_cache_read + ?,
  t_cache_creation = t_cache_creation + ?, t_cache_creation_1h = t_cache_creation_1h + ?,
  t_weighted = t_weighted + ?, t_cost_usd = t_cost_usd + ?, t_unpriced = t_unpriced + ?
`;

type TotalsParams = [number, number, number, number, number, number, number, number];

function totalsParams(
  usage: CrowEventUsage,
  priced: number | undefined,
  weighted: number,
): TotalsParams {
  return [
    usage.input,
    usage.output,
    usage.cacheRead,
    usage.cacheCreation,
    usage.cacheCreation1h ?? 0,
    weighted,
    priced ?? 0,
    priced === undefined ? 1 : 0,
  ];
}

/**
 * Prices and weighs a usage block, adds it to the session/agent/day totals in
 * the same transaction (R4), and stamps the session's and agent's `model`.
 * Returns the usage with `costUsd`/`weightedTokens` stamped (R20, R21).
 */
function applyUsage(
  db: Database,
  sessionId: string,
  agentRowKey: string,
  projectKey: string,
  usage: CrowEventUsage,
  ts: number,
): CrowEventUsage {
  const priced = computeCostUsd(usage);
  const weighted = weightedTokens(usage, usage.model ?? null);
  const params = totalsParams(usage, priced, weighted);

  db.query(`UPDATE sessions SET ${TOTALS_INCREMENT_SET} WHERE id = ?`).run(...params, sessionId);
  db.query(`UPDATE agents SET ${TOTALS_INCREMENT_SET} WHERE id = ?`).run(...params, agentRowKey);
  const day = localDay(ts);
  db.query(
    "INSERT INTO project_daily (project_key, day) VALUES (?, ?) ON CONFLICT(project_key, day) DO NOTHING",
  ).run(projectKey, day);
  db.query(
    `UPDATE project_daily SET ${TOTALS_INCREMENT_SET} WHERE project_key = ? AND day = ?`,
  ).run(...params, projectKey, day);

  if (usage.model) {
    db.query("UPDATE sessions SET model = ? WHERE id = ?").run(usage.model, sessionId);
    db.query("UPDATE agents SET model = ? WHERE id = ?").run(usage.model, agentRowKey);
  }

  return { ...usage, costUsd: priced, weightedTokens: weighted };
}

/** Builds the full stored `CrowEvent`, stamping what only the store can know and dropping the store-only fields. */
function stampEvent(
  id: string,
  engine: EngineId,
  source: EventSource,
  projectKey: string,
  projectPath: string,
  seq: number,
  partial: PartialCrowEvent,
): CrowEvent {
  const { usageKey: _usageKey, semanticKey: _semanticKey, ...rest } = partial;
  return { ...rest, id, engine, source, projectKey, projectPath, seq };
}

/**
 * Inserts one event row and applies its side effects: session status/
 * `last_event_at`/`last_prompt` (skipped for `ingest.error`, D10), and the
 * project's `last_error_json` for `tool.error`/`ingest.error`.
 */
function persistEvent(
  db: Database,
  deps: IngestBatchDeps,
  engine: EngineId,
  source: EventSource,
  sessionId: string,
  agentRowKey: string,
  projectKey: string,
  seq: number,
  partial: PartialCrowEvent,
): CrowEvent {
  const projectPath = projectPathFor(db, projectKey);
  const id = deps.nextId();
  const full = stampEvent(id, engine, source, projectKey, projectPath, seq, partial);

  db.query(
    `INSERT INTO events (id, session_id, project_key, agent_id, kind, ts, source, call_id, body_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    sessionId,
    projectKey,
    full.agentId,
    full.kind,
    full.ts,
    full.source,
    full.tool?.callId ?? null,
    JSON.stringify(full),
  );

  if (full.kind !== "ingest.error") {
    const now = deps.now();
    const current = db
      .query<{ status: SessionStatus; last_event_at: number }, [string]>(
        "SELECT status, last_event_at FROM sessions WHERE id = ?",
      )
      .get(sessionId);
    if (current !== null) {
      const status = nextStatus(current.status, full.kind, full.ts, now, deps.idleMs);
      const lastEventAt = Math.max(current.last_event_at, full.ts);
      db.query("UPDATE sessions SET status = ?, last_event_at = ? WHERE id = ?").run(
        status,
        lastEventAt,
        sessionId,
      );
    }
    if (full.kind === "session.end") {
      db.query("UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL").run(
        full.ts,
        sessionId,
      );
    }
    if (full.kind === "prompt" && full.text !== undefined) {
      db.query("UPDATE sessions SET last_prompt = ? WHERE id = ?").run(
        full.text.slice(0, 8192),
        sessionId,
      );
    }
    db.query(
      "UPDATE agents SET last_event_at = MAX(COALESCE(last_event_at, 0), ?) WHERE id = ?",
    ).run(full.ts, agentRowKey);
  }

  if (full.kind === "tool.error" || full.kind === "ingest.error") {
    db.query("UPDATE projects SET last_error_json = ? WHERE key = ?").run(
      JSON.stringify({
        kind: full.kind,
        ts: full.ts,
        sessionId: full.sessionId,
        message: full.error?.message ?? "",
      }),
      projectKey,
    );
  }
  if (full.kind === "ingest.error" && full.error?.reason) {
    incrementStat(db, `errors:${full.error.reason}`);
  }

  return full;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * One event queued for `ingestBatch`, carrying the identity fields only the
 * pipeline (`ingest.ts`, B3) knows: which line it came from, and which part
 * of that line's output it is (D7).
 */
export interface PendingEvent {
  engine: EngineId;
  source: EventSource;
  /** sha1 hex (40 chars) of the raw source line's bytes. */
  lineHash: string;
  /** Index of this event within its line's output (`"0"`, `"1"`, …), or `"e<n>"` for a derived error/warning (D7). */
  part: string;
  /** Where the source line sits in its file, for `ingest.error` (R10). */
  pos: LinePos;
  event: PartialCrowEvent;
}

/** Input to {@link ingestBatch}: one file-processing step (design.md § Esquema v1). */
export interface IngestBatchInput {
  path: string;
  inode: string;
  nextOffset: number;
  state: JsonValue;
  events: PendingEvent[];
}

/** Dependencies {@link ingestBatch} needs but must not read for itself (testability). */
export interface IngestBatchDeps {
  /** Assigns the next monotonic ULID (`createUlidFactory`'s return value). */
  nextId: () => string;
  /** Injected clock, used only for the `live`/`idle` status decision (D10). */
  now: ClockFn;
  /** Idle window in ms (R18). */
  idleMs: number;
}

/**
 * Stores a batch of parsed events in a single transaction (design.md §
 * Esquema v1, "ingestBatch"): content + semantic dedupe (D7), sticky project
 * assignment (D8), usage dedupe with the `usage-anomaly` guard (R13, D7),
 * incremental session/agent/day totals (R4), session status (D10) and the
 * file's offset — then returns the events actually stored, in commit order.
 *
 * Callers (the tailer, B3) must publish the returned events to the
 * {@link import("../bus").EventBus} only after this call returns (R22): the
 * transaction has already committed by then.
 */
export function ingestBatch(
  db: Database,
  deps: IngestBatchDeps,
  input: IngestBatchInput,
): CrowEvent[] {
  const stored: CrowEvent[] = [];

  const run = db.transaction(() => {
    for (const pending of input.events) {
      const { event, engine, source, lineHash, part, pos } = pending;
      const lineKey = `l:${lineHash}:${part}`;
      if (!insertDedupe(db, source, event.sessionId, lineKey, null)) continue; // R16

      if (event.semanticKey !== undefined) {
        const semanticKey = `s:${event.agentId ?? "main"}:${event.semanticKey}`;
        if (!insertDedupe(db, source, event.sessionId, semanticKey, null)) {
          incrementStat(db, "semantic_duplicates"); // D7
          continue;
        }
      }

      const { id: sessionId, projectKey } = ensureSession(
        db,
        engine,
        event.sessionId,
        event.cwd,
        event.ts,
      );
      const agentRowKey = ensureAgent(db, sessionId, event.agentId, event.parentAgentId, event.ts);

      if (event.kind === "agent.start" && event.agent) {
        db.query(
          "UPDATE agents SET type = ?, description = ?, spawn_call_id = ?, depth = ? WHERE id = ?",
        ).run(
          event.agent.type ?? null,
          event.agent.description ?? null,
          event.agent.spawnCallId ?? null,
          event.agent.depth ?? null,
          agentRowKey,
        );
        // depth > 1: the adapter never knows its native parent, only the call id that spawned
        // it — resolve it now if that tool.pre already landed (D3/ingestBatch step 5).
        if ((event.agent.depth ?? 0) > 1 && event.agent.spawnCallId !== undefined) {
          const parentRowKey = resolveDepthParent(db, sessionId, event.agent.spawnCallId);
          if (parentRowKey !== null) {
            db.query("UPDATE agents SET parent_id = ? WHERE id = ?").run(parentRowKey, agentRowKey);
          }
        }
      }
      if (event.kind === "agent.stop") {
        db.query("UPDATE agents SET ended_at = ? WHERE id = ?").run(event.ts, agentRowKey);
      }
      if (event.kind === "tool.pre" && event.tool?.callId !== undefined) {
        // Symmetric case: some depth > 1 agent may already be waiting on this exact call id
        // (child ingested before its parent's tool.pre — the other processing order).
        resolvePendingChildren(db, sessionId, agentRowKey, event.tool.callId);
      }

      let usageForStorage: CrowEventUsage | undefined = event.usage;
      if (event.usage !== undefined) {
        const usage = event.usage;
        if (event.usageKey !== undefined) {
          const next = usageComponents(usage);
          if (insertUsageDedupe(db, source, event.sessionId, event.usageKey, next)) {
            // First line ever seen for this key: the whole usage is the delta (baseline was zero).
            usageForStorage = applyUsage(db, sessionId, agentRowKey, projectKey, usage, event.ts);
          } else {
            const storedMax = readUsageDedupe(db, source, event.sessionId, event.usageKey);
            const delta = usageDelta(storedMax, next);
            if (delta === null) {
              // A component went backwards vs. the tracked max: don't trust this line at all, not
              // even its growing components (D7/R13, round 4) — keep the stored max as-is.
              usageForStorage = undefined;
              incrementStat(db, "usage_anomalies");
              const anomaly = persistEvent(
                db,
                deps,
                engine,
                source,
                sessionId,
                agentRowKey,
                projectKey,
                pos.offset,
                {
                  sessionId: event.sessionId,
                  agentId: event.agentId,
                  parentAgentId: event.parentAgentId,
                  kind: "ingest.error",
                  ts: event.ts,
                  cwd: event.cwd,
                  error: {
                    message: `usage-anomaly: ${event.usageKey} had a component below the tracked max`,
                    reason: "usage-anomaly",
                    path: pos.path,
                    offset: pos.offset,
                    line: pos.line,
                  },
                },
              );
              stored.push(anomaly);
            } else if (isZeroUsageDelta(delta)) {
              // Every component matches the tracked max exactly: nothing new to count, silently.
              usageForStorage = undefined;
            } else {
              // Every component is ≥ the tracked max, and at least one grew: count only the
              // positive delta, and advance the tracked max to this line's values.
              updateUsageDedupeMax(db, source, event.sessionId, event.usageKey, next);
              const deltaUsage: CrowEventUsage = { ...delta, model: usage.model };
              usageForStorage = applyUsage(
                db,
                sessionId,
                agentRowKey,
                projectKey,
                deltaUsage,
                event.ts,
              );
            }
          }
        } else {
          usageForStorage = applyUsage(db, sessionId, agentRowKey, projectKey, usage, event.ts);
        }
      }

      // A usage-only continuation line (no text, e.g. a streamed `tool_use`-only assistant chunk,
      // round 4 `map-line.ts` change) whose usage ended up counting nothing this line — either a
      // zero delta or a rejected anomaly — would otherwise persist as a content-free
      // `assistant.message` row and fill the timeline with noise. Skip it: the line was still
      // dedupe-marked above (R16), and, for the anomaly case, the `ingest.error` above already
      // recorded it — there's nothing else this row would carry.
      if (
        event.kind === "assistant.message" &&
        event.text === undefined &&
        usageForStorage === undefined
      ) {
        continue;
      }

      const eventToStore: PartialCrowEvent = { ...event, usage: usageForStorage };
      const full = persistEvent(
        db,
        deps,
        engine,
        source,
        sessionId,
        agentRowKey,
        projectKey,
        pos.offset,
        eventToStore,
      );
      stored.push(full);
    }

    db.query(
      `INSERT INTO ingest_offsets (path, inode, byte_offset, state_json, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET inode = excluded.inode, byte_offset = excluded.byte_offset,
         state_json = excluded.state_json, updated_at = excluded.updated_at`,
    ).run(input.path, input.inode, input.nextOffset, JSON.stringify(input.state), deps.now());
  });

  run.immediate();
  return stored;
}

/** Persisted offset/state for a watched file, or `null` if it's never been ingested (R6). */
export interface StoredOffset {
  inode: string;
  byteOffset: number;
  state: unknown;
}

/** Reads the persisted offset/state for `path`, for the tailer to resume from (R6, B3). */
export function getOffset(db: Database, path: string): StoredOffset | null {
  const row = db
    .query<{ inode: string; byte_offset: number; state_json: string }, [string]>(
      "SELECT inode, byte_offset, state_json FROM ingest_offsets WHERE path = ?",
    )
    .get(path);
  if (row === null) return null;
  return {
    inode: row.inode,
    byteOffset: row.byte_offset,
    state: JSON.parse(row.state_json) as unknown,
  };
}

/** `true` if an event with this id has ever been stored — the cursor-validation primitive (D9). */
export function hasEvent(db: Database, id: string): boolean {
  return (
    db
      .query<{ one: number }, [string]>("SELECT 1 AS one FROM events WHERE id = ? LIMIT 1")
      .get(id) !== null
  );
}

/** The highest stored event id, or `""` if the store is empty — a snapshot's REST `cursor` (D9). */
export function currentCursor(db: Database): string {
  const row = db.query<{ id: string }, []>("SELECT id FROM events ORDER BY id DESC LIMIT 1").get();
  return row?.id ?? "";
}

/** Reads the observable ingest counters (D7, R10) for `GET /api/stats`. */
export function stats(db: Database): IngestStats {
  const rows = db
    .query<{ name: string; value: number }, []>("SELECT name, value FROM ingest_stats")
    .all();
  const result: IngestStats = { semanticDuplicates: 0, usageAnomalies: 0, errorsByReason: {} };
  for (const row of rows) {
    if (row.name === "semantic_duplicates") result.semanticDuplicates = row.value;
    else if (row.name === "usage_anomalies") result.usageAnomalies = row.value;
    else if (row.name.startsWith("errors:")) {
      const reason = row.name.slice("errors:".length) as IngestErrorReason;
      result.errorsByReason[reason] = row.value;
    }
  }
  return result;
}

/** Marks every `live` session idle since before `now - idleMs` (R18). Run on a timer and once at startup. */
export function sweepIdle(db: Database, now: ClockFn, idleMs: number): void {
  db.query("UPDATE sessions SET status = 'idle' WHERE status = 'live' AND last_event_at < ?").run(
    now() - idleMs,
  );
}

/**
 * Applies a sidecar-derived metadata patch to an agent row (e.g. Claude's
 * `.meta.json`), creating a placeholder row if the agent hasn't produced an
 * event yet. `engine` isn't on {@link AgentMetaPatch} because sidecars are
 * parsed by an engine-specific adapter that already knows it; the store
 * still needs it to compose the composite `sessions.id`/`agents.id`.
 */
export function upsertAgentMeta(
  db: Database,
  engine: EngineId,
  patch: AgentMetaPatch,
  now: ClockFn,
): void {
  const sessionId = compositeSessionId(engine, patch.sessionId);
  const id = agentRowId(sessionId, patch.agentId);
  const ts = now();
  const existing = db.query<{ id: string }, [string]>("SELECT id FROM agents WHERE id = ?").get(id);
  if (existing === null) {
    db.query(
      `INSERT INTO agents (id, session_id, agent_id, type, description, spawn_call_id, depth, started_at, last_event_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      sessionId,
      patch.agentId,
      patch.type ?? null,
      patch.description ?? null,
      patch.spawnCallId ?? null,
      patch.depth ?? null,
      ts,
      ts,
    );
    return;
  }
  db.query(
    "UPDATE agents SET type = ?, description = ?, spawn_call_id = ?, depth = ? WHERE id = ?",
  ).run(
    patch.type ?? null,
    patch.description ?? null,
    patch.spawnCallId ?? null,
    patch.depth ?? null,
    id,
  );
}

function activeAgentFor(
  db: Database,
  sessionId: string,
): { agentId: string; type: string | null } | null {
  const row = db
    .query<{ agent_id: string | null; type: string | null }, [string]>(
      `SELECT agent_id, type FROM agents WHERE session_id = ? AND agent_id IS NOT NULL AND ended_at IS NULL
       ORDER BY last_event_at DESC LIMIT 1`,
    )
    .get(sessionId);
  return row && row.agent_id !== null ? { agentId: row.agent_id, type: row.type } : null;
}

function sessionSummaryFromRow(
  row: SessionRow,
  activeAgent: { agentId: string; type: string | null } | null,
): SessionSummary {
  return {
    id: row.id,
    engine: row.engine,
    nativeId: row.native_id,
    projectKey: row.project_key,
    status: row.status,
    startedAt: row.started_at,
    lastEventAt: row.last_event_at,
    endedAt: row.ended_at,
    model: row.model,
    lastPrompt: row.last_prompt,
    activeAgent,
    totals: totalsFromRow(row),
  };
}

function listSessionsForProject(
  db: Database,
  projectKey: string,
  sinceMs: number,
): SessionSummary[] {
  const rows = db
    .query<SessionRow, [string, number]>(
      `SELECT * FROM sessions WHERE project_key = ? AND (status = 'live' OR last_event_at >= ?)
       ORDER BY last_event_at DESC`,
    )
    .all(projectKey, sinceMs);
  return rows.map((row) => sessionSummaryFromRow(row, activeAgentFor(db, row.id)));
}

/** `GET /api/projects?since=` (R25): every project seen since `sinceMs`, with its sessions and today's totals. */
export function listProjects(db: Database, sinceMs: number): ProjectSummary[] {
  const projectRows = db
    .query<ProjectRow, [number]>(
      "SELECT * FROM projects WHERE last_seen >= ? ORDER BY last_seen DESC",
    )
    .all(sinceMs);
  const day = localDay(Date.now());

  return projectRows.map((p) => {
    const sessions = listSessionsForProject(db, p.key, sinceMs);
    const engines = [...new Set(sessions.map((s) => s.engine))];
    const todayRow = db
      .query<TotalsRow, [string, string]>(
        `SELECT t_input, t_output, t_cache_read, t_cache_creation, t_cache_creation_1h, t_weighted, t_cost_usd, t_unpriced
         FROM project_daily WHERE project_key = ? AND day = ?`,
      )
      .get(p.key, day);

    return {
      key: p.key,
      path: p.path,
      name: p.name,
      engines,
      lastSeen: p.last_seen,
      today: todayRow ? totalsFromRow(todayRow) : ZERO_TOTALS,
      lastError: p.last_error_json
        ? (JSON.parse(p.last_error_json) as ProjectSummary["lastError"])
        : null,
      sessions,
    };
  });
}

function agentNodeFromRow(row: AgentRow): AgentNode {
  return {
    agentId: row.agent_id,
    parentAgentId: row.parent_id !== null ? nativeAgentIdFromRowId(row.parent_id) : null,
    type: row.type,
    description: row.description,
    model: row.model,
    status: row.ended_at !== null ? "done" : "running",
    startedAt: row.started_at,
    endedAt: row.ended_at,
    lastEventAt: row.last_event_at,
    totals: totalsFromRow(row),
  };
}

/** `GET /api/sessions/:id` (R26): a session's summary plus its agent tree. `null` if the id is unknown. */
export function getSessionDetail(
  db: Database,
  sessionId: string,
): { session: SessionSummary; agents: AgentNode[] } | null {
  const row = db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(sessionId);
  if (row === null) return null;

  const session = sessionSummaryFromRow(row, activeAgentFor(db, sessionId));
  const agents = db
    .query<AgentRow, [string]>("SELECT * FROM agents WHERE session_id = ? ORDER BY started_at ASC")
    .all(sessionId)
    .map(agentNodeFromRow);

  return { session, agents };
}

/** A page of a session's events (R27), or `null` if `after` doesn't exist (409 `unknown-cursor`, D9). */
export interface SessionEventsPage {
  events: CrowEvent[];
  nextAfter: string | null;
  hasMore: boolean;
}

/** `GET /api/sessions/:id/events?after=&limit=` (R27). */
export function listSessionEvents(
  db: Database,
  sessionId: string,
  after: string | null,
  limit: number,
): SessionEventsPage | null {
  if (after !== null && !hasEvent(db, after)) return null;

  const rows =
    after !== null
      ? db
          .query<{ id: string; body_json: string }, [string, string, number]>(
            "SELECT id, body_json FROM events WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?",
          )
          .all(sessionId, after, limit + 1)
      : db
          .query<{ id: string; body_json: string }, [string, number]>(
            "SELECT id, body_json FROM events WHERE session_id = ? ORDER BY id ASC LIMIT ?",
          )
          .all(sessionId, limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const events = page.map((r) => JSON.parse(r.body_json) as CrowEvent);
  const nextAfter = page.length > 0 ? page[page.length - 1]!.id : after;

  return { events, nextAfter, hasMore };
}

/** Filter for {@link listSessions} (R26): `project`/`status` are `null` when unfiltered; `since` is a plain lower bound (no implicit "or live" widening — that's `listProjects`' job). */
export interface SessionsFilter {
  project: string | null;
  status: SessionStatus | null;
  since: number;
  limit: number;
}

/** `GET /api/sessions?project=&status=&since=&limit=` (R26): sessions matching every given filter, most recent first. */
export function listSessions(db: Database, filter: SessionsFilter): SessionSummary[] {
  const clauses = ["last_event_at >= ?"];
  const params: SQLQueryBindings[] = [filter.since];
  if (filter.project !== null) {
    clauses.push("project_key = ?");
    params.push(filter.project);
  }
  if (filter.status !== null) {
    clauses.push("status = ?");
    params.push(filter.status);
  }
  params.push(filter.limit);

  const rows = db
    .query<SessionRow, SQLQueryBindings[]>(
      `SELECT * FROM sessions WHERE ${clauses.join(" AND ")} ORDER BY last_event_at DESC LIMIT ?`,
    )
    .all(...params);
  return rows.map((row) => sessionSummaryFromRow(row, activeAgentFor(db, row.id)));
}

/** Filter for {@link listRecentEvents}: `project` is `null` when unfiltered. */
export interface RecentEventsFilter {
  project: string | null;
  limit: number;
}

/** `GET /api/events?project=&limit=` (adición, R31/R33): the most recent events, `(ts desc, id desc)`. */
export function listRecentEvents(db: Database, filter: RecentEventsFilter): CrowEvent[] {
  const clauses: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (filter.project !== null) {
    clauses.push("project_key = ?");
    params.push(filter.project);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(filter.limit);

  const rows = db
    .query<{ body_json: string }, SQLQueryBindings[]>(
      `SELECT body_json FROM events ${where} ORDER BY ts DESC, id DESC LIMIT ?`,
    )
    .all(...params);
  return rows.map((r) => JSON.parse(r.body_json) as CrowEvent);
}

/** Filter for {@link listEventsAfter} (D13's SSE replay): `after` is the exclusive cursor (`null` = from the start); `projects` empty means unfiltered. */
export interface EventsAfterFilter {
  after: string | null;
  projects: readonly string[];
  sessionId: string | null;
  limit: number;
}

/**
 * A page of events with `id > after` (or all, if `after` is `null`) matching
 * the given project/session filters, ordered by `id` ascending — the
 * paginated replay primitive `sse.ts` uses to catch a reconnecting client up
 * without gaps or duplicates (D13, R24). Callers already validated `after`
 * with {@link hasEvent} before calling this.
 */
export function listEventsAfter(db: Database, filter: EventsAfterFilter): CrowEvent[] {
  const clauses: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (filter.after !== null) {
    clauses.push("id > ?");
    params.push(filter.after);
  }
  if (filter.projects.length > 0) {
    clauses.push(`project_key IN (${filter.projects.map(() => "?").join(",")})`);
    params.push(...filter.projects);
  }
  if (filter.sessionId !== null) {
    clauses.push("session_id = ?");
    params.push(filter.sessionId);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(filter.limit);

  const rows = db
    .query<{ body_json: string }, SQLQueryBindings[]>(
      `SELECT body_json FROM events ${where} ORDER BY id ASC LIMIT ?`,
    )
    .all(...params);
  return rows.map((r) => JSON.parse(r.body_json) as CrowEvent);
}
