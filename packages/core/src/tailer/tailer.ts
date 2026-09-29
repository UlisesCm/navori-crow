/**
 * Discovery, backfill, watcher/poll/rescan and sidecar wiring for the
 * generic tailer (design.md D4, D6, § Components `packages/core/src/tailer.ts`).
 *
 * `fs.watch` is only ever a *hint*: every path it reports is handed to the
 * hot queue, which then does its own `stat` + read through `processFile`
 * (D4). Nothing here trusts a watch event's content or ordering.
 */
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { FSWatcher } from "node:fs";
import { watch as fsWatch } from "node:fs";
import type { BoundAdapter, FileMatch } from "../adapter";
import type { EventBus } from "../bus";
import { getOffset } from "../store/store";
import type { ClockFn } from "../ulid";
import { lstatFile, processFile, processSidecar } from "./ingest";
import type { SidecarLoader, StatFn } from "./ingest";
import { readLines } from "./line-reader";
import type { ReadLinesOptions } from "./line-reader";

/** One file discovered under a watch root, with the adapter and identity that claimed it. */
export interface DiscoveredFile {
  path: string;
  root: string;
  adapter: BoundAdapter;
  match: FileMatch;
}

/** Recursively lists every regular file under `dir` (symlinked entries are skipped, D5). */
async function walk(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // root doesn't exist yet: retried on the next rescan (D4)
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Walks every adapter's watch roots and matches each file against its adapter (design.md § Approach). */
export async function discoverFiles(
  roots: readonly { root: string; adapter: BoundAdapter }[],
): Promise<DiscoveredFile[]> {
  const out: DiscoveredFile[] = [];
  for (const { root, adapter } of roots) {
    for (const path of await walk(root)) {
      const match = adapter.matches(path, root);
      if (match !== null) out.push({ path, root, adapter, match });
    }
  }
  return out;
}

/**
 * Probes whether this platform supports `fs.watch(dir, { recursive: true })`
 * (D4). macOS (FSEvents) does; Linux support is version/kernel-dependent and
 * Bun may not expose it — callers must fall back to polling-only when this
 * is `false`, per D4's "modo polling".
 */
export function probeRecursiveWatchSupport(dir: string): boolean {
  try {
    const watcher = fsWatch(dir, { recursive: true }, () => {});
    watcher.close();
    return true;
  } catch {
    return false;
  }
}

/** Starts a hinting-only recursive watcher on `root`; every reported path (resolved to `root`) reaches `onHint`. */
export function watchRoot(root: string, onHint: (path: string) => void): FSWatcher | null {
  try {
    return fsWatch(root, { recursive: true }, (_event, filename) => {
      if (filename !== null) onHint(join(root, filename.toString()));
    });
  } catch {
    return null; // no recursive support here (D4): the caller relies on polling/rescan instead
  }
}

/** Shared, injectable dependencies for backfill, poll and sidecar processing. */
export interface TailerDeps {
  db: Database;
  bus: EventBus;
  nextId: () => string;
  now: ClockFn;
  idleMs: number;
  stat?: StatFn;
  read?: typeof readLines;
  lineOptions?: ReadLinesOptions;
  loadSidecar?: SidecarLoader;
}

function roleOrder(role: FileMatch["role"]): number {
  return role === "main" ? 0 : role === "agent" ? 1 : 2;
}

async function processDiscovered(deps: TailerDeps, file: DiscoveredFile): Promise<void> {
  if (file.match.role === "sidecar") {
    await processSidecar(deps.db, file.adapter, file.match, file.path, deps.now, deps.loadSidecar);
    return;
  }
  await processFile({
    db: deps.db,
    bus: deps.bus,
    adapter: file.adapter,
    path: file.path,
    match: file.match,
    nextId: deps.nextId,
    now: deps.now,
    idleMs: deps.idleMs,
    stat: deps.stat,
    read: deps.read,
    lineOptions: deps.lineOptions,
    loadSidecar: deps.loadSidecar,
  });
}

/** `true` if `path` has a persisted offset that grew, or whose inode changed since then (D6, R7). */
async function hasPersistedGrowth(deps: TailerDeps, path: string): Promise<boolean> {
  const stored = getOffset(deps.db, path);
  if (stored === null) return false;
  const statFn = deps.stat ?? lstatFile;
  const current = await statFn(path);
  if (current === null) return false;
  return current.inode !== stored.inode || current.size > stored.byteOffset;
}

export interface BackfillOptions {
  /** Milliseconds; a group with any file whose mtime falls within this window is fully hydrated (D6, R9). */
  windowMs: number;
  /** Clock used to compute the window's cutoff; defaults to `Date.now`. */
  now?: ClockFn;
}

export interface BackfillResult {
  processedPaths: string[];
}

/**
 * Computes the ordered list of files a backfill pass should hydrate
 * (design.md D6), without processing any of them: groups discovered files by
 * `(adapter.id, groupKey)`, keeps every group that has a file inside the
 * recent window or that already grew past its persisted offset, orders each
 * kept group's files main role before agents, and orders the groups
 * themselves by their most recent mtime first. Everything else is left out
 * — a file with no persisted offset that changes later is simply discovered
 * and ingested from 0 like any newly-seen file, on a later pass.
 *
 * Split out from {@link runBackfillOnce} so {@link TailerScheduler} can feed
 * this same plan through its priority queue instead of processing files
 * directly and out of turn with hot-queue work (D6's "la cola hot pasa antes
 * que la de backfill").
 */
export async function planBackfill(
  deps: TailerDeps,
  roots: readonly { root: string; adapter: BoundAdapter }[],
  opts: BackfillOptions,
): Promise<DiscoveredFile[]> {
  const discovered = await discoverFiles(roots);
  const statFn = deps.stat ?? lstatFile;
  const now = opts.now ?? Date.now;
  const cutoff = now() - opts.windowMs;

  const groups = new Map<string, DiscoveredFile[]>();
  for (const file of discovered) {
    const key = `${file.adapter.id}:${file.match.groupKey}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(file);
    else groups.set(key, [file]);
  }

  const eligible: { files: DiscoveredFile[]; maxMtime: number }[] = [];
  for (const files of groups.values()) {
    let maxMtime = 0;
    let inWindow = false;
    let grew = false;
    for (const file of files) {
      const stat = await statFn(file.path);
      if (stat === null) continue;
      // `FileStat` has no mtime; re-stat with lstat directly for this one, best-effort.
      const mtimeMs = await mtimeOf(file.path);
      if (mtimeMs !== null) {
        maxMtime = Math.max(maxMtime, mtimeMs);
        if (mtimeMs >= cutoff) inWindow = true;
      }
      if (await hasPersistedGrowth(deps, file.path)) grew = true;
    }
    if (inWindow || grew) eligible.push({ files, maxMtime });
  }

  eligible.sort((a, b) => b.maxMtime - a.maxMtime);

  const ordered: DiscoveredFile[] = [];
  for (const group of eligible) {
    ordered.push(
      ...[...group.files].sort((a, b) => roleOrder(a.match.role) - roleOrder(b.match.role)),
    );
  }
  return ordered;
}

/**
 * One backfill pass (design.md D6): computes {@link planBackfill}'s ordered
 * plan and processes it directly, sequentially, `await`ing between files.
 * Standalone entry point for tests and for `TailerScheduler`'s startup pass;
 * `TailerScheduler`'s recurring rescans instead feed the same plan through
 * its priority queue (see {@link TailerScheduler.rescanOnce}) so a hot hint
 * arriving mid-backfill can still cut in line.
 */
export async function runBackfillOnce(
  deps: TailerDeps,
  roots: readonly { root: string; adapter: BoundAdapter }[],
  opts: BackfillOptions,
): Promise<BackfillResult> {
  const ordered = await planBackfill(deps, roots, opts);
  const processedPaths: string[] = [];
  for (const file of ordered) {
    await processDiscovered(deps, file);
    processedPaths.push(file.path);
  }
  return { processedPaths };
}

async function mtimeOf(path: string): Promise<number | null> {
  try {
    const st = await lstat(path);
    return st.isSymbolicLink() ? null : st.mtimeMs;
  } catch {
    return null;
  }
}

/**
 * One poll pass over a fixed set of candidate paths (hot files or watch
 * hints): re-matches each against its adapter's roots and processes it if
 * it still exists (D4's 1s hot poll). Paths that no longer match any
 * adapter, or have vanished, are silently skipped.
 */
export async function pollPaths(
  deps: TailerDeps,
  roots: readonly { root: string; adapter: BoundAdapter }[],
  paths: readonly string[],
): Promise<BackfillResult> {
  const processedPaths: string[] = [];
  for (const path of paths) {
    for (const { root, adapter } of roots) {
      const match = adapter.matches(path, root);
      if (match === null) continue;
      await processDiscovered(deps, { path, root, adapter, match });
      processedPaths.push(path);
      break;
    }
  }
  return { processedPaths };
}

/**
 * Tracks which paths are "hot" (recently modified/ingested), so the 1s poll
 * only re-checks a small set instead of every file on every tick (D4).
 */
export class HotSet {
  private readonly paths = new Set<string>();

  add(path: string): void {
    this.paths.add(path);
  }

  drain(): string[] {
    const out = [...this.paths];
    this.paths.clear();
    return out;
  }

  get size(): number {
    return this.paths.size;
  }
}

// ---------------------------------------------------------------------------
// Scheduler (D6): hot queue before backfill queue, dirty re-queue, await
// between steps.
// ---------------------------------------------------------------------------

/**
 * A hot-before-backfill priority queue with dirty re-queueing (design.md D6:
 * "la cola hot pasa antes que la de backfill... un archivo en proceso se
 * marca 'dirty' y se reencola").
 *
 * A path already mid-step (in either queue) that's hinted again isn't
 * processed concurrently: it's marked dirty and re-enqueued as hot once its
 * current step finishes, so the next pass picks up whatever changed while it
 * was running. `drain` `await`s between every processed path, yielding the
 * event loop so newly-hinted hot paths can be picked up before the next
 * backfill item — that's what makes "hot has priority" true interleaving
 * rather than a one-shot sort.
 */
export class Scheduler {
  private readonly hot: string[] = [];
  private readonly backfill: string[] = [];
  private readonly hotSet = new Set<string>();
  private readonly backfillSet = new Set<string>();
  private readonly inProgress = new Set<string>();
  private readonly dirty = new Set<string>();

  /** Queues `path` for immediate processing, ahead of any pending backfill work. */
  enqueueHot(path: string): void {
    if (this.inProgress.has(path)) {
      this.dirty.add(path);
      return;
    }
    if (this.hotSet.has(path)) return;
    this.backfillSet.delete(path);
    const backfillIndex = this.backfill.indexOf(path);
    if (backfillIndex !== -1) this.backfill.splice(backfillIndex, 1);
    this.hotSet.add(path);
    this.hot.push(path);
  }

  /** Queues `path` for backfill; a no-op if it's already hot, queued for backfill, or mid-step. */
  enqueueBackfill(path: string): void {
    if (this.inProgress.has(path)) {
      this.dirty.add(path);
      return;
    }
    if (this.hotSet.has(path) || this.backfillSet.has(path)) return;
    this.backfillSet.add(path);
    this.backfill.push(path);
  }

  private dequeue(): string | null {
    if (this.hot.length > 0) {
      const path = this.hot.shift()!;
      this.hotSet.delete(path);
      return path;
    }
    if (this.backfill.length > 0) {
      const path = this.backfill.shift()!;
      this.backfillSet.delete(path);
      return path;
    }
    return null;
  }

  /** Number of paths currently queued (hot + backfill), excluding whatever is mid-step. */
  get pending(): number {
    return this.hot.length + this.backfill.length;
  }

  /**
   * Processes every currently queued path with `process`, hot before
   * backfill, `await`ing between each. A path hinted again while `process`
   * is running for it is re-queued as hot once that call resolves (D6),
   * instead of being skipped or run concurrently with itself.
   */
  async drain(process: (path: string) => Promise<void>): Promise<void> {
    for (;;) {
      const path = this.dequeue();
      if (path === null) break;
      this.inProgress.add(path);
      try {
        await process(path);
      } finally {
        this.inProgress.delete(path);
      }
      if (this.dirty.delete(path)) this.enqueueHot(path);
    }
  }
}

/**
 * Schedules a recurring callback and returns a function that cancels it —
 * injectable so tests never wait on real timers. `fn` may return a promise
 * (the real `setInterval` ignores it, but a fake scheduler used in tests can
 * capture and `await` it to drive one tick deterministically).
 */
export type IntervalScheduler = (fn: () => void | Promise<void>, ms: number) => () => void;

/** Default {@link IntervalScheduler}, backed by the real `setInterval`/`clearInterval`. */
export const realInterval: IntervalScheduler = (fn, ms) => {
  const handle = setInterval(fn, ms);
  return () => clearInterval(handle);
};

export interface TailerSchedulerOptions {
  db: Database;
  bus: EventBus;
  roots: readonly { root: string; adapter: BoundAdapter }[];
  nextId: () => string;
  now: ClockFn;
  idleMs: number;
  /** Backfill window (R9), e.g. `24 * 60 * 60_000`. */
  backfillWindowMs: number;
  /** Hot-poll cadence (D4), e.g. `1000`. */
  pollIntervalMs: number;
  /** Rescan cadence (D4), e.g. `30_000`. */
  rescanIntervalMs: number;
  stat?: StatFn;
  read?: typeof readLines;
  lineOptions?: ReadLinesOptions;
  loadSidecar?: SidecarLoader;
  /** Injected in tests to drive ticks manually instead of waiting on real timers. */
  scheduleInterval?: IntervalScheduler;
  /** Watcher factory; defaults to {@link watchRoot}. Injected in tests to fire hints by hand. */
  watch?: typeof watchRoot;
}

/**
 * Ties discovery, backfill, the hint-only watchers, the hot poll and the
 * rescan into one running tailer (design.md D4, D6, § Components
 * `tailer.ts`: "scheduler... y sidecars"). `apps/server`'s `startApp` (B5)
 * is expected to be a thin caller: build a `TailerScheduler` with its
 * `CrowConfig`-derived intervals, `await start()`, and `stop()` on shutdown —
 * every interval/clock here is already injectable, so B5 never needs its own
 * scheduling logic.
 */
export class TailerScheduler {
  private readonly queue = new Scheduler();
  private readonly watchers: FSWatcher[] = [];
  private readonly cancelTimers: Array<() => void> = [];
  private readonly scheduleIntervalFn: IntervalScheduler;
  private draining = false;
  private stopped = false;
  /** Watch hints still doing their stat/offset check; drained before each step run and by `stop()`. */
  private readonly hintsInFlight = new Set<Promise<void>>();
  /** The most recently started drain, so `stop()` can await whatever's in flight instead of racing it. */
  private drainPromise: Promise<void> = Promise.resolve();

  constructor(private readonly opts: TailerSchedulerOptions) {
    this.scheduleIntervalFn = opts.scheduleInterval ?? realInterval;
  }

  private tailerDeps(): TailerDeps {
    const { db, bus, nextId, now, idleMs, stat, read, lineOptions, loadSidecar } = this.opts;
    return { db, bus, nextId, now, idleMs, stat, read, lineOptions, loadSidecar };
  }

  /** Queues `path` for immediate processing (a watch hint, or any other external signal). */
  hint(path: string): void {
    this.queue.enqueueHot(path);
  }

  /**
   * A watcher hint, minus the startup replay: the OS can replay the events of files written
   * just before `fs.watch` started (FSEvents on macOS), and a hot hint bypasses the backfill
   * window (R9). A file that is out of the window and was never tailed is left to the rescan.
   */
  private async watchHint(path: string): Promise<void> {
    const mtimeMs = await mtimeOf(path);
    const cutoff = this.opts.now() - this.opts.backfillWindowMs;
    if (mtimeMs !== null && mtimeMs < cutoff && getOffset(this.opts.db, path) === null) {
      return;
    }
    this.hint(path);
  }

  /** Runs `watchHint` tracked, never rejecting: a failed check falls back to a plain hint unless stopped. */
  private trackWatchHint(path: string): void {
    const run = this.watchHint(path)
      .catch(() => {
        if (!this.stopped) this.hint(path); // e.g. transient DB error: hint anyway, processing re-checks
      })
      .finally(() => this.hintsInFlight.delete(run));
    this.hintsInFlight.add(run);
  }

  private async processOne(path: string): Promise<void> {
    for (const { root, adapter } of this.opts.roots) {
      const match = adapter.matches(path, root);
      if (match === null) continue;
      await processDiscovered(this.tailerDeps(), { path, root, adapter, match });
      return;
    }
  }

  /**
   * Drains every path currently queued, hot before backfill (D6). Safe to
   * call re-entrantly (e.g. from both the poll timer and a hint arriving
   * mid-drain): a call made while one is already running is a no-op, since
   * the running one will keep draining until the queue is empty anyway.
   */
  async runPendingSteps(): Promise<void> {
    await Promise.allSettled([...this.hintsInFlight]);
    if (this.draining) return;
    this.draining = true;
    const drain = (async () => {
      try {
        await this.queue.drain((path) => this.processOne(path));
      } finally {
        this.draining = false;
      }
    })();
    this.drainPromise = drain;
    await drain;
  }

  /** Recomputes the backfill plan (D6, R9) and enqueues it behind whatever's already hot. */
  private async rescanOnce(): Promise<void> {
    const files = await planBackfill(this.tailerDeps(), this.opts.roots, {
      windowMs: this.opts.backfillWindowMs,
      now: this.opts.now,
    });
    for (const file of files) this.queue.enqueueBackfill(file.path);
    await this.runPendingSteps();
  }

  /**
   * Starts every root's hint-only watcher (D4; a root without recursive
   * support simply gets no watcher and relies on polling/rescan instead),
   * runs one backfill pass immediately (R9), then arms the recurring hot
   * poll and rescan.
   */
  async start(): Promise<void> {
    for (const { root } of this.opts.roots) {
      const watcher = (this.opts.watch ?? watchRoot)(root, (path) => this.trackWatchHint(path));
      if (watcher !== null) this.watchers.push(watcher);
    }
    await this.rescanOnce();
    // The real `setInterval` ignores a callback's return value; returning the
    // promise (instead of `void`-discarding it) only matters to a fake
    // `IntervalScheduler` in tests, which can `await` it to drive one tick
    // deterministically instead of racing a fire-and-forget call.
    this.cancelTimers.push(
      this.scheduleIntervalFn(() => this.runPendingSteps(), this.opts.pollIntervalMs),
    );
    this.cancelTimers.push(
      this.scheduleIntervalFn(() => this.rescanOnce(), this.opts.rescanIntervalMs),
    );
  }

  /**
   * Closes every watcher and cancels every timer, then awaits whatever
   * drain is currently in flight (a poll/rescan tick or a hint-triggered
   * run) before resolving — so a caller that closes the DB right after
   * `stop()` never races a step still reading/writing it (B5's `startApp`
   * shutdown order relies on this). A failure in that in-flight step is
   * swallowed here: it already propagates to whoever called
   * `start()`/`runPendingSteps()` for it, and `stop()` is a cleanup path —
   * it must wait for the step to *settle*, not re-throw an unrelated
   * ingest error into the caller trying to shut down.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const watcher of this.watchers.splice(0)) watcher.close();
    await Promise.allSettled([...this.hintsInFlight]);
    for (const cancel of this.cancelTimers.splice(0)) cancel();
    await this.drainPromise.catch(() => {});
  }
}
