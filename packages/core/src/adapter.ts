import type { CrowEvent, CrowEventUsage, EngineId, IngestErrorReason } from "./crow-event";
import type { FlatOtelRecord } from "./otel";

/** A JSON value, used where an adapter's persisted state must stay serializable. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/**
 * Runtime configuration adapters need to compute their watch roots (design.md
 * § Configuración). `packages/core/src/config.ts` (B2) is the only place
 * that reads `env`/`homedir` to build one of these; it's declared here,
 * where it's consumed, so `EngineAdapter.watchRoots` doesn't need to wait
 * for the store batch to land.
 */
export interface CrowConfig {
  crowHome: string;
  crowPort: number;
  backfillHours: number;
  idleMinutes: number;
  allowedOrigins: string[];
  claudeConfigDir: string;
  codexHome: string;
  /** R3: ingest token (`CROW_TOKEN`, else `$CROW_HOME/token`); `null` = no token configured. */
  token: string | null;
  /** R34: OTLP lane opt-in; off unless flag, `CROW_OTLP` or `config.json` enables it. */
  otlpEnabled: boolean;
  otlpPort: number;
}

/** How the store correlates a contribution across lanes (design.md D5). */
export interface MatchSpec {
  /** Session-scoped; include the agent in class keys. */
  key: string;
  mode: "exact" | "nearest";
  /** "nearest" only. */
  windowMs?: number;
  fingerprint?: string;
  /** One contribution per role; default = source. */
  role?: string;
}

/**
 * What an adapter emits for one line, before the core pipeline stamps the
 * fields only it can know (`id`, `engine`, `source`, `projectKey`,
 * `projectPath`, `seq`) — see design.md § Contracts.
 */
export type PartialCrowEvent = Omit<
  CrowEvent,
  "id" | "engine" | "source" | "projectKey" | "projectPath" | "seq"
> & {
  /** R13: usage counted once per key within session+agent. */
  usageKey?: string;
  /** D7: secondary identity, scoped to the agent/file. */
  semanticKey?: string;
  match?: MatchSpec;
  /** Transcript usage call key, `req:<requestId>` (D6). */
  usageCallKey?: string;
  /** OTel candidate usage: the store decides (D6); never counted directly. */
  otelUsage?: CrowEventUsage;
};

/** A hook delivery, transport-agnostic. */
export interface HookInput {
  body: unknown;
  receivedAt: number;
}

/** Outcome of mapping one hook payload. */
export type HookResult =
  | { ok: true; events: PartialCrowEvent[]; warnings?: LineWarning[] }
  | {
      ok: false;
      reason: IngestErrorReason;
      detail?: string;
      sessionId: string | null;
      agentId: string | null;
    };

/** Outcome of mapping one flattened OTel record. */
export type OtelResult =
  | { ok: true; events: PartialCrowEvent[] }
  | { ok: false; reason: "unattributable"; detail?: string };

/** Which watched file a path matched, and the identity it carries. */
export interface FileMatch {
  role: "main" | "agent" | "sidecar";
  groupKey: string;
  sessionId: string | null;
  agentId: string | null;
  sidecarPath: string | null;
}

/** Where a line sits in its source file, for error reporting (R10). */
export interface LinePos {
  path: string;
  offset: number;
  line: number;
}

/** A non-fatal issue found while parsing a line, converted to `ingest.error` by the pipeline. */
export interface LineWarning {
  reason: IngestErrorReason;
  detail: string;
}

/** Outcome of parsing one line: the events it produced, or why it couldn't be parsed. */
export type LineResult<S extends JsonValue> =
  | { ok: true; events: PartialCrowEvent[]; warnings?: LineWarning[]; state: S }
  | {
      ok: false;
      reason: IngestErrorReason;
      detail?: string;
      /** `null` when the line doesn't reveal its session: core falls back to the file's `match.sessionId`. */
      sessionId: string | null;
      agentId: string | null;
      /** Last known `cwd` from the adapter state, so the error resolves to the session's project (R15). */
      cwd?: string;
      state: S;
    };

/** Metadata patch parsed from a sidecar file (e.g. Claude's `.meta.json`). */
export interface AgentMetaPatch {
  sessionId: string;
  agentId: string;
  type?: string;
  description?: string;
  spawnCallId?: string;
  depth?: number;
}

/**
 * A pure, engine-specific line parser (design.md § Approach, peldaño 3).
 *
 * The adapter owns no I/O: the core tailer reads files, tracks offsets and
 * state, and hands each complete line to `parseLine`. `S` is the adapter's
 * own persisted-state shape, round-tripped through `state_json`.
 */
export interface EngineAdapter<S extends JsonValue> {
  readonly id: EngineId;
  watchRoots(cfg: CrowConfig): string[];
  matches(path: string, root: string): FileMatch | null;
  initialState(match: FileMatch, sidecarText: string | null): S;
  /** `null` return means the persisted state is incompatible: re-ingest from 0. */
  restoreState(json: unknown, match: FileMatch): S | null;
  /** Pure: never throws. Parse failures are reported via `LineResult.ok === false`. */
  parseLine(line: string, state: S, pos: LinePos): LineResult<S>;
  parseSidecar?(text: string, match: FileMatch): AgentMetaPatch | null;
  /** Pure, stateless, transport-agnostic. */
  fromHook?(input: HookInput): HookResult;
  /** Signature-based ownership of an OTel record (D10). */
  ownsOtel?(record: FlatOtelRecord): boolean;
  /** Pure, allowlist. */
  fromOtel?(record: FlatOtelRecord): OtelResult;
}

/** An {@link EngineAdapter} with its state type `S` erased, so a registry can hold adapters for different engines. */
export type BoundAdapter = EngineAdapter<JsonValue>;

/**
 * Erases an adapter's state-type generic `S` so it can sit in a homogeneous
 * registry (`apps/server/src/adapters.ts`) alongside adapters for other
 * engines, without ever needing `any`: `S extends JsonValue`, so every value
 * an adapter of type `S` produces or consumes is itself a valid `JsonValue`,
 * and the erased view only ever moves those values opaquely.
 */
export function bindAdapter<S extends JsonValue>(adapter: EngineAdapter<S>): BoundAdapter {
  return adapter as unknown as BoundAdapter;
}
