/**
 * `GET /api/stream` (design.md § SSE, D13). Covers R23, R24.
 *
 * Ordering that guarantees no gap and no duplicate on reconnect (D13):
 *   1. subscribe to the bus in buffer mode (nothing is sent yet);
 *   2. paginated replay of stored events with `id > cursor`, yielding the
 *      event loop between pages;
 *   3. flush the buffer, skipping ids the replay already sent;
 *   4. go live — subsequent bus events are sent as they arrive.
 *
 * `server.ts` dispatches `/api/stream` here before `api.ts` ever sees it.
 */
import type { Server } from "bun";
import type { Database } from "bun:sqlite";
import { hasEvent, listEventsAfter } from "@crow/core";
import type { BusListener, CrowEvent, IntervalScheduler, StreamResetPayload } from "@crow/core";
import { jsonError, PROJECT_KEY_PATTERN } from "./api";

const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_PAGE_SIZE = 500;
/** A queued-but-unsent backlog this deep means the client can't keep up; close and let it reconnect with `Last-Event-ID` (D13). */
const BACKPRESSURE_FLOOR = -1000;

/**
 * Tracks every open `/api/stream` response so `AppHandle.stop()` can close
 * them (and their heartbeats) instead of leaving dangling timers/sockets.
 */
export class StreamRegistry {
  private readonly closers = new Set<() => void>();

  /** Registers `close`; returns a function that unregisters it (called once the stream ends on its own). */
  register(close: () => void): () => void {
    this.closers.add(close);
    return () => this.closers.delete(close);
  }

  /** Force-closes every currently open stream. Idempotent per stream (each `close` cleans up once). */
  closeAll(): void {
    for (const close of [...this.closers]) close();
    this.closers.clear();
  }
}

/** The one `EventBus` method `sse.ts` needs — narrowed for testability (a fake publisher needs no store/DB machinery). */
export interface EventPublisher {
  subscribe(listener: BusListener): () => void;
}

/** Dependencies `createStreamResponse` needs, closed over by `app.ts`. */
export interface StreamContext {
  db: Database;
  bus: EventPublisher;
  scheduleInterval: IntervalScheduler;
  registry: StreamRegistry;
  /** Interval between `: hb` comments (R23). Default 15 000 ms. */
  heartbeatMs?: number;
  /** Events per replay page (D13). Default 500; tests shrink this to force multiple pages. */
  pageSize?: number;
  /** Yields the event loop between replay pages (D13's "con `await` entre páginas"). Default a microtask tick. */
  nextTick?: () => Promise<void>;
}

function eventFrame(event: CrowEvent): string {
  return `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** `true` if every raw `project` query value is a well-formed project key (D8/D9's `unresolved` included). */
function projectsAreValid(projects: readonly string[]): boolean {
  return projects.every((p) => PROJECT_KEY_PATTERN.test(p));
}

/**
 * Builds the `GET /api/stream` response: validates query params and the
 * cursor synchronously (so a malformed request never opens a stream), then
 * returns a `text/event-stream` `Response` backed by a `ReadableStream` that
 * runs the subscribe → replay → flush → live sequence in its `start`.
 */
export function createStreamResponse(
  req: Request,
  server: Server<unknown>,
  url: URL,
  ctx: StreamContext,
): Response {
  const projects = url.searchParams.getAll("project");
  if (!projectsAreValid(projects)) return jsonError(400, "invalid-project");
  const sessionId = url.searchParams.get("session");

  // `Last-Event-ID` takes precedence over `after` (D13).
  const cursor = req.headers.get("Last-Event-ID") ?? url.searchParams.get("after");

  const heartbeatMs = ctx.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const pageSize = ctx.pageSize ?? DEFAULT_PAGE_SIZE;
  const nextTick = ctx.nextTick ?? (() => Promise.resolve());
  const encoder = new TextEncoder();

  function matches(event: CrowEvent): boolean {
    if (projects.length > 0 && !projects.includes(event.projectKey)) return false;
    if (sessionId !== null && event.sessionId !== sessionId) return false;
    return true;
  }

  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let cancelHeartbeat: (() => void) | null = null;
  let unregister: (() => void) | null = null;

  /** Tears down the subscription/timer/registry entry. Safe to call more than once. */
  function cleanup(): void {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    cancelHeartbeat?.();
    unregister?.();
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function closeStream(): void {
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed by the runtime (client disconnected) — nothing to do.
        }
      }

      /** Enqueues `frame`; closes the stream on a full queue or a slow-consumer backlog (D13). Returns whether it was actually sent. */
      function send(frame: string): boolean {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          closeStream();
          return false;
        }
        if ((controller.desiredSize ?? 0) < BACKPRESSURE_FLOOR) {
          closeStream();
          return false;
        }
        return true;
      }

      if (cursor !== null && !hasEvent(ctx.db, cursor)) {
        // Unknown cursor (D9): DB recreated, clock went back, or a foreign id. Reset and stop.
        const payload: StreamResetPayload = { reason: "unknown-cursor" };
        send(`event: reset\ndata: ${JSON.stringify(payload)}\n\n`);
        closeStream();
        return;
      }

      send("retry: 2000\n\n");

      // 1. Subscribe to the bus FIRST, buffering everything that matches while
      //    still in replay mode (D13 step 1).
      let live = false;
      const buffer: CrowEvent[] = [];
      unsubscribe = ctx.bus.subscribe((events) => {
        for (const event of events) {
          if (!matches(event)) continue;
          if (live) send(eventFrame(event));
          else buffer.push(event);
        }
      });

      // 2. Paginated replay of stored events with `id > cursor` (D13 step 2).
      //    No cursor at all means "live only" (design's SSE semantics): skip replay entirely.
      let lastSent = cursor;
      if (cursor !== null) {
        for (;;) {
          const page = listEventsAfter(ctx.db, {
            after: lastSent,
            projects,
            sessionId,
            limit: pageSize,
          });
          for (const event of page) {
            send(eventFrame(event));
            lastSent = event.id;
          }
          if (page.length < pageSize) break;
          await nextTick();
        }
      }

      // 3. Flush the buffer, skipping ids the replay already sent (D13 step 3).
      for (const event of buffer) {
        if (lastSent !== null && event.id <= lastSent) continue;
        send(eventFrame(event));
        lastSent = event.id;
      }
      buffer.length = 0;

      // 4. Go live (D13 step 4).
      live = true;

      cancelHeartbeat = ctx.scheduleInterval(() => {
        send(": hb\n\n");
      }, heartbeatMs);
      unregister = ctx.registry.register(closeStream);
    },
    cancel() {
      // The client disconnected or aborted; the runtime already tore down the controller.
      cleanup();
    },
  });

  // Bun's default idle timeout would otherwise cut a long-lived stream (D13).
  server.timeout(req, 0);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
