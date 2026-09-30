/**
 * The OTel usage ledger (F2a D6, R12): a model call is counted once across the transcript and
 * OTLP lanes, in every arrival order, with an injected clock for the 30 s retention and promotion.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { CrowEvent, CrowEventUsage } from "../crow-event";
import { createUlidFactory } from "../ulid";
import { MIGRATIONS, migrate } from "./migrations";
import type { IngestBatchDeps, PendingEvent } from "./store";
import { OTEL_HOLD_MS, promoteHeldUsage } from "./store";
import { freshDb, IDLE_MS, ingest, pending, permutations, T0 } from "./testing";

const SESSION = "claude:s1";

const USAGE: CrowEventUsage = {
  input: 100,
  output: 50,
  cacheRead: 1000,
  cacheCreation: 200,
  cacheCreation1h: 200,
  model: "claude-sonnet-5",
};

const UNPRICED: CrowEventUsage = { ...USAGE, model: "mystery-model" };

interface Clock {
  t: number;
}

/** Deps whose `now` and ULID timestamps follow a mutable, test-owned clock. */
function clockDeps(clock: Clock): IngestBatchDeps {
  return {
    nextId: createUlidFactory("00000000000000000000000000", () => clock.t),
    now: () => clock.t,
    idleMs: IDLE_MS,
  };
}

/** A transcript assistant line for call `callKey`, counting `usage` under `usageKey`. */
function transcript(callKey: string | undefined, usage: CrowEventUsage = USAGE): PendingEvent {
  return pending("transcript", {
    kind: "assistant.message",
    ts: T0,
    text: "answer",
    usage,
    usageKey: `u:main:${callKey ?? "none"}`,
    ...(callKey !== undefined ? { usageCallKey: callKey } : {}),
  });
}

/** An OTel `api_request` candidate (built through the B1.T1 contract: `otelUsage` + `usageCallKey`). */
function otel(
  callKey: string | undefined,
  usage: CrowEventUsage = USAGE,
  ts = T0 + 500,
): PendingEvent {
  return pending("otel", {
    kind: "api.request",
    ts,
    otelUsage: usage,
    reported: { metric: "api_request", input: usage.input, output: usage.output },
    ...(callKey !== undefined ? { usageCallKey: callKey } : {}),
  });
}

interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  unpriced: number;
  cost: number;
}

const COLUMNS =
  "t_input AS input, t_output AS output, t_cache_read AS cacheRead, t_cache_creation AS cacheCreation, t_unpriced AS unpriced, t_cost_usd AS cost";

function sessionTotals(db: Database, id = SESSION): Totals {
  const row = db.query<Totals, [string]>(`SELECT ${COLUMNS} FROM sessions WHERE id = ?`).get(id);
  if (row === null) throw new Error(`no session ${id}`);
  return row;
}

function mainAgentTotals(db: Database, id = SESSION): Totals | null {
  return db.query<Totals, [string]>(`SELECT ${COLUMNS} FROM agents WHERE id = ?`).get(`${id}/main`);
}

function dailyTotals(db: Database): Totals {
  return db
    .query<Totals, []>(
      `SELECT SUM(t_input) AS input, SUM(t_output) AS output, SUM(t_cache_read) AS cacheRead,
              SUM(t_cache_creation) AS cacheCreation, SUM(t_unpriced) AS unpriced, SUM(t_cost_usd) AS cost
       FROM project_daily`,
    )
    .get() as Totals;
}

function ledgerStates(db: Database): Array<{ key: string; state: string }> {
  return db
    .query<{ key: string; state: string }, []>("SELECT key, state FROM otel_usage ORDER BY key")
    .all();
}

const ZERO: Totals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, unpriced: 0, cost: 0 };

function expected(
  usage: CrowEventUsage,
): Pick<Totals, "input" | "output" | "cacheRead" | "cacheCreation"> {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheCreation: usage.cacheCreation,
  };
}

function pickCounts(t: Totals): Pick<Totals, "input" | "output" | "cacheRead" | "cacheCreation"> {
  return {
    input: t.input,
    output: t.output,
    cacheRead: t.cacheRead,
    cacheCreation: t.cacheCreation,
  };
}

