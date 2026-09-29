import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { PartialCrowEvent } from "../adapter";
import { createUlidFactory } from "../ulid";
import { migrate } from "./migrations";
import { getSessionDetail, ingestBatch, sweepIdle } from "./store";
import type { IngestBatchDeps, PendingEvent } from "./store";

const IDLE_MS = 5 * 60_000;

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function makeDeps(now: number): IngestBatchDeps {
  return {
    nextId: createUlidFactory("00000000000000000000000000", () => now),
    now: () => now,
    idleMs: IDLE_MS,
  };
}

function makePending(eventOverrides: Partial<PartialCrowEvent>): PendingEvent {
  return {
    engine: "claude",
    source: "transcript",
    lineHash: `hash-${Math.random()}`,
    part: "0",
    pos: { path: "/tmp/f.jsonl", offset: 0, line: 1 },
    event: {
      sessionId: "s1",
      agentId: null,
      parentAgentId: null,
      kind: "prompt",
      ts: 0,
      ...eventOverrides,
    },
  };
}

function ingestOne(db: Database, deps: IngestBatchDeps, event: Partial<PartialCrowEvent>): void {
  ingestBatch(db, deps, {
    path: "/f",
    inode: "1",
    nextOffset: 1,
    state: null,
    events: [makePending(event)],
  });
}

describe("session status (D10)", () => {
  test("a session receiving a fresh event becomes live (R17)", () => {
    // Covers: R17
    const db = freshDb();
    const now = 1_700_000_000_000;
    ingestOne(db, makeDeps(now), { ts: now });

    expect(getSessionDetail(db, "claude:s1")?.session.status).toBe("live");
  });

  test("an old (backfilled) event does not mark a session live", () => {
    // Covers: R17
    const db = freshDb();
    const now = 1_700_000_000_000;
    const oldTs = now - IDLE_MS * 10;
    ingestOne(db, makeDeps(now), { ts: oldTs });

    expect(getSessionDetail(db, "claude:s1")?.session.status).toBe("idle");
  });

  test("sweepIdle marks a live session idle once it's been quiet past the idle window (R18)", () => {
    // Covers: R18
    const db = freshDb();
    let now = 1_700_000_000_000;
    ingestOne(db, makeDeps(now), { ts: now });
    expect(getSessionDetail(db, "claude:s1")?.session.status).toBe("live");

    now += IDLE_MS + 1_000; // clock advances past the idle window; no new events arrive
    sweepIdle(db, () => now, IDLE_MS);

    expect(getSessionDetail(db, "claude:s1")?.session.status).toBe("idle");
  });

  test("sweepIdle leaves a still-fresh live session alone", () => {
    // Covers: R18
    const db = freshDb();
    let now = 1_700_000_000_000;
    ingestOne(db, makeDeps(now), { ts: now });

    now += 1_000; // well within the idle window
    sweepIdle(db, () => now, IDLE_MS);

    expect(getSessionDetail(db, "claude:s1")?.session.status).toBe("live");
  });

  test("a session.end event sets the session to ended (R19)", () => {
    // Covers: R19
    const db = freshDb();
    const now = 1_700_000_000_000;
    ingestOne(db, makeDeps(now), { ts: now, kind: "prompt" });
    ingestOne(db, makeDeps(now), { ts: now + 1, kind: "session.end" });

    const detail = getSessionDetail(db, "claude:s1");
    expect(detail?.session.status).toBe("ended");
    expect(detail?.session.endedAt).toBe(now + 1);
  });

  test("a fresh event resumes an ended session back to live (D10 resumption)", () => {
    // Covers: R17, R19
    const db = freshDb();
    let now = 1_700_000_000_000;
    ingestOne(db, makeDeps(now), { ts: now, kind: "session.end" });
    expect(getSessionDetail(db, "claude:s1")?.session.status).toBe("ended");

    now += 1_000;
    ingestOne(db, makeDeps(now), { ts: now, kind: "prompt" });

    expect(getSessionDetail(db, "claude:s1")?.session.status).toBe("live");
  });
});

