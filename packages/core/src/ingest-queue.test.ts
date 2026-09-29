import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { BoundAdapter, HookInput, HookResult } from "./adapter";
import { EventBus } from "./bus";
import type { CrowEvent } from "./crow-event";
import { IngestQueue } from "./ingest-queue";
import type { IngestQueueOptions } from "./ingest-queue";
import { isRec } from "./narrow";
import { freshDb, IDLE_MS, T0 } from "./store/testing";
import { ingestEvents } from "./store/store";
import { createUlidFactory } from "./ulid";

/** Trivial hook mapping: `{ session, type }` → one event; `type` picks the failure modes. */
function testFromHook(input: HookInput): HookResult {
  const body = input.body;
  if (!isRec(body) || typeof body.session !== "string") {
    return { ok: false, reason: "bad-shape", detail: "no session", sessionId: null, agentId: null };
  }
  if (body.type === "unknown") {
    return {
      ok: false,
      reason: "unknown-type",
      detail: "unknown hook event Foo",
      sessionId: body.session,
      agentId: null,
    };
  }
  if (body.type === "throw") throw new Error("adapter blew up");
  return {
    ok: true,
    events: [
      {
        sessionId: body.session,
        agentId: null,
        parentAgentId: null,
        kind: "prompt",
        ts: T0,
        cwd: "/tmp/proj",
        text: String(body.n ?? ""),
      },
    ],
  };
}

const testAdapter = {
  id: "claude",
  fromHook: testFromHook,
} as unknown as BoundAdapter;

const otherAdapter = { id: "codex", fromHook: testFromHook } as unknown as BoundAdapter;

interface Harness {
  db: Database;
  queue: IngestQueue;
  published: CrowEvent[];
  drops: string[];
}

function harness(overrides: Partial<IngestQueueOptions> = {}): Harness {
  const db = freshDb();
  const bus = new EventBus();
  const published: CrowEvent[] = [];
  bus.subscribe((events) => published.push(...events));
  const drops: string[] = [];
  const queue = new IngestQueue({
    db,
    bus,
    nextId: createUlidFactory("00000000000000000000000000", () => T0),
    now: () => T0,
    idleMs: IDLE_MS,
    adapters: [testAdapter, otherAdapter],
    onDrop: (engine) => drops.push(engine),
    ...overrides,
  });
  return { db, queue, published, drops };
}

const hook = (session: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ session, ...extra });

function errors(db: Database): CrowEvent[] {
  return db
    .query<{ body_json: string }, []>(
      "SELECT body_json FROM events WHERE kind = 'ingest.error' ORDER BY id",
    )
    .all()
    .map((r) => JSON.parse(r.body_json) as CrowEvent);
}

function count(db: Database, kind: string): number {
  return (
    db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE kind = ?").get(kind)
      ?.n ?? 0
  );
}

describe("IngestQueue: drain and R6", () => {
  test("a valid hook is stored and published by the drainer", async () => {
    // Covers: R6
    const h = harness();
    h.queue.enqueueHook("claude", hook("s1", { n: 1 }));
    await h.queue.idle();
    expect(count(h.db, "prompt")).toBe(1);
    expect(h.published.map((e) => e.kind)).toEqual(["prompt"]);
  });

  test("invalid JSON becomes a visible ingest.error invalid-json", async () => {
    // Covers: R6
    const h = harness();
    h.queue.enqueueHook("claude", "{not json");
    await h.queue.idle();
    const [err] = errors(h.db);
    expect(err?.error?.reason).toBe("invalid-json");
    expect(err?.engine).toBe("claude");
  });

  test("an unknown event name becomes ingest.error unknown-type with the name", async () => {
    // Covers: R6
    const h = harness();
    h.queue.enqueueHook("claude", hook("s1", { type: "unknown" }));
    await h.queue.idle();
    const [err] = errors(h.db);
    expect(err?.error?.reason).toBe("unknown-type");
    expect(err?.error?.message).toContain("Foo");
    expect(err?.sessionId).toBe("s1");
  });

  test("an adapter that throws becomes ingest.error bad-shape and the queue continues", async () => {
    // Covers: R6
    const h = harness();
    h.queue.enqueueHook("claude", hook("s1", { type: "throw" }));
    h.queue.enqueueHook("claude", hook("s2"));
    await h.queue.idle();
    expect(errors(h.db).map((e) => e.error?.reason)).toEqual(["bad-shape"]);
    expect(count(h.db, "prompt")).toBe(1);
  });

  test("a payload the adapter rejects as bad-shape is reported, not dropped", async () => {
    // Covers: R6
    const h = harness();
    h.queue.enqueueHook("claude", JSON.stringify({ nope: true }));
    await h.queue.idle();
    expect(errors(h.db).map((e) => e.error?.reason)).toEqual(["bad-shape"]);
  });

  test("identical payloads are two facts (identity includes receipt order)", async () => {
    // Covers: R6
    const h = harness();
    h.queue.enqueueHook("claude", hook("s1", { n: 1 }));
    h.queue.enqueueHook("claude", hook("s1", { n: 1 }));
    await h.queue.idle();
    expect(count(h.db, "prompt")).toBe(2);
  });
});

