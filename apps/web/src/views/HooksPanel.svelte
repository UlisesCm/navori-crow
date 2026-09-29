<script lang="ts">
  import type { HookStat } from "@crow/core/types";
  import { formatDuration, formatTime } from "../lib/format";

  const { hooks, hooksFrom }: { hooks: HookStat[]; hooksFrom: number | null } = $props();
</script>

<section class="panel">
  <h3>Hooks</h3>
  {#if hooks.length === 0}
    <p class="muted">Sin registros de hooks para este motor</p>
  {:else}
    <table>
      <thead>
        <tr><th>Hook</th><th>Ejec.</th><th>Total</th><th>Máx.</th><th>Bloq.</th></tr>
      </thead>
      <tbody>
        {#each hooks as h (h.name)}
          <tr>
            <td>{h.name}</td>
            <td>{h.runs}</td>
            <td>{formatDuration(h.totalMs)}</td>
            <td>{formatDuration(h.maxMs)}</td>
            <td>{h.blocking}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if hooksFrom !== null}
      <p class="muted note">registrados desde {formatTime(hooksFrom)}</p>
    {/if}
  {/if}
</section>

<style>
  .panel {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.5rem 0.75rem;
  }
  h3 {
    font-size: 0.95rem;
    margin: 0 0 0.5rem;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }
  th {
    color: var(--muted);
    font-weight: normal;
    text-align: left;
  }
  .muted {
    color: var(--muted);
    margin: 0;
    font-size: 0.85rem;
  }
  .note {
    margin-top: 0.5rem;
    font-size: 0.75rem;
  }
</style>
