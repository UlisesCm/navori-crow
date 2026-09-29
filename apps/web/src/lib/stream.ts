/**
 * Single `EventSource` on `/api/stream` (D13, D16). Resumption after a network
 * drop is native: the browser resends `Last-Event-ID`. `after` only seeds the
 * first connection. On `event: reset` (unknown cursor, D9) the source is
 * closed and `onReset` fires so the view can re-snapshot and reopen.
 */
import type { CrowEvent } from "@crow/core/types";

export interface StreamOptions {
  /** Project keys to filter by (repeatable `project` param). */
  projects?: readonly string[];
  session?: string;
  /** Cursor of the snapshot the view just rendered. */
  after?: string;
  onEvent: (event: CrowEvent) => void;
  /** Server said the cursor is unknown; the stream is already closed. */
  onReset: () => void;
  /**
   * The browser gave up (a non-200 response leaves the `EventSource` CLOSED and
   * it never retries by itself). The source is already closed; the owner should
   * re-snapshot and reopen through a {@link Restarter}.
   */
  onDead?: () => void;
  onConnection?: (connected: boolean) => void;
}

export interface StreamHandle {
  close: () => void;
}

export function streamUrl(o: Pick<StreamOptions, "projects" | "session" | "after">): string {
  const qs = new URLSearchParams();
  for (const p of o.projects ?? []) qs.append("project", p);
  if (o.session !== undefined) qs.set("session", o.session);
  // `""` is an empty store's snapshot cursor: sending it would be an unknown cursor (reset loop).
  if (o.after !== undefined && o.after !== "") qs.set("after", o.after);
  const query = qs.toString();
  return query === "" ? "/api/stream" : `/api/stream?${query}`;
}

export function openStream(o: StreamOptions): StreamHandle {
  const source = new EventSource(streamUrl(o));
  source.onopen = () => o.onConnection?.(true);
  source.onerror = () => {
    o.onConnection?.(false); // a dropped connection is retried natively (CONNECTING)
    if (source.readyState === EventSource.CLOSED) o.onDead?.();
  };
  source.onmessage = (msg: MessageEvent<string>) => {
    try {
      o.onEvent(JSON.parse(msg.data) as CrowEvent);
    } catch {
      // malformed frame: skip it, the next one still carries its own id
    }
  };
  source.addEventListener("reset", () => {
    source.close();
    o.onConnection?.(false);
    o.onReset();
  });
  return { close: () => source.close() };
}

/** Exponential backoff for restart `attempt` (0-based), capped: 1 s, 2 s, 4 s … 30 s. */
export function backoffDelay(attempt: number, baseMs = 1_000, maxMs = 30_000): number {
  return Math.min(maxMs, baseMs * 2 ** attempt);
}

/** Timer functions a {@link Restarter} uses; injectable so tests need no real clock. */
export interface RestartTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const realTimers: RestartTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Schedules a store restart (re-snapshot, then reopen) with bounded backoff so
 * a down server never causes a reconnect storm: at most one pending restart,
 * delays grow up to 30 s, and {@link Restarter.reset} (on a successful open)
 * starts the ladder over.
 */
export class Restarter {
  private attempt = 0;
  private pending: unknown = null;

  constructor(
    private readonly run: () => void,
    private readonly timers: RestartTimers = realTimers,
  ) {}

  /** Queues one restart; a no-op while one is already pending. */
  schedule(): void {
    if (this.pending !== null) return;
    const delay = backoffDelay(this.attempt++);
    this.pending = this.timers.set(() => {
      this.pending = null;
      this.run();
    }, delay);
  }

  /** The stream is healthy again. */
  reset(): void {
    this.attempt = 0;
  }

  /** Drops any pending restart (view unmounted). */
  cancel(): void {
    if (this.pending !== null) this.timers.clear(this.pending);
    this.pending = null;
  }
}
