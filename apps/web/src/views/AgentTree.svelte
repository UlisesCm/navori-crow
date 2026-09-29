<script lang="ts">
  import { agentDurationMs, type AgentTreeNode } from "../lib/reduce/session";
  import { formatDuration, nf } from "../lib/format";
  import AgentTree from "./AgentTree.svelte";

  const { nodes, title = true }: { nodes: AgentTreeNode[]; title?: boolean } = $props();

  const STATUS: Record<string, string> = { running: "en curso", done: "terminado", idle: "inactivo" };
  const tokens = (n: AgentTreeNode): number =>
    n.agent.totals.input + n.agent.totals.output + n.agent.totals.cacheRead + n.agent.totals.cacheCreation;
</script>

<section class:panel={title}>
  {#if title}<h3>Agentes</h3>{/if}
  {#if nodes.length === 0}
    {#if title}<p class="muted">Sin subagentes.</p>{/if}
  {:else}
    <ul>
      {#each nodes as n (n.agent.agentId ?? "main")}
        <li>
          <div class="row">
            <strong>{n.agent.type ?? n.agent.agentId ?? "principal"}</strong>
            <span class="status" class:running={n.agent.status === "running"}>
              {STATUS[n.agent.status] ?? n.agent.status}
            </span>
            <span class="muted">{formatDuration(agentDurationMs(n.agent, Date.now()))}</span>
            <span class="muted">{nf.format(tokens(n))} tokens</span>
          </div>
          {#if n.agent.description !== null}<div class="muted desc">{n.agent.description}</div>{/if}
          {#if n.children.length > 0}<AgentTree nodes={n.children} title={false} />{/if}
        </li>
      {/each}
    </ul>
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
  ul {
    list-style: none;
    margin: 0;
    padding-left: 0;
    font-size: 0.8rem;
  }
  section:not(.panel) ul {
    padding-left: 1rem;
    border-left: 1px solid var(--border);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    padding: 0.2rem 0;
  }
  .desc {
    overflow-wrap: anywhere;
  }
  .running {
    color: var(--live);
  }
  .muted {
    color: var(--muted);
  }
</style>
