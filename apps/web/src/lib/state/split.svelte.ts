import type { CrowEvent } from "@crow/core/types";
import { fetchEvents } from "../api";
import {
  applyToColumns,
  COLUMN_WINDOW,
  feedFromEvents,
  minCursor,
  type FeedState,
} from "../reduce/feed";
import { openStream, Restarter, type StreamHandle } from "../stream";

/** Runes wrapper for the split view (D16): one snapshot per project, one shared stream. */
export class SplitStore {
  columns: Record<string, FeedState> = $state({});
  loaded = $state(false);
  error: string | null = $state(null);
  connected = $state(false);

  private handle: StreamHandle | null = null;
  private generation = 0;
  private readonly restarter = new Restarter(() => void this.start(this.keys));
  private keys: readonly string[] = [];

  /** Backfills every project, then opens one stream from the smallest cursor. */
  async start(keys: readonly string[]): Promise<void> {
    this.keys = keys;
    this.handle?.close();
    const gen = ++this.generation;
    try {
      const snapshots = await Promise.all(keys.map((k) => fetchEvents(k, COLUMN_WINDOW)));
      if (gen !== this.generation) return;
      const next: Record<string, FeedState> = {};
      keys.forEach((k, i) => {
        const snap = snapshots[i]!;
        next[k] = feedFromEvents(snap.events, snap.cursor, COLUMN_WINDOW);
      });
      this.columns = next;
      this.loaded = true;
      this.error = null;
      const after = minCursor(next);
      this.handle = openStream({
        projects: keys,
        ...(after !== null ? { after } : {}),
        onEvent: (e: CrowEvent) => {
          this.columns = applyToColumns(this.columns, e);
        },
        onReset: () => void this.start(keys),
        onDead: () => this.restarter.schedule(),
        onConnection: (c) => {
          this.connected = c;
          if (c) this.restarter.reset();
        },
      });
    } catch (err) {
      if (gen !== this.generation) return;
      this.error = err instanceof Error ? err.message : String(err);
      this.restarter.schedule();
    }
  }

  stop(): void {
    this.generation++;
    this.handle?.close();
    this.handle = null;
    this.restarter.cancel();
  }
}
