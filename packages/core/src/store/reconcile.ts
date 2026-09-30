/**
 * Cross-lane fact fusion (F2a design D5, § Reconciliación): pure functions, no DB.
 *
 * A logical fact is decomposed into named **units** (a field or a small group of fields that always
 * travel together). Each unit remembers which `role` contributed its current value (`prov`); a later
 * contribution replaces it only if it ranks higher for that unit. Ranks plus a deterministic
 * tie-break make the final fact a function of the SET of contributions, never of their arrival order.
 */
import type { PartialCrowEvent } from "../adapter";
import type {
  CrowEvent,
  CrowEventError,
  CrowEventPermission,
  CrowEventTurn,
  EngineId,
  EventKind,
  EventSource,
} from "../crow-event";

/** Persisted in `events.lmeta`: the roles that contributed and which role set each unit. */
export interface FactMeta {
  lanes: string[];
  prov: Record<string, string>;
}

type MsSource = NonNullable<NonNullable<CrowEvent["tool"]>["msSource"]>;
type Verdict = NonNullable<NonNullable<CrowEvent["tool"]>["verdict"]>;

/** Every mergeable piece of a fact. Absent = no lane has contributed it. */
type Units = {
  kind: EventKind;
  ts: number;
  agentId: string | null;
  parentAgentId: string | null;
  seq?: number;
  cwd?: string;
  text?: string;
  raw?: unknown;
  "tool.name"?: string;
  "tool.callId"?: string;
  "tool.input"?: unknown;
  "tool.ok"?: boolean;
  "tool.ms"?: { ms: number; msSource?: MsSource };
  "tool.verdict"?: { verdict?: Verdict; decisionSource?: string };
  error?: CrowEventError;
  "agent.type"?: string;
  "agent.description"?: string;
  "agent.spawnCallId"?: string;
  "agent.depth"?: number;
  "agent.outcome"?: NonNullable<CrowEvent["agent"]>["outcome"];
  permission?: CrowEventPermission;
  "compact.trigger"?: string;
  "compact.startedAt"?: number;
  "compact.endedAt"?: number;
  turn?: CrowEventTurn;
};

type UnitName = keyof Units;

/** Units that never reach the UI: changing only these publishes no `revision` (D5). */
const SILENT_UNITS: ReadonlySet<UnitName> = new Set<UnitName>(["ts", "seq", "cwd", "raw"]);

/** What a fact needs from an event: satisfied by both `PartialCrowEvent` and a stored `CrowEvent`. */
type FactLike = Pick<
  CrowEvent,
  | "kind"
  | "ts"
  | "agentId"
  | "parentAgentId"
  | "seq"
  | "cwd"
  | "text"
  | "raw"
  | "tool"
  | "error"
  | "agent"
  | "permission"
  | "compact"
  | "turn"
>;

const LANE_RANK: Readonly<Record<string, number>> = { transcript: 3, hook: 2, otel: 1 };
const SOURCE_ORDER: readonly EventSource[] = ["transcript", "hook", "otel", "sse", "file"];

/** `hook:pre` → `hook`; a role without a suffix is its own lane. */
function laneOf(role: string): string {
  const i = role.indexOf(":");
  return i === -1 ? role : role.slice(0, i);
}

function laneRank(role: string): number {
  return LANE_RANK[laneOf(role)] ?? 0;
}

const MS_SOURCE_RANK: Readonly<Record<MsSource, number>> = {
  engine: 3,
  "hook-receipt": 2,
  transcript: 1,
};

/** Higher wins. Ranks per unit follow design.md § Reconciliación → Precedencia. */
function rankOf(unit: UnitName, role: string, value: unknown): number {
  switch (unit) {
    case "tool.ms": {
      const v = value as NonNullable<Units["tool.ms"]>;
      const source: MsSource =
        v.msSource ?? (laneOf(role) === "transcript" ? "transcript" : "hook-receipt");
      return MS_SOURCE_RANK[source] * 10 + laneRank(role); // engine (hook, then otel) > receipt > transcript (D7)
    }
    case "tool.verdict":
      return laneOf(role) === "transcript" ? 0 : laneRank(role); // hook > otel
    case "permission":
      if (role === "hook:denied") return 3;
      return laneOf(role) === "otel" ? 2 : laneOf(role) === "hook" ? 1 : 0; // denied > otel > request
    case "compact.trigger":
    case "compact.startedAt":
      return role === "hook:pre" ? 100 : laneRank(role);
    case "compact.endedAt":
      return role === "hook:post" ? 100 : laneRank(role);
    case "kind":
      return (value === "tool.error" ? 100 : 0) + laneRank(role); // tool.error if any lane says so
    default:
      return laneRank(role); // transcript > hook > otel
  }
}

