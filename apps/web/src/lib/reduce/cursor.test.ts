import { describe, expect, test } from "bun:test";
import type { CrowEvent, ProjectsResponse } from "@crow/core/types";
import { applyMany, applyOne, fromSnapshot } from "./cursor";
import { applyManyToProjects, applyToProjects, projectsFromSnapshot } from "./projects";

const DAY_TS = new Date(2026, 8, 29, 12, 0, 0).getTime();
const id = (n: number): string => `01J${String(n).padStart(23, "0")}`;

function usageEvent(n: number, cost = 1): CrowEvent {
  return {
    id: id(n),
    engine: "claude",
    source: "transcript",
    projectKey: "aaaaaaaaaaaa",
    projectPath: "/repo/demo",
    sessionId: "s1",
    agentId: null,
    parentAgentId: null,
    kind: "assistant.message",
    ts: DAY_TS,
    usage: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0, costUsd: cost },
  };
}

function snapshot(cursor: string, costUsd: number): ProjectsResponse {
  return {
    cursor,
    idleMs: 60_000,
    day: "2026-09-29",
    projects: [
      {
        key: "aaaaaaaaaaaa",
        path: "/repo/demo",
        name: "demo",
        engines: ["claude"],
        lastSeen: DAY_TS,
        today: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheCreation: 0,
          cacheCreation1h: 0,
          weightedTokens: 0,
          costUsd,
          unpricedUsages: 0,
        },
        lastError: null,
        sessions: [],
      },
    ],
  };
}

const cost = (s: ReturnType<typeof projectsFromSnapshot>): number =>
  s.value.projects["aaaaaaaaaaaa"]!.today.costUsd;

describe("cursor rule", () => {
  // Covers: R33
  test("id <= lastApplied is ignored and returns the same state", () => {
    const state = fromSnapshot(0, id(5));
    const step = (n: number, _e: { id: string }): number => n + 1;
    expect(applyOne(state, { id: id(5) }, step)).toBe(state);
    expect(applyOne(state, { id: id(3) }, step)).toBe(state);
    expect(applyOne(state, { id: id(6) }, step).value).toBe(1);
  });

  // Covers: R33
  test("null cursor applies everything and advances lastApplied", () => {
    const next = applyMany(fromSnapshot(0, null), [{ id: id(1) }, { id: id(2) }], (n) => n + 1);
    expect(next).toEqual({ lastApplied: id(2), value: 2 });
  });

  // Covers: R33
  test("paginated items with id > cursor count once, even when the stream repeats them", () => {
    let state = projectsFromSnapshot(snapshot(id(10), 5));
    const page = [usageEvent(9), usageEvent(10), usageEvent(11), usageEvent(12)];
    state = applyManyToProjects(state, page); // 9 and 10 are <= cursor: skipped
    expect(cost(state)).toBe(7);
    state = applyManyToProjects(state, page); // stream overlap: nothing new
    state = applyToProjects(state, usageEvent(12));
    expect(cost(state)).toBe(7);
    expect(state.lastApplied).toBe(id(12));
  });

  // Covers: R33
  test("reset discards state and reapplies the new snapshot without double counting", () => {
    let state = projectsFromSnapshot(snapshot(id(10), 5));
    state = applyToProjects(state, usageEvent(11));
    expect(cost(state)).toBe(6);

    // reset: the view throws the state away and rebuilds from a fresh snapshot,
    // which already includes event 11 (server-side total 6, cursor 11)
    state = projectsFromSnapshot(snapshot(id(11), 6));
    expect(cost(state)).toBe(6);
    state = applyToProjects(state, usageEvent(11)); // replayed by the new stream: ignored
    state = applyToProjects(state, usageEvent(12));
    expect(cost(state)).toBe(7);
  });
});
