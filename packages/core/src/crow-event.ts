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
  model?: string;
  costUsd?: number;
}

/** Harness hook details attached to `hook` events. */
export interface CrowEventHook {
  name: string;
  phase: string;
  verdict?: string;
  ms?: number;
  reason?: string;
}

/**
 * Neutral, engine-agnostic event emitted by any ingestion lane.
 * See PLAN.md §7.1 for the full data model rationale.
 */
export interface CrowEvent {
  id: string; // ulid; global order
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
}
