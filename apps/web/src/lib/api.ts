/** Typed REST client (R33 backfill). Response types come from the server's own contract. */
import type {
  ApiErrorResponse,
  EventsResponse,
  ProjectsResponse,
  SessionDetailResponse,
  SessionEventsResponse,
} from "@crow/core/types";

/** Non-2xx response; `code` is the server's `{ error }` (e.g. `unknown-cursor` on 409, D9). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`${status} ${code}`);
    this.status = status;
    this.code = code;
  }
}

async function getJson<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
  const query = qs.toString();
  const res = await fetch(query === "" ? path : `${path}?${query}`);
  if (!res.ok) {
    let code = res.statusText;
    try {
      code = ((await res.json()) as ApiErrorResponse).error;
    } catch {
      // non-JSON error body: keep statusText
    }
    throw new ApiError(res.status, code);
  }
  return (await res.json()) as T;
}

/** `GET /api/projects` — home snapshot with its stream cursor. */
export const fetchProjects = (): Promise<ProjectsResponse> => getJson("/api/projects");

/** `GET /api/events?project=&limit=` — recent feed for a project (split, B6.T2). */
export const fetchEvents = (project: string, limit = 200): Promise<EventsResponse> =>
  getJson("/api/events", { project, limit });

/** `GET /api/sessions/:id` (detail, B6.T2). */
export const fetchSessionDetail = (id: string): Promise<SessionDetailResponse> =>
  getJson(`/api/sessions/${encodeURIComponent(id)}`);

/**
 * `GET /api/sessions/:id/events?tail=1|before=&limit=` — the latest page of a
 * session (`before` omitted) or the one right before `before`; ascending order,
 * `hasMore` = older events exist.
 */
export const fetchSessionEventsBackward = (
  id: string,
  before?: string,
  limit = 500,
): Promise<SessionEventsResponse> =>
  getJson(`/api/sessions/${encodeURIComponent(id)}/events`, {
    ...(before === undefined ? { tail: 1 } : { before }),
    limit,
  });
