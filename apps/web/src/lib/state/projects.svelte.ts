import type { ProjectSummary } from "@crow/core/types";
import { fetchProjects } from "../api";
import {
  applyToProjects,
  projectsFromSnapshot,
  sortedProjects,
  type ProjectsState,
} from "../reduce/projects";
import { openStream, type StreamHandle } from "../stream";

/** Runes wrapper over the pure projects reducer (D16): snapshot, then stream from its cursor. */
export class ProjectsStore {
  private state: ProjectsState | null = $state(null);
  error: string | null = $state(null);
  connected = $state(false);

  private handle: StreamHandle | null = null;
  private generation = 0;

  readonly cards: ProjectSummary[] = $derived(
    this.state === null ? [] : sortedProjects(this.state.value),
  );
  readonly loaded = $derived(this.state !== null);

  /** Backfills via REST and subscribes; also the re-snapshot path after `reset`. */
  async start(): Promise<void> {
    this.handle?.close();
    const gen = ++this.generation;
    try {
      const snapshot = await fetchProjects();
      if (gen !== this.generation) return; // superseded or stopped
      this.state = projectsFromSnapshot(snapshot); // replaces state: no double counting
      this.error = null;
      this.handle = openStream({
        after: snapshot.cursor,
        onEvent: (e) => {
          if (this.state !== null) this.state = applyToProjects(this.state, e);
        },
        onReset: () => void this.start(),
        onConnection: (c) => (this.connected = c),
      });
    } catch (err) {
      if (gen === this.generation) this.error = err instanceof Error ? err.message : String(err);
    }
  }

  stop(): void {
    this.generation++;
    this.handle?.close();
    this.handle = null;
  }
}
