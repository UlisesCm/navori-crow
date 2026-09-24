import { describe, expect, test } from "bun:test";
import { EventBus } from "./bus";
import type { CrowEvent } from "./crow-event";

function fakeEvent(id: string): CrowEvent {
  return {
    id,
    engine: "claude",
    source: "transcript",
    projectKey: "p1",
    projectPath: "/tmp/p1",
    sessionId: "s1",
    agentId: null,
    parentAgentId: null,
    kind: "prompt",
    ts: 1,
  };
}

describe("EventBus", () => {
  test("delivers published events, in order, to every subscriber", () => {
    // Covers: R22
    const bus = new EventBus();
    const received: CrowEvent[][] = [];
    bus.subscribe((events) => received.push([...events]));

    const batch = [fakeEvent("a"), fakeEvent("b")];
    bus.publish(batch);

    expect(received).toEqual([batch]);
  });

  test("an unsubscribed listener stops receiving events", () => {
    // Covers: R22
    const bus = new EventBus();
    let count = 0;
    const unsubscribe = bus.subscribe(() => count++);

    bus.publish([fakeEvent("a")]);
    unsubscribe();
    bus.publish([fakeEvent("b")]);

    expect(count).toBe(1);
  });

  test("publishing an empty batch notifies nobody", () => {
    // Covers: R22
    const bus = new EventBus();
    let called = false;
    bus.subscribe(() => (called = true));

    bus.publish([]);

    expect(called).toBe(false);
  });

  test("a second subscriber added after publish does not see past events", () => {
    // Covers: R22 — publish is synchronous fan-out, not a replay log
    const bus = new EventBus();
    bus.publish([fakeEvent("a")]);

    const received: CrowEvent[][] = [];
    bus.subscribe((events) => received.push([...events]));
    bus.publish([fakeEvent("b")]);

    expect(received).toEqual([[fakeEvent("b")]]);
  });
});
