/**
 * Synchronous REST handlers (design.md § REST, `apps/server/src/api.ts`).
 * Covers R25–R27, R33. Every response is JSON; errors are `{ error: string }`
 * with 400 for a malformed parameter, 404 for an unknown id, and 409
 * `unknown-cursor` for a well-formed but never-stored `after` (D9).
 *
 * `routeApi` assumes the caller (`server.ts`) already ran the request through
 * `checkRequest` (R28) — these handlers never see a rejected request.
 */
import type { Database } from "bun:sqlite";
import {
  currentCursor,
  getSessionDetail,
  listProjects,
  listRecentEvents,
  listSessionEvents,
  listSessions,
  localDay,
  stats,
} from "@crow/core";
import type {
  ApiErrorResponse,
  ClockFn,
  EventsResponse,
  ProjectsResponse,
  SessionDetailResponse,
  SessionEventsResponse,
  SessionsResponse,
  SessionStatus,
  StatsResponse,
} from "@crow/core";

/** Dependencies the REST handlers need, closed over by `routeApi`'s caller. */
export interface RestContext {
  db: Database;
  now: ClockFn;
  idleMinutes: number;
  backfillHours: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** Crockford base32, 26 chars — matches `createUlidFactory`'s output (packages/core/src/ulid.ts). */
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** `sha1(path).slice(0, 12)` (project-key.ts), or the reserved `unresolved` project (D8). Exported for `sse.ts`'s `project` filter, which validates the same shape. */
export const PROJECT_KEY_PATTERN = /^[0-9a-f]{12}$|^unresolved$/;

/** Distinguishes "absent" (`null`) from "present but malformed" for optional query params. */
const INVALID = Symbol("invalid-param");

/** Builds `{ error }` JSON error responses; exported so `sse.ts` can reject a malformed query the same way before the stream ever opens. */
export function jsonError(status: number, error: string): Response {
  const body: ApiErrorResponse = { error };
  return Response.json(body, { status });
}

function parseLimit(url: URL): number | typeof INVALID {
  const raw = url.searchParams.get("limit");
  if (raw === null) return DEFAULT_LIMIT;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= MAX_LIMIT ? n : INVALID;
}

function parseSince(url: URL, fallback: number): number | typeof INVALID {
  const raw = url.searchParams.get("since");
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : INVALID;
}

function parseProject(url: URL): string | null | typeof INVALID {
  const raw = url.searchParams.get("project");
  if (raw === null) return null;
  return PROJECT_KEY_PATTERN.test(raw) ? raw : INVALID;
}

function parseStatus(url: URL): SessionStatus | null | typeof INVALID {
  const raw = url.searchParams.get("status");
  if (raw === null) return null;
  return raw === "live" || raw === "idle" || raw === "ended" ? raw : INVALID;
}

function parseAfter(url: URL): string | null | typeof INVALID {
  const raw = url.searchParams.get("after");
  if (raw === null) return null;
  return ULID_PATTERN.test(raw) ? raw : INVALID;
}

/** `GET /api/projects?since=` (R25, R30). */
function handleProjects(url: URL, ctx: RestContext): Response {
  const since = parseSince(url, ctx.now() - ctx.backfillHours * 3_600_000);
  if (since === INVALID) return jsonError(400, "invalid-since");

  const body: ProjectsResponse = {
    cursor: currentCursor(ctx.db),
    idleMs: ctx.idleMinutes * 60_000,
    day: localDay(ctx.now()),
    projects: listProjects(ctx.db, since),
  };
  return Response.json(body);
}

/** `GET /api/sessions?project=&status=&since=&limit=` (R26). */
function handleSessions(url: URL, ctx: RestContext): Response {
  const project = parseProject(url);
  if (project === INVALID) return jsonError(400, "invalid-project");
  const status = parseStatus(url);
  if (status === INVALID) return jsonError(400, "invalid-status");
  const since = parseSince(url, 0);
  if (since === INVALID) return jsonError(400, "invalid-since");
  const limit = parseLimit(url);
  if (limit === INVALID) return jsonError(400, "invalid-limit");

  const body: SessionsResponse = {
    sessions: listSessions(ctx.db, { project, status, since, limit }),
  };
  return Response.json(body);
}

/** `GET /api/sessions/:id` (R26, R32). */
function handleSessionDetail(sessionId: string, ctx: RestContext): Response {
  const detail = getSessionDetail(ctx.db, sessionId);
  if (detail === null) return jsonError(404, "not-found");

  const body: SessionDetailResponse = {
    cursor: currentCursor(ctx.db),
    idleMs: ctx.idleMinutes * 60_000,
    session: detail.session,
    agents: detail.agents,
  };
  return Response.json(body);
}

/** `GET /api/sessions/:id/events?after=&limit=` (R27, R33). */
function handleSessionEvents(sessionId: string, url: URL, ctx: RestContext): Response {
  if (getSessionDetail(ctx.db, sessionId) === null) return jsonError(404, "not-found");

  const after = parseAfter(url);
  if (after === INVALID) return jsonError(400, "invalid-after");
  const limit = parseLimit(url);
  if (limit === INVALID) return jsonError(400, "invalid-limit");

  const page = listSessionEvents(ctx.db, sessionId, after, limit);
  if (page === null) return jsonError(409, "unknown-cursor"); // D9

  const body: SessionEventsResponse = page;
  return Response.json(body);
}

/** `GET /api/events?project=&limit=` (R31, R33 backfill). */
function handleEvents(url: URL, ctx: RestContext): Response {
  const project = parseProject(url);
  if (project === INVALID) return jsonError(400, "invalid-project");
  const limit = parseLimit(url);
  if (limit === INVALID) return jsonError(400, "invalid-limit");

  const body: EventsResponse = {
    cursor: currentCursor(ctx.db),
    events: listRecentEvents(ctx.db, { project, limit }),
  };
  return Response.json(body);
}

/** `GET /api/stats` (observability over R10, R13, R16). */
function handleStats(ctx: RestContext): Response {
  const body: StatsResponse = { ingest: stats(ctx.db) };
  return Response.json(body);
}

const SESSION_EVENTS_PATH = /^\/api\/sessions\/([^/]+)\/events$/;
const SESSION_DETAIL_PATH = /^\/api\/sessions\/([^/]+)$/;

/**
 * Routes an already-guarded `/api/*` request (except `/api/stream`, which
 * `server.ts` dispatches to `sse.ts` before reaching here) to its handler.
 */
export function routeApi(req: Request, url: URL, ctx: RestContext): Response {
  if (req.method !== "GET") return jsonError(405, "method-not-allowed");

  if (url.pathname === "/api/projects") return handleProjects(url, ctx);
  if (url.pathname === "/api/sessions") return handleSessions(url, ctx);
  if (url.pathname === "/api/events") return handleEvents(url, ctx);
  if (url.pathname === "/api/stats") return handleStats(ctx);

  const eventsMatch = SESSION_EVENTS_PATH.exec(url.pathname);
  if (eventsMatch !== null) return handleSessionEvents(eventsMatch[1]!, url, ctx);

  const detailMatch = SESSION_DETAIL_PATH.exec(url.pathname);
  if (detailMatch !== null) return handleSessionDetail(detailMatch[1]!, ctx);

  return jsonError(404, "not-found");
}
