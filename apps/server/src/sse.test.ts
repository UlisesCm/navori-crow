import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { migrate } from "@crow/core";
import type { BusListener, CrowEvent, IntervalScheduler } from "@crow/core";
import { createStreamResponse, StreamRegistry } from "./sse";
import type { EventPublisher } from "./sse";

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

/** A minimal publish/subscribe stand-in for `EventBus` (sse.ts only needs `subscribe`), with counters the tests assert on. */
class FakeBus implements EventPublisher {
  private readonly listeners = new Set<BusListener>();
  subscribeCount = 0;
  unsubscribeCount = 0;

  subscribe(listener: BusListener): () => void {
    this.subscribeCount++;
    this.listeners.add(listener);
    return () => {
      this.unsubscribeCount++;
      this.listeners.delete(listener);
    };
  }

  publish(events: readonly CrowEvent[]): void {
    for (const listener of this.listeners) listener(events);
  }
}

/** A `Server<unknown>` stand-in: `sse.ts` only calls `.timeout()`, once, to disable Bun's idle cutoff. */
function fakeServer(): Server<unknown> {
  const calls: Array<[Request, number]> = [];
  const server = {
    timeout: (req: Request, seconds: number) => {
      calls.push([req, seconds]);
    },
    timeoutCalls: calls,
  };
  return server as unknown as Server<unknown>;
}

function fakeIntervalScheduler(): {
  scheduleInterval: IntervalScheduler;
  tick: (ms: number) => Promise<void>;
  cancelledCount: () => number;
} {
  const registered: Array<{ fn: () => void | Promise<void>; ms: number; cancelled: boolean }> = [];
  return {
    scheduleInterval: (fn, ms) => {
      const entry = { fn, ms, cancelled: false };
      registered.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    tick: async (ms: number) => {
      for (const entry of registered) if (entry.ms === ms && !entry.cancelled) await entry.fn();
    },
    cancelledCount: () => registered.filter((e) => e.cancelled).length,
  };
}

function makeCrowEvent(overrides: Partial<CrowEvent> = {}): CrowEvent {
  return {
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    engine: "claude",
    source: "transcript",
    projectKey: "aaaaaaaaaaaa",
    projectPath: "/tmp/proj-a",
    sessionId: "s1",
    agentId: null,
    parentAgentId: null,
    kind: "prompt",
    ts: Date.now(),
    ...overrides,
  };
}

/** Reads frames off the stream's reader until at least `count` `\n\n`-terminated frames have arrived. */
async function readFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number,
): Promise<string[]> {
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: string[] = [];
  while (frames.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      frames.push(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
    }
  }
  return frames;
}

function streamUrl(query = ""): URL {
  return new URL(`http://127.0.0.1:7777/api/stream${query}`);
}

