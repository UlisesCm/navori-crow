import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindAdapter } from "../adapter";
import { EventBus } from "../bus";
import { migrate } from "../store/migrations";
import { createUlidFactory } from "../ulid";
import { readLines } from "./line-reader";
import { Scheduler, TailerScheduler } from "./tailer";
import type { IntervalScheduler, watchRoot } from "./tailer";
import { makeTestAdapter, testLine } from "./testing/test-adapter";

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function withTempDir(fn: (dir: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "crow-scheduler-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const NOW = Date.now();

describe("Scheduler: hot before backfill (D6)", () => {
  test("a hot path is drained before any pending backfill path, even if it was queued later", async () => {
    // Covers: R5, R9
    const scheduler = new Scheduler();
    scheduler.enqueueBackfill("/backfill-1");
    scheduler.enqueueBackfill("/backfill-2");
    scheduler.enqueueHot("/hot-1");

    const order: string[] = [];
    await scheduler.drain(async (path) => {
      order.push(path);
    });

    expect(order).toEqual(["/hot-1", "/backfill-1", "/backfill-2"]);
  });

  test("a hint that arrives for an already-queued backfill path promotes it ahead of the rest", async () => {
    // Covers: R5, R9
    const scheduler = new Scheduler();
    scheduler.enqueueBackfill("/backfill-1");
    scheduler.enqueueBackfill("/backfill-2");
    scheduler.enqueueHot("/backfill-2"); // a watch hint arrives for a path already queued for backfill

    const order: string[] = [];
    await scheduler.drain(async (path) => {
      order.push(path);
    });

    expect(order).toEqual(["/backfill-2", "/backfill-1"]);
  });
});

describe("Scheduler: dirty re-queue (D6)", () => {
  test("a path hinted again while it's mid-step is re-queued as hot once that step ends, not processed concurrently", async () => {
    // Covers: R5, R6
    const scheduler = new Scheduler();
    scheduler.enqueueHot("/a");
    scheduler.enqueueBackfill("/b");

    const order: string[] = [];
    let concurrentCallsForA = 0;
    let maxConcurrentForA = 0;
    let hintedOnce = false;

    await scheduler.drain(async (path) => {
      order.push(path);
      if (path === "/a" && !hintedOnce) {
        hintedOnce = true;
        concurrentCallsForA++;
        maxConcurrentForA = Math.max(maxConcurrentForA, concurrentCallsForA);
        // While "/a" is still mid-step, a fresh hint arrives for it (e.g. another watch event).
        scheduler.enqueueHot("/a");
        await Promise.resolve(); // yield once, no real timer — just enough to prove no re-entrant call happens
        concurrentCallsForA--;
      }
    });

    expect(maxConcurrentForA).toBe(1); // never processed concurrently with itself
    // The re-queued dirty path goes back onto the *hot* queue (a fresh hint is hot by
    // definition), so it's drained again before the still-pending backfill path "/b".
    expect(order).toEqual(["/a", "/a", "/b"]);
  });

  test("hinting a path that isn't mid-step just queues it normally (no spurious dirty re-queue)", async () => {
    // Covers: R5
    const scheduler = new Scheduler();
    scheduler.enqueueHot("/a");

    const order: string[] = [];
    await scheduler.drain(async (path) => {
      order.push(path);
    });

    expect(order).toEqual(["/a"]);
  });
});

function fakeIntervalScheduler(): {
  scheduleInterval: IntervalScheduler;
  /** Invokes every registered callback for `ms` and waits for all of them to settle — no real timer involved. */
  tick: (ms: number) => Promise<void>;
  cancelled: boolean[];
} {
  const registered: Array<{ fn: () => void | Promise<void>; ms: number }> = [];
  const cancelled: boolean[] = [];
  const scheduleInterval: IntervalScheduler = (fn, ms) => {
    const index = registered.length;
    registered.push({ fn, ms });
    cancelled.push(false);
    return () => {
      cancelled[index] = true;
    };
  };
  return {
    scheduleInterval,
    cancelled,
    tick: async (ms: number) => {
      for (const entry of registered) if (entry.ms === ms) await entry.fn();
    },
  };
}

describe("TailerScheduler: injectable timers and stop() (D4, D6)", () => {
  test("start() registers a poll and a rescan interval, and stop() cancels both without any real waiting", async () => {
    // Covers: R5, R9
    await withTempDir(async (dir) => {
      const db = freshDb();
      const bus = new EventBus();
      const adapter = bindAdapter(makeTestAdapter());
      const fake = fakeIntervalScheduler();

      const scheduler = new TailerScheduler({
        db,
        bus,
        roots: [{ root: dir, adapter }],
        nextId: createUlidFactory("00000000000000000000000000", () => NOW),
        now: () => NOW,
        idleMs: 5 * 60_000,
        backfillWindowMs: 24 * 60 * 60_000,
        pollIntervalMs: 1000,
        rescanIntervalMs: 30_000,
        scheduleInterval: fake.scheduleInterval,
      });

      await scheduler.start();
      expect(fake.cancelled).toEqual([false, false]);

      await scheduler.stop();
      expect(fake.cancelled).toEqual([true, true]);
    });
  });

  test("a hinted path is ingested once the poll tick drains the queue, without any real setInterval/sleep", async () => {
    // Covers: R5
    await withTempDir(async (dir) => {
      const path = join(dir, "hot.jsonl");
      writeFileSync(path, `${testLine({ sessionId: "s1", ts: NOW, text: "hello" })}\n`);

      const db = freshDb();
      const bus = new EventBus();
      const adapter = bindAdapter(makeTestAdapter());
      const fake = fakeIntervalScheduler();
      const received: unknown[] = [];
      bus.subscribe((events) => received.push(...events));

      const scheduler = new TailerScheduler({
        db,
        bus,
        roots: [{ root: dir, adapter }],
        nextId: createUlidFactory("00000000000000000000000000", () => NOW),
        now: () => NOW,
        idleMs: 5 * 60_000,
        backfillWindowMs: 24 * 60 * 60_000,
        pollIntervalMs: 1000,
        rescanIntervalMs: 30_000,
        scheduleInterval: fake.scheduleInterval,
      });

      await scheduler.start(); // runs an initial backfill pass, which already ingests the file once
      expect(received).toHaveLength(1);

      scheduler.hint(path); // simulate a fresh watch hint for the same, now-unchanged file
      await fake.tick(1000); // drive the poll tick manually — no real timer, no sleep

      expect(received).toHaveLength(1); // nothing new to ingest, but it didn't throw or duplicate
      await scheduler.stop();
    });
  });

  test("stop() doesn't resolve until an in-flight drain step finishes, and no step starts after it", async () => {
    // No R<n> tag: this proves shutdown ordering (stop() must never let the DB
    // close — app.ts's shutdown order — while a step is still mid-read/write
    // against it), not R6 (offset persistence and resume). No requirement in
    // requirements.md covers graceful shutdown, so it's left untagged
    // (B5.T2 review finding).
    await withTempDir(async (dir) => {
      const db = freshDb();
      const bus = new EventBus();
      const adapter = bindAdapter(makeTestAdapter());
      const fake = fakeIntervalScheduler();

      let releaseRead: (() => void) | null = null;
      const gate = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      let readCalls = 0;
      const blockingRead: typeof readLines = async (readPath, offset, options) => {
        readCalls += 1;
        if (readCalls === 1) await gate; // only the hinted step below hits this; start() sees an empty dir
        return readLines(readPath, offset, options);
      };

      const scheduler = new TailerScheduler({
        db,
        bus,
        roots: [{ root: dir, adapter }],
        nextId: createUlidFactory("00000000000000000000000000", () => NOW),
        now: () => NOW,
        idleMs: 5 * 60_000,
        backfillWindowMs: 24 * 60 * 60_000,
        pollIntervalMs: 1000,
        rescanIntervalMs: 30_000,
        scheduleInterval: fake.scheduleInterval,
        read: blockingRead,
      });

      // start() sees an empty directory, so its own backfill pass never calls
      // `read` — it resolves normally and arms both timers.
      await scheduler.start();
      expect(fake.cancelled).toEqual([false, false]);

      const path = join(dir, "hot.jsonl");
      writeFileSync(path, `${testLine({ sessionId: "s1", ts: NOW, text: "hello" })}\n`);

      scheduler.hint(path);
      const stepPromise = scheduler.runPendingSteps(); // starts draining; blocks on `gate` inside `read`

      // Let the microtask queue reach the blocked `read` call before racing `stop()`.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      let stopSettled = false;
      const stopPromise = scheduler.stop().then(() => {
        stopSettled = true;
      });

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(stopSettled).toBe(false); // stop() must still be waiting on the in-flight step

      releaseRead!();
      await stopPromise;
      expect(stopSettled).toBe(true); // only settles once the step actually finished
      await stepPromise;

      const stored = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get();
      expect(stored?.n).toBe(1); // the blocked step really did run to completion before stop() resolved

      // stop() already cancelled both timers; nothing new can be scheduled afterward.
      expect(fake.cancelled).toEqual([true, true]);
    });
  });

  test("stop() neither hangs nor rejects when the in-flight step itself throws", async () => {
    // No R<n> tag: proves stop()'s error handling, not R6 — see the note on
    // the previous test (B5.T2 review finding).
    await withTempDir(async (dir) => {
      const path = join(dir, "hot.jsonl");
      writeFileSync(path, `${testLine({ sessionId: "s1", ts: NOW, text: "hello" })}\n`);

      const db = freshDb();
      const bus = new EventBus();
      const adapter = bindAdapter(makeTestAdapter());
      const fake = fakeIntervalScheduler();

      const failingRead: typeof readLines = async () => {
        throw new Error("boom: simulated read failure");
      };

      const scheduler = new TailerScheduler({
        db,
        bus,
        roots: [{ root: dir, adapter }],
        nextId: createUlidFactory("00000000000000000000000000", () => NOW),
        now: () => NOW,
        idleMs: 5 * 60_000,
        backfillWindowMs: 24 * 60 * 60_000,
        pollIntervalMs: 1000,
        rescanIntervalMs: 30_000,
        scheduleInterval: fake.scheduleInterval,
        read: failingRead,
      });

      // start()'s own initial backfill pass hits the failing `read` and
      // rejects — the test owns that rejection so it never becomes an
      // unhandled rejection.
      await expect(scheduler.start()).rejects.toThrow("boom");

      await scheduler.stop(); // must resolve cleanly despite the failed step
    });
  });
});

describe("TailerScheduler: watch hints skip the startup replay (R5, R9)", () => {
  const HOUR = 60 * 60_000;

  /** Builds a scheduler whose watcher is fake: `hint(path)` is what `fs.watch` would report. */
  async function setup(dir: string, path: string, ageMs: number) {
    writeFileSync(path, `${testLine({ sessionId: "s1", ts: NOW, text: "one" })}\n`);
    const old = new Date(NOW - ageMs);
    utimesSync(path, old, old);
    const db = freshDb();
    const bus = new EventBus();
    const received: unknown[] = [];
    bus.subscribe((events) => received.push(...events));
    let onHint: (p: string) => void = () => {};
    const watch: typeof watchRoot = (_root, cb) => {
      onHint = cb;
      return null;
    };
    const scheduler = new TailerScheduler({
      db,
      bus,
      roots: [{ root: dir, adapter: bindAdapter(makeTestAdapter()) }],
      nextId: createUlidFactory("00000000000000000000000000", () => NOW),
      now: () => NOW,
      idleMs: 5 * 60_000,
      backfillWindowMs: 24 * HOUR,
      pollIntervalMs: 1000,
      rescanIntervalMs: 30_000,
      scheduleInterval: fakeIntervalScheduler().scheduleInterval,
      watch,
    });
    return { scheduler, received, hint: (p: string) => onHint(p) };
  }

  test("a replayed hint for an out-of-window file with no offset is dropped", async () => {
    // Covers: R5, R9
    await withTempDir(async (dir) => {
      const path = join(dir, "old.jsonl");
      const { scheduler, received, hint } = await setup(dir, path, 48 * HOUR);
      await scheduler.start();
      expect(received).toHaveLength(0);

      hint(path);
      await scheduler.runPendingSteps();

      expect(received).toHaveLength(0);
      await scheduler.stop();
    });
  });

  test("the same file is ingested by a hint once its mtime is inside the window", async () => {
    // Covers: R5, R9
    await withTempDir(async (dir) => {
      const path = join(dir, "old.jsonl");
      const { scheduler, received, hint } = await setup(dir, path, 48 * HOUR);
      await scheduler.start();
      utimesSync(path, new Date(), new Date());

      hint(path);
      await scheduler.runPendingSteps();

      expect(received).toHaveLength(1);
      await scheduler.stop();
    });
  });

  test("an out-of-window file with a persisted offset is still followed by a hint", async () => {
    // Covers: R5, R9
    await withTempDir(async (dir) => {
      const path = join(dir, "old.jsonl");
      const { scheduler, received, hint } = await setup(dir, path, 0); // in window: start() ingests it
      await scheduler.start();
      expect(received).toHaveLength(1);

      appendFileSync(path, `${testLine({ sessionId: "s1", ts: NOW, text: "two" })}\n`);
      const old = new Date(NOW - 48 * HOUR);
      utimesSync(path, old, old);
      hint(path);
      await scheduler.runPendingSteps();

      expect(received).toHaveLength(2);
      await scheduler.stop();
    });
  });
});
