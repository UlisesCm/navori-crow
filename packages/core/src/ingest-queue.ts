/**
 * The single in-process queue behind the hook and OTLP lanes (design.md D2).
 *
 * Two bounded FIFOs (hooks and already-routed OTel events) and **one** drainer, so the store keeps a
 * single writer. Requests are answered before their payload is processed; the drainer takes hooks
 * first, works in steps of at most {@link STEP_MAX_ITEMS} items or {@link STEP_MAX_BYTES} bytes per
 * transaction, publishes to the bus with no `await` between commit and publish (R22) and yields the
 * thread before the next step.
 *
 * Store failures never escape the drainer: a step that throws is bisected down to the poisoned item
 * (discarded with an `ingest.error store-error`); an *environmental* failure (`SQLITE_FULL`, IOERR,
 * BUSY, LOCKED) leaves the item at the head and backs off 1 s → 30 s while the FIFOs keep accepting
 * until they are full (R7).
 */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { BoundAdapter } from "./adapter";
import type { EventBus } from "./bus";
import type { CrowEvent, EngineId, IngestErrorReason } from "./crow-event";
import { ingestEvents } from "./store/store";
import type { IngestBatchDeps, PendingEvent } from "./store/store";
import type { ClockFn } from "./ulid";

/** Hooks FIFO cap (D2): items. */
export const HOOK_QUEUE_MAX_ITEMS = 2000;
/** Hooks FIFO cap (D2): bytes. */
export const HOOK_QUEUE_MAX_BYTES = 32 * 1024 * 1024;
/** OTel FIFO cap (D2): estimated bytes. */
export const OTEL_QUEUE_MAX_BYTES = 64 * 1024 * 1024;
/** One engine may hold at most this share of the hooks FIFO (D2, SF3-S1). */
export const ENGINE_QUOTA_RATIO = 0.6;
/** Simultaneous body reads on `/ingest/*` (D2, SF3-S2). */
export const MAX_INFLIGHT_BODIES = 16;
/** Max new sessions per engine created through the hook lane per minute (D2). */
export const MAX_NEW_SESSIONS_PER_MINUTE = 120;
/** Max items in one drainer transaction (D2). */
export const STEP_MAX_ITEMS = 200;
/** Max bytes in one drainer transaction (D2). */
export const STEP_MAX_BYTES = 4 * 1024 * 1024;
/** Environmental-failure backoff bounds, ms (D2). */
export const BACKOFF_MIN_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;

const NEW_SESSION_WINDOW_MS = 60_000;
const AMBIENT_ERROR = /SQLITE_(FULL|IOERR|BUSY|LOCKED)/;

/** Everything the queue needs but must not read for itself (testability). */
export interface IngestQueueOptions {
  db: Database;
  bus: EventBus;
  nextId: () => string;
  now: ClockFn;
  idleMs: number;
  /** Adapters looked up by `id` for `fromHook`. */
  adapters: readonly BoundAdapter[];
  /** Called once per discarded payload/event, for the lane counters (R7). */
  onDrop?: (engine: EngineId) => void;
  /** Called after a committed hook-lane event, for `lastStoredAt`. */
  onStored?: (engine: EngineId) => void;
  hookMaxItems?: number;
  hookMaxBytes?: number;
  otelMaxBytes?: number;
  /** Per-engine share of the hooks FIFO; default {@link ENGINE_QUOTA_RATIO}. */
  engineQuotaRatio?: number;
  maxInflightBodies?: number;
  maxNewSessionsPerMinute?: number;
  stepMaxItems?: number;
  stepMaxBytes?: number;
  /** Test seam replacing the store write (default `ingestEvents`). */
  ingest?: (db: Database, deps: IngestBatchDeps, events: readonly PendingEvent[]) => CrowEvent[];
  /** Test seam replacing the backoff/yield timer; default is a cancellable `setTimeout`. */
  delay?: (ms: number) => Promise<void>;
}

