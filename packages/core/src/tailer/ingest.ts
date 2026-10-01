/**
 * Per-file ingestion step (design.md § Components `packages/core/src/ingest.ts`).
 *
 * Ties `line-reader.ts` (bytes), the pure `EngineAdapter` (line → events) and
 * the store together: resolves the file's inode/offset/state (D5, R6, R7),
 * reads whatever new complete lines are available, runs each one through the
 * adapter, converts parse errors and warnings into `ingest.error` events
 * (R10, D7), stores everything in a single `ingestBatch` transaction (D7
 * identity, R4 totals) and publishes the stored events to the bus only after
 * that commit (R22).
 */
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import type { Database } from "bun:sqlite";
import type { EventBus } from "../bus";
import type { AgentMetaPatch, EngineAdapter, FileMatch, JsonValue, LinePos } from "../adapter";
import type { CrowEvent, IngestErrorReason } from "../crow-event";
import { getOffset, ingestBatch, upsertAgentMeta } from "../store/store";
import type { PendingEvent } from "../store/store";
import type { ClockFn } from "../ulid";
import { readLines } from "./line-reader";
import type { LineEntry, ReadLinesOptions } from "./line-reader";

/**
 * A step never processes more than this many lines in one transaction (D6):
 * "cada paso procesa como máximo 1,000 líneas u 8 MiB, whichever comes
 * first". The byte half of that cap is `line-reader.ts`'s `maxBytesPerStep`
 * (defaults to `DEFAULT_CHUNK_BYTES`, 8 MiB) — `readLines` never returns more
 * than that many bytes' worth of entries in one call, so this constant only
 * needs to additionally bound the line *count* once those entries arrive.
 */
export const MAX_LINES_PER_STEP = 1000;

export interface FileStat {
  inode: string;
  size: number;
}

/** Injectable file-stat dependency: `lstat`, so symlinks are never followed (D5). */
export type StatFn = (path: string) => Promise<FileStat | null>;

/** Default {@link StatFn}: `lstat`, returning `null` for a missing path or a symlink (D5). */
export const lstatFile: StatFn = async (path) => {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) return null;
    return { inode: String(st.ino), size: st.size };
  } catch {
    return null;
  }
};

/** Reads a sidecar file's text, or `null` if it's missing/unreadable (tolerant, per D5/Claude's `.meta.json`). */
export type SidecarLoader = (path: string) => Promise<string | null>;

export const defaultLoadSidecar: SidecarLoader = async (path) => {
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
};

export interface ProcessFileDeps<S extends JsonValue> {
  db: Database;
  bus: EventBus;
  adapter: EngineAdapter<S>;
  path: string;
  match: FileMatch;
  nextId: () => string;
  now: ClockFn;
  idleMs: number;
  stat?: StatFn;
  read?: typeof readLines;
  lineOptions?: ReadLinesOptions;
  loadSidecar?: SidecarLoader;
}

export interface ProcessFileResult {
  events: CrowEvent[];
  bytesRead: number;
  linesRead: number;
}

const EMPTY_RESULT: ProcessFileResult = { events: [], bytesRead: 0, linesRead: 0 };

function endOffsetOf(entry: LineEntry): number {
  return entry.kind === "line"
    ? entry.startOffset + entry.bytes.length + 1
    : entry.startOffset + entry.length + 1;
}

/** Builds the `ingest.error` partial event for a line/entry-level failure (R10). */
function ingestErrorEvent(
  pos: LinePos,
  reason: IngestErrorReason,
  message: string,
  sessionId: string,
  agentId: string | null,
  now: ClockFn,
  cwd?: string,
): PendingEvent["event"] {
  return {
    sessionId,
    agentId,
    parentAgentId: null,
    kind: "ingest.error",
    ts: now(),
    ...(cwd !== undefined ? { cwd } : {}),
    error: {
      message: message.slice(0, 1024),
      reason,
      path: pos.path,
      offset: pos.offset,
      line: pos.line,
    },
  };
}

/**
 * Resolves the state to parse `path` from: fresh (offset 0) if it's never
 * been seen, if its inode changed, if it shrank below the persisted offset
 * (R7), or if `restoreState` rejects the persisted `state_json` (D5) —
 * otherwise resumes from the persisted offset/state.
 */
async function resolveStartState<S extends JsonValue>(
  deps: ProcessFileDeps<S>,
  fileStat: FileStat,
): Promise<{ offset: number; state: S }> {
  const { db, adapter, path, match } = deps;
  const loadSidecar = deps.loadSidecar ?? defaultLoadSidecar;

  const fresh = async (): Promise<{ offset: number; state: S }> => {
    const sidecarText = match.sidecarPath !== null ? await loadSidecar(match.sidecarPath) : null;
    return { offset: 0, state: adapter.initialState(match, sidecarText) };
  };

  const stored = getOffset(db, path);
  if (stored === null) return fresh();
  if (stored.inode !== fileStat.inode || fileStat.size < stored.byteOffset) return fresh(); // R7
  const restored = adapter.restoreState(stored.state, match);
  if (restored === null) return fresh(); // incompatible state: re-ingest from 0, no duplicates (D5, D7)
  return { offset: stored.byteOffset, state: restored };
}

