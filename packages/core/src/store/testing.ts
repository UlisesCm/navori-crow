/**
 * Shared helpers for the multi-lane store tests (F2a B1.T2): synthetic events built with the
 * contract types, an in-memory DB and readers over the raw `events` table. Test-only.
 */
import { Database } from "bun:sqlite";
import type { PartialCrowEvent } from "../adapter";
import type { CrowEvent, EventSource } from "../crow-event";
import { createUlidFactory } from "../ulid";
import { migrate } from "./migrations";
import { ingestEvents } from "./store";
import type { IngestBatchDeps, PendingEvent } from "./store";

export const IDLE_MS = 5 * 60_000;
export const T0 = 1_700_000_000_000;

export function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

/** Deps with a frozen clock; ids are strictly monotonic anyway (`createUlidFactory`). */
export function makeDeps(now: number = T0): IngestBatchDeps {
  return {
    nextId: createUlidFactory("00000000000000000000000000", () => now),
    now: () => now,
    idleMs: IDLE_MS,
  };
}

let counter = 0;

/** A synthetic pending event for `source`; every call gets a unique line identity. */
export function pending(
  source: EventSource,
  event: Partial<PartialCrowEvent> & Pick<PartialCrowEvent, "kind" | "ts">,
  offset = 0,
): PendingEvent {
  counter += 1;
  return {
    engine: "claude",
    source,
    lineHash: `test-line-${counter}`,
    part: "0",
    pos: { path: "/tmp/f.jsonl", offset, line: 1 },
    event: {
      sessionId: "s1",
      agentId: null,
      parentAgentId: null,
      cwd: "/tmp/proj-a",
      ...event,
    },
  };
}

/** Ingests through the lane-agnostic entry point and returns what it would publish. */
export function ingest(
  db: Database,
  deps: IngestBatchDeps,
  ...events: PendingEvent[]
): CrowEvent[] {
  return ingestEvents(db, deps, events);
}

/** Every stored row of `kind !== 'revision'`, in id order, as parsed bodies. */
export function factRows(db: Database, sessionId = "claude:s1"): CrowEvent[] {
  return db
    .query<{ body_json: string }, [string]>(
      "SELECT body_json FROM events WHERE session_id = ? AND kind != 'revision' ORDER BY id ASC",
    )
    .all(sessionId)
    .map((r) => JSON.parse(r.body_json) as CrowEvent);
}

/** Every stored `revision` row, in id order. */
export function revisionRows(db: Database, sessionId = "claude:s1"): CrowEvent[] {
  return db
    .query<{ body_json: string }, [string]>(
      "SELECT body_json FROM events WHERE session_id = ? AND kind = 'revision' ORDER BY id ASC",
    )
    .all(sessionId)
    .map((r) => JSON.parse(r.body_json) as CrowEvent);
}

/** The fact without its `id`, for "identical apart from id" comparisons. */
export function withoutId(fact: CrowEvent): Omit<CrowEvent, "id"> {
  const { id: _id, ...rest } = fact;
  return rest;
}

/** All permutations of `items` (Heap-free recursive form; fine for n <= 6). */
export function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  items.forEach((item, i) => {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([item, ...p]);
  });
  return out;
}
