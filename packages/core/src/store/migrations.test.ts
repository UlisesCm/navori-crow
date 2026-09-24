import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { MIGRATIONS, migrate } from "./migrations";

describe("migrate", () => {
  test("applies MIGRATIONS in order and creates schema v1 + v2", () => {
    // Covers: R1, R2
    const db = new Database(":memory:");
    migrate(db);

    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(tables).toEqual([
      "agents",
      "dedupe",
      "events",
      "ingest_offsets",
      "ingest_stats",
      "project_daily",
      "projects",
      "sessions",
    ]);

    const version = db.query<{ user_version: number }, []>("PRAGMA user_version;").get();
    expect(version?.user_version).toBe(2);
  });

  test("dedupe carries fp, the v2 usage-max columns, and ingest_stats exists (R16 usage-anomaly, R10 error counters)", () => {
    // Covers: R2
    const db = new Database(":memory:");
    migrate(db);

    db.exec(
      "INSERT INTO projects (key, path, name, first_seen, last_seen) VALUES ('p','/p','p',1,1)",
    );
    db.exec(
      "INSERT INTO sessions (id, engine, native_id, project_key, started_at, last_event_at, status) VALUES ('s','claude','n','p',1,1,'live')",
    );
    db.exec(
      `INSERT INTO dedupe (source, session_id, key, fp, u_input, u_output, u_cache_read, u_cache_creation, u_cache_creation_1h)
       VALUES ('transcript','s','u:main:m1',NULL,10,5,0,0,0)`,
    );
    db.exec("INSERT INTO ingest_stats (name, value) VALUES ('usage_anomalies', 1)");

    const dedupe = db
      .query<{ fp: string | null; u_input: number; u_output: number }, []>(
        "SELECT fp, u_input, u_output FROM dedupe",
      )
      .get();
    expect(dedupe?.fp).toBeNull();
    expect(dedupe?.u_input).toBe(10);
    expect(dedupe?.u_output).toBe(5);
    const stat = db
      .query<{ value: number }, []>("SELECT value FROM ingest_stats WHERE name = 'usage_anomalies'")
      .get();
    expect(stat?.value).toBe(1);
  });

  test("running migrate twice is a no-op the second time", () => {
    // Covers: R2
    const db = new Database(":memory:");
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version;").get();
    expect(version?.user_version).toBe(2);
  });

  test("rolls back and rejects when a pending migration fails, without touching user_version", () => {
    // Covers: R2
    const db = new Database(":memory:");
    const broken = [{ version: 1, sql: "CREATE TABLE ok (a INTEGER); THIS IS NOT SQL;" }];

    expect(() => migrate(db, broken)).toThrow();

    const version = db.query<{ user_version: number }, []>("PRAGMA user_version;").get();
    expect(version?.user_version).toBe(0);
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all();
    expect(tables).toEqual([]);
  });

  test("rejects a database whose schema version is newer than this build's latest migration", () => {
    // Covers: R2
    const db = new Database(":memory:");
    migrate(db);
    db.exec("PRAGMA user_version = 99;");

    expect(() => migrate(db, MIGRATIONS)).toThrow(/newer/);
  });

  test("upgrading a real v1-only DB to v2 preserves existing dedupe rows and adds nullable usage-max columns", () => {
    // Covers: R2, R13 — additive migration, no existing DB breaks (round 4)
    const db = new Database(":memory:");
    const v1Only = MIGRATIONS.filter((m) => m.version === 1);
    migrate(db, v1Only); // simulates a DB created before v2 existed

    db.exec(
      "INSERT INTO projects (key, path, name, first_seen, last_seen) VALUES ('p','/p','p',1,1)",
    );
    db.exec(
      "INSERT INTO sessions (id, engine, native_id, project_key, started_at, last_event_at, status) VALUES ('s','claude','n','p',1,1,'live')",
    );
    db.exec(
      "INSERT INTO dedupe (source, session_id, key, fp) VALUES ('transcript','s','l:abc:0',NULL)",
    );

    migrate(db, MIGRATIONS); // now upgrade to v2

    const row = db
      .query<{ key: string; u_input: number | null }, []>("SELECT key, u_input FROM dedupe")
      .get();
    expect(row?.key).toBe("l:abc:0"); // pre-existing row survives
    expect(row?.u_input).toBeNull(); // new column, no backfill needed for non-usage rows
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version;").get();
    expect(version?.user_version).toBe(2);
  });

  test("applies pending migrations incrementally on top of an already-migrated older version", () => {
    // Covers: R2
    const db = new Database(":memory:");
    const v1 = { version: 1, sql: "CREATE TABLE a (x INTEGER);" };
    const v2 = { version: 2, sql: "CREATE TABLE b (y INTEGER);" };
    migrate(db, [v1]);

    migrate(db, [v1, v2]);

    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(tables).toEqual(["a", "b"]);
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version;").get();
    expect(version?.user_version).toBe(2);
  });
});
