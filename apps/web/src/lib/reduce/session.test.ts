import { describe, expect, test } from "bun:test";
import type { AgentNode, CrowEvent, SessionDetailResponse } from "@crow/core/types";
import { emptyTotals } from "./projects";
import {
  agentDurationMs,
  applyManyToSession,
  applyToSession,
  buildAgentTree,
  sessionFromSnapshot,
} from "./session";

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
    ts: 1_000 * n,
    ...over,
  };
}

const usage = (costUsd: number) => ({
  input: 10,
  output: 5,
  cacheRead: 2,
  cacheCreation: 1,
  weightedTokens: 7,
  costUsd,
  model: "claude-opus",
});

function agent(agentId: string, parentAgentId: string | null, startedAt = 0): AgentNode {
  return {
    agentId,
    parentAgentId,
    type: null,
    description: null,
    model: null,
    status: "running",
    startedAt,
    endedAt: null,
    lastEventAt: startedAt,
    totals: emptyTotals(),
  };
}

function snapshot(cursor: string, agents: AgentNode[] = []): SessionDetailResponse {
  return {
    cursor,
    idleMs: 60_000,
    session: {
      id: "claude:s1",
      engine: "claude",
      nativeId: "s1",
      projectKey: "aaaaaaaaaaaa",
      status: "live",
      startedAt: 0,
      lastEventAt: 0,
      endedAt: null,
      model: null,
      lastPrompt: null,
      activeAgent: null,
      totals: { ...emptyTotals(), input: 100, costUsd: 1 },
    },
    agents,
  };
}

describe("agent tree", () => {
  // Covers: R32
  test("a child listed before its parent still hangs under it", () => {
    const tree = buildAgentTree([agent("child", "parent", 2), agent("parent", null, 1)]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.agent.agentId).toBe("parent");
    expect(tree[0]!.children.map((c) => [c.agent.agentId, c.depth])).toEqual([["child", 1]]);
  });

  // Covers: R32
  test("a child streamed before its parent is a root until the parent shows up", () => {
    let s = sessionFromSnapshot(snapshot(id(0)));
    s = applyToSession(s, ev(1, { kind: "agent.start", agentId: "c", parentAgentId: "p" }));
    expect(buildAgentTree(s.value.agents).map((n) => n.agent.agentId)).toEqual(["c"]);
    s = applyToSession(
      s,
      ev(2, { kind: "agent.start", agentId: "p", agent: { type: "explorer" } }),
    );
    const tree = buildAgentTree(s.value.agents);
    expect(tree.map((n) => n.agent.agentId)).toEqual(["p"]);
    expect(tree[0]!.children[0]!.agent.agentId).toBe("c");
  });

  // Covers: R32
  test("orders siblings by start, nests several levels and survives a cycle", () => {
    const tree = buildAgentTree([
      agent("b", "root", 3),
      agent("a", "root", 2),
      agent("root", null, 1),
      agent("leaf", "a", 4),
    ]);
    expect(tree[0]!.children.map((c) => c.agent.agentId)).toEqual(["a", "b"]);
    expect(tree[0]!.children[0]!.children[0]!.depth).toBe(2);
    const cyc = buildAgentTree([agent("x", "y"), agent("y", "x")]);
    expect(
      cyc.flatMap((n) => [n.agent.agentId, ...n.children.map((c) => c.agent.agentId)]),
    ).toEqual(["x", "y"]);
  });

  // Covers: R32
  test("agent lifecycle sets type, status, duration and per-agent tokens", () => {
    let s = sessionFromSnapshot(snapshot(id(0)));
    s = applyManyToSession(s, [
      ev(1, { kind: "agent.start", agentId: "a1", agent: { type: "explorer", description: "d" } }),
      ev(2, { agentId: "a1", usage: usage(0.5) }),
      ev(3, { kind: "agent.stop", agentId: "a1" }),
    ]);
    const a = s.value.agents[0]!;
    expect(a).toMatchObject({
      type: "explorer",
      description: "d",
      status: "done",
      model: "claude-opus",
    });
    expect(a.totals.input).toBe(10);
    expect(agentDurationMs(a, 99_999)).toBe(2_000);
    expect(agentDurationMs(agent("r", null, 1_000), 5_000)).toBe(4_000);
  });
});

describe("cost totals", () => {
  // Covers: R32, R33
  test("only events past the snapshot cursor add to the totals", () => {
    let s = sessionFromSnapshot(snapshot(id(10)));
    const page = [
      ev(9, { usage: usage(1) }),
      ev(10, { usage: usage(1) }),
      ev(11, { usage: usage(2) }),
    ];
    s = applyManyToSession(s, page);
    s = applyManyToSession(s, page); // the stream repeats the page: nothing new
    const t = s.value.session.totals;
    expect(t.input).toBe(110);
    expect(t.cacheRead).toBe(2);
    expect(t.cacheCreation).toBe(1);
    expect(t.weightedTokens).toBe(7);
    expect(t.costUsd).toBe(3);
    expect(s.value.session.model).toBe("claude-opus");
    expect(s.lastApplied).toBe(id(11));
  });

  // Covers: R32
  test("unpriced usage bumps unpricedUsages and session.end closes the session", () => {
    let s = sessionFromSnapshot(snapshot(id(0)));
    s = applyToSession(
      s,
      ev(1, { usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } }),
    );
    s = applyToSession(s, ev(2, { kind: "session.end" }));
    expect(s.value.session.totals.unpricedUsages).toBe(1);
    expect(s.value.session.totals.costUsd).toBe(1);
    expect(s.value.session.status).toBe("ended");
  });
});