/** `true` when `incoming` must replace `current`; equal ranks fall to the smaller role name (deterministic). */
function beats(
  unit: UnitName,
  incoming: { role: string; value: unknown },
  current: { role: string; value: unknown },
): boolean {
  const a = rankOf(unit, incoming.role, incoming.value);
  const b = rankOf(unit, current.role, current.value);
  return a !== b ? a > b : incoming.role < current.role;
}

function unitsOf(e: FactLike): Units {
  const u: Units = { kind: e.kind, ts: e.ts, agentId: e.agentId, parentAgentId: e.parentAgentId };
  if (e.seq !== undefined) u.seq = e.seq;
  if (e.cwd !== undefined) u.cwd = e.cwd;
  if (e.text !== undefined) u.text = e.text;
  if (e.raw !== undefined) u.raw = e.raw;
  const t = e.tool;
  if (t !== undefined) {
    u["tool.name"] = t.name;
    if (t.callId !== undefined) u["tool.callId"] = t.callId;
    if (t.input !== undefined) u["tool.input"] = t.input;
    if (t.ok !== undefined) u["tool.ok"] = t.ok;
    if (t.ms !== undefined) {
      u["tool.ms"] = t.msSource !== undefined ? { ms: t.ms, msSource: t.msSource } : { ms: t.ms };
    }
    if (t.verdict !== undefined || t.decisionSource !== undefined) {
      const v: NonNullable<Units["tool.verdict"]> = {};
      if (t.verdict !== undefined) v.verdict = t.verdict;
      if (t.decisionSource !== undefined) v.decisionSource = t.decisionSource;
      u["tool.verdict"] = v;
    }
  }
  if (e.error !== undefined) u.error = e.error;
  const a = e.agent;
  if (a !== undefined) {
    if (a.type !== undefined) u["agent.type"] = a.type;
    if (a.description !== undefined) u["agent.description"] = a.description;
    if (a.spawnCallId !== undefined) u["agent.spawnCallId"] = a.spawnCallId;
    if (a.depth !== undefined) u["agent.depth"] = a.depth;
    if (a.outcome !== undefined) u["agent.outcome"] = a.outcome;
  }
  if (e.permission !== undefined) u.permission = e.permission;
  const c = e.compact;
  if (c !== undefined) {
    if (c.trigger !== undefined) u["compact.trigger"] = c.trigger;
    if (c.startedAt !== undefined) u["compact.startedAt"] = c.startedAt;
    if (c.endedAt !== undefined) u["compact.endedAt"] = c.endedAt;
  }
  if (e.turn !== undefined) u.turn = e.turn;
  return u;
}

/** Identity the store stamps on a fact; `id` is immutable across fusions. */
export interface FactIdentity {
  id: string;
  engine: EngineId;
  projectKey: string;
  projectPath: string;
  sessionId: string;
}

function assemble(identity: FactIdentity, u: Units, sources: EventSource[]): CrowEvent {
  const fact: CrowEvent = {
    id: identity.id,
    engine: identity.engine,
    source: sources[0] ?? "transcript",
    projectKey: identity.projectKey,
    projectPath: identity.projectPath,
    sessionId: identity.sessionId,
    agentId: u.agentId,
    parentAgentId: u.parentAgentId,
    kind: u.kind,
    ts: u.ts,
  };
  if (u.seq !== undefined) fact.seq = u.seq;
  if (u.text !== undefined) fact.text = u.text;
  if (u.raw !== undefined) fact.raw = u.raw;
  if (u.cwd !== undefined) fact.cwd = u.cwd;

  const name = u["tool.name"];
  if (name !== undefined) {
    const tool: NonNullable<CrowEvent["tool"]> = { name };
    if (u["tool.callId"] !== undefined) tool.callId = u["tool.callId"];
    if (u["tool.input"] !== undefined) tool.input = u["tool.input"];
    if (u["tool.ok"] !== undefined) tool.ok = u["tool.ok"];
    const ms = u["tool.ms"];
    if (ms !== undefined) {
      tool.ms = ms.ms;
      if (ms.msSource !== undefined) tool.msSource = ms.msSource;
    }
    const vd = u["tool.verdict"];
    if (vd?.verdict !== undefined) tool.verdict = vd.verdict;
    if (vd?.decisionSource !== undefined) tool.decisionSource = vd.decisionSource;
    fact.tool = tool;
  }
  if (u.error !== undefined) fact.error = u.error;

  const agent: NonNullable<CrowEvent["agent"]> = {};
  if (u["agent.type"] !== undefined) agent.type = u["agent.type"];
  if (u["agent.description"] !== undefined) agent.description = u["agent.description"];
  if (u["agent.spawnCallId"] !== undefined) agent.spawnCallId = u["agent.spawnCallId"];
  if (u["agent.depth"] !== undefined) agent.depth = u["agent.depth"];
  if (u["agent.outcome"] !== undefined) agent.outcome = u["agent.outcome"];
  if (Object.keys(agent).length > 0) fact.agent = agent;

  if (u.permission !== undefined) fact.permission = u.permission;
  const compact: NonNullable<CrowEvent["compact"]> = {};
  if (u["compact.trigger"] !== undefined) compact.trigger = u["compact.trigger"];
  if (u["compact.startedAt"] !== undefined) compact.startedAt = u["compact.startedAt"];
  if (u["compact.endedAt"] !== undefined) compact.endedAt = u["compact.endedAt"];
  if (Object.keys(compact).length > 0) fact.compact = compact;
  if (u.turn !== undefined) fact.turn = u.turn;

  fact.sources = sources;
  return fact;
}

