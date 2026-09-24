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

describe("ingestBatch: usage anomaly (R13)", () => {
  test("a repeated message.id with a different usage keeps the first and flags an anomaly", () => {
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
              output: 5,
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
            kind: "assistant.message",
            usage: {
              input: 999,
              output: 999,
              cacheRead: 0,
              cacheCreation: 0,
              model: "claude-sonnet-5",
            },
            usageKey: "u:main:dup",
          },
        ),
      ],
    });

    expect(
      stored.filter((e) => e.kind === "assistant.message" && e.usage !== undefined),
    ).toHaveLength(1);
    expect(
      stored.some((e) => e.kind === "ingest.error" && e.error?.reason === "usage-anomaly"),
    ).toBe(true);

    const detail = getSessionDetail(db, "claude:s1");
    expect(detail?.session.totals.input).toBe(10); // only the first usage counted

    const ingestStats = stats(db);
    expect(ingestStats.usageAnomalies).toBe(1);
    expect(ingestStats.errorsByReason["usage-anomaly"]).toBe(1);
  });

  test("an identical repeated usage is dropped silently, without an anomaly", () => {
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
          { kind: "assistant.message", usage: { ...sameUsage }, usageKey: "u:main:same" },
        ),
        makePending(
          { lineHash: "h2" },
          { kind: "assistant.message", usage: { ...sameUsage }, usageKey: "u:main:same" },
        ),
      ],
    });

    expect(stored.every((e) => e.kind !== "ingest.error")).toBe(true);
    expect(stats(db).usageAnomalies).toBe(0);

    const detail = getSessionDetail(db, "claude:s1");
    expect(detail?.session.totals.input).toBe(10);
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