/** Sum of every published `usage`-carrying event: the stream must agree with the stored totals. */
function publishedSum(events: readonly CrowEvent[]): Totals {
  const sum = { ...ZERO };
  for (const e of events) {
    if (e.usage === undefined) continue;
    sum.input += e.usage.input;
    sum.output += e.usage.output;
    sum.cacheRead += e.usage.cacheRead;
    sum.cacheCreation += e.usage.cacheCreation;
  }
  return sum;
}

describe("OTel usage ledger (D6)", () => {
  test("OTel then transcript inside the retention: held is dropped, no events, transcript counts once", () => {
    // Covers: R12
    const db = freshDb();
    const clock: Clock = { t: T0 };
    const deps = clockDeps(clock);

    const first = ingest(db, deps, otel("req:a"));
    expect(first.filter((e) => e.usage !== undefined)).toHaveLength(0);
    expect(ledgerStates(db)).toEqual([{ key: "req:a", state: "held" }]);
    expect(sessionTotals(db).input).toBe(0);

    clock.t = T0 + OTEL_HOLD_MS - 1; // still inside the retention: nothing to promote
    expect(promoteHeldUsage(db, deps)).toEqual([]);

    const second = ingest(db, deps, transcript("req:a"));
    expect(second.filter((e) => e.usage !== undefined && e.source === "otel")).toHaveLength(0);
    expect(ledgerStates(db)).toEqual([{ key: "req:a", state: "dropped" }]);

    clock.t = T0 + 10 * OTEL_HOLD_MS;
    expect(promoteHeldUsage(db, deps)).toEqual([]);
    expect(pickCounts(sessionTotals(db))).toEqual(expected(USAGE));
  });

  test("transcript then OTel: the r: mark discards it, nothing is held", () => {
    // Covers: R12
    const db = freshDb();
    const deps = clockDeps({ t: T0 });

    ingest(db, deps, transcript("req:a"));
    ingest(db, deps, otel("req:a"));

    expect(ledgerStates(db)).toEqual([]);
    expect(pickCounts(sessionTotals(db))).toEqual(expected(USAGE));
  });

  test("a solo-OTel call is promoted after 30 s onto the main agent, priced by crow, with a counted usage event", () => {
    // Covers: R12
    const db = freshDb();
    const clock: Clock = { t: T0 };
    const deps = clockDeps(clock);

    ingest(db, deps, otel("req:solo"));
    clock.t = T0 + OTEL_HOLD_MS; // hold_until is inclusive
    const promoted = promoteHeldUsage(db, deps);

    expect(promoted).toHaveLength(1);
    const event = promoted[0]!;
    expect(event.kind).toBe("usage");
    expect(event.source).toBe("otel");
    expect(event.agentId).toBeNull();
    expect(event.ts).toBe(T0 + 500); // the record's own ts
    expect(event.usage?.input).toBe(USAGE.input);
    expect(event.usage?.costUsd).toBeGreaterThan(0); // crow's price table, not OTel's cost_usd
    expect(ledgerStates(db)).toEqual([{ key: "req:solo", state: "counted" }]);
    expect(pickCounts(sessionTotals(db))).toEqual(expected(USAGE));
    expect(pickCounts(mainAgentTotals(db)!)).toEqual(expected(USAGE));
    expect(pickCounts(dailyTotals(db))).toEqual(expected(USAGE));

    // A second tick has nothing left to do.
    expect(promoteHeldUsage(db, deps)).toEqual([]);
  });

  test("OTel, promotion, then the transcript: exact negative correction, net zero plus the transcript", () => {
    // Covers: R12
    const db = freshDb();
    const clock: Clock = { t: T0 };
    const deps = clockDeps(clock);

    const published: CrowEvent[] = [];
    published.push(...ingest(db, deps, otel("req:a")));
    clock.t = T0 + OTEL_HOLD_MS;
    published.push(...promoteHeldUsage(db, deps));
    expect(sessionTotals(db).input).toBe(USAGE.input);

    published.push(...ingest(db, deps, transcript("req:a")));

    const corrections = published.filter(
      (e) => e.source === "otel" && e.usage !== undefined && e.usage.input < 0,
    );
    expect(corrections).toHaveLength(1);
    expect(corrections[0]!.usage?.input).toBe(-USAGE.input);
    expect(corrections[0]!.usage?.costUsd).toBeLessThan(0);
    expect(corrections[0]!.ts).toBe(T0 + 500); // the record's day, not the arrival's
    expect(ledgerStates(db)).toEqual([{ key: "req:a", state: "dropped" }]);
    expect(pickCounts(sessionTotals(db))).toEqual(expected(USAGE));
    expect(pickCounts(mainAgentTotals(db)!)).toEqual(expected(USAGE));
    expect(pickCounts(dailyTotals(db))).toEqual(expected(USAGE));
    expect(pickCounts(publishedSum(published))).toEqual(expected(USAGE));

    // Streamed chunks of the same call re-run nothing: the mark already exists.
    const again = ingest(db, deps, transcript("req:a"));
    expect(again.filter((e) => e.source === "otel")).toHaveLength(0);
  });

  test("a negative correction lowers t_unpriced by 1 when the model has no price", () => {
    // Covers: R12
    const db = freshDb();
    const clock: Clock = { t: T0 };
    const deps = clockDeps(clock);

    ingest(db, deps, otel("req:a", UNPRICED));
    clock.t = T0 + OTEL_HOLD_MS;
    promoteHeldUsage(db, deps);
    expect(sessionTotals(db).unpriced).toBe(1);

    ingest(db, deps, transcript("req:a", UNPRICED));

    // The transcript's own unpriced usage counts 1; the correction removed the OTel one.
    expect(sessionTotals(db).unpriced).toBe(1);
    expect(dailyTotals(db).unpriced).toBe(1);
  });

  test("a transcript line without requestId marks tu_unkeyed: OTel never counts and counted rows are replaced", () => {
    // Covers: R12
    const db = freshDb();
    const clock: Clock = { t: T0 };
    const deps = clockDeps(clock);

    ingest(db, deps, otel("req:a"));
    clock.t = T0 + OTEL_HOLD_MS;
    promoteHeldUsage(db, deps); // counted
    ingest(db, deps, otel("req:b")); // held
    expect(sessionTotals(db).input).toBe(USAGE.input);

    const events = ingest(db, deps, transcript(undefined));

    expect(events.filter((e) => e.source === "otel" && (e.usage?.input ?? 0) < 0)).toHaveLength(1);
    expect(ledgerStates(db)).toEqual([
      { key: "req:a", state: "dropped" },
      { key: "req:b", state: "dropped" },
    ]);
    expect(pickCounts(sessionTotals(db))).toEqual(expected(USAGE)); // only the transcript's

    // Later OTel of any call is discarded while the session is unkeyed.
    ingest(db, deps, otel("req:c"));
    clock.t = T0 + 10 * OTEL_HOLD_MS;
    expect(promoteHeldUsage(db, deps)).toEqual([]);
    expect(ledgerStates(db)).toHaveLength(2);
    expect(pickCounts(sessionTotals(db))).toEqual(expected(USAGE));
  });

  test("session scope (Codex): OTel without a call key is held, promoted, and replaced by the transcript's unkeyed usage", () => {
    // Covers: R12
    const db = freshDb();
    const clock: Clock = { t: T0 };
    const deps = clockDeps(clock);

    ingest(db, deps, otel(undefined));
    expect(ledgerStates(db)).toHaveLength(1);
    expect(ledgerStates(db)[0]!.key.startsWith("rec:")).toBe(true);

    clock.t = T0 + OTEL_HOLD_MS;
    promoteHeldUsage(db, deps);
    expect(sessionTotals(db).input).toBe(USAGE.input);

    ingest(db, deps, transcript(undefined));
    expect(pickCounts(sessionTotals(db))).toEqual(expected(USAGE));

    ingest(db, deps, otel(undefined));
    clock.t = T0 + 10 * OTEL_HOLD_MS;
    promoteHeldUsage(db, deps);
    expect(pickCounts(sessionTotals(db))).toEqual(expected(USAGE));
  });

  test("a held session-scope row is dropped at promotion when the transcript arrived meanwhile (tu_keyed)", () => {
    // Covers: R12
    const db = freshDb();
    const clock: Clock = { t: T0 };
    const deps = clockDeps(clock);

    ingest(db, deps, otel(undefined));
    // A keyed transcript line of another call flips tu_keyed; the session scope is then covered.
    ingest(db, deps, transcript("req:other"));
    clock.t = T0 + OTEL_HOLD_MS;

    expect(promoteHeldUsage(db, deps)).toEqual([]);
    expect(pickCounts(sessionTotals(db))).toEqual(expected(USAGE));
  });

  test("a migrated F1 session (totals before v3) never counts OTel", () => {
    // Covers: R12
    const db = new Database(":memory:");
    migrate(
      db,
      MIGRATIONS.filter((m) => m.version <= 2),
    );
    db.exec(
      "INSERT INTO projects (key, path, name, first_seen, last_seen) VALUES ('p','/p','p',1,1)",
    );
    db.exec(
      `INSERT INTO sessions (id, engine, native_id, project_key, started_at, last_event_at, status, t_input)
       VALUES ('claude:s1','claude','s1','p',1,5,'idle',10)`,
    );
    migrate(db, MIGRATIONS);
    const clock: Clock = { t: T0 };
    const deps = clockDeps(clock);

    ingest(db, deps, otel("req:a"));
    ingest(db, deps, otel(undefined));
    clock.t = T0 + 10 * OTEL_HOLD_MS;

    expect(ledgerStates(db)).toEqual([]);
    expect(promoteHeldUsage(db, deps)).toEqual([]);
    expect(sessionTotals(db).input).toBe(10);
  });

  test("retries and repeated OTel records for one call never count twice", () => {
    // Covers: R12
    const db = freshDb();
    const clock: Clock = { t: T0 };
    const deps = clockDeps(clock);

    const retried = otel("req:a");
    ingest(db, deps, retried);
    ingest(db, deps, retried); // same batch again: line dedupe
    ingest(db, deps, otel("req:a")); // another record for the same call: ledger PK
    clock.t = T0 + OTEL_HOLD_MS;
    promoteHeldUsage(db, deps);
    ingest(db, deps, otel("req:a")); // after promotion: PK again

    expect(ledgerStates(db)).toEqual([{ key: "req:a", state: "counted" }]);
    expect(pickCounts(sessionTotals(db))).toEqual(expected(USAGE));
  });

  test("OTel metrics and non-usage OTel events never reach the ledger", () => {
    // Covers: R12
    const db = freshDb();
    const clock: Clock = { t: T0 };
    const deps = clockDeps(clock);

    // Metrics carry `reported` only (no `otelUsage`), so the store has nothing to count.
    ingest(
      db,
      deps,
      pending("otel", { kind: "usage", ts: T0, reported: { metric: "token.usage", input: 999 } }),
    );
    clock.t = T0 + 10 * OTEL_HOLD_MS;

    expect(ledgerStates(db)).toEqual([]);
    expect(promoteHeldUsage(db, deps)).toEqual([]);
    expect(sessionTotals(db).input).toBe(0);
  });
});

