<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { ProjectsStore } from "../lib/state/projects.svelte";
  import ProjectCard from "./ProjectCard.svelte";

  const store = new ProjectsStore();
  let selected: string[] = $state([]);

  /** Split holds 2 to 4 projects (R31); a fifth selection is ignored. */
  function toggle(key: string): void {
    if (selected.includes(key)) selected = selected.filter((k) => k !== key);
    else if (selected.length < 4) selected = [...selected, key];
  }
  const splitHref = $derived(`#/split/${encodeURIComponent(selected.join(","))}`);

  onMount(() => void store.start());
  onDestroy(() => store.stop());
</script>

<p class="muted status">
  {store.connected ? "En vivo" : "Sin conexión al stream"}
</p>

{#if selected.length > 0}
  <p class="split-bar">
    {#if selected.length >= 2}
      <a href={splitHref}>Abrir split ({selected.length})</a>
    {:else}
      <span class="muted">Elige de 2 a 4 proyectos para el split.</span>
    {/if}
    <button type="button" onclick={() => (selected = [])}>Limpiar</button>
  </p>
{/if}

{#if store.error !== null}
  <p class="error">No se pudo cargar los proyectos: {store.error}</p>
{:else if !store.loaded}
  <p class="muted">Cargando…</p>
{:else}
  {#if store.cards.length === 0}
    <p class="muted">Aún no hay proyectos con actividad reciente.</p>
  {:else}
    <div class="grid">
      {#each store.cards as project (project.key)}
        <ProjectCard {project} selected={selected.includes(project.key)} onToggle={toggle} />
      {/each}
    </div>
  {/if}

  {#if store.unattributed !== null}
    {@const bucket = store.unattributed}
    <details class="unattributed">
      <summary>Sin atribuir ({bucket.sessions.length} {bucket.sessions.length === 1 ? "sesión" : "sesiones"})</summary>
      <p class="muted">
        Eventos que no se pudieron asociar a un repositorio (sin directorio de trabajo o telemetría OTLP sin sesión).
      </p>
      {#if bucket.lastError !== null}
        <p class="error" title={bucket.lastError.message}>Último error: {bucket.lastError.message}</p>
      {/if}
      <p class="sessions">
        {#each bucket.sessions as s (s.id)}
          <a href={`#/session/${encodeURIComponent(s.id)}`}>Ver sesión {s.nativeId.slice(0, 8)}</a>
        {/each}
      </p>
    </details>
  {/if}
{/if}

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 1rem;
  }
  .split-bar {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    margin: 0 0 0.75rem;
    font-size: 0.875rem;
  }
  .unattributed {
    margin-top: 1.5rem;
    font-size: 0.875rem;
  }
  .unattributed summary {
    cursor: pointer;
    color: var(--muted);
  }
  .sessions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
  }
  .status {
    margin: 0 0 0.5rem;
    font-size: 0.8rem;
  }
  .muted {
    color: var(--muted);
  }
  .error {
    color: var(--error);
  }
</style>
