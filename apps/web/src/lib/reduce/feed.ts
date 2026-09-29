/**
 * Event-feed reducer (R31, R32, D16): an id-ordered, de-duplicated window of
 * `CrowEvent`s used by the split columns and the session timeline, plus the
 * pure timeline filters. Pure — no runes, no DOM, no clock.
 */
import type { CrowEvent } from "@crow/core/types";
import { formatDuration, usd } from "../format";
import { applyMany, applyOne, fromSnapshot, type Cursored } from "./cursor";

/** Render/retention cap of the session timeline (D16). */
export const TIMELINE_WINDOW = 500;
/** Hard retention ceiling of the timeline after "mostrar anteriores" (D16): the oldest events drop beyond it. */
export const LOADED_CEILING = 5_000;
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

/**
 * Replaces the fact a `revision` row corrects, in place, if the window holds it; otherwise a no-op.
 * A revision is never appended (D5/D16): it only updates a fact the timeline already shows.
 */
function reviseIn(events: readonly CrowEvent[], revision: CrowEvent): CrowEvent[] {
  const target = revision.revision;
  if (target === undefined) return [...events];
  return events.map((e) => (e.id === target.of ? target.fact : e));
}

/** Sorts by id, drops repeated ids (first occurrence wins) and folds `revision` rows into their facts. */
function normalize(events: readonly CrowEvent[]): CrowEvent[] {
  const sorted = [...events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const unique = sorted.filter((e, i) => i === 0 || e.id !== sorted[i - 1]!.id);
  const facts = unique.filter((e) => e.kind !== "revision");
  return unique.filter((e) => e.kind === "revision").reduce(reviseIn, facts);
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
  if (e.kind === "revision") return { ...data, events: reviseIn(data.events, e) };
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
 * of the session. Once older history is loaded the live cap rises to
 * {@link LOADED_CEILING}: live events append without dropping what the user
 * loaded, and only beyond the ceiling the oldest go (flagging `truncated`,
 * which re-enables "mostrar anteriores").
 */
export function mergeOlder(
  state: FeedState,
  events: readonly CrowEvent[],
  complete: boolean,
): FeedState {
  const data = state.value;
  const merged = trim({
    events: normalize([...events, ...data.events]),
    max: LOADED_CEILING,
    truncated: !complete,
  });
  return { ...state, value: merged };
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
      isPainted(e) &&
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
  for (const e of events.filter(isPainted)) {
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
  "turn.end": "Fin de turno",
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

/** Kinds the timeline never paints (D16): usage is folded into totals, revisions into their fact. */
const UNPAINTED: ReadonlySet<string> = new Set(["usage", "revision"]);

/** `true` when the timeline shows a row for this event (D16). */
export function isPainted(e: CrowEvent): boolean {
  return !UNPAINTED.has(e.kind);
}

/** `true` for a `hook` event whose verdict blocks (badge in the timeline, R29). */
export function isBlockingHook(e: CrowEvent): boolean {
  return e.kind === "hook" && e.hook?.blocking === true;
}

const join = (parts: ReadonlyArray<string | undefined>): string =>
  parts.filter((p): p is string => p !== undefined && p !== "").join(" · ");

const ms = (v: number | undefined): string | undefined =>
  v === undefined ? undefined : formatDuration(v);

const DECISIONS: Record<string, string> = { ask: "Pregunta", allow: "Permitido", deny: "Denegado" };

/** One-line detail of an event (D16): per-kind Spanish copy, else tool name, text or agent type. */
export function describeEvent(e: CrowEvent): string {
  switch (e.kind) {
    case "hook": {
      const h = e.hook;
      if (h === undefined) return e.text ?? "";
      return join([
        h.name,
        h.phase,
        h.verdict,
        ms(h.ms),
        h.blocking === true ? "bloqueante" : undefined,
      ]);
    }
    case "permission": {
      const p = e.permission;
      const decision =
        p?.decision === undefined ? "Solicitud" : (DECISIONS[p.decision] ?? p.decision);
      const by = p?.decisionSource === undefined ? undefined : `por ${p.decisionSource}`;
      return join([e.tool?.name, decision, by, p?.reason]);
    }
    case "turn.end":
      if (e.turn?.ok === false) {
        return e.turn.category === undefined
          ? "Turno fallido"
          : `Turno fallido: ${e.turn.category}`;
      }
      return "Fin de turno";
    case "compact": {
      const c = e.compact;
      const state = c?.endedAt === undefined ? "en curso" : "terminada";
      const dur =
        c?.startedAt !== undefined && c.endedAt !== undefined
          ? ms(c.endedAt - c.startedAt)
          : undefined;
      return join([c?.trigger, state, dur]);
    }
    case "api.request": {
      const r = e.reported;
      const cost = r?.costUsd === undefined ? undefined : usd.format(r.costUsd);
      return join([r?.model ?? e.usage?.model, ms(r?.ms), cost]);
    }
    default:
      break;
  }
  if (e.error !== undefined) return e.error.message;
  if (e.tool !== undefined) return e.tool.name;
  if (e.agent?.type !== undefined) return e.agent.type;
  return e.text ?? "";
}
