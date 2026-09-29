/**
 * Session-detail reducer (R32, D16): folds `CrowEvent`s into the session
 * summary and its per-agent nodes returned by `GET /api/sessions/:id`, and
 * builds the agent tree. Pure — no runes, no DOM, no clock.
 */
import type { AgentNode, CrowEvent, SessionDetailResponse, SessionSummary } from "@crow/core/types";
import { applyMany, applyOne, fromSnapshot, type Cursored } from "./cursor";
import { MAIN_AGENT } from "./feed";
import { addUsage, emptyTotals, factOf, updateSession } from "./projects";

/** What the detail view renders next to the timeline. */
export interface SessionData {
  idleMs: number;
  session: SessionSummary;
  agents: AgentNode[];
}

export type SessionState = Cursored<SessionData>;

/**
 * Builds the state from a REST snapshot. Events paginated with `id > cursor`
 * add to the totals; the rest are already in them (D16, R33).
 */
export function sessionFromSnapshot(snapshot: SessionDetailResponse): SessionState {
  return fromSnapshot(
    { idleMs: snapshot.idleMs, session: snapshot.session, agents: snapshot.agents },
    snapshot.cursor,
  );
}

function newAgent(e: CrowEvent, agentId: string): AgentNode {
  return {
    agentId,
    parentAgentId: e.parentAgentId,
    type: null,
    description: null,
    model: null,
    status: "running",
    startedAt: e.ts,
    endedAt: null,
    lastEventAt: e.ts,
    totals: emptyTotals(),
  };
}

function updateAgent(a: AgentNode, e: CrowEvent): AgentNode {
  const next: AgentNode = { ...a, lastEventAt: Math.max(a.lastEventAt ?? 0, e.ts) };
  if (next.parentAgentId === null && e.parentAgentId !== null) next.parentAgentId = e.parentAgentId;
  if (e.kind === "agent.start") {
    next.type = e.agent?.type ?? next.type;
    next.description = e.agent?.description ?? next.description;
    // Metadata only: a finished agent never revives (BD1); the row is created `running`.
  } else if (e.kind === "agent.stop") {
    next.status = "done";
    next.endedAt = a.endedAt ?? e.ts;
  }
  if (e.usage !== undefined) {
    next.totals = addUsage(a.totals, e.usage);
    if (e.usage.model !== undefined) next.model = e.usage.model;
  }
  return next;
}

function foldEvent(data: SessionData, row: CrowEvent): SessionData {
  const e = factOf(row);
  const session = updateSession(data.session, e);
  if (e.agentId === null) return { ...data, session };
  const known = data.agents.some((a) => a.agentId === e.agentId);
  const agents = known
    ? data.agents.map((a) => (a.agentId === e.agentId ? updateAgent(a, e) : a))
    : [...data.agents, updateAgent(newAgent(e, e.agentId), e)];
  return { ...data, session, agents };
}

/** Applies one stream/page event; ids `<= lastApplied` are ignored (R33). */
export function applyToSession(state: SessionState, e: CrowEvent): SessionState {
  return applyOne(state, e, foldEvent);
}

/** Applies a page (or replay) in order under the same cursor rule. */
export function applyManyToSession(
  state: SessionState,
  events: readonly CrowEvent[],
): SessionState {
  return applyMany(state, events, foldEvent);
}

/** A node of the agent tree; `depth` is 0 for roots. */
export interface AgentTreeNode {
  agent: AgentNode;
  depth: number;
  children: AgentTreeNode[];
}

/**
 * Builds the agent forest from `parentAgentId`. Independent of arrival order:
 * a child listed (or streamed) before its parent hangs under it as soon as the
 * parent exists, and is a root until then. Agents whose parent is the main
 * thread (`null`) or unknown are roots. Siblings sort by `startedAt`. A cycle
 * (corrupt data) cannot loop: unreachable nodes are promoted to roots.
 */
export function buildAgentTree(agents: readonly AgentNode[]): AgentTreeNode[] {
  const byId = new Map<string, AgentNode>();
  for (const a of agents) if (a.agentId !== null) byId.set(a.agentId, a);

  const childrenOf = new Map<string, AgentNode[]>();
  const roots: AgentNode[] = [];
  for (const a of agents) {
    const parent = a.parentAgentId;
    if (parent !== null && parent !== a.agentId && byId.has(parent)) {
      const list = childrenOf.get(parent) ?? [];
      list.push(a);
      childrenOf.set(parent, list);
    } else {
      roots.push(a);
    }
  }

  const seen = new Set<AgentNode>();
  const byStart = (a: AgentNode, b: AgentNode): number => (a.startedAt ?? 0) - (b.startedAt ?? 0);
  const build = (a: AgentNode, depth: number): AgentTreeNode => {
    seen.add(a);
    const kids = a.agentId === null ? [] : (childrenOf.get(a.agentId) ?? []);
    return {
      agent: a,
      depth,
      children: kids
        .filter((k) => !seen.has(k))
        .sort(byStart)
        .map((k) => build(k, depth + 1)),
    };
  };

  const tree = roots.sort(byStart).map((r) => build(r, 0));
  for (const a of agents) if (!seen.has(a)) tree.push(build(a, 0)); // cycle members
  return tree;
}

/**
 * The agent tree of a session with the main thread as its root (D16). The main
 * thread has no `agents` row, so it is synthesized from the session (id
 * {@link MAIN_AGENT}, type `principal`, totals = session totals minus the
 * agents', floored at 0) and every agent with a `null` parent hangs under it.
 * Agents with an unknown parent stay as extra roots, after the main node.
 */
export function buildSessionTree(
  session: SessionSummary,
  agents: readonly AgentNode[],
): AgentTreeNode[] {
  const totals = { ...session.totals };
  for (const a of agents) {
    for (const k of Object.keys(totals) as Array<keyof typeof totals>) {
      totals[k] = Math.max(0, totals[k] - a.totals[k]);
    }
  }
  const main: AgentNode = {
    agentId: MAIN_AGENT,
    parentAgentId: null,
    type: "principal",
    description: null,
    model: session.model,
    status: session.status === "ended" ? "done" : "running",
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    lastEventAt: session.lastEventAt,
    totals,
  };
  const rewired = agents.map((a) =>
    a.parentAgentId === null ? { ...a, parentAgentId: MAIN_AGENT } : a,
  );
  return buildAgentTree([main, ...rewired]);
}

/** Wall-clock span of an agent up to `nowMs` while it still runs; `null` without a start. */
export function agentDurationMs(a: AgentNode, nowMs: number): number | null {
  if (a.startedAt === null) return null;
  const end = a.endedAt ?? (a.status === "running" ? nowMs : (a.lastEventAt ?? a.startedAt));
  return Math.max(0, end - a.startedAt);
}
