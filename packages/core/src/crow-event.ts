/**
 * Identifier of the coding-agent engine that produced an event.
 * Open union: known engines get autocomplete, unknown ones are still valid.
 */
export type EngineId =
  | "claude"
  | "codex"
  | "gemini"
  | "opencode"
  | "aider"
  | "cursor"
  | (string & {});

/** Ingestion lane an event arrived through (see PLAN.md §6.1). */
export type EventSource = "transcript" | "hook" | "otel" | "sse" | "file";

/** Neutral kind of a {@link CrowEvent}, shared across all engines. */
export type EventKind =
  | "session.start"
  | "session.end"
  | "prompt"
  | "assistant.message" // text/thinking + usage
  | "tool.pre"
  | "tool.post"
  | "tool.error"
  | "agent.start" // subagents
  | "agent.stop"
  | "hook" // harness hook with verdict/duration
  | "permission" // request/decision
  | "compact"
  | "instructions.loaded" // CLAUDE.md/AGENTS.md/skill
  | "usage" // aggregated tokens/cost (OTel)
  | "api.request"
  | "ingest.error"; // unparseable line / unknown format

/** Tool call details attached to `tool.*` events. */
export interface CrowEventTool {
  name: string;
  callId?: string;
  input?: unknown;
  ok?: boolean;
  ms?: number;
}

/** Token/cost usage attached to `assistant.message` or `usage` events. */
export interface CrowEventUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** Subset of `cacheCreation` billed at the 1h TTL rate (F1: 100% of writes). */
  cacheCreation1h?: number;
  model?: string;
  /** Stamped by core from the pricing table; undefined = model not priced (R20). */
  costUsd?: number;
  /** Stamped by core with the ported navori-harness formula (R21). */
  weightedTokens?: number;
}

/** Harness hook details attached to `hook` events. */
export interface CrowEventHook {
  name: string;
  phase: string;
  verdict?: string;
  ms?: number;
  reason?: string;
}

/** Subagent lifecycle details attached to `agent.start` / `agent.stop` events. */
export interface CrowEventAgent {
  type?: string;
  description?: string;
  spawnCallId?: string;
  depth?: number;
  outcome?: "completed" | "failed" | "killed";
}

/** Why a line or event was rejected or flagged during ingestion. */
export type IngestErrorReason =
  | "invalid-json"
  | "unknown-type"
  | "bad-shape"
  | "line-too-long"
  | "usage-anomaly";

/** Error details attached to `tool.error` / `ingest.error` events. */
export interface CrowEventError {
  message: string; // short, <= 1 KiB, no source content
  reason?: IngestErrorReason; // ingest.error only
  path?: string;
  offset?: number;
  line?: number;
}

/**
 * Neutral, engine-agnostic event emitted by any ingestion lane.
 * See PLAN.md §7.1 for the full data model rationale.
 */
export interface CrowEvent {
  id: string; // ULID; global ingestion order
  engine: EngineId;
  source: EventSource;
  projectKey: string; // stable hash (see project-key.ts / PLAN.md §7.3)
  projectPath: string; // real git root, for display
  sessionId: string; // engine-native id
  agentId: string | null; // null = main thread (orchestrator)
  parentAgentId: string | null;
  kind: EventKind;
  ts: number; // event epoch ms (not ingestion time)
  seq?: number; // position in the source (line/offset) for dedupe
  tool?: CrowEventTool;
  usage?: CrowEventUsage;
  hook?: CrowEventHook;
  text?: string; // prompt/message (subject to redaction)
  raw?: unknown; // original payload (optional, trimmed)
  cwd?: string; // the event's own cwd (R15)
  agent?: CrowEventAgent; // agent.start / agent.stop
  error?: CrowEventError; // tool.error / ingest.error
}
