import type { CrowEvent, EngineId, IngestErrorReason } from "./crow-event";

/**
 * REST/SSE DTOs (design.md § Contracts → REST, § Esquema v1 → `SessionStatus`).
 * Consumed by `apps/server` (B5) and `apps/web` (B6), which import this
 * module only through the `@crow/core/types` subpath.
 */

export type SessionStatus = "live" | "idle" | "ended";

export interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  cacheCreation1h: number;
  weightedTokens: number;
  costUsd: number;
  unpricedUsages: number;
}

export interface SessionSummary {
  id: string;
  engine: EngineId;
  nativeId: string;
  projectKey: string;
  status: SessionStatus;
  startedAt: number;
  lastEventAt: number;
  endedAt: number | null;
  model: string | null;
  lastPrompt: string | null;
  /** `ts` of the prompt in `lastPrompt`; later-arriving older prompts must not replace it (BD1). */
  lastPromptAt: number | null;
  activeAgent: { agentId: string; type: string | null } | null;
  /** Latest agent start/stop `ts` applied; an older `agent.start` must not change `activeAgent` (BD1). */
  activeAgentAt: number | null;
  totals: Totals;
}

export interface ProjectSummary {
  key: string;
  path: string;
  name: string;
  engines: EngineId[];
  lastSeen: number;
  today: Totals;
  lastError: {
    kind: "tool.error" | "ingest.error";
    ts: number;
    sessionId: string;
    message: string;
  } | null;
  sessions: SessionSummary[];
}

export interface AgentNode {
  agentId: string | null;
  parentAgentId: string | null;
  type: string | null;
  description: string | null;
  model: string | null;
  status: "running" | "done" | "idle";
  startedAt: number | null;
  endedAt: number | null;
  lastEventAt: number | null;
  totals: Totals;
}

export interface IngestStats {
  semanticDuplicates: number;
  usageAnomalies: number;
  /** Contributions dropped because the same lane had already contributed to that fact (D5). */
  laneDuplicates: number;
  errorsByReason: Partial<Record<IngestErrorReason, number>>;
}

/** `GET /api/projects?since=<ms>` */
export interface ProjectsResponse {
  cursor: string;
  idleMs: number;
  day: string;
  projects: ProjectSummary[];
}

/** `GET /api/sessions?project=&status=&since=&limit=` */
export interface SessionsResponse {
  sessions: SessionSummary[];
}

/** `GET /api/sessions/:id` */
export interface SessionDetailResponse {
  cursor: string;
  idleMs: number;
  session: SessionSummary;
  agents: AgentNode[];
}

/** `GET /api/sessions/:id/events?after=|before=|tail=1&limit=`; with `before`/`tail`, `hasMore` means older events exist. */
export interface SessionEventsResponse {
  events: CrowEvent[];
  nextAfter: string | null;
  hasMore: boolean;
}

/** `GET /api/events?project=&limit=` */
export interface EventsResponse {
  cursor: string;
  events: CrowEvent[];
}

/** Why a lane refused or discarded a delivery (D3, D15). */
export type LaneRejection =
  | "unauthorized"
  | "unknown-engine"
  | "too-large"
  | "bad-request"
  | "unsupported-media-type"
  | "queue-overflow"
  | "unattributable";

/** In-memory counters of one engine's lane since server start (D15). */
export interface LaneCounters {
  lastReceivedAt: number | null;
  lastStoredAt: number | null;
  received: number;
  rejected: Partial<Record<LaneRejection, number>>;
}

/** `GET /api/stats` `lanes`: only the hook lane so far (F2a B2.T2; OTLP joins in B4.T2). */
export interface LanesStatus {
  /** Server start, epoch ms: the counters are in-memory. */
  since: number;
  engines: Record<string, { hook: LaneCounters }>;
}

/** `GET /api/stats` */
export interface StatsResponse {
  ingest: IngestStats;
  lanes: LanesStatus;
}

/** Shape of every REST error body, including the 409 `unknown-cursor` (D9). */
export interface ApiErrorResponse {
  error: string;
}

/** `event: reset` payload on `/api/stream` when a cursor is unknown (D9). */
export interface StreamResetPayload {
  reason: "unknown-cursor";
}
