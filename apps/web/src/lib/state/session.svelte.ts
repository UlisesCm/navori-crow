import type { CrowEvent } from "@crow/core/types";
import { ApiError, fetchSessionDetail, fetchSessionEvents } from "../api";
import {
  applyManyToFeed,
  applyToFeed,
  feedFromEvents,
  mergeOlder,
  TIMELINE_WINDOW,
  type FeedState,
} from "../reduce/feed";
import {
  applyManyToSession,
  applyToSession,
  buildAgentTree,
  sessionFromSnapshot,
  type AgentTreeNode,
  type SessionState,
} from "../reduce/session";
import { openStream, Restarter, type StreamHandle } from "../stream";

const PAGE_SIZE = 500;

/**
 * Runes wrapper for the session detail (D16). The events endpoint only pages
 * ascending (`id > after`), so the latest window is found by paging from the
 * start and keeping the last {@link TIMELINE_WINDOW}; older events are
 * re-fetched on demand by `loadOlder`.
 */
export class SessionStore {
  private feed: FeedState | null = $state(null);
  private detail: SessionState | null = $state(null);
  error: string | null = $state(null);
  connected = $state(false);
  loadingOlder = $state(false);

  private handle: StreamHandle | null = null;
  private generation = 0;
  private id = "";
  private readonly restarter = new Restarter(() => void this.start(this.id));

  readonly loaded = $derived(this.feed !== null && this.detail !== null);
  readonly events: CrowEvent[] = $derived(this.feed?.value.events ?? []);
  readonly hasOlder = $derived(this.feed?.value.truncated ?? false);
  readonly session = $derived(this.detail?.value.session ?? null);
  readonly tree: AgentTreeNode[] = $derived(buildAgentTree(this.detail?.value.agents ?? []));

  /** Snapshot (detail + newest window), then stream from the last id; also the re-sync path. */
  async start(id: string): Promise<void> {
    this.id = id;
    this.handle?.close();
    const gen = ++this.generation;
    try {
      const snapshot = await fetchSessionDetail(id);
      let detail = sessionFromSnapshot(snapshot);
      let feed = feedFromEvents([], null, TIMELINE_WINDOW);
      let after: string | undefined;
      for (;;) {
        const page = await fetchSessionEvents(id, after, PAGE_SIZE);
        if (gen !== this.generation) return;
        feed = applyManyToFeed(feed, page.events);
        detail = applyManyToSession(detail, page.events); // only ids > snapshot.cursor count
        if (!page.hasMore || page.nextAfter === null) break;
        after = page.nextAfter;
      }
      this.feed = feed;
      this.detail = detail;
      this.error = null;
      this.handle = openStream({
        session: id,
        ...(feed.lastApplied !== null ? { after: feed.lastApplied } : {}),
        onEvent: (e) => {
          if (this.feed !== null) this.feed = applyToFeed(this.feed, e);
          if (this.detail !== null) this.detail = applyToSession(this.detail, e);
        },
        onReset: () => void this.start(id),
        onDead: () => this.restarter.schedule(),
        onConnection: (c) => {
          this.connected = c;
          if (c) this.restarter.reset();
        },
      });
    } catch (err) {
      if (gen !== this.generation) return;
      if (err instanceof ApiError && err.status === 409) return void this.start(id); // D9
      this.error = err instanceof Error ? err.message : String(err);
      if (!(err instanceof ApiError && err.status === 404)) this.restarter.schedule();
    }
  }

  /** Pages from the start of the session up to the oldest held event and merges them in. */
  async loadOlder(): Promise<void> {
    const feed = this.feed;
    const first = feed?.value.events[0];
    if (feed === null || first === undefined || !feed.value.truncated || this.loadingOlder) return;
    const gen = this.generation;
    this.loadingOlder = true;
    try {
      const older: CrowEvent[] = [];
      let after: string | undefined;
      for (;;) {
        const page = await fetchSessionEvents(this.id, after, PAGE_SIZE);
        if (gen !== this.generation) return;
        older.push(...page.events.filter((e) => e.id < first.id));
        if (!page.hasMore || page.nextAfter === null || page.nextAfter >= first.id) break;
        after = page.nextAfter;
      }
      if (this.feed !== null) this.feed = mergeOlder(this.feed, older, true);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loadingOlder = false;
    }
  }

  stop(): void {
    this.generation++;
    this.handle?.close();
    this.handle = null;
    this.restarter.cancel();
  }
}
