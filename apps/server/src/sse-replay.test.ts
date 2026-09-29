/**
 * `sse-replay.test.ts` — design.md § Testing strategy, cases (a)-(f):
 * reconnection, the replay/live race, header-over-`after` precedence, a
 * recreated DB, a clock injected backward with the DB intact, and the REST
 * 409 on an unknown `after`. Covers R24.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { createUlidFactory, ingestBatch, migrate } from "@crow/core";
import type {
  BusListener,
  CrowEvent,
  IngestBatchDeps,
  PartialCrowEvent,
  PendingEvent,
} from "@crow/core";
import { routeApi } from "./api";
import type { RestContext } from "./api";
import { createStreamResponse, StreamRegistry } from "./sse";
import type { EventPublisher } from "./sse";

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

class FakeBus implements EventPublisher {
  private readonly listeners = new Set<BusListener>();
  subscribe(listener: BusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  publish(events: readonly CrowEvent[]): void {
    for (const listener of this.listeners) listener(events);
  }
}

function fakeServer(): Server<unknown> {
  return { timeout: () => {} } as unknown as Server<unknown>;
}

function makeEvent(overrides: Partial<PartialCrowEvent> = {}): PartialCrowEvent {
  return {
    sessionId: "s1",
    agentId: null,
    parentAgentId: null,
    kind: "prompt",
    ts: Date.now(),
    text: "hi",
    cwd: "/tmp/proj-a",
    ...overrides,
  };
}

function makePending(
  overrides: Partial<PendingEvent> = {},
  eventOverrides: Partial<PartialCrowEvent> = {},
): PendingEvent {
  return {
    engine: "claude",
    source: "transcript",
    lineHash: `hash-${Math.random()}`,
    part: "0",
    pos: { path: "/tmp/f.jsonl", offset: 0, line: 1 },
    event: makeEvent(eventOverrides),
    ...overrides,
  };
}

/** Ingests one event and returns it (as stored, with its assigned `id`). */
function ingestOne(
  db: Database,
  deps: IngestBatchDeps,
  eventOverrides: Partial<PartialCrowEvent>,
): CrowEvent {
  const stored = ingestBatch(db, deps, {
    path: "/tmp/f.jsonl",
    inode: "1",
    nextOffset: 1,
    state: null,
    events: [makePending({ lineHash: `h-${Math.random()}` }, eventOverrides)],
  });
  return stored[0]!;
}

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

function connect(
  db: Database,
  bus: EventPublisher,
  opts: {
    lastEventId?: string;
    after?: string;
    pageSize?: number;
    nextTick?: () => Promise<void>;
  } = {},
): { reader: ReadableStreamDefaultReader<Uint8Array>; registry: StreamRegistry } {
  const registry = new StreamRegistry();
  const search = opts.after !== undefined ? `?after=${opts.after}` : "";
  const req = new Request(`http://127.0.0.1:7777/api/stream${search}`, {
    headers: opts.lastEventId !== undefined ? { "Last-Event-ID": opts.lastEventId } : {},
  });
  const res = createStreamResponse(req, fakeServer(), new URL(req.url), {
    db,
    bus,
    scheduleInterval: () => () => {},
    registry,
    pageSize: opts.pageSize,
    nextTick: opts.nextTick,
  });
  return { reader: res.body!.getReader(), registry };
}

