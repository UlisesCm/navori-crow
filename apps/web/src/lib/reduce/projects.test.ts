import { describe, expect, test } from "bun:test";
import type { CrowEvent, ProjectsResponse } from "@crow/core/types";
import { UNRESOLVED_PROJECT_KEY } from "@crow/core/types";
import {
  applyToProjects,
  partitionProjects,
  projectsFromSnapshot,
  rollDay,
  sortedProjects,
} from "./projects";

const TODAY = new Date(2026, 8, 29, 12, 0, 0).getTime();
const YESTERDAY = TODAY - 86_400_000;
const id = (n: number): string => `01J${String(n).padStart(23, "0")}`;

const empty: ProjectsResponse = { cursor: id(0), idleMs: 60_000, day: "2026-09-29", projects: [] };

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
    ts: TODAY,
    ...over,
  };
}

describe("applyToProjects", () => {
  // Covers: R30
  test("upserts the project card and session from an event", () => {
    const s = applyToProjects(projectsFromSnapshot(empty), ev(1, { kind: "session.start" }));
    const p = s.value.projects["aaaaaaaaaaaa"]!;
    expect(p.name).toBe("demo");
    expect(p.engines).toEqual(["claude"]);
    expect(p.sessions).toHaveLength(1);
    expect(p.sessions[0]!.id).toBe("claude:s1");
    expect(p.sessions[0]!.status).toBe("live");
  });

  // Covers: R30
  test("tracks current prompt, active agent and session end", () => {
    let s = projectsFromSnapshot(empty);
    s = applyToProjects(s, ev(1, { kind: "prompt", text: "fix the bug" }));
    s = applyToProjects(
      s,
      ev(2, { kind: "agent.start", agentId: "a1", agent: { type: "explorer" } }),
    );
    let session = s.value.projects["aaaaaaaaaaaa"]!.sessions[0]!;
    expect(session.lastPrompt).toBe("fix the bug");
    expect(session.activeAgent).toEqual({ agentId: "a1", type: "explorer" });

    s = applyToProjects(s, ev(3, { kind: "agent.stop", agentId: "a1" }));
    s = applyToProjects(s, ev(4, { kind: "session.end" }));
    session = s.value.projects["aaaaaaaaaaaa"]!.sessions[0]!;
    expect(session.activeAgent).toBeNull();
    expect(session.status).toBe("ended");
  });

  // Covers: R30
  test("adds sealed usage to today only when ts falls on the snapshot day", () => {
    const usage = { input: 10, output: 5, cacheRead: 1, cacheCreation: 2, costUsd: 0.5 };
    let s = projectsFromSnapshot(empty);
    s = applyToProjects(s, ev(1, { usage }));
    s = applyToProjects(s, ev(2, { usage, ts: YESTERDAY }));
    const p = s.value.projects["aaaaaaaaaaaa"]!;
    expect(p.today.input).toBe(10);
    expect(p.today.costUsd).toBe(0.5);
    expect(p.sessions[0]!.totals.input).toBe(20); // the session total is not day-scoped
  });

  // Covers: R30
  test("unpriced usage bumps unpricedUsages instead of cost", () => {
    const s = applyToProjects(
      projectsFromSnapshot(empty),
      ev(1, { usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } }),
    );
    const today = s.value.projects["aaaaaaaaaaaa"]!.today;
    expect(today.costUsd).toBe(0);
    expect(today.unpricedUsages).toBe(1);
  });

  // Covers: R30
  test("keeps the last error and orders cards by recency", () => {
    let s = projectsFromSnapshot(empty);
    s = applyToProjects(s, ev(1, { kind: "tool.error", error: { message: "boom" } }));
    s = applyToProjects(
      s,
      ev(2, { projectKey: "bbbbbbbbbbbb", projectPath: "/repo/other", ts: TODAY + 1000 }),
    );
    expect(s.value.projects["aaaaaaaaaaaa"]!.lastError?.message).toBe("boom");
    expect(sortedProjects(s.value).map((p) => p.name)).toEqual(["other", "demo"]);
  });
});

describe("rollDay", () => {
  // Covers: R30
  test("resets today totals once the injected clock crosses local midnight", () => {
    const usage = { input: 10, output: 5, cacheRead: 0, cacheCreation: 0, costUsd: 0.5 };
    let s = applyToProjects(projectsFromSnapshot(empty), ev(1, { usage }));
    expect(rollDay(s, TODAY)).toBe(s); // same day: untouched
    const tomorrow = new Date(2026, 8, 30, 0, 0, 1).getTime();
    s = rollDay(s, tomorrow);
    expect(s.value.day).toBe("2026-09-30");
    expect(s.value.projects["aaaaaaaaaaaa"]!.today.costUsd).toBe(0);
    expect(s.value.projects["aaaaaaaaaaaa"]!.sessions[0]!.totals.input).toBe(10);
    s = applyToProjects(s, ev(2, { usage, ts: tomorrow }));
    expect(s.value.projects["aaaaaaaaaaaa"]!.today.costUsd).toBe(0.5);
  });
});

