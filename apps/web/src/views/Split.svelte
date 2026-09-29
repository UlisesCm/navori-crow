<script lang="ts">
  import { SplitStore } from "../lib/state/split.svelte";
  import FeedColumn from "./FeedColumn.svelte";

  const { keys }: { keys: string[] } = $props();

  const store = new SplitStore();

  // Restarts when the route's key list changes; the cleanup also runs on unmount.
  $effect(() => {
    void store.start([...keys]);
    return () => store.stop();
  });
</script>

<p class="muted status">
  {store.connected ? "En vivo" : "Sin conexión al stream"} ·
  <a href="#/">Volver al inicio</a>
</p>

{#if store.error !== null}
  <p class="error">No se pudo cargar el split: {store.error}</p>
{/if}

{#if !store.loaded}
  <p class="muted">Cargando…</p>
{:else}
  <div class="columns" style={`--cols: ${keys.length}`}>
    {#each keys as key (key)}
      {#if store.columns[key] !== undefined}
        <FeedColumn projectKey={key} events={store.columns[key].value.events} />
      {/if}
    {/each}
  </div>
{/if}

<style>
  .columns {
    display: grid;
    grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
    gap: 1rem;
    align-items: start;
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