describe("IngestQueue: overflow (R7)", () => {
  test("capacity 3 with 5 sends → 3 stored, one ingest.error carrying the count", async () => {
    // Covers: R7
    const h = harness({ hookMaxItems: 3, engineQuotaRatio: 1 });
    h.queue.pause();
    const accepted = [1, 2, 3, 4, 5].map((n) => h.queue.enqueueHook("claude", hook(`s${n}`)));
    expect(accepted).toEqual([true, true, true, false, false]);
    expect(h.drops).toEqual(["claude", "claude"]);
    h.queue.resume();
    await h.queue.idle();
    expect(count(h.db, "prompt")).toBe(3);
    const errs = errors(h.db);
    expect(errs).toHaveLength(1);
    expect(errs[0]?.error?.reason).toBe("queue-overflow");
    expect(errs[0]?.error?.message).toContain("2 payload");
    expect(errs[0]?.sessionId).toBe("unknown");
  });

  test("a second episode after draining produces a second error", async () => {
    // Covers: R7
    const h = harness({ hookMaxItems: 1, engineQuotaRatio: 1 });
    for (let episode = 0; episode < 2; episode++) {
      h.queue.pause();
      h.queue.enqueueHook("claude", hook(`e${episode}`));
      h.queue.enqueueHook("claude", hook("dropped"));
      h.queue.resume();
      await h.queue.idle();
    }
    expect(errors(h.db)).toHaveLength(2);
  });

  test("one engine cannot hold more than 60% of the FIFO", () => {
    // Covers: R7
    const h = harness({ hookMaxItems: 10 });
    h.queue.pause();
    const results = Array.from({ length: 8 }, (_, n) =>
      h.queue.enqueueHook("claude", hook(`c${n}`)),
    );
    expect(results.filter(Boolean)).toHaveLength(6);
    expect(h.queue.enqueueHook("codex", hook("x1"))).toBe(true);
    expect(h.drops).toEqual(["claude", "claude"]);
  });

  test("the 17th simultaneous body read is refused and counted; release frees a slot", () => {
    // Covers: R7
    const h = harness();
    const releases = Array.from({ length: 16 }, () => h.queue.acquireBody("claude"));
    expect(releases.every((r) => r !== null)).toBe(true);
    expect(h.queue.acquireBody("claude")).toBeNull();
    expect(h.drops).toEqual(["claude"]);
    releases[0]?.();
    releases[0]?.(); // releasing twice must not free two slots
    expect(h.queue.acquireBody("claude")).not.toBeNull();
    expect(h.queue.acquireBody("claude")).toBeNull();
  });

  test("session-creation quota: past N new sessions per minute the events are discarded and counted", async () => {
    // Covers: R7
    const h = harness({ maxNewSessionsPerMinute: 2, engineQuotaRatio: 1 });
    for (const s of ["a", "b", "c", "a"]) h.queue.enqueueHook("claude", hook(s));
    await h.queue.idle();
    // `a` and `b` create sessions, `c` is over quota, the second `a` is an existing session.
    expect(count(h.db, "prompt")).toBe(3);
    expect(h.drops).toEqual(["claude"]);
  });

  test("a stopped queue answers by discarding and counting", async () => {
    // Covers: R7
    const h = harness();
    await h.queue.stop();
    expect(h.queue.enqueueHook("claude", hook("s1"))).toBe(false);
    expect(h.queue.enqueueOtel([], 0)).toBe(true);
    expect(h.drops).toEqual(["claude"]);
  });
});

