/**
 * Single `EventSource` on `/api/stream` (D13, D16). Resumption after a network
 * drop is native: the browser resends `Last-Event-ID`. `after` only seeds the
 * first connection. On `event: reset` (unknown cursor, D9) the source is
 * closed and `onReset` fires so the view can re-snapshot and reopen.
 */
import type { CrowEvent } from "@crow/core/types";

export interface StreamOptions {
  /** Project keys to filter by (repeatable `project` param). */
  projects?: readonly string[];
  session?: string;
  /** Cursor of the snapshot the view just rendered. */
  after?: string;
  onEvent: (event: CrowEvent) => void;
  /** Server said the cursor is unknown; the stream is already closed. */
  onReset: () => void;
  onConnection?: (connected: boolean) => void;
}

export interface StreamHandle {
  close: () => void;
}

export function streamUrl(o: Pick<StreamOptions, "projects" | "session" | "after">): string {
  const qs = new URLSearchParams();
  for (const p of o.projects ?? []) qs.append("project", p);
  if (o.session !== undefined) qs.set("session", o.session);
  if (o.after !== undefined) qs.set("after", o.after);
  const query = qs.toString();
  return query === "" ? "/api/stream" : `/api/stream?${query}`;
}

export function openStream(o: StreamOptions): StreamHandle {
  const source = new EventSource(streamUrl(o));
  source.onopen = () => o.onConnection?.(true);
  source.onerror = () => o.onConnection?.(false); // EventSource retries by itself
  source.onmessage = (msg: MessageEvent<string>) => {
    try {
      o.onEvent(JSON.parse(msg.data) as CrowEvent);
    } catch {
      // malformed frame: skip it, the next one still carries its own id
    }
  };
  source.addEventListener("reset", () => {
    source.close();
    o.onConnection?.(false);
    o.onReset();
  });
  return { close: () => source.close() };
}
