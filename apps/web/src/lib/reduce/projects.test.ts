import { describe, expect, test } from "bun:test";
import type { CrowEvent, ProjectsResponse } from "@crow/core/types";
import { applyToProjects, projectsFromSnapshot, sortedProjects } from "./projects";

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