function revision(n: number, of: number, fact: CrowEvent): CrowEvent {
  return ev(n, {
    kind: "revision",
    ts: fact.ts,
    revision: { of: id(of), fact: { ...fact, id: id(of) } },
  });
}

describe("BD1: ts-guarded effects with revisions and late facts (home)", () => {
  const card = (s: ReturnType<typeof projectsFromSnapshot>) =>
    s.value.projects["aaaaaaaaaaaa"]!.sessions[0]!;

  // Covers: R11, R13
  test("(1) a prompt revision or late prompt never regresses lastPrompt", () => {
    let s = projectsFromSnapshot(empty);
    const p1 = ev(1, { kind: "prompt", text: "P1", ts: TODAY + 100 });
    s = applyToProjects(s, p1);
    s = applyToProjects(s, ev(2, { kind: "prompt", text: "P2", ts: TODAY + 200 }));
    s = applyToProjects(s, revision(3, 1, { ...p1, text: "P1 full", ts: TODAY + 95 }));
    expect(card(s).lastPrompt).toBe("P2");
    expect(card(s).lastPromptAt).toBe(TODAY + 200);
  });

  // Covers: R13
  test("(2) agent.stop, then an older agent.start (also as a revision): no active agent", () => {
    let s = projectsFromSnapshot(empty);
    s = applyToProjects(s, ev(1, { kind: "agent.start", agentId: "a1", ts: TODAY + 10 }));
    expect(card(s).activeAgent?.agentId).toBe("a1");
    s = applyToProjects(s, ev(2, { kind: "agent.stop", agentId: "a1", ts: TODAY + 300 }));
    expect(card(s).activeAgent).toBeNull();
    const start = ev(3, { kind: "agent.start", agentId: "a1", ts: TODAY + 100 });
    s = applyToProjects(s, start);
    s = applyToProjects(s, revision(4, 3, start));
    expect(card(s).activeAgent).toBeNull();
    expect(card(s).activeAgentAt).toBe(TODAY + 300);
  });

  // Covers: R11
  test("(3) SessionEnd then an older event or revision: still ended; a later event revives it", () => {
    let s = projectsFromSnapshot(empty);
    s = applyToProjects(s, ev(1, { kind: "session.end", ts: TODAY + 500 }));
    s = applyToProjects(s, ev(2, { kind: "prompt", text: "old", ts: TODAY + 400 }));
    s = applyToProjects(s, revision(3, 2, ev(2, { kind: "prompt", text: "old", ts: TODAY + 450 })));
    expect(card(s).status).toBe("ended");
    expect(card(s).endedAt).toBe(TODAY + 500);
    s = applyToProjects(s, ev(4, { kind: "assistant.message", ts: TODAY + 501 }));
    expect(card(s).status).toBe("live");
  });

  // Covers: R11, R13
  test("a revision of a tool.error fact updates the project's lastError and never the totals", () => {
    let s = projectsFromSnapshot(empty);
    const call = ev(1, { kind: "tool.post", tool: { name: "Bash" } });
    s = applyToProjects(s, call);
    s = applyToProjects(
      s,
      revision(2, 1, { ...call, kind: "tool.error", error: { message: "boom" } }),
    );
    expect(s.value.projects["aaaaaaaaaaaa"]!.lastError?.message).toBe("boom");
    expect(card(s).totals.input).toBe(0);
  });
});

describe("partitionProjects", () => {
  const orphan = (n: number, over: Partial<CrowEvent> = {}): CrowEvent =>
    ev(n, { projectKey: UNRESOLVED_PROJECT_KEY, projectPath: "", sessionId: "orphan", ...over });

  // Covers: R30
  test("separates `unresolved` from real projects and never lists it as a card", () => {
    let s = projectsFromSnapshot(empty);
    s = applyToProjects(s, ev(1, { kind: "session.start" }));
    s = applyToProjects(
      s,
      orphan(2, { kind: "ingest.error", error: { reason: "unattributable", message: "boom" } }),
    );
    const { cards, unattributed } = partitionProjects(s.value);
    expect(cards.map((p) => p.key)).toEqual(["aaaaaaaaaaaa"]);
    expect(unattributed?.key).toBe(UNRESOLVED_PROJECT_KEY);
    expect(unattributed?.lastError?.message).toBe("boom");
  });

  // Covers: R30
  test("excludes `unresolved` from split candidates (cards are the only selectable set)", () => {
    const s = applyToProjects(projectsFromSnapshot(empty), orphan(1, { kind: "session.start" }));
    expect(partitionProjects(s.value).cards).toEqual([]);
  });

  // Covers: R30
  test("hides the bucket when it has no sessions", () => {
    const snap: ProjectsResponse = {
      ...empty,
      projects: [
        {
          key: UNRESOLVED_PROJECT_KEY,
          path: "",
          name: "unresolved",
          engines: [],
          lastSeen: TODAY,
          today: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheCreation: 0,
            cacheCreation1h: 0,
            weightedTokens: 0,
            costUsd: 0,
            unpricedUsages: 0,
          },
          lastError: null,
          sessions: [],
        },
      ],
    };
    expect(partitionProjects(projectsFromSnapshot(snap).value).unattributed).toBeNull();
  });
});