describe("createStreamResponse: live streaming (R23)", () => {
  test("headers, retry frame, and a matching live event reach the client", async () => {
    // Covers: R23
    const db = freshDb();
    const bus = new FakeBus();
    const registry = new StreamRegistry();
    const req = new Request("http://127.0.0.1:7777/api/stream");

    const res = createStreamResponse(req, fakeServer(), streamUrl(), {
      db,
      bus,
      scheduleInterval: fakeIntervalScheduler().scheduleInterval,
      registry,
    });

    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");

    const reader = res.body!.getReader();
    const [retryFrame] = await readFrames(reader, 1);
    expect(retryFrame).toBe("retry: 2000");
    expect(bus.subscribeCount).toBe(1);

    const event = makeCrowEvent();
    bus.publish([event]);

    const [frame] = await readFrames(reader, 1);
    expect(frame).toBe(`id: ${event.id}\ndata: ${JSON.stringify(event)}`);

    await reader.cancel();
  });

  test("project and session filters drop non-matching live events", async () => {
    // Covers: R23
    const db = freshDb();
    const bus = new FakeBus();
    const registry = new StreamRegistry();
    const req = new Request("http://127.0.0.1:7777/api/stream?project=aaaaaaaaaaaa&session=s1");

    const res = createStreamResponse(
      req,
      fakeServer(),
      streamUrl("?project=aaaaaaaaaaaa&session=s1"),
      {
        db,
        bus,
        scheduleInterval: fakeIntervalScheduler().scheduleInterval,
        registry,
      },
    );
    const reader = res.body!.getReader();
    await readFrames(reader, 1); // retry

    const wrongProject = makeCrowEvent({
      id: "01ARZ3NDEKTSV4RRFFQ69G5FA1",
      projectKey: "bbbbbbbbbbbb",
    });
    const wrongSession = makeCrowEvent({ id: "01ARZ3NDEKTSV4RRFFQ69G5FA2", sessionId: "s2" });
    const matching = makeCrowEvent({ id: "01ARZ3NDEKTSV4RRFFQ69G5FA3" });
    bus.publish([wrongProject, wrongSession, matching]);

    const [frame] = await readFrames(reader, 1);
    expect(frame).toContain(matching.id);
    expect(frame).not.toContain(wrongProject.id);
    expect(frame).not.toContain(wrongSession.id);

    await reader.cancel();
  });

  test("an injected heartbeat interval sends `: hb` without any real waiting", async () => {
    // Covers: R23
    const db = freshDb();
    const bus = new FakeBus();
    const registry = new StreamRegistry();
    const fake = fakeIntervalScheduler();
    const req = new Request("http://127.0.0.1:7777/api/stream");

    const res = createStreamResponse(req, fakeServer(), streamUrl(), {
      db,
      bus,
      scheduleInterval: fake.scheduleInterval,
      registry,
      heartbeatMs: 15_000,
    });
    const reader = res.body!.getReader();
    await readFrames(reader, 1); // retry

    await fake.tick(15_000);
    const [frame] = await readFrames(reader, 1);
    expect(frame).toBe(": hb");

    await reader.cancel();
  });

  test("cancelling the reader (client disconnect) unsubscribes from the bus and cancels the heartbeat", async () => {
    // Covers: R23
    const db = freshDb();
    const bus = new FakeBus();
    const registry = new StreamRegistry();
    const fake = fakeIntervalScheduler();
    const req = new Request("http://127.0.0.1:7777/api/stream");

    const res = createStreamResponse(req, fakeServer(), streamUrl(), {
      db,
      bus,
      scheduleInterval: fake.scheduleInterval,
      registry,
    });
    const reader = res.body!.getReader();
    await readFrames(reader, 1); // retry, so start() has finished subscribing

    expect(bus.unsubscribeCount).toBe(0);
    await reader.cancel();

    expect(bus.unsubscribeCount).toBe(1);
    expect(fake.cancelledCount()).toBe(1);
  });

  test("server.timeout(req, 0) is called so Bun's idle timeout never cuts the stream", () => {
    const db = freshDb();
    const bus = new FakeBus();
    const registry = new StreamRegistry();
    const req = new Request("http://127.0.0.1:7777/api/stream");
    const server = fakeServer() as unknown as { timeoutCalls: Array<[Request, number]> };

    createStreamResponse(req, server as unknown as Server<unknown>, streamUrl(), {
      db,
      bus,
      scheduleInterval: fakeIntervalScheduler().scheduleInterval,
      registry,
    });

    expect(server.timeoutCalls).toEqual([[req, 0]]);
  });

  test("registry.closeAll() closes every open stream and cancels its heartbeat", async () => {
    const db = freshDb();
    const bus = new FakeBus();
    const registry = new StreamRegistry();
    const fake = fakeIntervalScheduler();
    const req = new Request("http://127.0.0.1:7777/api/stream");

    const res = createStreamResponse(req, fakeServer(), streamUrl(), {
      db,
      bus,
      scheduleInterval: fake.scheduleInterval,
      registry,
    });
    const reader = res.body!.getReader();
    await readFrames(reader, 1); // retry

    registry.closeAll();

    const { done } = await reader.read();
    expect(done).toBe(true);
    expect(bus.unsubscribeCount).toBe(1);
    expect(fake.cancelledCount()).toBe(1);
  });

  test("an invalid `project` query param is rejected with 400 before any stream opens", () => {
    const db = freshDb();
    const bus = new FakeBus();
    const registry = new StreamRegistry();
    const req = new Request("http://127.0.0.1:7777/api/stream?project=not-a-key");

    const res = createStreamResponse(req, fakeServer(), streamUrl("?project=not-a-key"), {
      db,
      bus,
      scheduleInterval: fakeIntervalScheduler().scheduleInterval,
      registry,
    });

    expect(res.status).toBe(400);
    expect(bus.subscribeCount).toBe(0);
  });
});
