<script lang="ts">
  import { router } from "./lib/router.svelte";
  import Home from "./views/Home.svelte";
</script>

<main>
  <header>
    <h1><a href="#/">navori-crow</a></h1>
  </header>

  {#if router.current.name === "home"}
    <Home />
  {:else if router.current.name === "split" || router.current.name === "session"}
    <p class="muted">Esta vista llega en la siguiente tarea (B6.T2). <a href="#/">Volver al inicio</a></p>
  {:else}
    <p class="muted">Ruta desconocida. <a href="#/">Volver al inicio</a></p>
  {/if}
</main>

<style>
  :global(:root) {
    color-scheme: light dark;
    --bg: #fafafa;
    --card: #fff;
    --fg: #1c1c1e;
    --muted: #6b7280;
    --border: #e5e7eb;
    --accent: #2563eb;
    --error: #b91c1c;
    --live: #16a34a;
  }
  @media (prefers-color-scheme: dark) {
    :global(:root) {
      --bg: #111214;
      --card: #1b1d20;
      --fg: #e5e7eb;
      --muted: #9ca3af;
      --border: #2d3036;
      --accent: #60a5fa;
      --error: #f87171;
      --live: #4ade80;
    }
  }
  :global(body) {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font-family: system-ui, sans-serif;
  }
  :global(a) {
    color: var(--accent);
  }
  main {
    max-width: 1200px;
    margin: 0 auto;
    padding: 1rem;
  }
  h1 {
    font-size: 1.25rem;
    margin: 0 0 1rem;
  }
  h1 a {
    color: inherit;
    text-decoration: none;
  }
  .muted {
    color: var(--muted);
  }
</style>
