<script lang="ts">
  import type { CrowEvent } from "@crow/core/types";
  import { describeEvent, kindLabel } from "../lib/reduce/feed";
  import { baseName } from "../lib/reduce/projects";
  import { formatTime } from "../lib/format";

  const { projectKey, events }: { projectKey: string; events: CrowEvent[] } = $props();

  const name = $derived.by(() => {
    const path = events.find((e) => e.projectPath !== "")?.projectPath;
    return path === undefined ? projectKey : baseName(path);
  });
  /** Newest first, so the live edge stays at the top. */
  const newestFirst = $derived([...events].reverse());
</script>

<section class="column">
  <h2>{name}</h2>
  {#if newestFirst.length === 0}
    <p class="muted">Sin eventos recientes.</p>
  {:else}
    <ol>
      {#each newestFirst as e (e.id)}
        <li class:error={e.kind === "tool.error" || e.kind === "ingest.error"}>
          <span class="time">{formatTime(e.ts)}</span>
          <span class="kind">{kindLabel(e)}</span>
          <span class="detail">{describeEvent(e)}</span>
          <a class="link" href={`#/session/${encodeURIComponent(`${e.engine}:${e.sessionId}`)}`}
            >sesión</a
          >
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .column {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.5rem 0.75rem;
    min-width: 0;
  }
  h2 {
    font-size: 1rem;
    margin: 0 0 0.5rem;
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 75vh;
    overflow-y: auto;
    font-size: 0.8rem;
  }
  li {
    display: grid;
    grid-template-columns: max-content 1fr max-content;
    gap: 0 0.5rem;
    padding: 0.25rem 0;
    border-bottom: 1px solid var(--border);
  }
  .time {
    color: var(--muted);
  }
  .detail {
    grid-column: 1 / 3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .link {
    grid-row: 1;
    grid-column: 3;
  }
  .error {
    color: var(--error);
  }
  .muted {
    color: var(--muted);
  }
</style>
