/**
 * Shared e2e plumbing: a temp `CROW_HOME` + fake Claude root, the real
 * `startApp`, synthetic transcript lines, and an SSE reader. Nothing here
 * touches a real `~/.claude` or `~/.codex`.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CrowConfig, CrowEvent, EventsResponse } from "@crow/core";
import { startApp } from "../apps/server/src/app";
import type { AppHandle, StartAppOptions } from "../apps/server/src/app";

export interface Sandbox {
  dir: string;
  config: CrowConfig;
  /** Absolute path of the one transcript the tests write. */
  transcript: string;
  cleanup(): void;
}

export const SESSION_ID = "e2e-session-1";

/** Fresh sandbox; the `projects/<slug>` dir exists so the tailer has a root to watch. */
export function makeSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "crow-e2e-"));
  const projectDir = join(dir, "claude", "projects", "-tmp-crow-e2e-proj");
  mkdirSync(projectDir, { recursive: true });
  return {
    dir,
    transcript: join(projectDir, `${SESSION_ID}.jsonl`),
    config: {
      crowHome: join(dir, "home"),
      crowPort: 0,
      backfillHours: 24,
      idleMinutes: 5,
      allowedOrigins: [],
      claudeConfigDir: join(dir, "claude"),
      codexHome: join(dir, "codex"),
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** One user-prompt transcript line; `text` doubles as a unique marker. */
export function promptLine(text: string, ts: number): string {
  return `${JSON.stringify({
    type: "user",
    uuid: `u-${text}`,
    timestamp: new Date(ts).toISOString(),
    cwd: "/tmp/crow-e2e/proj",
    sessionId: SESSION_ID,
    message: { role: "user", content: text },
  })}\n`;
}

export function writeTranscript(path: string, lines: readonly string[]): void {
  writeFileSync(path, lines.join(""));
}

export function appendTranscript(path: string, line: string): void {
  appendFileSync(path, line);
}

export function start(sandbox: Sandbox, opts: StartAppOptions = {}): Promise<AppHandle> {
  return startApp(sandbox.config, opts);
}

export function baseUrl(handle: AppHandle): string {
  return `http://127.0.0.1:${handle.server.port}`;
}

export async function getEvents(handle: AppHandle): Promise<EventsResponse> {
  const res = await fetch(`${baseUrl(handle)}/api/events?limit=500`);
  return (await res.json()) as EventsResponse;
}

/** Prompt texts stored so far, in `id` order. */
export function promptTexts(events: readonly CrowEvent[]): string[] {
  return events
    .filter((e) => e.kind === "prompt")
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((e) => e.text ?? "");
}

/** Polls `fn` until it returns a truthy value or `timeoutMs` elapses (then throws). */
export async function waitFor<T>(
  fn: () => Promise<T | false | null | undefined>,
  what: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

/** Minimal SSE client over `/api/stream`: collects each `data:` frame as a `CrowEvent`. */
export class SseClient {
  private readonly controller = new AbortController();
  private readonly waiters: Array<{ match: (e: CrowEvent) => boolean; resolve: () => void }> = [];
  readonly received: CrowEvent[] = [];

  private constructor() {}

  static async open(handle: AppHandle): Promise<SseClient> {
    const client = new SseClient();
    const res = await fetch(`${baseUrl(handle)}/api/stream`, { signal: client.controller.signal });
    if (!res.body) throw new Error("no SSE body");
    void client.pump(res.body);
    return client;
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of body) {
        buf += decoder.decode(chunk, { stream: true });
        let cut = buf.indexOf("\n\n");
        while (cut !== -1) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const data = frame.split("\n").find((l) => l.startsWith("data: "));
          if (data && !frame.startsWith("event:")) this.deliver(JSON.parse(data.slice(6)));
          cut = buf.indexOf("\n\n");
        }
      }
    } catch {
      // aborted on close()
    }
  }

  private deliver(event: CrowEvent): void {
    this.received.push(event);
    for (const w of [...this.waiters]) {
      if (w.match(event)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve();
      }
    }
  }

  /** Resolves once an event matching `match` arrives (or already has); rejects on timeout. */
  next(match: (e: CrowEvent) => boolean, timeoutMs = 10_000): Promise<void> {
    if (this.received.some(match)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for SSE event")),
        timeoutMs,
      );
      this.waiters.push({
        match,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }

  close(): void {
    this.controller.abort();
  }
}