describe("no double count or loss in any permutation", () => {
  type Step = "T" | "O" | "O2" | "P";

  /** Runs `steps` in order; each `P` moves the clock past the retention and ticks the sweeper. */
  function run(steps: readonly Step[]): { db: Database; published: CrowEvent[] } {
    const db = freshDb();
    const clock: Clock = { t: T0 };
    const deps = clockDeps(clock);
    const published: CrowEvent[] = [];
    for (const step of steps) {
      if (step === "T") published.push(...ingest(db, deps, transcript("req:a")));
      else if (step === "O") published.push(...ingest(db, deps, otel("req:a")));
      else if (step === "O2") published.push(...ingest(db, deps, otel("req:a")));
      else {
        clock.t += OTEL_HOLD_MS + 1;
        published.push(...promoteHeldUsage(db, deps));
      }
    }
    // Flush: whatever is still held must reach its verdict.
    clock.t += 10 * OTEL_HOLD_MS;
    published.push(...promoteHeldUsage(db, deps));
    return { db, published };
  }

  const WITH_TRANSCRIPT: Step[] = ["T", "O", "O2", "P"];
  const OTEL_ONLY: Step[] = ["O", "O2", "P"];

  test("with the transcript: totals equal the transcript alone, ledger and stream agree (24 orders)", () => {
    // Covers: R12
    const orders = permutations(WITH_TRANSCRIPT);
    expect(orders).toHaveLength(24);
    for (const order of orders) {
      const { db, published } = run(order);
      const label = order.join(",");
      expect({ order: label, ...pickCounts(sessionTotals(db)) }).toEqual({
        order: label,
        ...expected(USAGE),
      });
      expect({ order: label, ...pickCounts(mainAgentTotals(db)!) }).toEqual({
        order: label,
        ...expected(USAGE),
      });
      expect({ order: label, ...pickCounts(dailyTotals(db)) }).toEqual({
        order: label,
        ...expected(USAGE),
      });
      expect({ order: label, ...pickCounts(publishedSum(published)) }).toEqual({
        order: label,
        ...expected(USAGE),
      });
      expect(ledgerStates(db).every((r) => r.state === "dropped")).toBe(true);
    }
  });

  test("without a transcript: the OTel call counts exactly once (6 orders)", () => {
    // Covers: R12
    const orders = permutations(OTEL_ONLY);
    expect(orders).toHaveLength(6);
    for (const order of orders) {
      const { db, published } = run(order);
      const label = order.join(",");
      expect({ order: label, ...pickCounts(sessionTotals(db)) }).toEqual({
        order: label,
        ...expected(USAGE),
      });
      expect({ order: label, ...pickCounts(publishedSum(published)) }).toEqual({
        order: label,
        ...expected(USAGE),
      });
      expect(ledgerStates(db)).toEqual([{ key: "req:a", state: "counted" }]);
    }
  });

  test("a call without requestId: every order still counts the transcript once", () => {
    // Covers: R12
    const steps = ["T", "O", "P"] as const;
    for (const order of permutations(steps)) {
      const db = freshDb();
      const clock: Clock = { t: T0 };
      const deps = clockDeps(clock);
      const published: CrowEvent[] = [];
      for (const step of order) {
        if (step === "T") published.push(...ingest(db, deps, transcript(undefined)));
        else if (step === "O") published.push(...ingest(db, deps, otel(undefined)));
        else {
          clock.t += OTEL_HOLD_MS + 1;
          published.push(...promoteHeldUsage(db, deps));
        }
      }
      clock.t += 10 * OTEL_HOLD_MS;
      published.push(...promoteHeldUsage(db, deps));
      const label = order.join(",");
      expect({ order: label, ...pickCounts(sessionTotals(db)) }).toEqual({
        order: label,
        ...expected(USAGE),
      });
      expect({ order: label, ...pickCounts(publishedSum(published)) }).toEqual({
        order: label,
        ...expected(USAGE),
      });
    }
  });
});