/**
 * Processes every complete line newly available in `path` since its last
 * persisted offset. Returns {@link EMPTY_RESULT} if the file vanished, is a
 * symlink, or had nothing new to read.
 */
export async function processFile<S extends JsonValue>(
  deps: ProcessFileDeps<S>,
): Promise<ProcessFileResult> {
  const { db, bus, adapter, path, match, nextId, now, idleMs } = deps;
  const statFn = deps.stat ?? lstatFile;
  const read = deps.read ?? readLines;

  const fileStat = await statFn(path);
  if (fileStat === null) return EMPTY_RESULT;

  const { offset, state: startState } = await resolveStartState(deps, fileStat);
  let state = startState;

  const { entries: allEntries, nextOffset: fullNextOffset } = await read(
    path,
    offset,
    deps.lineOptions,
  );
  if (allEntries.length === 0) return EMPTY_RESULT;

  const capped = allEntries.length > MAX_LINES_PER_STEP;
  const entries = capped ? allEntries.slice(0, MAX_LINES_PER_STEP) : allEntries;
  const nextOffset = capped ? endOffsetOf(entries[entries.length - 1]!) : fullNextOffset;

  const pending: PendingEvent[] = [];
  let unknownEntries = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let lineNumber = 0;

  for (const entry of entries) {
    lineNumber += 1;
    const pos: LinePos = { path, offset: entry.startOffset, line: lineNumber };

    if (entry.kind === "too-long") {
      const lineHash = createHash("sha1")
        .update(`too-long:${path}:${entry.startOffset}:${entry.length}`)
        .digest("hex");
      pending.push({
        engine: adapter.id,
        source: "transcript",
        lineHash,
        part: "e0",
        pos,
        event: ingestErrorEvent(
          pos,
          "line-too-long",
          `line exceeds the ${entry.length}-byte cap`,
          match.sessionId ?? "unknown",
          match.agentId,
          now,
        ),
      });
      continue;
    }

    const lineHash = createHash("sha1").update(entry.bytes).digest("hex");
    let text: string;
    try {
      text = decoder.decode(entry.bytes);
    } catch {
      pending.push({
        engine: adapter.id,
        source: "transcript",
        lineHash,
        part: "e0",
        pos,
        event: ingestErrorEvent(
          pos,
          "invalid-json",
          "invalid UTF-8 byte sequence",
          match.sessionId ?? "unknown",
          match.agentId,
          now,
        ),
      });
      continue;
    }

    const result = adapter.parseLine(text, state, pos);
    state = result.state;

    if (!result.ok) {
      pending.push({
        engine: adapter.id,
        source: "transcript",
        lineHash,
        part: "e0",
        pos,
        event: ingestErrorEvent(
          pos,
          result.reason,
          result.detail ?? result.reason,
          result.sessionId ?? match.sessionId ?? "unknown",
          result.agentId ?? match.agentId,
          now,
          result.cwd,
        ),
      });
      continue;
    }

    if (result.unknown === true) unknownEntries += 1;

    result.events.forEach((event, index) => {
      pending.push({
        engine: adapter.id,
        source: "transcript",
        lineHash,
        part: String(index),
        pos,
        event,
      });
    });

    const fallbackSessionId = result.events[0]?.sessionId ?? match.sessionId ?? "unknown";
    const fallbackAgentId = result.events[0]?.agentId ?? match.agentId ?? null;
    (result.warnings ?? []).forEach((warning, index) => {
      pending.push({
        engine: adapter.id,
        source: "transcript",
        lineHash,
        part: `e${index}`,
        pos,
        event: ingestErrorEvent(
          pos,
          warning.reason,
          warning.detail,
          fallbackSessionId,
          fallbackAgentId,
          now,
          result.events[0]?.cwd,
        ),
      });
    });
  }

  const stored = ingestBatch(
    db,
    { nextId, now, idleMs },
    {
      path,
      inode: fileStat.inode,
      nextOffset,
      state,
      events: pending,
      unknownEntries,
    },
  );

  bus.publish(stored); // after commit (R22)
  return { events: stored, bytesRead: nextOffset - offset, linesRead: entries.length };
}

/** Applies a sidecar's parsed metadata to its agent row, if the adapter maps sidecars (Claude's `.meta.json`). */
export async function processSidecar<S extends JsonValue>(
  db: Database,
  adapter: EngineAdapter<S>,
  match: FileMatch,
  sidecarPath: string,
  now: ClockFn,
  loadSidecar: SidecarLoader = defaultLoadSidecar,
): Promise<AgentMetaPatch | null> {
  if (!adapter.parseSidecar) return null;
  const text = await loadSidecar(sidecarPath);
  if (text === null) return null;
  const patch = adapter.parseSidecar(text, match);
  if (patch === null) return null;
  upsertAgentMeta(db, adapter.id, patch, now);
  return patch;
}
