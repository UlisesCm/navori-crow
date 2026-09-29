/**
 * Wires the server together in the order design.md § Components
 * `apps/server/src/app.ts` fixes:
 *
 *   1. open the DB and migrate;
 *   2. seed the ULID factory and run `sweepIdle` once;
 *   3. bind `Bun.serve` on loopback;
 *   4. start the tailer (with the engine adapter registry) and the periodic
 *      sweeper.
 *
 * A migration failure rejects `startApp` before step 3, so nothing ever
 * listens on a database this build can't trust (D2, R2).
 */
import type { Server } from "bun";
import type { Database } from "bun:sqlite";
import {
  createUlidFactory,
  currentCursor,
  EventBus,
  migrate,
  openDatabase,
  realInterval,
  sweepIdle,
  TailerScheduler,
  ulidTime,
} from "@crow/core";
import type { ClockFn, CrowConfig, IntervalScheduler, TailerSchedulerOptions } from "@crow/core";
import { ENGINE_ADAPTERS } from "./adapters";
import { createRequestHandler } from "./server";
import { StreamRegistry } from "./sse";

/** Lower than any real ULID: used as the floor when seeding a fresh factory (D9). */
const ULID_FLOOR = "00000000000000000000000000";

/** A stored id whose encoded time is this far ahead of the wall clock is treated as clock skew (D9). */
const CLOCK_SKEW_WARNING_MS = 60_000;

/**
 * Seeds the ULID factory with the greater of `max(id)` already in the store
 * and a fresh id for `now()` (D9), so ids stay strictly increasing across
 * restarts even if the store is empty or the clock lags behind what's
 * already persisted.
 */
function seedUlid(db: Database, now: ClockFn): string {
  const stored = currentCursor(db);
  const fresh = createUlidFactory(ULID_FLOOR, now)();
  if (stored !== "" && ulidTime(stored) > now() + CLOCK_SKEW_WARNING_MS) {
    // Path/count-only per D15: no event content, just the two ids being compared.
    console.warn(
      `crow: stored max event id (${stored}) is ahead of the wall clock by more than ${CLOCK_SKEW_WARNING_MS}ms; continuing in monotonic mode`,
    );
  }
  return stored > fresh ? stored : fresh;
}

/** Injectable knobs `startApp`'s tests need instead of real timers/clock or `~/.claude` (design.md § Configuración). */
export interface StartAppOptions {
  now?: ClockFn;
  scheduleInterval?: IntervalScheduler;
  pollIntervalMs?: number;
  rescanIntervalMs?: number;
  sweepIntervalMs?: number;
  stat?: TailerSchedulerOptions["stat"];
  read?: TailerSchedulerOptions["read"];
  loadSidecar?: TailerSchedulerOptions["loadSidecar"];
  /** `/api/stream` heartbeat interval (R23). Default 15 000 ms. */
  heartbeatMs?: number;
  /** `/api/stream` replay page size (D13). Default 500. */
  streamPageSize?: number;
}

/** What `startApp` returns: the live pieces, plus a clean, ordered shutdown. */
export interface AppHandle {
  readonly db: Database;
  readonly server: Server<unknown>;
  readonly bus: EventBus;
  /**
   * Stops the sweeper timer, then the tailer (awaiting its in-flight step —
   * see `TailerScheduler.stop`), then every open `/api/stream` (and its
   * heartbeat), then the HTTP server, then closes the DB. That order never
   * closes the DB under a running tailer step or a stream still reading it.
   */
  stop(): Promise<void>;
}

/** Starts the crow server: DB + migrations, ULID/sweep seeding, HTTP, tailer + sweeper (design.md § Components). */
export async function startApp(config: CrowConfig, opts: StartAppOptions = {}): Promise<AppHandle> {
  const now = opts.now ?? Date.now;
  const idleMs = config.idleMinutes * 60_000;

  // 1. Open the DB and migrate — reject before anything listens (D2, R2).
  const db = openDatabase(config.crowHome);
  try {
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }

  // 2. Seed the ULID factory and run sweepIdle once (D9, D10).
  const nextId = createUlidFactory(seedUlid(db, now), now);
  sweepIdle(db, now, idleMs);

  // 3. Bind Bun.serve on loopback only.
  const bus = new EventBus();
  const scheduleIntervalFn = opts.scheduleInterval ?? realInterval;
  const streams = new StreamRegistry();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: config.crowPort,
    fetch: createRequestHandler(config.allowedOrigins, {
      db,
      bus,
      now,
      idleMinutes: config.idleMinutes,
      backfillHours: config.backfillHours,
      scheduleInterval: scheduleIntervalFn,
      registry: streams,
      heartbeatMs: opts.heartbeatMs,
      streamPageSize: opts.streamPageSize,
    }),
  });

  // 4. Start the tailer (with the engine registry) and the periodic sweeper.
  const roots = ENGINE_ADAPTERS.flatMap((adapter) =>
    adapter.watchRoots(config).map((root) => ({ root, adapter })),
  );
  const tailer = new TailerScheduler({
    db,
    bus,
    roots,
    nextId,
    now,
    idleMs,
    backfillWindowMs: config.backfillHours * 60 * 60_000,
    pollIntervalMs: opts.pollIntervalMs ?? 1000,
    rescanIntervalMs: opts.rescanIntervalMs ?? 30_000,
    stat: opts.stat,
    read: opts.read,
    loadSidecar: opts.loadSidecar,
    scheduleInterval: scheduleIntervalFn,
  });
  await tailer.start();

  const cancelSweep = scheduleIntervalFn(
    () => sweepIdle(db, now, idleMs),
    opts.sweepIntervalMs ?? 30_000,
  );

  return {
    db,
    server,
    bus,
    async stop(): Promise<void> {
      cancelSweep();
      await tailer.stop();
      streams.closeAll();
      server.stop(true);
      db.close();
    },
  };
}
