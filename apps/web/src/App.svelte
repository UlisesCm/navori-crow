<script lang="ts">
  import { onMount } from "svelte";

  interface HealthzResponse {
    ok: boolean;
  }

  let status: "loading" | "up" | "down" = $state("loading");

  onMount(async () => {
    try {
      const res = await fetch("/healthz");
      if (!res.ok) {
        status = "down";
        return;
      }
      const body = (await res.json()) as HealthzResponse;
      status = body.ok ? "up" : "down";
    } catch {
      status = "down";
    }
  });
</script>

<main>
  <h1>navori-crow</h1>
  <p>server status: <strong>{status}</strong></p>
</main>