/** Deep structural equality over JSON-like values (key order does not matter). */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  return ka.every((k) => k in rb && sameJson(ra[k], rb[k]));
}

/** A stored fact plus its provenance: what {@link mergeContribution} folds a new contribution into. */
export interface FactState {
  fact: CrowEvent;
  meta: FactMeta;
}

function orderedSources(sources: Iterable<EventSource>): EventSource[] {
  const set = new Set(sources);
  return SOURCE_ORDER.filter((s) => set.has(s)).concat(
    [...set].filter((s) => !SOURCE_ORDER.includes(s)),
  );
}

/** The first contribution to a logical fact. */
export function createFact(
  identity: FactIdentity,
  incoming: FactLike,
  role: string,
  source: EventSource,
): FactState {
  const units = unitsOf(incoming);
  const prov: Record<string, string> = {};
  for (const name of Object.keys(units)) prov[name] = role;
  return { fact: assemble(identity, units, [source]), meta: { lanes: [role], prov } };
}

/**
 * Folds one more contribution into an existing fact. The `id` is untouched. `visibleChanged` says
 * whether a field the UI paints changed, i.e. whether a `revision` row must be published (D5).
 */
export function mergeContribution(
  identity: FactIdentity,
  current: FactState,
  incoming: FactLike,
  role: string,
  source: EventSource,
): { next: FactState; visibleChanged: boolean } {
  const before = unitsOf(current.fact);
  const after: Units = { ...before };
  const prov = { ...current.meta.prov };
  const target = after as Record<string, unknown>;
  const incomingUnits = unitsOf(incoming) as Record<string, unknown>;
  let visibleChanged = false;

  for (const name of Object.keys(incomingUnits) as UnitName[]) {
    const value = incomingUnits[name];
    const held = target[name];
    const heldRole = prov[name];
    // `null` counts as absent for the parent (D19 B1): a hook's null never overrides an OTel parent.
    if (name === "parentAgentId" && value === null) continue;
    const wins =
      held === undefined ||
      (name === "parentAgentId" && held === null) ||
      heldRole === undefined ||
      beats(name, { role, value }, { role: heldRole, value: held });
    if (!wins) continue;
    target[name] = value;
    prov[name] = role;
    if (!SILENT_UNITS.has(name) && !sameJson(held, value)) visibleChanged = true;
  }

  const sources = orderedSources([...(current.fact.sources ?? [current.fact.source]), source]);
  const lanes = [...new Set([...current.meta.lanes, role])].sort();
  return {
    next: { fact: assemble(identity, after, sources), meta: { lanes, prov } },
    visibleChanged,
  };
}

/** Why an event must not carry a `match`, or `null` if it may (D5 invariants). */
export function matchViolation(event: PartialCrowEvent): string | null {
  if (event.usage !== undefined || event.otelUsage !== undefined) {
    return "an event carrying usage must not carry a match";
  }
  if (event.kind === "hook" || event.hook !== undefined)
    return "a hook event must not carry a match";
  if (event.kind === "revision") return "only the store emits revision rows";
  if (event.reported !== undefined)
    return "an event carrying reported numbers must not carry a match";
  return null;
}