describe("non-monotone effects are guarded by ts (BD1)", () => {
  test("(3) an ended session only revives with ts > ended_at; ended_at keeps the maximum", () => {
    // Covers: R17, R19
    const db = freshDb();
    const now = 1_700_000_000_000;
    const deps = makeDeps(now);
    ingestOne(db, deps, { ts: now, kind: "session.end" });

    ingestOne(db, deps, { ts: now - 1_000, kind: "prompt", text: "late and old" }); // older than the end
    expect(getSessionDetail(db, "claude:s1")?.session.status).toBe("ended");
    ingestOne(db, deps, { ts: now, kind: "assistant.message", text: "same ms" }); // ts == ended_at
    expect(getSessionDetail(db, "claude:s1")?.session.status).toBe("ended");

    ingestOne(db, deps, { ts: now + 1, kind: "prompt", text: "fresh" });
    expect(getSessionDetail(db, "claude:s1")?.session.status).toBe("live");

    ingestOne(db, deps, { ts: now + 50, kind: "session.end" });
    ingestOne(db, deps, { ts: now + 20, kind: "session.end" }); // an older end arriving late
    const detail = getSessionDetail(db, "claude:s1");
    expect(detail?.session.status).toBe("ended");
    expect(detail?.session.endedAt).toBe(now + 50);
  });

  test("(1) last_prompt only changes with ts >= last_prompt_at", () => {
    // Covers: R13
    const db = freshDb();
    const now = 1_700_000_000_000;
    const deps = makeDeps(now);
    ingestOne(db, deps, { ts: now + 200, kind: "prompt", text: "P2" });
    ingestOne(db, deps, { ts: now + 100, kind: "prompt", text: "P1 (late)" });
    let session = getSessionDetail(db, "claude:s1")!.session;
    expect(session.lastPrompt).toBe("P2");
    expect(session.lastPromptAt).toBe(now + 200);

    ingestOne(db, deps, { ts: now + 200, kind: "prompt", text: "P2 again" }); // ts == last_prompt_at
    session = getSessionDetail(db, "claude:s1")!.session;
    expect(session.lastPrompt).toBe("P2 again");
    ingestOne(db, deps, { ts: now + 300, kind: "prompt", text: "P3" });
    expect(getSessionDetail(db, "claude:s1")!.session.lastPrompt).toBe("P3");
  });

  test("(2) a finished agent never revives: agent.stop ingested before the file's agent.start", () => {
    // Covers: R13
    const db = freshDb();
    const now = 1_700_000_000_000;
    const deps = makeDeps(now);
    ingestOne(db, deps, { ts: now + 300, kind: "agent.stop", agentId: "a1" });
    ingestOne(db, deps, {
      ts: now + 100,
      kind: "agent.start",
      agentId: "a1",
      agent: { type: "explorer", depth: 1 },
    });

    const detail = getSessionDetail(db, "claude:s1")!;
    expect(detail.agents[0]!.status).toBe("done");
    expect(detail.agents[0]!.endedAt).toBe(now + 300);
    expect(detail.agents[0]!.type).toBe("explorer");
    expect(detail.session.activeAgent).toBeNull();
    expect(detail.session.activeAgentAt).toBe(now + 300);
  });

  test("a second agent.stop keeps the first ended_at", () => {
    // Covers: R13
    const db = freshDb();
    const now = 1_700_000_000_000;
    const deps = makeDeps(now);
    ingestOne(db, deps, { ts: now + 10, kind: "agent.start", agentId: "a1", agent: {} });
    ingestOne(db, deps, { ts: now + 20, kind: "agent.stop", agentId: "a1" });
    ingestOne(db, deps, { ts: now + 30, kind: "agent.stop", agentId: "a1" });
    expect(getSessionDetail(db, "claude:s1")!.agents[0]!.endedAt).toBe(now + 20);
  });
});
