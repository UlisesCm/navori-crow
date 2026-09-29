<script lang="ts">
  import type { SessionSummary } from "@crow/core/types";
  import { nf, usd } from "../lib/format";

  const { session }: { session: SessionSummary } = $props();
  const t = $derived(session.totals);
</script>

<section class="panel">
  <h3>Costo</h3>
  <dl>
    <dt>Modelo</dt>
    <dd>{session.model ?? "—"}</dd>
    <dt>Entrada</dt>
    <dd>{nf.format(t.input)}</dd>
    <dt>Salida</dt>
    <dd>{nf.format(t.output)}</dd>
    <dt>Caché (lectura)</dt>
    <dd>{nf.format(t.cacheRead)}</dd>
    <dt>Caché (escritura)</dt>
    <dd>{nf.format(t.cacheCreation)}</dd>
    <dt>Tokens ponderados</dt>
    <dd>{nf.format(t.weightedTokens)}</dd>
    <dt>Costo (USD)</dt>
    <dd>{usd.format(t.costUsd)}{t.unpricedUsages > 0 ? " (parcial)" : ""}</dd>
  </dl>
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
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 0.75rem;
    margin: 0;
    font-size: 0.85rem;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
  }
</style>
