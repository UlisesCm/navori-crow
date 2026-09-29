import { describe, expect, test } from "bun:test";
import { backoffDelay, Restarter, streamUrl, type RestartTimers } from "./stream";

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
