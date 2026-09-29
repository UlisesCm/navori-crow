import type { CrowEvent } from "@crow/core/types";
import { ApiError, fetchSessionDetail, fetchSessionEventsBackward } from "../api";
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
  buildSessionTree,
  sessionFromSnapshot,
  type AgentTreeNode,
  type SessionState,
} from "../reduce/session";
import { openStream, Restarter, type StreamHandle } from "../stream";

const PAGE_SIZE = 500;

/**
 * Runes wrapper for the session detail (D16). Opening fetches only the newest
 * page (`tail=1`); `loadOlder` pages backward with `before=<oldest held id>`.
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
  readonly tree: AgentTreeNode[] = $derived(
    this.detail === null
      ? []
      : buildSessionTree(this.detail.value.session, this.detail.value.agents),
  );

  /** Snapshot (detail + newest window), then stream from the last id; also the re-sync path. */
  async start(id: string): Promise<void> {
    this.id = id;
    this.handle?.close();
    const gen = ++this.generation;
    try {
      const snapshot = await fetchSessionDetail(id);
      const page = await fetchSessionEventsBackward(id, undefined, PAGE_SIZE);
      if (gen !== this.generation) return;
      let feed = applyManyToFeed(feedFromEvents([], null, TIMELINE_WINDOW), page.events);
      feed = { ...feed, value: { ...feed.value, truncated: page.hasMore } };
      const detail = applyManyToSession(sessionFromSnapshot(snapshot), page.events); // only ids > snapshot.cursor count
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

  /** Fetches the page right before the oldest held event and merges it in. */
  async loadOlder(): Promise<void> {
    const feed = this.feed;
    const first = feed?.value.events[0];
    if (feed === null || first === undefined || !feed.value.truncated || this.loadingOlder) return;
    const gen = this.generation;
    this.loadingOlder = true;
    try {
      const page = await fetchSessionEventsBackward(this.id, first.id, PAGE_SIZE);
      if (gen !== this.generation) return;
      if (this.feed !== null) this.feed = mergeOlder(this.feed, page.events, !page.hasMore);
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
