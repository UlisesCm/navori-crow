import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PartialCrowEvent } from "../adapter";
import { createUlidFactory } from "../ulid";
import { migrate } from "./migrations";
import { getSessionDetail, hasEvent, ingestBatch, listProjects, stats } from "./store";
import type { IngestBatchDeps, PendingEvent } from "./store";

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

const NOW = Date.now(); // project_daily buckets by the event's local day, so "today" must be real "today"

function makeDeps(overrides: Partial<IngestBatchDeps> = {}): IngestBatchDeps {
  return {
    nextId: createUlidFactory("00000000000000000000000000", () => NOW),
    now: () => NOW,
    idleMs: 5 * 60_000,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<PartialCrowEvent> = {}): PartialCrowEvent {
  return {
    sessionId: "s1",
    agentId: null,
    parentAgentId: null,
    kind: "prompt",
    ts: NOW,
    text: "hi",
    ...overrides,
  };
}

function makePending(
  overrides: Partial<PendingEvent> = {},
  eventOverrides: Partial<PartialCrowEvent> = {},
): PendingEvent {
  return {
    engine: "claude",
    source: "transcript",
    lineHash: `hash-${Math.random()}`,
    part: "0",
    pos: { path: "/tmp/f.jsonl", offset: 0, line: 1 },
    event: makeEvent(eventOverrides),
    ...overrides,
  };
}

describe("ingestBatch: totals", () => {
  test("session, agent and project_daily totals equal the sum of stamped usage (R4)", () => {
    // Covers: R4
    const db = freshDb();
    const deps = makeDeps();

    ingestBatch(db, deps, {
      path: "/f",
      inode: "1",
      nextOffset: 10,
      state: null,
      events: [
        makePending(
          { lineHash: "h1" },
          {
            kind: "assistant.message",
            usage: {
              input: 10,
              output: 5,
              cacheRead: 0,
              cacheCreation: 0,
              model: "claude-sonnet-5",
            },
            usageKey: "u:main:m1",
            cwd: "/tmp/proj-a",
          },
        ),
        makePending(
          { lineHash: "h2" },
          {
            kind: "assistant.message",
            usage: {
              input: 3,
              output: 1,
              cacheRead: 0,
              cacheCreation: 0,
              model: "claude-sonnet-5",
            },
            usageKey: "u:main:m2",
            cwd: "/tmp/proj-a",
          },
        ),
      ],
    });

    const detail = getSessionDetail(db, "claude:s1");
    expect(detail).not.toBeNull();
    expect(detail?.session.totals.input).toBe(13);
    expect(detail?.session.totals.output).toBe(6);
    expect(detail?.agents[0]?.totals.input).toBe(13);

    const projects = listProjects(db, 0);
    const project = projects.find((p) => p.sessions.some((s) => s.id === "claude:s1"));
    expect(project?.today.input).toBe(13);
  });

  test("a failed transaction leaves no partial rows (R4)", () => {
    // Covers: R4
    const db = freshDb();
    let calls = 0;
    const deps: IngestBatchDeps = {
      nextId: () => {
        calls++;
        if (calls > 1) throw new Error("boom");
        return "01AAAAAAAAAAAAAAAAAAAAAAAA";
      },
      now: () => 1_700_000_000_000,
      idleMs: 5 * 60_000,
    };

    expect(() =>
      ingestBatch(db, deps, {
        path: "/f",
        inode: "1",
        nextOffset: 10,
        state: null,
        events: [makePending({ lineHash: "a" }), makePending({ lineHash: "b" })],
      }),
    ).toThrow("boom");

    const eventCount = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM events").get();
    expect(eventCount?.c).toBe(0);
    const dedupeCount = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM dedupe").get();
    expect(dedupeCount?.c).toBe(0);
    const offsetCount = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM ingest_offsets")
      .get();
    expect(offsetCount?.c).toBe(0);
  });
});

describe("ingestBatch: a fork's carried-over accumulator (BLOCKER 1, real 0.145.0 id19 numbers)", () => {
  test("session weightedTokens and costUsd reflect only the counted usage, never the carried total (R4, R20, R21)", () => {
    // Covers: R4, R20, R21
    // fixtures/codex/0.145.0 id19: the adapter counts the first token_count's last_token_usage
    // (1395 in, 117504 cached, 1231 out) and later only deltas; it never emits the carried 2,331,377.
    const db = freshDb();
    ingestBatch(db, makeDeps(), {
      path: "/f",
      inode: "1",
      nextOffset: 10,
      state: null,
      events: [
        makePending(
          { engine: "codex", lineHash: "c1" },
          {
            sessionId: "id0",
            agentId: "id19",
            kind: "assistant.message",
            usage: {
              input: 1395,
              output: 1231,
              cacheRead: 117_504,
              cacheCreation: 0,
              model: "gpt-5.6-sol",
            },
          },
        ),
      ],
    });
    const t = getSessionDetail(db, "codex:id0")!.session.totals;
    expect([t.input, t.output, t.cacheRead]).toEqual([1395, 1231, 117_504]);
    expect(t.weightedTokens).toBeCloseTo(1395 + 5 * 1231 + 0.1 * 117_504, 6);
    expect(t.weightedTokens).toBeLessThan(2_331_377); // the carried input alone outweighs it
    expect(t.costUsd).toBe(0); // Codex models are unpriced (R20): tokens count, cost stays unset
  });
});

describe("ingestBatch: usage max-tracking and anomaly (R13, round 4)", () => {
  test("a repeated message.id whose usage grew counts only the positive delta, once", () => {
    // Covers: R13 — real Claude streaming: output_tokens grows across duplicate message.id lines.
    const db = freshDb();
    const deps = makeDeps();

    const stored = ingestBatch(db, deps, {
      path: "/f",
      inode: "1",
      nextOffset: 10,
      state: null,
      events: [
        makePending(
          { lineHash: "h1" },
          {
            kind: "assistant.message",
            usage: {
              input: 2,
              output: 1,
              cacheRead: 100,
              cacheCreation: 50,
              model: "claude-sonnet-5",
            },
            usageKey: "u:main:grow",
          },
        ),
        makePending(
          { lineHash: "h2" },
          {
            kind: "assistant.message",
            usage: {
              input: 2,
              output: 388, // grew; every other component held
              cacheRead: 100,
              cacheCreation: 50,
              model: "claude-sonnet-5",
            },
            usageKey: "u:main:grow",
          },
        ),
      ],
    });

    const withUsage = stored.filter((e) => e.kind === "assistant.message" && e.usage !== undefined);
    expect(withUsage).toHaveLength(2); // both lines counted: first is the baseline, second is the delta
    expect(withUsage[0]?.usage).toMatchObject({
      input: 2,
      output: 1,
      cacheRead: 100,
      cacheCreation: 50,
    });
    expect(withUsage[1]?.usage).toMatchObject({
      input: 0,
      output: 387,
      cacheRead: 0,
      cacheCreation: 0,
    }); // delta only
    expect(stored.some((e) => e.kind === "ingest.error")).toBe(false);

    const detail = getSessionDetail(db, "claude:s1");
    expect(detail?.session.totals.input).toBe(2);
    expect(detail?.session.totals.output).toBe(388); // 1 + 387, the true final value — not 1+388
    expect(detail?.session.totals.cacheRead).toBe(100);

    expect(stats(db).usageAnomalies).toBe(0);
  });

  test("an identical repeated usage is a zero-delta no-op: counted once, no anomaly, no phantom event", () => {
    // Covers: R13
    const db = freshDb();
    const deps = makeDeps();
    const sameUsage = {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheCreation: 0,
      model: "claude-sonnet-5",
    };

    const stored = ingestBatch(db, deps, {
      path: "/f",
      inode: "1",
      nextOffset: 10,
      state: null,
      events: [
        makePending(
          { lineHash: "h1" },
          {
            kind: "assistant.message",
            usage: { ...sameUsage },
            usageKey: "u:main:same",
            text: "hi",
          },
        ),
        // A usage-only continuation (no text): the round-4 shape `mapAssistant` now emits for a
        // duplicate `message.id` whose usage didn't move at all.
        makePending(
          { lineHash: "h2" },
          {
            kind: "assistant.message",
            usage: { ...sameUsage },
            usageKey: "u:main:same",
            text: undefined,
          },
        ),
      ],
    });

    expect(stored.every((e) => e.kind !== "ingest.error")).toBe(true);
    expect(stats(db).usageAnomalies).toBe(0);
    // The zero-delta, text-free second line isn't persisted at all (round 4: no phantom events).
    expect(stored).toHaveLength(1);

    const detail = getSessionDetail(db, "claude:s1");
    expect(detail?.session.totals.input).toBe(10);
  });

  test("any component decreasing is an anomaly: the tracked max is kept, nothing from that line counts", () => {
    // Covers: R13
    const db = freshDb();
    const deps = makeDeps();

    const stored = ingestBatch(db, deps, {
      path: "/f",
      inode: "1",
      nextOffset: 10,
      state: null,
      events: [
        makePending(
          { lineHash: "h1" },
          {
            kind: "assistant.message",
            usage: {
              input: 10,
              output: 999,
              cacheRead: 0,
              cacheCreation: 0,
              model: "claude-sonnet-5",
            },
            usageKey: "u:main:dup",
          },
        ),
        makePending(
          { lineHash: "h2" },
          {
            // input grew, but output DROPPED below the tracked max: the whole line is an anomaly,
            // even the grown component doesn't count (design.md D7, round 4).
            kind: "assistant.message",
            usage: {
              input: 20,
              output: 5,
              cacheRead: 0,
              cacheCreation: 0,
              model: "claude-sonnet-5",
            },
            usageKey: "u:main:dup",
            text: "still has text, but usage is dropped",
          },
        ),
      ],
    });

    expect(
      stored.filter((e) => e.kind === "assistant.message" && e.usage !== undefined),
    ).toHaveLength(1);
    // The text-bearing second line is still persisted (it carries `text`), just without usage.
    expect(stored.find((e) => e.kind === "assistant.message" && e.usage === undefined)?.text).toBe(
      "still has text, but usage is dropped",
    );
    expect(
      stored.some((e) => e.kind === "ingest.error" && e.error?.reason === "usage-anomaly"),
    ).toBe(true);

    const detail = getSessionDetail(db, "claude:s1");
    expect(detail?.session.totals.input).toBe(10); // kept the max, not the grown-but-tainted 20
    expect(detail?.session.totals.output).toBe(999);

    const ingestStats = stats(db);
    expect(ingestStats.usageAnomalies).toBe(1);
    expect(ingestStats.errorsByReason["usage-anomaly"]).toBe(1);
  });

  test("re-ingesting the exact same lines (offset-0 restart) doesn't double-count the tracked max", () => {
    // Covers: R13, R6, R16 — content dedupe (lineKey) short-circuits before usage tracking runs at
    // all, so a full re-ingest from a persisted offset of 0 is idempotent for usage too.
    const db = freshDb();
    const events = [
      makePending(
        { lineHash: "h1" },
        {
          kind: "assistant.message",
          usage: { input: 2, output: 1, cacheRead: 0, cacheCreation: 0, model: "claude-sonnet-5" },
          usageKey: "u:main:restart",
        },
      ),
      makePending(
        { lineHash: "h2" },
        {
          kind: "assistant.message",
          usage: {
            input: 2,
            output: 500,
            cacheRead: 0,
            cacheCreation: 0,
            model: "claude-sonnet-5",
          },
          usageKey: "u:main:restart",
        },
      ),
    ];
    const input = { path: "/f", inode: "1", nextOffset: 10, state: null, events };

    ingestBatch(db, makeDeps(), input);
    const before = getSessionDetail(db, "claude:s1")?.session.totals.output;

    // Same file re-tailed from a persisted offset of 0 (e.g. after a restart) with a fresh ULID
    // factory — same lineHash+part, so every event is a content-identity duplicate (R16).
    ingestBatch(db, makeDeps(), { ...input, events });

    const after = getSessionDetail(db, "claude:s1")?.session.totals.output;
    expect(before).toBe(500);
    expect(after).toBe(500); // unchanged: no double counting
    expect(stats(db).usageAnomalies).toBe(0);
  });

  test("usage growing across two separate ingestBatch calls (a later poll) still counts only the delta", () => {
    // Covers: R13 — the tracked max is a DB row, not in-memory state, so it survives across batches.
    const db = freshDb();

    ingestBatch(db, makeDeps(), {
      path: "/f",
      inode: "1",
      nextOffset: 10,
      state: null,
      events: [
        makePending(
          { lineHash: "h1" },
          {
            kind: "assistant.message",
            usage: {
              input: 2,
              output: 1,
              cacheRead: 0,
              cacheCreation: 0,
              model: "claude-sonnet-5",
            },
            usageKey: "u:main:cross-batch",
          },
        ),
      ],
    });

    ingestBatch(db, makeDeps(), {
      path: "/f",
      inode: "1",
      nextOffset: 20,
      state: null,
      events: [
        makePending(
          { lineHash: "h2" }, // a new line, appended later, same message.id/usageKey
          {
            kind: "assistant.message",
            usage: {
              input: 2,
              output: 388,
              cacheRead: 0,
              cacheCreation: 0,
              model: "claude-sonnet-5",
            },
            usageKey: "u:main:cross-batch",
          },
        ),
      ],
    });

    const detail = getSessionDetail(db, "claude:s1");
    expect(detail?.session.totals.input).toBe(2); // not 2+2
    expect(detail?.session.totals.output).toBe(388); // not 1+388
    expect(stats(db).usageAnomalies).toBe(0);
  });
});

describe("ingestBatch: dedupe (R16)", () => {
  test("the same content key is stored only once", () => {
    // Covers: R16
    const db = freshDb();
    const deps = makeDeps();
    const input = {
      path: "/f",
      inode: "1",
      nextOffset: 10,
      state: null,
      events: [makePending({ lineHash: "same", part: "0" })],
    };

    const first = ingestBatch(db, deps, input);
    const second = ingestBatch(db, makeDeps(), {
      ...input,
      events: [makePending({ lineHash: "same", part: "0" })],
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    const count = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM events").get();
    expect(count?.c).toBe(1);
  });

  test("a semantic duplicate is discarded and counted (D7)", () => {
    // Covers: R16
    const db = freshDb();
    const deps = makeDeps();

    const stored = ingestBatch(db, deps, {
      path: "/f",
      inode: "1",
      nextOffset: 10,
      state: null,
      events: [
        makePending({ lineHash: "h1" }, { semanticKey: "uuid:abc:0" }),
        makePending({ lineHash: "h2" }, { semanticKey: "uuid:abc:0" }), // same semantic key, different bytes
      ],
    });

    expect(stored).toHaveLength(1);
    expect(stats(db).semanticDuplicates).toBe(1);
  });
});

describe("ingestBatch: sticky project (R15)", () => {
  test("a session keeps the project of its first cwd, even if a later event carries another cwd", () => {
    // Covers: R15
    const base = mkdtempSync(join(tmpdir(), "crow-store-"));
    const projA = join(base, "a");
    const projB = join(base, "b");
    try {
      const db = freshDb();
      const deps = makeDeps();

      ingestBatch(db, deps, {
        path: "/f",
        inode: "1",
        nextOffset: 10,
        state: null,
        events: [makePending({ lineHash: "h0" }, { kind: "prompt" })], // no cwd yet -> unresolved
      });
      let detail = getSessionDetail(db, "claude:s1");
      expect(detail?.session.projectKey).toBe("unresolved");

      ingestBatch(db, deps, {
        path: "/f",
        inode: "1",
        nextOffset: 20,
        state: null,
        events: [makePending({ lineHash: "h1" }, { kind: "prompt", cwd: projA })],
      });
      detail = getSessionDetail(db, "claude:s1");
      const stickyKey = detail?.session.projectKey;
      expect(stickyKey).not.toBe("unresolved");

      const stored = ingestBatch(db, deps, {
        path: "/f",
        inode: "1",
        nextOffset: 30,
        state: null,
        events: [makePending({ lineHash: "h2" }, { kind: "prompt", cwd: projB })],
      });
      detail = getSessionDetail(db, "claude:s1");
      expect(detail?.session.projectKey).toBe(stickyKey); // still sticky to A
      expect(stored[0]?.cwd).toBe(projB); // but the event keeps its own cwd
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("hasEvent", () => {
  test("is true for a stored id and false for an unknown one", () => {
    // Covers: R4
    const db = freshDb();
    const stored = ingestBatch(db, makeDeps(), {
      path: "/f",
      inode: "1",
      nextOffset: 10,
      state: null,
      events: [makePending({ lineHash: "h1" })],
    });

    expect(hasEvent(db, stored[0]!.id)).toBe(true);
    expect(hasEvent(db, "01UNKNOWNUNKNOWNUNKNOWNUNK")).toBe(false);
  });
});