describe("sse-replay (R24)", () => {
  test("(a) reconnection with Last-Event-ID replays everything after it, then goes live", async () => {
    // Covers: R24
    const db = freshDb();
    const bus = new FakeBus();
    const deps: IngestBatchDeps = {
      nextId: createUlidFactory("00000000000000000000000000", () => Date.now()),
      now: () => Date.now(),
      idleMs: 300_000,
    };
    const e1 = ingestOne(db, deps, { text: "one" });
    const e2 = ingestOne(db, deps, { text: "two" });
    const e3 = ingestOne(db, deps, { text: "three" });

    const { reader } = connect(db, bus, { lastEventId: e1.id });
    const frames = await readFrames(reader, 3); // retry + e2 + e3
    expect(frames[1]).toContain(e2.id);
    expect(frames[2]).toContain(e3.id);

    const e4 = ingestOne(db, deps, { text: "four" });
    bus.publish([e4]);
    const [liveFrame] = await readFrames(reader, 1);
    expect(liveFrame).toContain(e4.id);

    await reader.cancel();
  });

  test("(b) an event ingested during the paginated replay arrives exactly once", async () => {
    // Covers: R24
    const db = freshDb();
    const bus = new FakeBus();
    const deps: IngestBatchDeps = {
      nextId: createUlidFactory("00000000000000000000000000", () => Date.now()),
      now: () => Date.now(),
      idleMs: 300_000,
    };
    const e1 = ingestOne(db, deps, { text: "one" });
    const e2 = ingestOne(db, deps, { text: "two" });

    let racedInjected = false;
    let raceEvent: CrowEvent | null = null;
    const { reader } = connect(db, bus, {
      lastEventId: e1.id,
      pageSize: 1, // forces a page per event, with an `await nextTick()` in between
      nextTick: async () => {
        if (!racedInjected) {
          racedInjected = true;
          // Committed to the store (so a later replay page's own SQL query would
          // also see it) AND published on the bus (so the buffer sees it too) —
          // exactly the race the buffer's `id > lastSent` flush guards against.
          raceEvent = ingestOne(db, deps, { text: "race" });
          bus.publish([raceEvent]);
        }
      },
    });

    const frames = await readFrames(reader, 3); // retry + e2 + race
    expect(frames[1]).toContain(e2.id);
    expect(raceEvent).not.toBeNull();
    const raceId = (raceEvent as unknown as CrowEvent).id;
    // Each frame that carries the event mentions its id twice (the SSE `id:`
    // line and the JSON body's own `id` field) — count *frames*, not raw
    // substring hits, so a single frame doesn't look like a duplicate.
    const framesCarryingIt = frames.filter((f) => f.includes(raceId)).length;
    expect(framesCarryingIt).toBe(1);

    await reader.cancel();
  });

  test("(c) `Last-Event-ID` wins over `after` when both are present", async () => {
    // Covers: R24
    const db = freshDb();
    const bus = new FakeBus();
    const deps: IngestBatchDeps = {
      nextId: createUlidFactory("00000000000000000000000000", () => Date.now()),
      now: () => Date.now(),
      idleMs: 300_000,
    };
    const e1 = ingestOne(db, deps, { text: "one" });
    const e2 = ingestOne(db, deps, { text: "two" });
    const e3 = ingestOne(db, deps, { text: "three" });

    // `after=e1` would replay e2+e3; the header (e2) must win and only replay e3.
    const { reader } = connect(db, bus, { lastEventId: e2.id, after: e1.id });
    const frames = await readFrames(reader, 2); // retry + e3
    expect(frames[1]).toContain(e3.id);
    expect(frames[1]).not.toContain(e2.id);

    await reader.cancel();
  });

  test("(d) a recreated DB with a foreign Last-Event-ID gets `event: reset` and closes", async () => {
    // Covers: R24
    const oldDb = freshDb();
    const deps: IngestBatchDeps = {
      nextId: createUlidFactory("00000000000000000000000000", () => Date.now()),
      now: () => Date.now(),
      idleMs: 300_000,
    };
    const staleEvent = ingestOne(oldDb, deps, { text: "from the old db" });
    oldDb.close();

    const recreatedDb = freshDb(); // same "port", a brand-new empty store
    const bus = new FakeBus();
    const { reader } = connect(recreatedDb, bus, { lastEventId: staleEvent.id });

    const [frame, done] = await Promise.all([
      readFrames(reader, 1),
      reader.read().then((r) => r), // will resolve after reset closes the stream
    ]);
    expect(frame[0]).toBe(`event: reset\ndata: {"reason":"unknown-cursor"}`);
    expect(done.done).toBe(true);
  });

  test("(e) a clock injected backward with the DB intact still delivers newer ids on replay", async () => {
    // Covers: R24
    const db = freshDb();
    const forwardNow = Date.now();
    const forwardDeps: IngestBatchDeps = {
      nextId: createUlidFactory("00000000000000000000000000", () => forwardNow),
      now: () => forwardNow,
      idleMs: 300_000,
    };
    const e1 = ingestOne(db, forwardDeps, { text: "one" });

    // The wall clock goes backward, but the factory is seeded with the last
    // assigned id (D9's rule), so it keeps issuing strictly greater ids.
    const backwardNow = forwardNow - 60_000;
    const backwardDeps: IngestBatchDeps = {
      nextId: createUlidFactory(e1.id, () => backwardNow),
      now: () => backwardNow,
      idleMs: 300_000,
    };
    const e2 = ingestOne(db, backwardDeps, { text: "two" });
    expect(e2.id > e1.id).toBe(true);

    const bus = new FakeBus();
    const { reader } = connect(db, bus, { lastEventId: e1.id });
    const frames = await readFrames(reader, 2); // retry + e2
    expect(frames[1]).toContain(e2.id);

    await reader.cancel();
  });

  test("(f) an unknown `after` on GET /api/sessions/:id/events returns 409 unknown-cursor", () => {
    // Covers: R24
    const db = freshDb();
    const deps: IngestBatchDeps = {
      nextId: createUlidFactory("00000000000000000000000000", () => Date.now()),
      now: () => Date.now(),
      idleMs: 300_000,
    };
    ingestOne(db, deps, { text: "one" });

    const ctx: RestContext = { db, now: () => Date.now(), idleMinutes: 5, backfillHours: 24 };
    const req = new Request(
      "http://127.0.0.1:7777/api/sessions/claude:s1/events?after=00000000000000000000000000",
    );
    const res = routeApi(req, new URL(req.url), ctx);

    expect(res.status).toBe(409);
  });
});