interface HookItem {
  engine: EngineId;
  receivedAt: number;
  seq: number;
  body: string;
  bytes: number;
  /** Cached mapping, so a retry after backoff does not re-count session-creation quota. */
  mapped?: PendingEvent[];
}

interface OtelItem {
  event: PendingEvent;
  bytes: number;
}

/** One indivisible piece of a step: the bisection never splits it. */
interface Unit {
  pendings: PendingEvent[];
  engine: EngineId;
  bytes: number;
}

/** Result of committing a prefix of units. */
interface CommitResult {
  consumed: number;
  ambient: boolean;
}

function isAmbient(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; message?: unknown };
  return AMBIENT_ERROR.test(`${String(e.code ?? "")} ${String(e.message ?? "")}`);
}

function describe(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/** A hook-lane `ingest.error` (`<engine>:unknown` unless the payload revealed a session). */
function errorPending(
  engine: EngineId,
  reason: IngestErrorReason,
  message: string,
  identity: string,
  ts: number,
  seq: number,
  sessionId: string | null = null,
  agentId: string | null = null,
): PendingEvent {
  return {
    engine,
    source: "hook",
    lineHash: sha1(identity),
    part: "e0",
    pos: { path: `hook:${engine}`, offset: seq, line: 0 },
    event: {
      sessionId: sessionId ?? "unknown",
      agentId,
      parentAgentId: null,
      kind: "ingest.error",
      ts,
      error: { message: message.slice(0, 1024), reason },
    },
  };
}

/** Two bounded FIFOs, one drainer (design.md D2). */
export class IngestQueue {
  private readonly hooks: HookItem[] = [];
  private hookBytes = 0;
  private readonly perEngine = new Map<EngineId, number>();
  private readonly otel: OtelItem[] = [];
  private otelBytes = 0;
  /** Internal `ingest.error` events (overflow episodes) awaiting the next step. */
  private readonly control: PendingEvent[] = [];
  /** Payloads discarded in the current overflow episode, per engine. */
  private readonly episodes = new Map<EngineId, number>();
  private readonly newSessions = new Map<EngineId, Map<string, number>>();
  private inflight = 0;
  private seq = 0;
  private paused = false;
  private stopped = false;
  private running: Promise<void> | null = null;
  private backoffMs = 0;
  private cancelDelay: (() => void) | null = null;
  private readonly deps: IngestBatchDeps;

  constructor(private readonly opts: IngestQueueOptions) {
    this.deps = { nextId: opts.nextId, now: opts.now, idleMs: opts.idleMs };
  }

  /** Items waiting in the hooks FIFO. */
  get hookDepth(): number {
    return this.hooks.length;
  }

  /** Events waiting in the OTel FIFO. */
  get otelDepth(): number {
    return this.otel.length;
  }

  /**
   * Enqueues a hook body. Returns `false` (payload discarded and counted, R7) when the FIFO is
   * full, the engine holds more than its quota, or the queue is stopped; the caller answers 204
   * either way.
   */
  enqueueHook(engine: EngineId, body: string): boolean {
    const bytes = Buffer.byteLength(body);
    const maxItems = this.opts.hookMaxItems ?? HOOK_QUEUE_MAX_ITEMS;
    const maxBytes = this.opts.hookMaxBytes ?? HOOK_QUEUE_MAX_BYTES;
    const quota = Math.max(
      1,
      Math.floor(maxItems * (this.opts.engineQuotaRatio ?? ENGINE_QUOTA_RATIO)),
    );
    const mine = this.perEngine.get(engine) ?? 0;
    if (
      this.stopped ||
      this.hooks.length >= maxItems ||
      this.hookBytes + bytes > maxBytes ||
      mine >= quota
    ) {
      this.recordDrop(engine);
      return false;
    }
    this.seq += 1;
    this.hooks.push({ engine, receivedAt: this.opts.now(), seq: this.seq, body, bytes });
    this.hookBytes += bytes;
    this.perEngine.set(engine, mine + 1);
    this.wake();
    return true;
  }

  /**
   * Enqueues already-routed OTel events as one all-or-nothing batch of `bytes` estimated bytes.
   * `false` = full or stopped: the receiver answers 503 (D2); nothing is stored.
   */
  enqueueOtel(events: readonly PendingEvent[], bytes: number): boolean {
    if (events.length === 0) return true;
    if (this.stopped || this.otelBytes + bytes > (this.opts.otelMaxBytes ?? OTEL_QUEUE_MAX_BYTES)) {
      return false;
    }
    const each = bytes / events.length;
    for (const event of events) this.otel.push({ event, bytes: each });
    this.otelBytes += bytes;
    this.wake();
    return true;
  }

  /**
   * Reserves one of the simultaneous body reads (SF3-S2). Returns the release function, or `null`
   * when all slots are taken: the payload counts as an overflow and the caller answers 204.
   */
  acquireBody(engine: EngineId): (() => void) | null {
    if (this.stopped || this.inflight >= (this.opts.maxInflightBodies ?? MAX_INFLIGHT_BODIES)) {
      this.recordDrop(engine);
      return null;
    }
    this.inflight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inflight -= 1;
    };
  }

  /** Pauses the drainer (tests, and the caller's own back-pressure); items keep queueing. */
  pause(): void {
    this.paused = true;
  }

  /** Resumes a paused drainer. */
  resume(): void {
    this.paused = false;
    this.wake();
  }

  /**
   * Stops accepting (further payloads count as discarded) and lets the step in flight finish (design.md § Failure modes). Items still queued are not drained.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelDelay?.();
    await this.running;
  }

  /** Resolves when the drainer has nothing left to do (tests). */
  async idle(): Promise<void> {
    while (this.running !== null) await this.running;
  }

  private recordDrop(engine: EngineId): void {
    this.episodes.set(engine, (this.episodes.get(engine) ?? 0) + 1);
    this.opts.onDrop?.(engine);
  }

  private wake(): void {
    if (this.running !== null || this.paused || this.stopped) return;
    this.running = this.run();
  }

  private hasWork(): boolean {
    return (
      this.hooks.length > 0 ||
      this.otel.length > 0 ||
      this.control.length > 0 ||
      this.episodes.size > 0
    );
  }

  private async run(): Promise<void> {
    try {
      // Yield first: the request that enqueued must answer before any store work.
      await this.wait(0);
      while (!this.paused && !this.stopped) {
        const outcome = this.step();
        if (outcome === "idle") break;
        if (outcome === "backoff") {
          this.backoffMs = Math.min(
            BACKOFF_MAX_MS,
            this.backoffMs === 0 ? BACKOFF_MIN_MS : this.backoffMs * 2,
          );
          await this.wait(this.backoffMs);
        } else {
          this.backoffMs = 0;
          await this.wait(0);
        }
      }
    } catch (err) {
      // The drainer must never throw into the process; path/count-only per D15.
      console.warn(`crow: ingest drainer error: ${describe(err)}`);
    } finally {
      // Cleared synchronously with the loop's exit and re-checked, so an enqueue that landed
      // while the loop was ending is never left waiting for the next enqueue (lost wake).
      this.running = null;
      if (this.hasWork()) this.wake();
    }
  }

  private wait(ms: number): Promise<void> {
    if (this.opts.delay !== undefined) return this.opts.delay(ms);
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.cancelDelay = null;
        resolve();
      }, ms);
      this.cancelDelay = () => {
        clearTimeout(timer);
        this.cancelDelay = null;
        resolve();
      };
    });
  }

  /** One transaction's worth of work. */
  private step(): "idle" | "worked" | "backoff" {
    this.closeEpisodesIfDrained();

    const units: Unit[] = [];
    let bytes = 0;
    const maxItems = this.opts.stepMaxItems ?? STEP_MAX_ITEMS;
    const maxBytes = this.opts.stepMaxBytes ?? STEP_MAX_BYTES;

    for (const pending of this.control) {
      units.push({ pendings: [pending], engine: pending.engine, bytes: 0 });
    }
    const controlCount = units.length;

    let hookCount = 0;
    while (hookCount < this.hooks.length && units.length < maxItems) {
      const item = this.hooks[hookCount];
      if (item === undefined || (hookCount > 0 && bytes + item.bytes > maxBytes)) break;
      units.push({ pendings: this.mapHook(item), engine: item.engine, bytes: item.bytes });
      bytes += item.bytes;
      hookCount += 1;
    }

    let otelCount = 0;
    if (hookCount === 0) {
      while (otelCount < this.otel.length && units.length < maxItems) {
        const item = this.otel[otelCount];
        if (item === undefined || (otelCount > 0 && bytes + item.bytes > maxBytes)) break;
        units.push({ pendings: [item.event], engine: item.event.engine, bytes: item.bytes });
        bytes += item.bytes;
        otelCount += 1;
      }
    }

    if (units.length === 0) return "idle";

    const result = this.commit(units);
    const fromControl = Math.min(result.consumed, controlCount);
    this.control.splice(0, fromControl);
    let rest = result.consumed - fromControl;
    const fromHooks = Math.min(rest, hookCount);
    this.removeHooks(fromHooks);
    rest -= fromHooks;
    this.removeOtel(Math.min(rest, otelCount));

    return result.ambient ? "backoff" : "worked";
  }

  private removeHooks(count: number): void {
    for (const item of this.hooks.splice(0, count)) {
      this.hookBytes -= item.bytes;
      const left = (this.perEngine.get(item.engine) ?? 1) - 1;
      if (left <= 0) this.perEngine.delete(item.engine);
      else this.perEngine.set(item.engine, left);
    }
  }

  private removeOtel(count: number): void {
    for (const item of this.otel.splice(0, count)) this.otelBytes -= item.bytes;
  }

  /** Turns an overflow episode (FIFO drained again) into one `ingest.error` carrying the count. */
  private closeEpisodesIfDrained(): void {
    if (this.hooks.length > 0 || this.episodes.size === 0) return;
    for (const [engine, count] of this.episodes) {
      this.seq += 1;
      this.control.push(
        errorPending(
          engine,
          "queue-overflow",
          `hook queue overflow: ${count} payload(s) discarded`,
          `overflow:${engine}:${this.seq}:${this.opts.now()}`,
          this.opts.now(),
          this.seq,
        ),
      );
    }
    this.episodes.clear();
  }

  /**
   * Commits `units` in one transaction; on failure bisects (D2, MF7). An isolated unit failing
   * with a non-environmental error is discarded with `store-error`; an environmental one stays
   * (`ambient`) and stops the step.
   */
  private commit(units: readonly Unit[]): CommitResult {
    try {
      const write = this.opts.ingest ?? ingestEvents;
      const stored = write(
        this.opts.db,
        this.deps,
        units.flatMap((u) => u.pendings),
      );
      this.opts.bus.publish(stored); // no `await` between commit and publish (R22)
      if (stored.length > 0) {
        for (const engine of new Set(stored.map((e) => e.engine))) this.opts.onStored?.(engine);
      }
      return { consumed: units.length, ambient: false };
    } catch (err) {
      if (units.length === 1) {
        if (isAmbient(err)) return { consumed: 0, ambient: true };
        this.discardPoisoned(units[0], err);
        return { consumed: 1, ambient: false };
      }
      const mid = units.length >> 1;
      const head = this.commit(units.slice(0, mid));
      if (head.ambient) return head;
      const tail = this.commit(units.slice(mid));
      return { consumed: head.consumed + tail.consumed, ambient: tail.ambient };
    }
  }

  /** Records `store-error` for a unit the store keeps rejecting, in its own transaction. */
  private discardPoisoned(unit: Unit | undefined, err: unknown): void {
    if (unit === undefined) return;
    this.opts.onDrop?.(unit.engine);
    this.seq += 1;
    const note = errorPending(
      unit.engine,
      "store-error",
      `store rejected an ingest item: ${describe(err)}`,
      `store-error:${unit.engine}:${this.seq}:${this.opts.now()}`,
      this.opts.now(),
      this.seq,
    );
    try {
      const stored = (this.opts.ingest ?? ingestEvents)(this.opts.db, this.deps, [note]);
      this.opts.bus.publish(stored);
    } catch {
      // Even the error record failed: nothing more can be done without stalling the queue.
    }
  }

  /** Maps one hook payload to store events (R6); never throws. Cached on the item. */
  private mapHook(item: HookItem): PendingEvent[] {
    if (item.mapped !== undefined) return item.mapped;
    const { engine, receivedAt, seq, body } = item;
    const identity = `${receivedAt}:${seq}:${body}`;
    const fail = (
      reason: IngestErrorReason,
      message: string,
      sessionId: string | null = null,
      agentId: string | null = null,
    ): PendingEvent[] => [
      errorPending(engine, reason, message, identity, this.opts.now(), seq, sessionId, agentId),
    ];

    const adapter = this.opts.adapters.find((a) => a.id === engine && a.fromHook !== undefined);
    if (adapter?.fromHook === undefined) {
      item.mapped = fail("unknown-type", `no hook support for engine ${engine}`);
      return item.mapped;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch (err) {
      item.mapped = fail("invalid-json", `hook payload is not valid JSON: ${describe(err)}`);
      return item.mapped;
    }

    let result: ReturnType<NonNullable<BoundAdapter["fromHook"]>>;
    try {
      result = adapter.fromHook({ body: parsed, receivedAt });
    } catch (err) {
      item.mapped = fail("bad-shape", `hook adapter threw: ${describe(err)}`);
      return item.mapped;
    }

    if (!result.ok) {
      item.mapped = fail(
        result.reason,
        result.detail ?? `hook payload rejected: ${result.reason}`,
        result.sessionId,
        result.agentId,
      );
      return item.mapped;
    }

    const out: PendingEvent[] = [];
    result.events.forEach((event, index) => {
      if (!this.admitSession(engine, event.sessionId)) return;
      out.push({
        engine,
        source: "hook",
        lineHash: sha1(identity),
        part: String(index),
        pos: { path: `hook:${engine}`, offset: seq, line: 1 },
        event,
      });
    });
    result.warnings?.forEach((warning, index) => {
      out.push({
        ...errorPending(engine, warning.reason, warning.detail, identity, this.opts.now(), seq),
        part: `e${index}`,
      });
    });
    item.mapped = out;
    return out;
  }

  /**
   * D2 session-creation quota: an event of a session unknown to the store is discarded (and
   * counted as overflow) once the engine has created {@link MAX_NEW_SESSIONS_PER_MINUTE} in the
   * last minute.
   */
  private admitSession(engine: EngineId, sessionId: string): boolean {
    const now = this.opts.now();
    let recent = this.newSessions.get(engine);
    if (recent === undefined) {
      recent = new Map();
      this.newSessions.set(engine, recent);
    }
    for (const [key, at] of recent) if (at <= now - NEW_SESSION_WINDOW_MS) recent.delete(key);
    const key = `${engine}:${sessionId}`;
    if (recent.has(key)) return true;
    const known = this.opts.db.query("SELECT 1 FROM sessions WHERE id = ?").get(key) !== null;
    if (known) return true;
    if (recent.size >= (this.opts.maxNewSessionsPerMinute ?? MAX_NEW_SESSIONS_PER_MINUTE)) {
      this.recordDrop(engine);
      return false;
    }
    recent.set(key, now);
    return true;
  }
}
