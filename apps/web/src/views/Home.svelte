<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { ProjectsStore } from "../lib/state/projects.svelte";
  import ProjectCard from "./ProjectCard.svelte";

  const store = new ProjectsStore();

  onMount(() => void store.start());
  onDestroy(() => store.stop());
</script>

<p class="muted status">
  {store.connected ? "En vivo" : "Sin conexión al stream"}
</p>

{#if store.error !== null}
  <p class="error">No se pudo cargar los proyectos: {store.error}</p>
{:else if !store.loaded}
  <p class="muted">Cargando…</p>
{:else if store.cards.length === 0}
  <p class="muted">Aún no hay proyectos con actividad reciente.</p>
{:else}
  <div class="grid">
    {#each store.cards as project (project.key)}
      <ProjectCard {project} />
    {/each}
  </div>
{/if}

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 1rem;
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
