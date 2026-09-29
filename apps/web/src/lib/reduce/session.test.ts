import { describe, expect, test } from "bun:test";
import type { AgentNode, CrowEvent, SessionDetailResponse } from "@crow/core/types";
import { emptyTotals } from "./projects";
import {
  agentDurationMs,
  applyManyToSession,
  applyToSession,
  buildAgentTree,
  buildSessionTree,
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
      lastPromptAt: null,
      activeAgent: null,
      activeAgentAt: null,
      totals: { ...emptyTotals(), input: 100, costUsd: 1 },
    },
    agents,
    hooks: [],
    hooksFrom: null,
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
  test("the main thread is the root: null-parent agents hang under it, unknown parents stay roots", () => {
    const session = snapshot(id(0)).session; // totals.input = 100
    const sub = { ...agent("a", null, 2), totals: { ...emptyTotals(), input: 30 } };
    const tree = buildSessionTree(session, [sub, agent("b", "a", 3), agent("orphan", "ghost", 4)]);
    expect(tree.map((n) => n.agent.agentId)).toEqual(["__main__", "orphan"]);
    const main = tree[0]!;
    expect(main.depth).toBe(0);
    expect(main.agent.type).toBe("principal");
    expect(main.agent.totals.input).toBe(70); // session minus subagents
    expect(main.children.map((c) => [c.agent.agentId, c.depth])).toEqual([["a", 1]]);
    expect(main.children[0]!.children.map((c) => [c.agent.agentId, c.depth])).toEqual([["b", 2]]);
    // a session without subagents still shows the main thread
    expect(buildSessionTree(session, []).map((n) => n.agent.type)).toEqual(["principal"]);
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

// A `revision` row carries the corrected fact of an earlier event (D5).
function revision(n: number, of: number, fact: CrowEvent): CrowEvent {
  return ev(n, {
    kind: "revision",
    ts: fact.ts,
    agentId: fact.agentId,
    revision: { of: id(of), fact: { ...fact, id: id(of) } },
  });
}

describe("BD1: ts-guarded effects with revisions and late facts (session detail)", () => {
  // Covers: R11, R13
  test("(1) a late prompt, alone or as a revision of an earlier one, never regresses lastPrompt", () => {
    let s = sessionFromSnapshot(snapshot(id(0)));
    const p1 = ev(1, { kind: "prompt", text: "P1", ts: 100 });
    s = applyToSession(s, p1);
    s = applyToSession(s, ev(2, { kind: "prompt", text: "P2", ts: 200 }));
    s = applyToSession(s, revision(3, 1, { ...p1, text: "P1 (full)", ts: 95 }));
    expect(s.value.session.lastPrompt).toBe("P2");
    expect(s.value.session.lastPromptAt).toBe(200);
    s = applyToSession(s, ev(4, { kind: "prompt", text: "P0 late", ts: 50 }));
    expect(s.value.session.lastPrompt).toBe("P2");
  });

  // Covers: R13
  test("(2) agent.stop before agent.start (fused later): the agent stays done and inactive", () => {
    let s = sessionFromSnapshot(snapshot(id(0)));
    s = applyToSession(s, ev(1, { kind: "agent.stop", agentId: "a1", ts: 300 }));
    const start = ev(2, {
      kind: "agent.start",
      agentId: "a1",
      ts: 100,
      agent: { type: "explorer" },
    });
    s = applyToSession(s, start);
    s = applyToSession(
      s,
      revision(3, 2, { ...start, agent: { type: "explorer", description: "d" } }),
    );
    const a1 = s.value.agents.find((a) => a.agentId === "a1")!;
    expect(a1.status).toBe("done");
    expect(a1.endedAt).toBe(300);
    expect(a1.type).toBe("explorer");
    expect(a1.description).toBe("d"); // metadata still filled by the revision
    expect(s.value.session.activeAgent).toBeNull();
    expect(s.value.session.activeAgentAt).toBe(300);
  });

  // Covers: R13
  test("an agent.start with ts >= activeAgentAt sets the active agent; an older one does not", () => {
    let s = sessionFromSnapshot(snapshot(id(0)));
    s = applyToSession(s, ev(1, { kind: "agent.start", agentId: "a1", ts: 100 }));
    s = applyToSession(s, ev(2, { kind: "agent.start", agentId: "a2", ts: 50 }));
    expect(s.value.session.activeAgent?.agentId).toBe("a1");
    s = applyToSession(s, ev(3, { kind: "agent.start", agentId: "a3", ts: 100 }));
    expect(s.value.session.activeAgent?.agentId).toBe("a3");
  });

  // Covers: R11
  test("(3) SessionEnd, then an event with a smaller ts: ended; a strictly later one revives", () => {
    let s = sessionFromSnapshot(snapshot(id(0)));
    s = applyToSession(s, ev(1, { kind: "session.end", ts: 500 }));
    s = applyToSession(s, ev(2, { kind: "prompt", text: "old", ts: 400 }));
    expect(s.value.session.status).toBe("ended");
    s = applyToSession(s, revision(3, 2, ev(2, { kind: "prompt", text: "old", ts: 450 })));
    expect(s.value.session.status).toBe("ended");
    s = applyToSession(s, ev(4, { kind: "prompt", text: "new", ts: 501 }));
    expect(s.value.session.status).toBe("live");
  });

  // Covers: R11
  test("a revision row never touches totals (it carries no usage) and is folded with the cursor rule", () => {
    let s = sessionFromSnapshot(snapshot(id(0)));
    const call = ev(1, { kind: "tool.post", tool: { name: "Bash" } });
    s = applyToSession(s, call);
    const before = s.value.session.totals;
    s = applyToSession(s, revision(2, 1, { ...call, tool: { name: "Bash", ok: true } }));
    expect(s.value.session.totals).toEqual(before);
    expect(s.lastApplied).toBe(id(2));
    expect(applyToSession(s, revision(2, 1, call))).toBe(s); // a replayed revision id is ignored
  });
});
