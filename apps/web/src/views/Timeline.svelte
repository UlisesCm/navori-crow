<script lang="ts">
  import type { CrowEvent } from "@crow/core/types";
  import {
    describeEvent,
    filterEvents,
    filterOptions,
    isBlockingHook,
    kindLabel,
    MAIN_AGENT,
    promptOrigin,
    rawKindLabel,
    TIMELINE_WINDOW,
    type TimelineFilter,
  } from "../lib/reduce/feed";
  import { formatTime } from "../lib/format";

  const {
    events,
    hasOlder,
    loadingOlder,
    onLoadOlder,
  }: {
    events: CrowEvent[];
    hasOlder: boolean;
    loadingOlder: boolean;
    onLoadOlder: () => Promise<void>;
  } = $props();

  const filter: TimelineFilter = $state({ kind: null, agent: null, tool: null });
  /** Render cap (D16): the newest `shown` matching events. */
  let shown = $state(TIMELINE_WINDOW);

  const options = $derived(filterOptions(events));
  const matching = $derived(filterEvents(events, filter));
  const visible = $derived(matching.slice(Math.max(0, matching.length - shown)));
  const canShowMore = $derived(matching.length > visible.length || hasOlder);

  async function showOlder(): Promise<void> {
    if (matching.length <= visible.length && hasOlder) await onLoadOlder();
    shown += TIMELINE_WINDOW;
  }

  /** Empty `<select>` value means "any". */
  const pick = (v: string): string | null => (v === "" ? null : v);
</script>

<section class="timeline">
  <div class="filters">
    <label>
      Tipo
      <select value={filter.kind ?? ""} onchange={(e) => (filter.kind = pick(e.currentTarget.value))}>
        <option value="">Todos</option>
        {#each options.kinds as k (k)}<option value={k}>{rawKindLabel(k)}</option>{/each}
      </select>
    </label>
    <label>
      Agente
      <select value={filter.agent ?? ""} onchange={(e) => (filter.agent = pick(e.currentTarget.value))}>
        <option value="">Todos</option>
        {#each options.agents as a (a)}
          <option value={a}>{a === MAIN_AGENT ? "Hilo principal" : a}</option>
        {/each}
      </select>
    </label>
    <label>
      Herramienta
      <select value={filter.tool ?? ""} onchange={(e) => (filter.tool = pick(e.currentTarget.value))}>
        <option value="">Todas</option>
        {#each options.tools as t (t)}<option value={t}>{t}</option>{/each}
      </select>
    </label>
  </div>

  {#if canShowMore}
    <button type="button" onclick={showOlder} disabled={loadingOlder}>
      {loadingOlder ? "Cargando…" : "Mostrar anteriores"}
    </button>
  {/if}

  {#if visible.length === 0}
    <p class="muted">Sin eventos que coincidan.</p>
  {:else}
    <ol>
      {#each visible as e (e.id)}
        <li
          class:error={e.kind === "tool.error" || e.kind === "ingest.error"}
          class:blocking={isBlockingHook(e)}
          class:delegated={promptOrigin(e) === "parent-agent"}
        >
          <span class="time">{formatTime(e.ts)}</span>
          <span class="kind">{kindLabel(e)}</span>
          {#if e.agentId !== null}<span class="agent">{e.agentId}</span>{/if}
          <span class="detail">{describeEvent(e)}</span>
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .timeline {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.5rem 0.75rem;
    min-width: 0;
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-bottom: 0.5rem;
    font-size: 0.8rem;
  }
  ol {
    list-style: none;
    margin: 0.5rem 0 0;
    padding: 0;
    font-size: 0.8rem;
  }
  li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    padding: 0.25rem 0;
    border-bottom: 1px solid var(--border);
  }
  .time,
  .agent {
    color: var(--muted);
  }
  .kind {
    font-weight: 600;
  }
  .detail {
    flex: 1 1 12rem;
    overflow-wrap: anywhere;
  }
  .delegated .kind {
    color: var(--accent);
  }
  .error,
  .blocking {
    color: var(--error);
  }
  .muted {
    color: var(--muted);
  }
</style>
