import type { Database } from "bun:sqlite";

/** One migration: a schema version and the SQL that gets the DB to it. */
export interface Migration {
  version: number;
  sql: string;
}

/**
 * Repeated in `sessions`, `agents` and `project_daily` (design.md § Esquema
 * v1, the "T" placeholder): incremental totals as plain numeric columns, so
 * they can be updated atomically without a read-modify-write round trip (D3).
 */
const TOTALS_COLUMNS = `
  t_input INTEGER NOT NULL DEFAULT 0,
  t_output INTEGER NOT NULL DEFAULT 0,
  t_cache_read INTEGER NOT NULL DEFAULT 0,
  t_cache_creation INTEGER NOT NULL DEFAULT 0,
  t_cache_creation_1h INTEGER NOT NULL DEFAULT 0,
  t_weighted REAL NOT NULL DEFAULT 0,
  t_cost_usd REAL NOT NULL DEFAULT 0,
  t_unpriced INTEGER NOT NULL DEFAULT 0
`;

/** Schema v1 (design.md § Esquema v1), verbatim. */
const SCHEMA_V1 = `
CREATE TABLE projects (
  key TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  last_error_json TEXT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  engine TEXT NOT NULL,
  native_id TEXT NOT NULL,
  project_key TEXT NOT NULL REFERENCES projects(key),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  last_event_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('live','idle','ended')),
  model TEXT,
  last_prompt TEXT,
  ${TOTALS_COLUMNS}
);
CREATE INDEX sessions_by_project ON sessions(project_key, last_event_at);
CREATE INDEX sessions_by_status  ON sessions(status, last_event_at);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  agent_id TEXT,
  parent_id TEXT,
  type TEXT,
  description TEXT,
  spawn_call_id TEXT,
  depth INTEGER,
  model TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  last_event_at INTEGER,
  ${TOTALS_COLUMNS}
);
CREATE INDEX agents_by_session ON agents(session_id);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  project_key TEXT NOT NULL,
  agent_id TEXT,
  kind TEXT NOT NULL,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL,
  call_id TEXT,
  body_json TEXT NOT NULL
);
CREATE INDEX events_by_session    ON events(session_id, id);
CREATE INDEX events_by_project_ts ON events(project_key, ts);

CREATE TABLE ingest_offsets (
  path TEXT PRIMARY KEY,
  inode TEXT NOT NULL,
  byte_offset INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE dedupe (
  source TEXT NOT NULL,
  session_id TEXT NOT NULL,
  key TEXT NOT NULL,
  fp TEXT,
  PRIMARY KEY (source, session_id, key)
) WITHOUT ROWID;

CREATE TABLE project_daily (
  project_key TEXT NOT NULL,
  day TEXT NOT NULL,
  ${TOTALS_COLUMNS},
  PRIMARY KEY (project_key, day)
) WITHOUT ROWID;

CREATE TABLE ingest_stats (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
`;

/**
 * Schema v2 (round 4, `.claude/progress/impl_f1-b4t3-contract.md`, D7/R13): `dedupe` gains 5 nullable
 * numeric columns to track the component-wise MAX usage seen per `usageKey`, replacing the old
 * single-fingerprint compare — needed so a later duplicate `message.id` line whose usage grew (real
 * Claude streaming) can count its positive delta instead of being dropped whole. `fp` is left in
 * place (still used by `lineKey`/`semanticKey` rows, always `NULL` for `usageKey` rows now) —
 * additive only, no existing column touched, so an existing DB upgrades without data loss.
 */
const SCHEMA_V2 = `
ALTER TABLE dedupe ADD COLUMN u_input INTEGER;
ALTER TABLE dedupe ADD COLUMN u_output INTEGER;
ALTER TABLE dedupe ADD COLUMN u_cache_read INTEGER;
ALTER TABLE dedupe ADD COLUMN u_cache_creation INTEGER;
ALTER TABLE dedupe ADD COLUMN u_cache_creation_1h INTEGER;
`;

/** Ordered set of migrations this build knows how to apply. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, sql: SCHEMA_V1 },
  { version: 2, sql: SCHEMA_V2 },
];

/** Reads `PRAGMA user_version` (outside any transaction, per D2). */
function userVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version;").get();
  return row?.user_version ?? 0;
}

/**
 * Applies every pending migration from `PRAGMA user_version` up to the
 * highest version in `migrations`, in a single `BEGIN IMMEDIATE … COMMIT`
 * (D2, R2). Rejects (throws, without touching the DB) if the DB's version is
 * newer than what this build supports — never downgrades.
 *
 * On failure inside the transaction, `db.transaction` rolls back automatically
 * and the error propagates: the caller (`startApp`, B5) must not start
 * listening (R2).
 */
export function migrate(db: Database, migrations: readonly Migration[] = MIGRATIONS): void {
  const current = userVersion(db);
  const latest = migrations.reduce((max, m) => Math.max(max, m.version), 0);

  if (current > latest) {
    throw new Error(
      `database schema version ${current} is newer than the version this build supports (${latest})`,
    );
  }

  const pending = [...migrations]
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);
  if (pending.length === 0) return;

  const applyAll = db.transaction(() => {
    for (const migration of pending) {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version};`);
    }
  });
  applyAll.immediate();
}