describe("IngestQueue: store failures", () => {
  test("a poison pill in a step of 10 is bisected; the other 9 are stored", async () => {
    // Covers: R6, R7
    const attempts: number[] = [];
    const h = harness({
      engineQuotaRatio: 1,
      ingest: (db, deps, events) => {
        attempts.push(events.length);
        if (events.some((e) => e.event.text === "poison")) throw new Error("bad row");
        return ingestEvents(db, deps, events);
      },
    });
    h.queue.pause();
    for (let n = 0; n < 10; n++) {
      h.queue.enqueueHook("claude", hook(`s${n}`, { n: n === 4 ? "poison" : n }));
    }
    h.queue.resume();
    await h.queue.idle();
    expect(count(h.db, "prompt")).toBe(9);
    expect(errors(h.db).map((e) => e.error?.reason)).toEqual(["store-error"]);
    expect(h.queue.hookDepth).toBe(0);
    expect(attempts[0]).toBe(10);
  });

  test("SQLITE_FULL backs off (1s, 2s, ...) without discarding, then recovers", async () => {
    // Covers: R7
    const delays: number[] = [];
    let failing = 3;
    const h = harness({
      delay: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
      ingest: (db, deps, events) => {
        if (failing > 0) {
          failing -= 1;
          throw Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
        }
        return ingestEvents(db, deps, events);
      },
    });
    h.queue.enqueueHook("claude", hook("s1"));
    await h.queue.idle();
    expect(delays.filter((ms) => ms > 0)).toEqual([1000, 2000, 4000]);
    expect(count(h.db, "prompt")).toBe(1);
    expect(errors(h.db)).toHaveLength(0);
  });

  test("while backed off, the FIFO keeps accepting until full", async () => {
    // Covers: R7
    let release: () => void = () => undefined;
    const h = harness({
      hookMaxItems: 2,
      engineQuotaRatio: 1,
      delay: (ms) => (ms > 0 ? new Promise<void>((r) => (release = r)) : Promise.resolve()),
      ingest: () => {
        throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
      },
    });
    h.queue.enqueueHook("claude", hook("s1"));
    await Bun.sleep(5); // the drainer is now waiting out its backoff
    expect(h.queue.enqueueHook("claude", hook("s2"))).toBe(true);
    expect(h.queue.enqueueHook("claude", hook("s3"))).toBe(false);
    expect(h.queue.hookDepth).toBe(2);
    const stopping = h.queue.stop();
    release();
    await stopping;
  });

  test("the drainer never throws into the process, even if the error record also fails", async () => {
    // Covers: R6, R7
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const h = harness({
      ingest: () => {
        throw "not even an Error"; // non-Error throw, and every retry fails too
      },
    });
    h.queue.enqueueHook("claude", hook("s1"));
    await h.queue.idle();
    await Bun.sleep(5);
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
    expect(h.queue.hookDepth).toBe(0);
    // The queue keeps working afterwards.
    h.queue.enqueueHook("claude", hook("s2"));
    await h.queue.idle();
    expect(h.queue.hookDepth).toBe(0);
  });
});

describe("IngestQueue: two FIFOs, one drainer", () => {
  test("hooks are drained before OTel events", async () => {
    // Covers: R1
    const order: string[] = [];
    const h = harness({
      ingest: (db, deps, events) => {
        order.push(events[0]?.source ?? "?");
        return ingestEvents(db, deps, events);
      },
    });
    h.queue.pause();
    const otelEvent = {
      engine: "claude",
      source: "otel" as const,
      lineHash: "l-otel",
      part: "0",
      pos: { path: "otel", offset: 0, line: 0 },
      event: {
        sessionId: "so",
        agentId: null,
        parentAgentId: null,
        kind: "prompt" as const,
        ts: T0,
        cwd: "/tmp/proj",
      },
    };
    expect(h.queue.enqueueOtel([otelEvent], 100)).toBe(true);
    h.queue.enqueueHook("claude", hook("sh"));
    h.queue.resume();
    await h.queue.idle();
    expect(order).toEqual(["hook", "otel"]);
  });

  test("a full OTel FIFO refuses the whole batch (503 upstream) and stores nothing of it", () => {
    // Covers: R7
    const h = harness({ otelMaxBytes: 100 });
    h.queue.pause();
    expect(h.queue.enqueueOtel([], 0)).toBe(true);
    const event = {
      engine: "claude",
      source: "otel" as const,
      lineHash: "l",
      part: "0",
      pos: { path: "otel", offset: 0, line: 0 },
      event: {
        sessionId: "s",
        agentId: null,
        parentAgentId: null,
        kind: "prompt" as const,
        ts: T0,
      },
    };
    expect(h.queue.enqueueOtel([event], 200)).toBe(false);
    expect(h.queue.otelDepth).toBe(0);
  });
});

describe("IngestQueue: no lost wake", () => {
  // Covers: R1
  test.each(Array.from({ length: 14 }, (_, k) => k))(
    "an enqueue landing %i microtasks after the first, while the drainer is exiting, is drained",
    async (ticks) => {
      const h = harness({ delay: () => Promise.resolve() });
      h.queue.enqueueHook("claude", hook("first"));
      for (let i = 0; i < ticks; i++) await Promise.resolve();
      h.queue.enqueueHook("claude", hook("second"));
      await Bun.sleep(5);
      await h.queue.idle();
      expect(h.queue.hookDepth).toBe(0);
      expect(count(h.db, "prompt")).toBe(2);
    },
  );
});
