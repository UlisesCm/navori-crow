<script lang="ts">
  import type { ProjectSummary } from "@crow/core/types";

  const {
    project,
    selected = false,
    onToggle,
  }: { project: ProjectSummary; selected?: boolean; onToggle?: (key: string) => void } = $props();

  const live = $derived(project.sessions.filter((s) => s.status === "live"));
  /** Most recently active live session drives "prompt" and "agent". */
  const current = $derived(
    [...live].sort((a, b) => b.lastEventAt - a.lastEventAt)[0] ?? null,
  );
  const tokens = $derived(
    project.today.input + project.today.output + project.today.cacheRead + project.today.cacheCreation,
  );

  const nf = new Intl.NumberFormat("es-MX");
  const cost = new Intl.NumberFormat("es-MX", { style: "currency", currency: "USD" });
</script>

<article class="card">
  <header>
    <h2>
      {#if onToggle !== undefined}
        <input
          type="checkbox"
          checked={selected}
          onchange={() => onToggle(project.key)}
          aria-label={`Seleccionar ${project.name} para el split`}
        />
      {/if}
      {project.name}
    </h2>
    <span class="engines">{project.engines.join(", ")}</span>
  </header>

  <dl>
    <dt>Sesiones en vivo</dt>
    <dd class:live={live.length > 0}>{live.length}</dd>

    <dt>Prompt actual</dt>
    <dd class="clip">{current?.lastPrompt ?? "—"}</dd>

    <dt>Agente activo</dt>
    <dd>{current?.activeAgent?.type ?? current?.activeAgent?.agentId ?? "—"}</dd>

    <dt>Tokens hoy</dt>
    <dd>{nf.format(tokens)}</dd>

    <dt>Costo hoy</dt>
    <dd>
      {cost.format(project.today.costUsd)}{project.today.unpricedUsages > 0 ? " (parcial)" : ""}
    </dd>
  </dl>

  {#if live.length > 0}
    <p class="sessions">
      {#each live as s (s.id)}
        <a href={`#/session/${encodeURIComponent(s.id)}`}>Ver sesión {s.nativeId.slice(0, 8)}</a>
      {/each}
    </p>
  {/if}

  {#if project.lastError !== null}
    <p class="error clip" title={project.lastError.message}>
      Último error: {project.lastError.message}
    </p>
  {/if}
</article>

<style>
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.75rem 1rem;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.5rem;
  }
  h2 {
    font-size: 1rem;
    margin: 0;
  }
  .engines {
    color: var(--muted);
    font-size: 0.8rem;
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 0.75rem;
    margin: 0.5rem 0 0;
    font-size: 0.875rem;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
  }
  .live {
    color: var(--live);
    font-weight: 600;
  }
  .clip {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sessions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    font-size: 0.8rem;
    margin: 0.5rem 0 0;
  }
  .error {
    color: var(--error);
    font-size: 0.8rem;
    margin: 0.5rem 0 0;
  }
</style>
