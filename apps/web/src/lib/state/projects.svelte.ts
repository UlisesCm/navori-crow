import type { ProjectSummary } from "@crow/core/types";
import { msUntilNextDay } from "@crow/core/time";
import { fetchProjects } from "../api";
import {
  applyToProjects,
  projectsFromSnapshot,
  rollDay,
  sortedProjects,
  type ProjectsState,
} from "../reduce/projects";
import { openStream, Restarter, type StreamHandle } from "../stream";

/** Runes wrapper over the pure projects reducer (D16): snapshot, then stream from its cursor. */
export class ProjectsStore {
  private state: ProjectsState | null = $state(null);
  error: string | null = $state(null);
  connected = $state(false);

  private handle: StreamHandle | null = null;
  private generation = 0;
  private readonly restarter = new Restarter(() => void this.start());
  private midnight: ReturnType<typeof setTimeout> | null = null;

  readonly cards: ProjectSummary[] = $derived(
    this.state === null ? [] : sortedProjects(this.state.value),
  );
  readonly loaded = $derived(this.state !== null);

  /** Backfills via REST and subscribes; also the re-snapshot path after `reset` or a dead stream. */
  async start(): Promise<void> {
    this.handle?.close();
    const gen = ++this.generation;
    try {
      const snapshot = await fetchProjects();
      if (gen !== this.generation) return; // superseded or stopped
      this.state = projectsFromSnapshot(snapshot); // replaces state: no double counting
      this.error = null;
      this.armMidnight();
      this.handle = openStream({
        after: snapshot.cursor,
        onEvent: (e) => {
          if (this.state !== null) this.state = applyToProjects(rollDay(this.state, Date.now()), e);
        },
        onReset: () => void this.start(),
        onDead: () => this.restarter.schedule(),
        onConnection: (c) => {
          this.connected = c;
          if (c) this.restarter.reset();
        },
      });
    } catch (err) {
      if (gen !== this.generation) return;
      this.error = err instanceof Error ? err.message : String(err);
      this.restarter.schedule(); // server down or non-200: retry with backoff
    }
  }

  /** Rolls "today" over at local midnight even when no event arrives (clock injected into the reducer). */
  private armMidnight(): void {
    if (this.midnight !== null) clearTimeout(this.midnight);
    this.midnight = setTimeout(
      () => {
        if (this.state !== null) this.state = rollDay(this.state, Date.now());
        this.armMidnight();
      },
      msUntilNextDay(Date.now()) + 50,
    );
  }

  stop(): void {
    this.generation++;
    this.handle?.close();
    this.handle = null;
    this.restarter.cancel();
    if (this.midnight !== null) clearTimeout(this.midnight);
    this.midnight = null;
  }
}