describe("the ledger is per agent for Codex subagent threads (D19, R36)", () => {
  const CODEX_USAGE: CrowEventUsage = { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 };
  const MAIN_USAGE: CrowEventUsage = { input: 7, output: 3, cacheRead: 0, cacheCreation: 0 };
  const codex = (p: PendingEvent): PendingEvent => ({ ...p, engine: "codex" });
  const startKid = { key: "agent-start:kid", mode: "exact" } as const;

  /** The OTel spawn that links `kid` to `root`: the thread's own records follow the link. */
  const spawn = (): PendingEvent =>
    codex(
      pending("otel", {
        sessionId: "root",
        agentId: "kid",
        kind: "agent.start",
        ts: T0 + 1,
        match: startKid,
      }),
    );
  /** Keyless OTel usage of a thread (`sessionId` is the thread id until it is linked). */
  const otelUsage = (thread: string, usage: CrowEventUsage, ts = T0 + 600): PendingEvent =>
    codex(
      pending("otel", {
        sessionId: thread,
        kind: "usage",
        ts,
        otelUsage: usage,
        reported: { metric: "sse_event", input: usage.input, output: usage.output },
      }),
    );
  /** A keyless rollout usage line (Codex `token_count`) of `agentId` (`null` = main) under `root`. */
  const rollout = (agentId: string | null, usage: CrowEventUsage): PendingEvent =>
    codex(
      pending("transcript", {
        sessionId: "root",
        agentId,
        kind: "assistant.message",
        ts: T0 + 650,
        text: "answer",
        usage,
        usageKey: `u:${agentId ?? "main"}:1`,
      }),
    );

  const input = (db: Database, sql: string): number =>
    db.query<{ t: number | null }, []>(sql).get()?.t ?? 0;
  const view = (db: Database): { total: number; main: number; kid: number; orphan: number } => ({
    total: input(db, "SELECT SUM(t_input) AS t FROM project_daily"),
    main: input(db, "SELECT t_input AS t FROM agents WHERE id = 'codex:root/main'"),
    kid: input(db, "SELECT t_input AS t FROM agents WHERE id = 'codex:root/kid'"),
    orphan: input(db, "SELECT t_input AS t FROM sessions WHERE id = 'codex:kid'"),
  });

  /** Runs `steps`, then lets every held row reach its verdict. */
  function run(steps: readonly PendingEvent[]): Database {
    const db = freshDb();
    const clock: Clock = { t: T0 };
    const deps = clockDeps(clock);
    for (const step of steps) ingest(db, deps, step);
    clock.t += 10 * OTEL_HOLD_MS;
    promoteHeldUsage(db, deps);
    return db;
  }

  test("(a) the root has a rollout and the child has none: main 7 and kid 10, total 17, in all 6 orders", () => {
    // Covers: R12, R36
    const make = (): Record<string, PendingEvent> => ({
      rootRollout: rollout(null, MAIN_USAGE),
      spawn: spawn(),
      kidOtel: otelUsage("kid", CODEX_USAGE),
    });
    const orders = permutations(Object.keys(make()));
    expect(orders).toHaveLength(6);
    for (const order of orders) {
      const lanes = make();
      const label = order.join(",");
      expect({ label, ...view(run(order.map((n) => lanes[n]!))) }).toEqual({
        label,
        total: 17,
        main: 7,
        kid: 10,
        orphan: 0,
      });
    }
  });

  test("(b) a keyless root line leaves the child's OTel rows alone", () => {
    // Covers: R12, R36
    const db = run([spawn(), otelUsage("kid", CODEX_USAGE), rollout(null, MAIN_USAGE)]);
    expect(view(db)).toEqual({ total: 17, main: 7, kid: 10, orphan: 0 });
    const states = db
      .query<{ state: string; agent_id: string | null }, []>(
        "SELECT state, agent_id FROM otel_usage",
      )
      .all();
    expect(states).toEqual([{ state: "counted", agent_id: "kid" }]);
  });

  test("(b) a keyless child line replaces the child's OTel and, conservatively, the main agent's (c3, never double counts)", () => {
    // Covers: R12, R36
    const main = otelUsage("root", MAIN_USAGE, T0 + 5);
    for (const order of permutations(["mainOtel", "spawn", "kidRollout"])) {
      const lanes: Record<string, PendingEvent> = {
        mainOtel: main,
        spawn: spawn(),
        kidRollout: rollout("kid", CODEX_USAGE),
      };
      const db = run(order.map((n) => lanes[n]!));
      const label = order.join(",");
      // Main's 7 is lost: the documented undercount of R36, limited to the main agent's OTLP usage.
      expect({ label, ...view(db) }).toEqual({ label, total: 10, main: 0, kid: 10, orphan: 0 });
    }
  });

  test("a keyless child line never covers another child's OTel usage", () => {
    // Covers: R12, R36
    const otherSpawn = codex(
      pending("otel", {
        sessionId: "root",
        agentId: "other",
        kind: "agent.start",
        ts: T0 + 2,
        match: { key: "agent-start:other", mode: "exact" },
      }),
    );
    const db = run([
      spawn(),
      otherSpawn,
      otelUsage("other", MAIN_USAGE),
      rollout("kid", CODEX_USAGE),
    ]);
    expect({
      kid: input(db, "SELECT t_input AS t FROM agents WHERE id = 'codex:root/kid'"),
      other: input(db, "SELECT t_input AS t FROM agents WHERE id = 'codex:root/other'"),
    }).toEqual({ kid: 10, other: 7 });
  });
});
