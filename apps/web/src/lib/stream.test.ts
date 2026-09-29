import { describe, expect, test } from "bun:test";
import type { CrowEvent } from "@crow/core/types";
import {
  backoffDelay,
  openStream,
  Restarter,
  streamUrl,
  type EventSourceLike,
  type RestartTimers,
} from "./stream";

/** Manual timers: `fire()` runs the pending callback. */
function fakeTimers(): RestartTimers & { delays: number[]; fire: () => void } {
  let fn: (() => void) | null = null;
  const delays: number[] = [];
  return {
    delays,
    set: (f, ms) => {
      fn = f;
      delays.push(ms);
      return 1;
    },
    clear: () => {
      fn = null;
    },
    fire: () => {
      const f = fn;
      fn = null;
      f?.();
    },
  };
}

describe("restart backoff", () => {
  // Covers: R33
  test("delays grow exponentially and are capped", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 10].map((n) => backoffDelay(n))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
  });

  // Covers: R33
  test("keeps a single pending restart, escalates, and resets on success", () => {
    const timers = fakeTimers();
    let runs = 0;
    const r = new Restarter(() => runs++, timers);
    r.schedule();
    r.schedule(); // a storm of errors queues only one restart
    expect(timers.delays).toEqual([1_000]);
    timers.fire();
    expect(runs).toBe(1);
    r.schedule(); // still failing: longer wait
    expect(timers.delays).toEqual([1_000, 2_000]);
    timers.fire();
    r.reset(); // stream opened fine
    r.schedule();
    expect(timers.delays).toEqual([1_000, 2_000, 1_000]);
  });

  // Covers: R33
  test("cancel drops the pending restart", () => {
    const timers = fakeTimers();
    let runs = 0;
    const r = new Restarter(() => runs++, timers);
    r.schedule();
    r.cancel();
    timers.fire();
    expect(runs).toBe(0);
    r.schedule(); // can be scheduled again after cancel
    expect(timers.delays).toHaveLength(2);
  });
});

/** Fake `EventSource`: records itself so the test can drive its callbacks. */
class FakeSource implements EventSourceLike {
  static last: FakeSource | null = null;
  readyState = 1;
  closed = false;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent<string>) => void) | null = null;
  private readonly listeners = new Map<string, () => void>();

  constructor(readonly url: string) {
    FakeSource.last = this;
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, listener);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  emit(type: string): void {
    this.listeners.get(type)?.();
  }
}

describe("openStream wiring", () => {
  const frame = (id: string): MessageEvent<string> =>
    ({ data: JSON.stringify({ id }) }) as MessageEvent<string>;

  // Covers: R33
  test("open marks connected and frames are applied; malformed frames are skipped", () => {
    const events: string[] = [];
    const conn: boolean[] = [];
    openStream(
      {
        after: "A",
        onEvent: (e: CrowEvent) => events.push(e.id),
        onReset: () => {},
        onConnection: (c) => conn.push(c),
      },
      FakeSource,
    );
    const src = FakeSource.last!;
    expect(src.url).toBe("/api/stream?after=A");
    src.onopen?.(new Event("open"));
    src.onmessage?.(frame("B"));
    src.onmessage?.({ data: "{not json" } as MessageEvent<string>);
    src.onmessage?.(frame("C"));
    expect(conn).toEqual([true]);
    expect(events).toEqual(["B", "C"]);
  });

  // Covers: R33
  test("reset closes the source and asks the view to re-snapshot", () => {
    let resets = 0;
    const conn: boolean[] = [];
    openStream(
      { onEvent: () => {}, onReset: () => resets++, onConnection: (c) => conn.push(c) },
      FakeSource,
    );
    const src = FakeSource.last!;
    src.emit("reset");
    expect(src.closed).toBe(true);
    expect(resets).toBe(1);
    expect(conn).toEqual([false]);
  });

  // Covers: R33
  test("a CLOSED source fires onDead and the restarter schedules a restart; CONNECTING does not", () => {
    const timers = fakeTimers();
    let restarts = 0;
    const restarter = new Restarter(() => restarts++, timers);
    let dead = 0;
    openStream(
      {
        onEvent: () => {},
        onReset: () => {},
        onDead: () => {
          dead++;
          restarter.schedule();
        },
      },
      FakeSource,
    );
    const src = FakeSource.last!;
    src.readyState = 0; // CONNECTING: the browser retries by itself
    src.onerror?.(new Event("error"));
    expect(dead).toBe(0);
    src.readyState = 2; // CLOSED: non-200, no native retry
    src.onerror?.(new Event("error"));
    expect(dead).toBe(1);
    expect(timers.delays).toEqual([1_000]);
    timers.fire();
    expect(restarts).toBe(1);
  });
});

describe("streamUrl", () => {
  // Covers: R33
  test("builds repeatable project params, session and cursor", () => {
    expect(streamUrl({})).toBe("/api/stream");
    expect(streamUrl({ projects: ["a", "b"], after: "X" })).toBe(
      "/api/stream?project=a&project=b&after=X",
    );
  });

  // Covers: R33
  test("an empty-store cursor is not sent (it would be an unknown cursor, i.e. a reset loop)", () => {
    expect(streamUrl({ after: "" })).toBe("/api/stream");
  });
});
