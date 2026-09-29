<script lang="ts">
  import { SessionStore } from "../lib/state/session.svelte";
  import AgentTree from "./AgentTree.svelte";
  import CostPanel from "./CostPanel.svelte";
  import HooksPanel from "./HooksPanel.svelte";
  import Timeline from "./Timeline.svelte";

  const { id }: { id: string } = $props();

  const store = new SessionStore();

  $effect(() => {
    void store.start(id);
    return () => store.stop();
  });
</script>

<p class="muted status">
  {store.connected ? "En vivo" : "Sin conexión al stream"} ·
  <a href="#/">Volver al inicio</a>
</p>

{#if store.error !== null}
  <p class="error">No se pudo cargar la sesión: {store.error}</p>
{/if}

{#if store.session === null}
  {#if store.error === null}<p class="muted">Cargando…</p>{/if}
{:else}
  <h2>Sesión {store.session.nativeId} <span class="muted">({store.session.status})</span></h2>
  <div class="layout">
    <Timeline
      events={store.events}
      hasOlder={store.hasOlder}
      loadingOlder={store.loadingOlder}
      onLoadOlder={() => store.loadOlder()}
    />
    <aside>
      <CostPanel session={store.session} />
      <HooksPanel hooks={store.hooks} hooksFrom={store.hooksFrom} />
      <AgentTree nodes={store.tree} />
    </aside>
  </div>
{/if}

<style>
  h2 {
    font-size: 1.1rem;
    margin: 0 0 0.75rem;
  }
  .layout {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr);
    gap: 1rem;
    align-items: start;
  }
  aside {
    display: grid;
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
