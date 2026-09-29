import { describe, expect, test } from "bun:test";
import type { CrowEvent } from "@crow/core/types";
import {
  applyManyToFeed,
  applyToColumns,
  applyToFeed,
  feedFromEvents,
  type FeedState,
  filterEvents,
  filterOptions,
  kindLabel,
  MAIN_AGENT,
  LOADED_CEILING,
  mergeOlder,
  minCursor,
  NO_FILTER,
  promptOrigin,
  TIMELINE_WINDOW,
} from "./feed";

const id = (n: number): string => `01J${String(n).padStart(23, "0")}`;

function ev(n: number, over: Partial<CrowEvent> = {}): CrowEvent {
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
    ts: 1_000 + n,
    ...over,
  };
}

const range = (from: number, to: number): CrowEvent[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ev(from + i));

describe("feed window", () => {
  // Covers: R32
  test("keeps only the latest 500 events and flags that older ones exist", () => {
    const state = applyManyToFeed(feedFromEvents([], null, TIMELINE_WINDOW), range(1, 620));
    expect(state.value.events).toHaveLength(500);
    expect(state.value.events[0]!.id).toBe(id(121));
    expect(state.value.events[499]!.id).toBe(id(620));
    expect(state.value.truncated).toBe(true);
    expect(state.lastApplied).toBe(id(620));
  });

  // Covers: R32
  test("older pages merge without duplicates, keep the cursor and raise the live cap", () => {
    let state = applyManyToFeed(feedFromEvents([], null, TIMELINE_WINDOW), range(1, 620));
    // first older page overlaps the window on purpose (ids 100..130)
    state = mergeOlder(state, range(100, 130), false);
    expect(state.value.events).toHaveLength(500 + 21);
    expect(state.value.truncated).toBe(true);
    state = mergeOlder(state, range(1, 120), true);
    expect(state.value.events).toHaveLength(620);
    expect(new Set(state.value.events.map((e) => e.id)).size).toBe(620);
    expect(state.value.truncated).toBe(false);
    expect(state.lastApplied).toBe(id(620)); // the cursor is untouched
    // live events keep flowing without dropping what the user loaded
    state = applyToFeed(state, ev(621));
    expect(state.value.events).toHaveLength(621);
    expect(state.value.events[0]!.id).toBe(id(1));
  });

  // Covers: R32
  test("after loading older, the live view is bounded by the hard ceiling and re-enables 'anteriores'", () => {
    let state = applyManyToFeed(
      feedFromEvents([], null, TIMELINE_WINDOW),
      range(LOADED_CEILING - 499, LOADED_CEILING),
    );
    state = mergeOlder(state, range(1, LOADED_CEILING - 500), true);
    expect(state.value.events).toHaveLength(LOADED_CEILING);
    expect(state.value.truncated).toBe(false);
    state = applyToFeed(state, ev(LOADED_CEILING + 1)); // one live event past the ceiling
    expect(state.value.events).toHaveLength(LOADED_CEILING);
    expect(state.value.events[0]!.id).toBe(id(2)); // oldest dropped
    expect(state.value.truncated).toBe(true);
  });

  // Covers: R32, R33
  test("orders by id whatever the snapshot order and ignores ids <= lastApplied", () => {
    const state = feedFromEvents([ev(3), ev(1), ev(2), ev(2)], id(3), null);
    expect(state.value.events.map((e) => e.id)).toEqual([id(1), id(2), id(3)]);
    expect(applyToFeed(state, ev(3))).toBe(state);
    expect(applyToFeed(state, ev(2))).toBe(state);
    expect(applyToFeed(state, ev(4)).value.events).toHaveLength(4);
  });
});

describe("split columns", () => {
  // Covers: R31
  test("routes each event to its project column with an independent cursor", () => {
    const a = feedFromEvents([ev(5)], id(5), 200);
    const b = feedFromEvents([ev(2, { projectKey: "bbbbbbbbbbbb" })], id(2), 200);
    let cols: Record<string, FeedState> = { aaaaaaaaaaaa: a, bbbbbbbbbbbb: b };
    expect(minCursor(cols)).toBe(id(2));
    // the stream opens at the min cursor: ids 3 and 4 are new for b but old for a
    cols = applyToColumns(cols, ev(3, { projectKey: "bbbbbbbbbbbb" }));
    cols = applyToColumns(cols, ev(4, { projectKey: "aaaaaaaaaaaa" })); // <= 5: ignored by a
    cols = applyToColumns(cols, ev(6, { projectKey: "aaaaaaaaaaaa" }));
    cols = applyToColumns(cols, ev(7, { projectKey: "cccccccccccc" })); // no such column
    expect(cols.aaaaaaaaaaaa!.value.events.map((e) => e.id)).toEqual([id(5), id(6)]);
    expect(cols.bbbbbbbbbbbb!.value.events.map((e) => e.id)).toEqual([id(2), id(3)]);
  });

  // Covers: R31
  test("a column window caps at its max", () => {
    const state = applyManyToFeed(feedFromEvents([], id(0), 3), range(1, 10));
    expect(state.value.events.map((e) => e.id)).toEqual([id(8), id(9), id(10)]);
  });
});

describe("filters and labels", () => {
  const events = [
    ev(1, { kind: "prompt", text: "hola" }),
    ev(2, { kind: "tool.pre", agentId: "a1", tool: { name: "Bash" } }),
    ev(3, { kind: "tool.pre", tool: { name: "Read" } }),
    ev(4, { kind: "tool.error", agentId: "a1", tool: { name: "Bash" }, error: { message: "x" } }),
  ];

  // Covers: R32
  test("filters by kind, agent and tool, combined", () => {
    expect(filterEvents(events, NO_FILTER)).toHaveLength(4);
    expect(filterEvents(events, { ...NO_FILTER, kind: "tool.pre" })).toHaveLength(2);
    expect(filterEvents(events, { ...NO_FILTER, agent: "a1" }).map((e) => e.id)).toEqual([
      id(2),
      id(4),
    ]);
    expect(filterEvents(events, { ...NO_FILTER, agent: MAIN_AGENT })).toHaveLength(2);
    expect(filterEvents(events, { kind: "tool.pre", agent: "a1", tool: "Bash" })).toHaveLength(1);
    expect(filterOptions(events)).toEqual({
      kinds: ["prompt", "tool.error", "tool.pre"],
      agents: [MAIN_AGENT, "a1"],
      tools: ["Bash", "Read"],
    });
  });

  // Covers: R32
  test("a prompt on a subagent is the parent agent's instruction, not the user's", () => {
    const user = ev(1, { kind: "prompt", text: "arregla esto" });
    const sub = ev(2, { kind: "prompt", text: "explora el repo", agentId: "a1" });
    expect(promptOrigin(user)).toBe("user");
    expect(promptOrigin(sub)).toBe("parent-agent");
    expect(promptOrigin(ev(3))).toBeNull();
    expect(kindLabel(user)).toBe("Prompt del usuario");
    expect(kindLabel(sub)).toBe("Instrucción del agente padre");
  });
});
