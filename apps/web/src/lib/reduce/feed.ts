/**
 * Event-feed reducer (R31, R32, D16): an id-ordered, de-duplicated window of
 * `CrowEvent`s used by the split columns and the session timeline, plus the
 * pure timeline filters. Pure — no runes, no DOM, no clock.
 */
import type { CrowEvent } from "@crow/core/types";
import { applyMany, applyOne, fromSnapshot, type Cursored } from "./cursor";

/** Render/retention cap of the session timeline (D16). */
export const TIMELINE_WINDOW = 500;
/** Retention cap of a split column. */
export const COLUMN_WINDOW = 200;

/** Events in ascending id order (= ingestion order, ULIDs). */
export interface FeedData {
  events: CrowEvent[];
  /** Keep only the latest `max` events; `null` = unbounded. */
  max: number | null;
  /** `true` while older events exist that were dropped by the window. */
  truncated: boolean;
}

export type FeedState = Cursored<FeedData>;

/** Sorts by id and drops repeated ids (first occurrence wins). */
function normalize(events: readonly CrowEvent[]): CrowEvent[] {
  const sorted = [...events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sorted.filter((e, i) => i === 0 || e.id !== sorted[i - 1]!.id);
}

function trim(data: FeedData): FeedData {
  if (data.max === null || data.events.length <= data.max) return data;
  return { ...data, events: data.events.slice(data.events.length - data.max), truncated: true };
}

/**
 * Builds a feed from a snapshot page taken at `cursor` (`null` when the events
 * will be applied one by one afterwards, as the session timeline does).
 */
export function feedFromEvents(
  events: readonly CrowEvent[],
  cursor: string | null,
  max: number | null,
): FeedState {
  return fromSnapshot(trim({ events: normalize(events), max, truncated: false }), cursor);
}

function append(data: FeedData, e: CrowEvent): FeedData {
  return trim({ ...data, events: [...data.events, e] });
}

/** Applies one stream/page event; ids `<= lastApplied` are ignored (R33). */
export function applyToFeed(state: FeedState, e: CrowEvent): FeedState {
  return applyOne(state, e, append);
}

/** Applies an ascending page (or replay) in order under the same cursor rule. */
export function applyManyToFeed(state: FeedState, events: readonly CrowEvent[]): FeedState {
  return applyMany(state, events, append);
}

/**
 * Merges older events (a REST page) into the window without touching the
 * cursor and without duplicates. `complete` says the caller reached the start
 * of the session, which lifts the cap so the merged history is kept.
 */
export function mergeOlder(
  state: FeedState,
  events: readonly CrowEvent[],
  complete: boolean,
): FeedState {
  const data = state.value;
  const merged = normalize([...events, ...data.events]);
  return {
    ...state,
    value: {
      events: merged,
      max: complete ? null : data.max,
      truncated: complete ? false : data.truncated,
    },
  };
}

/** Routes a stream event to the column of its project (split view, one cursor per column). */
export function applyToColumns(
  columns: Readonly<Record<string, FeedState>>,
  e: CrowEvent,
): Record<string, FeedState> {
  const col = columns[e.projectKey];
  if (col === undefined) return { ...columns };
  const next = applyToFeed(col, e);
  return next === col ? { ...columns } : { ...columns, [e.projectKey]: next };
}

/** Smallest column cursor: the stream opens there so no column misses events (D16). */
export function minCursor(columns: Readonly<Record<string, FeedState>>): string | null {
  let min: string | null = null;
  for (const c of Object.values(columns)) {
    if (c.lastApplied === null) return null;
    if (min === null || c.lastApplied < min) min = c.lastApplied;
  }
  return min;
}

// ---------------------------------------------------------------- filters

/** Sentinel for the main thread (`agentId === null`) in {@link TimelineFilter.agent}. */
export const MAIN_AGENT = "__main__";

/** `null` in a field means "any". */
export interface TimelineFilter {
  kind: string | null;
  agent: string | null;
  tool: string | null;
}

export const NO_FILTER: TimelineFilter = { kind: null, agent: null, tool: null };

/** Filters by kind, agent and tool (R32); every set field must match. */
export function filterEvents(events: readonly CrowEvent[], f: TimelineFilter): CrowEvent[] {
  return events.filter(
    (e) =>
      (f.kind === null || e.kind === f.kind) &&
      (f.agent === null || (e.agentId ?? MAIN_AGENT) === f.agent) &&
      (f.tool === null || e.tool?.name === f.tool),
  );
}

export interface FilterOptions {
  kinds: string[];
  agents: string[];
  tools: string[];
}

/** Distinct values present in `events`, to populate the filter selectors. */
export function filterOptions(events: readonly CrowEvent[]): FilterOptions {
  const kinds = new Set<string>();
  const agents = new Set<string>();
  const tools = new Set<string>();
  for (const e of events) {
    kinds.add(e.kind);
    agents.add(e.agentId ?? MAIN_AGENT);
    if (e.tool !== undefined) tools.add(e.tool.name);
  }
  return {
    kinds: [...kinds].sort(),
    agents: [...agents].sort(),
    tools: [...tools].sort(),
  };
}

// ------------------------------------------------------------ presentation

/**
 * Who wrote a `prompt` event, from event fields only: `agentId === null` is the
 * main thread (crow-event.ts), so the text was typed by the user; a non-null
 * `agentId` means a subagent/fork thread, whose "prompt" (Codex guardian/fork
 * `UserMessage`, Claude subagent prompt) is the parent agent's instruction.
 * `null` for any other kind.
 */
export function promptOrigin(e: CrowEvent): "user" | "parent-agent" | null {
  if (e.kind !== "prompt") return null;
  return e.agentId === null ? "user" : "parent-agent";
}

const KIND_LABELS: Record<string, string> = {
  "session.start": "Inicio de sesión",
  "session.end": "Fin de sesión",
  prompt: "Prompt",
  "assistant.message": "Respuesta",
  "tool.pre": "Herramienta",
  "tool.post": "Herramienta (fin)",
  "tool.error": "Error de herramienta",
  "agent.start": "Agente inicia",
  "agent.stop": "Agente termina",
  hook: "Hook",
  permission: "Permiso",
  compact: "Compactación",
  "instructions.loaded": "Instrucciones",
  usage: "Uso",
  "api.request": "Petición API",
  "ingest.error": "Error de ingesta",
};

/** Spanish label of the event's kind; prompts are split by {@link promptOrigin}. */
export function kindLabel(e: CrowEvent): string {
  const origin = promptOrigin(e);
  if (origin === "parent-agent") return "Instrucción del agente padre";
  if (origin === "user") return "Prompt del usuario";
  return KIND_LABELS[e.kind] ?? e.kind;
}

/** Spanish label for a raw kind string (filter selector). */
export function rawKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/** One-line detail of an event: tool name, text, agent type or error message. */
export function describeEvent(e: CrowEvent): string {
  if (e.error !== undefined) return e.error.message;
  if (e.tool !== undefined) return e.tool.name;
  if (e.agent?.type !== undefined) return e.agent.type;
  if (e.hook !== undefined) return e.hook.name;
  return e.text ?? "";
}
