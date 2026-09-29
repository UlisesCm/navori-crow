import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { MIGRATIONS, migrate } from "./migrations";

describe("migrate", () => {
  test("applies MIGRATIONS in order and creates schema v1 + v2 + v3", () => {
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
      "otel_usage",
      "project_daily",
      "projects",
      "sessions",
    ]);

    const version = db.query<{ user_version: number }, []>("PRAGMA user_version;").get();
    expect(version?.user_version).toBe(3);
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
    expect(version?.user_version).toBe(3);
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

    migrate(db, MIGRATIONS); // now upgrade to the latest

    const row = db
      .query<{ key: string; u_input: number | null }, []>("SELECT key, u_input FROM dedupe")
      .get();
    expect(row?.key).toBe("l:abc:0"); // pre-existing row survives
    expect(row?.u_input).toBeNull(); // new column, no backfill needed for non-usage rows
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version;").get();
    expect(version?.user_version).toBe(3);
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

  describe("schema v3 (F2a)", () => {
    const v2Only = MIGRATIONS.filter((m) => m.version <= 2);

    /** A v2 DB (what F1 ships) with one session that counted usage, one that did not, and an event. */
    function seededV2(): Database {
      const db = new Database(":memory:");
      migrate(db, v2Only);
      db.exec(
        "INSERT INTO projects (key, path, name, first_seen, last_seen) VALUES ('p','/p','p',1,1)",
      );
      db.exec(
        `INSERT INTO sessions (id, engine, native_id, project_key, started_at, last_event_at, status, last_prompt, t_input)
         VALUES ('claude:used','claude','used','p',1,5,'idle','old prompt',10)`,
      );
      db.exec(
        `INSERT INTO sessions (id, engine, native_id, project_key, started_at, last_event_at, status)
         VALUES ('claude:empty','claude','empty','p',1,1,'live')`,
      );
      db.exec(
        `INSERT INTO events (id, session_id, project_key, agent_id, kind, ts, source, call_id, body_json)
         VALUES ('01A','claude:used','p',NULL,'prompt',5,'transcript',NULL,'{"id":"01A"}')`,
      );
      return db;
    }

    test("v2 with data upgrades: tu_unkeyed marks sessions that already counted usage, rows survive", () => {
      // Covers: R10, R11, R13 — additive migration 3 (Migración)
      const db = seededV2();

      migrate(db, MIGRATIONS);

      const marks = db
        .query<
          { id: string; tu_keyed: number; tu_unkeyed: number; last_prompt_at: number | null },
          []
        >("SELECT id, tu_keyed, tu_unkeyed, last_prompt_at FROM sessions ORDER BY id")
        .all();
      expect(marks).toEqual([
        { id: "claude:empty", tu_keyed: 0, tu_unkeyed: 0, last_prompt_at: null },
        { id: "claude:used", tu_keyed: 0, tu_unkeyed: 1, last_prompt_at: null },
      ]);
      const event = db
        .query<{ id: string; lkey: string | null; lfp: string | null; lmeta: string | null }, []>(
          "SELECT id, lkey, lfp, lmeta FROM events",
        )
        .get();
      expect(event).toEqual({ id: "01A", lkey: null, lfp: null, lmeta: null });
      const indexes = db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all()
        .map((r) => r.name);
      expect(indexes).toContain("events_by_lkey");
      expect(indexes).toContain("otel_usage_held");
    });

    test("otel_usage enforces its scope/state CHECKs", () => {
      // Covers: R13
      const db = new Database(":memory:");
      migrate(db);
      const insert = (state: string): void => {
        db.exec(`INSERT INTO otel_usage VALUES ('s','req:1','call','${state}',0,0,NULL,1,1,0,0,0)`);
      };
      expect(() => insert("held")).not.toThrow();
      expect(() => db.exec("DELETE FROM otel_usage")).not.toThrow();
      expect(() => insert("bogus")).toThrow();
    });

    test("v2 -> v3 -> rollback to 2 -> v3 again works and keeps the data", () => {
      // Covers: R10, R11 — the design's rollback path must be re-upgradable
      const db = seededV2();
      migrate(db, MIGRATIONS);
      db.exec(
        `UPDATE events SET lkey = 'k', lfp = 'f', lmeta = '{"lanes":["transcript"],"prov":{}}' WHERE id = '01A'`,
      );
      db.exec("UPDATE sessions SET last_prompt_at = 7 WHERE id = 'claude:used'");
      db.exec("PRAGMA user_version = 2;");
      // F1 keeps counting usage in a session that had none while rolled back.
      db.exec("UPDATE sessions SET t_input = 3 WHERE id = 'claude:empty'");

      expect(() => migrate(db, MIGRATIONS)).not.toThrow();

      const version = db.query<{ user_version: number }, []>("PRAGMA user_version;").get();
      expect(version?.user_version).toBe(3);
      const event = db
        .query<{ lkey: string | null; lfp: string | null; lmeta: string | null }, []>(
          "SELECT lkey, lfp, lmeta FROM events WHERE id = '01A'",
        )
        .get();
      expect(event).toEqual({ lkey: "k", lfp: "f", lmeta: '{"lanes":["transcript"],"prov":{}}' });
      const sessions = db
        .query<{ id: string; tu_unkeyed: number; last_prompt_at: number | null }, []>(
          "SELECT id, tu_unkeyed, last_prompt_at FROM sessions ORDER BY id",
        )
        .all();
      expect(sessions).toEqual([
        { id: "claude:empty", tu_unkeyed: 1, last_prompt_at: null },
        { id: "claude:used", tu_unkeyed: 1, last_prompt_at: 7 },
      ]);
    });

    test("rollback (PRAGMA user_version = 2): F1's statements and reads keep working on the v3 schema", () => {
      // Covers: R10, R11 — § Migration rollback; F1 ignores the additive columns and tables
      const db = seededV2();
      migrate(db, MIGRATIONS);
      db.exec("PRAGMA user_version = 2;");

      // F1 refuses nothing at v2: its migrate() sees the version it knows.
      expect(() => migrate(db, v2Only)).not.toThrow();
      // F1's INSERTs name no v3 column and rely on their defaults.
      db.exec(
        `INSERT INTO sessions (id, engine, native_id, project_key, started_at, last_event_at, status)
         VALUES ('claude:f1','claude','f1','p',1,1,'live')`,
      );
      db.exec(
        `INSERT INTO events (id, session_id, project_key, agent_id, kind, ts, source, call_id, body_json)
         VALUES ('01B','claude:f1','p',NULL,'prompt',6,'transcript',NULL,'{"id":"01B"}')`,
      );
      // F1's reads.
      const rows = db
        .query<{ id: string; body_json: string }, [string]>(
          "SELECT id, body_json FROM events WHERE session_id = ? ORDER BY id ASC",
        )
        .all("claude:used");
      expect(rows.map((r) => r.id)).toEqual(["01A"]);
      const sessions = db
        .query<{ id: string; last_prompt: string | null }, []>(
          "SELECT id, last_prompt FROM sessions WHERE project_key = 'p' ORDER BY id",
        )
        .all();
      expect(sessions.map((s) => s.id)).toEqual(["claude:empty", "claude:f1", "claude:used"]);
    });
  });
});
