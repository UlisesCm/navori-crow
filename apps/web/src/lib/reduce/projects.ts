/**
 * Home-view reducer (R30, D16): folds `CrowEvent`s into the per-project card
 * data returned by `GET /api/projects`. Pure — no runes, no DOM, no clock.
 */
import type {
  CrowEvent,
  ProjectSummary,
  ProjectsResponse,
  SessionSummary,
  Totals,
} from "@crow/core/types";
import { localDay } from "@crow/core/time";
import { applyMany, applyOne, fromSnapshot, type Cursored } from "./cursor";

/** What the home view renders; `day` and `idleMs` come from the snapshot. */
export interface ProjectsData {
  day: string;
  idleMs: number;
  projects: Record<string, ProjectSummary>;
}

export type ProjectsState = Cursored<ProjectsData>;

const UNRESOLVED = "unresolved";

export function emptyTotals(): Totals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    cacheCreation1h: 0,
    weightedTokens: 0,
    costUsd: 0,
    unpricedUsages: 0,
  };
}

/** Builds the state from a REST snapshot; the cursor rule starts at `snapshot.cursor`. */
export function projectsFromSnapshot(snapshot: ProjectsResponse): ProjectsState {
  const projects: Record<string, ProjectSummary> = {};
  for (const p of snapshot.projects) projects[p.key] = p;
  return fromSnapshot({ day: snapshot.day, idleMs: snapshot.idleMs, projects }, snapshot.cursor);
}

export function addUsage(totals: Totals, usage: NonNullable<CrowEvent["usage"]>): Totals {
  return {
    input: totals.input + usage.input,
    output: totals.output + usage.output,
    cacheRead: totals.cacheRead + usage.cacheRead,
    cacheCreation: totals.cacheCreation + usage.cacheCreation,
    cacheCreation1h: totals.cacheCreation1h + (usage.cacheCreation1h ?? 0),
    weightedTokens: totals.weightedTokens + (usage.weightedTokens ?? 0),
    costUsd: totals.costUsd + (usage.costUsd ?? 0),
    unpricedUsages: totals.unpricedUsages + (usage.costUsd === undefined ? 1 : 0),
  };
}

/** Last path segment of a project path (display name). */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter((s) => s !== "");
  return parts[parts.length - 1] ?? UNRESOLVED;
}

function newSession(e: CrowEvent, id: string): SessionSummary {
  return {
    id,
    engine: e.engine,
    nativeId: e.sessionId,
    projectKey: e.projectKey,
    status: "live",
    startedAt: e.ts,
    lastEventAt: e.ts,
    endedAt: null,
    model: null,
    lastPrompt: null,
    activeAgent: null,
    totals: emptyTotals(),
  };
}

export function updateSession(s: SessionSummary, e: CrowEvent): SessionSummary {
  const next: SessionSummary = { ...s, lastEventAt: Math.max(s.lastEventAt, e.ts) };
  if (e.kind === "session.end") {
    next.status = "ended";
    next.endedAt = e.ts;
  } else if (next.status !== "live") {
    next.status = "live"; // any later event resumes the session (D10)
    next.endedAt = null;
  }
  if (e.kind === "prompt" && e.text !== undefined) next.lastPrompt = e.text;
  if (e.kind === "agent.start" && e.agentId !== null) {
    next.activeAgent = { agentId: e.agentId, type: e.agent?.type ?? null };
  } else if (e.kind === "agent.stop" && next.activeAgent?.agentId === e.agentId) {
    next.activeAgent = null;
  }
  if (e.usage !== undefined) {
    next.totals = addUsage(s.totals, e.usage);
    if (e.usage.model !== undefined) next.model = e.usage.model;
  }
  return next;
}

/** Folds one event into the data (no cursor check; see {@link applyToProjects}). */
function foldEvent(data: ProjectsData, e: CrowEvent): ProjectsData {
  const prev = data.projects[e.projectKey];
  const sessionId = `${e.engine}:${e.sessionId}`;
  const project: ProjectSummary = prev ?? {
    key: e.projectKey,
    path: e.projectPath,
    name: e.projectPath === "" ? UNRESOLVED : baseName(e.projectPath),
    engines: [],
    lastSeen: e.ts,
    today: emptyTotals(),
    lastError: null,
    sessions: [],
  };

  const existing = project.sessions.find((s) => s.id === sessionId);
  const session = updateSession(existing ?? newSession(e, sessionId), e);
  const sessions = existing
    ? project.sessions.map((s) => (s.id === sessionId ? session : s))
    : [...project.sessions, session];

  const next: ProjectSummary = {
    ...project,
    engines: project.engines.includes(e.engine) ? project.engines : [...project.engines, e.engine],
    lastSeen: Math.max(project.lastSeen, e.ts),
    sessions,
  };
  if (e.usage !== undefined && localDay(e.ts) === data.day) {
    next.today = addUsage(project.today, e.usage);
  }
  if ((e.kind === "tool.error" || e.kind === "ingest.error") && e.error !== undefined) {
    next.lastError = { kind: e.kind, ts: e.ts, sessionId, message: e.error.message };
  }
  return { ...data, projects: { ...data.projects, [e.projectKey]: next } };
}

/** Applies one stream event; ids `<= lastApplied` are ignored (R33). */
export function applyToProjects(state: ProjectsState, e: CrowEvent): ProjectsState {
  return applyOne(state, e, foldEvent);
}

/** Applies a batch (e.g. a replay) in order under the same cursor rule. */
export function applyManyToProjects(
  state: ProjectsState,
  events: readonly CrowEvent[],
): ProjectsState {
  return applyMany(state, events, foldEvent);
}

/**
 * Midnight rollover (D16): once the local day of `nowMs` differs from
 * `data.day`, "today" restarts at zero for every card. The clock is injected,
 * so the reducer stays pure; returns the same state when the day is unchanged.
 */
export function rollDay(state: ProjectsState, nowMs: number): ProjectsState {
  const day = localDay(nowMs);
  if (day === state.value.day) return state;
  const projects: Record<string, ProjectSummary> = {};
  for (const [key, p] of Object.entries(state.value.projects)) {
    projects[key] = { ...p, today: emptyTotals() };
  }
  return { ...state, value: { ...state.value, day, projects } };
}

/** Cards ordered most-recently-active first. */
export function sortedProjects(data: ProjectsData): ProjectSummary[] {
  return Object.values(data.projects).sort((a, b) => b.lastSeen - a.lastSeen);
}
