import { describe, expect, test } from "bun:test";
import type { CrowEvent, SessionDetailResponse } from "@crow/core/types";
import { applyManyToHooks, applyToHooks, hooksFromSnapshot } from "./hooks";

const id = (n: number): string => `01J${String(n).padStart(23, "0")}`;

function hook(n: number, over: Partial<NonNullable<CrowEvent["hook"]>> = {}): CrowEvent {
  return {
    id: id(n),
    engine: "claude",
    source: "hook",
    projectKey: "aaaaaaaaaaaa",
    projectPath: "/repo/demo",
    sessionId: "s1",
    agentId: null,
    parentAgentId: null,
    kind: "hook",
    ts: 1_000 * n,
    hook: { name: "lint", phase: "PostToolUse", ms: 100, ...over },
  };
}

function snap(over: Partial<SessionDetailResponse> = {}): SessionDetailResponse {
  return { cursor: id(5), hooks: [], hooksFrom: null, ...over } as SessionDetailResponse;
}

describe("hooks reducer (R30)", () => {
  test("empty snapshot stays empty (empty state)", () => {
    // Covers: R30
    const s = hooksFromSnapshot(snap());
    expect(s.value.hooks).toEqual([]);
    expect(s.value.hooksFrom).toBeNull();
  });

  test("folds only events after the snapshot cursor onto the aggregate", () => {
    // Covers: R30
    const base = snap({
      hooks: [{ name: "lint", runs: 2, totalMs: 300, maxMs: 200, blocking: 1 }],
      hooksFrom: 500,
    });
    const s = applyManyToHooks(hooksFromSnapshot(base), [
      hook(4, { ms: 900 }), // already in the snapshot
      hook(6, { ms: 50, blocking: true }),
      hook(7, { name: "fmt", ms: 10 }),
    ]);
    expect(s.value.hooks).toEqual([
      { name: "lint", runs: 3, totalMs: 350, maxMs: 200, blocking: 2 },
      { name: "fmt", runs: 1, totalMs: 10, maxMs: 10, blocking: 0 },
    ]);
    expect(s.value.hooksFrom).toBe(500);
  });

  test("a hook on an empty snapshot sets the horizon; aggregate spans are ignored", () => {
    // Covers: R30
    let s = hooksFromSnapshot(snap());
    s = applyToHooks(s, hook(6, { aggregate: true }));
    expect(s.value.hooks).toEqual([]);
    s = applyToHooks(s, hook(7));
    expect(s.value.hooksFrom).toBe(7_000);
    expect(s.value.hooks[0]?.runs).toBe(1);
  });

  test("replays and revisions do not double count", () => {
    // Covers: R30
    const h = hook(6);
    const rev: CrowEvent = {
      ...hook(7),
      kind: "revision",
      hook: undefined,
      revision: { of: h.id, fact: h },
    };
    let s = hooksFromSnapshot(snap());
    s = applyManyToHooks(s, [h, h, rev]);
    expect(s.value.hooks).toEqual([
      { name: "lint", runs: 1, totalMs: 100, maxMs: 100, blocking: 0 },
    ]);
  });
});
