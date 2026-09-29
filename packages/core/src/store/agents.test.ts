import { describe, expect, test } from "bun:test";
import { getSessionDetail } from "./store";
import { factRows, freshDb, ingest, makeDeps, pending, permutations, T0 } from "./testing";

const agentRows = (db: ReturnType<typeof freshDb>): string[] =>
  db
    .query<{ id: string }, []>("SELECT id FROM agents WHERE agent_id IS NOT NULL ORDER BY id")
    .all()
    .map((r) => r.id);

describe("agent attribution: reconcile before ensureAgent (D4, MF3)", () => {
  test("a hook SubagentStop for an unknown agent is stored as an event but creates no agent row", () => {
    // Covers: R10
    const db = freshDb();
    ingest(
      db,
      makeDeps(),
      pending("hook", { kind: "agent.stop", agentId: "internal-1", ts: T0 + 10 }),
    );

    expect(factRows(db).map((f) => f.kind)).toEqual(["agent.stop"]);
    expect(agentRows(db)).toEqual([]);
    expect(getSessionDetail(db, "claude:s1")!.agents).toEqual([]);
  });

  test("a hook SubagentStop with an unknown id plus a transcript agent.stop for another yields ONE agent row (MF3)", () => {
    // Covers: R10
    for (const order of permutations(["hook", "transcript"] as const)) {
      const db = freshDb();
      const deps = makeDeps();
      for (const lane of order) {
        ingest(
          db,
          deps,
          lane === "hook"
            ? pending("hook", { kind: "agent.stop", agentId: "internal-1", ts: T0 + 10 })
            : pending("transcript", { kind: "agent.stop", agentId: "a-real", ts: T0 + 20 }),
        );
      }
      expect(agentRows(db)).toEqual(["claude:s1/a-real"]);
    }
  });

  test("the same stop by both lanes under one key, with different agent ids, ends up on the transcript's agent only", () => {
    // Covers: R10, R13
    const match = { key: "agent-stop:a-real", mode: "exact" } as const;
    for (const order of permutations(["hook", "transcript"] as const)) {
      const db = freshDb();
      const deps = makeDeps();
      for (const lane of order) {
        ingest(
          db,
          deps,
          lane === "hook"
            ? pending("hook", { kind: "agent.stop", agentId: "internal-1", ts: T0 + 10, match })
            : pending("transcript", { kind: "agent.stop", agentId: "a-real", ts: T0 + 20, match }),
        );
      }
      expect(agentRows(db)).toEqual(["claude:s1/a-real"]);
      const facts = factRows(db);
      expect(facts).toHaveLength(1);
      expect(facts[0]!.agentId).toBe("a-real");
      const row = db
        .query<{ agent_id: string | null }, []>(
          "SELECT agent_id FROM events WHERE kind = 'agent.stop'",
        )
        .get();
      expect(row!.agent_id).toBe("a-real"); // the column follows the canonical agent
    }
  });

  test("a hook SubagentStop for an agent that has an agent.start fact keeps its row", () => {
    // Covers: R10
    const db = freshDb();
    const deps = makeDeps();
    ingest(db, deps, pending("hook", { kind: "agent.start", agentId: "a1", ts: T0 + 1 }));
    ingest(db, deps, pending("hook", { kind: "agent.stop", agentId: "a1", ts: T0 + 2 }));
    const detail = getSessionDetail(db, "claude:s1")!;
    expect(detail.agents.map((a) => a.agentId)).toEqual(["a1"]);
    expect(detail.agents[0]!.status).toBe("done");
  });

  test("hook tool events carrying an agent_id do create the agent row", () => {
    // Covers: R10
    const db = freshDb();
    ingest(
      db,
      makeDeps(),
      pending("hook", {
        kind: "tool.pre",
        agentId: "a9",
        ts: T0 + 1,
        tool: { name: "Read", callId: "c1" },
      }),
    );
    expect(agentRows(db)).toEqual(["claude:s1/a9"]);
  });

  test("a hook event lands in the same session and project as the transcript's (cwd + sticky rule)", () => {
    // Covers: R10
    const db = freshDb();
    const deps = makeDeps();
    ingest(db, deps, pending("transcript", { kind: "prompt", ts: T0, text: "hi" }));
    ingest(
      db,
      deps,
      pending("hook", { kind: "tool.pre", ts: T0 + 1, tool: { name: "Bash", callId: "c1" } }),
    );
    const rows = db
      .query<{ session_id: string; project_key: string }, []>(
        "SELECT session_id, project_key FROM events",
      )
      .all();
    expect(new Set(rows.map((r) => `${r.session_id}|${r.project_key}`)).size).toBe(1);
    const sessions = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sessions").get();
    expect(sessions!.n).toBe(1);
  });
});
