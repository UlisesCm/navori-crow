/**
 * Routing of flattened OTLP records to an engine adapter (design.md D10, R16, R17).
 *
 * Routing is by the record's signature through `EngineAdapter.ownsOtel`, never by
 * `service.name` (Claude doesn't set it). Records nobody owns, or that the owner can't
 * attribute to a session, are counted and turned into ONE `ingest.error` per episode.
 */
import { createHash } from "node:crypto";
import type { BoundAdapter, FlatOtelRecord, PendingEvent } from "@crow/core";

/** One `ingest.error unattributable` per (`service.name` or "unknown") per this window (D10). */
export const UNATTRIBUTABLE_EPISODE_MS = 10 * 60_000;

/** Bound on remembered episode keys, so a stream of distinct service names can't grow memory. */
const MAX_EPISODES = 256;

/** Rate limiter for `ingest.error unattributable`: one per key per {@link UNATTRIBUTABLE_EPISODE_MS}. */
export class EpisodeLimiter {
  private readonly last = new Map<string, number>();

  /** `true` when `key` has no episode open at `now`; opens one as a side effect. */
  open(key: string, now: number): boolean {
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < UNATTRIBUTABLE_EPISODE_MS) return false;
    this.last.delete(key);
    this.last.set(key, now);
    if (this.last.size > MAX_EPISODES) {
      const oldest = this.last.keys().next();
      if (!oldest.done) this.last.delete(oldest.value);
    }
    return true;
  }
}

/** What routing a batch of records produced. */
export interface RouteResult {
  /** Events ready for `ingestEvents`, including the per-episode `ingest.error`s. */
  events: PendingEvent[];
  /** Records nobody owns or that couldn't be attributed to a session (R17). */
  unattributed: number;
  /** Records an adapter owns but maps to nothing (`otelIgnored`). */
  ignored: number;
  /** Records that produced at least one event. */
  mapped: number;
}

const OTLP_POS = { path: "otlp", offset: 0, line: 0 } as const;

interface Episode {
  engine: string;
  session: string;
  detail: string;
}

function unattributableError(ep: Episode, service: string, now: number): PendingEvent {
  const lineHash = createHash("sha1").update(`unattributable\n${service}\n${now}`).digest("hex");
  return {
    engine: ep.engine,
    source: "otel",
    lineHash,
    part: "e0",
    pos: OTLP_POS,
    event: {
      sessionId: ep.session,
      agentId: null,
      parentAgentId: null,
      kind: "ingest.error",
      ts: now,
      // No cwd on purpose: the project stays `unresolved`, never a real one (D8, R17).
      error: { message: ep.detail.slice(0, 1024), reason: "unattributable" },
    },
  };
}

/**
 * Routes `records` through the adapters' `ownsOtel`/`fromOtel`. Pure apart from the `limiter`
 * it updates; the caller queues `events` and answers the request without waiting for storage.
 */
export function routeOtel(
  records: readonly FlatOtelRecord[],
  adapters: readonly BoundAdapter[],
  limiter: EpisodeLimiter,
  now: number,
): RouteResult {
  const out: RouteResult = { events: [], unattributed: 0, ignored: 0, mapped: 0 };
  const episodes = new Map<string, Episode>();

  const unattributable = (
    record: FlatOtelRecord,
    owner: BoundAdapter | null,
    why: string,
  ): void => {
    out.unattributed++;
    const service = record.service ?? "unknown";
    if (episodes.has(service)) return;
    episodes.set(service, {
      engine: owner?.id ?? "otel",
      session: owner === null ? "unattributed" : "unknown",
      detail: `${why} (service: ${service.slice(0, 64)})`,
    });
  };

  for (const record of records) {
    const owner = adapters.find((a) => a.ownsOtel?.(record) === true) ?? null;
    if (owner === null || owner.fromOtel === undefined) {
      unattributable(record, null, "OTLP record not owned by any engine");
      continue;
    }
    const mapped = owner.fromOtel(record);
    if (!mapped.ok) {
      unattributable(record, owner, mapped.detail ?? `${owner.id} record without a session`);
      continue;
    }
    if (mapped.events.length === 0) {
      out.ignored++;
      continue;
    }
    out.mapped++;
    mapped.events.forEach((event, i) => {
      out.events.push({
        engine: owner.id,
        source: "otel",
        lineHash: record.hash,
        part: String(i),
        pos: OTLP_POS,
        event,
      });
    });
  }

  for (const [service, ep] of episodes) {
    if (limiter.open(service, now)) out.events.push(unattributableError(ep, service, now));
  }
  return out;
}
