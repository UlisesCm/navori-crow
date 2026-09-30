/**
 * Codex thread identity across lanes (D19, R12, R13, R35, R36, R37): the OTel spawn, the
 * `SubagentStart` hook, the rollout's `session_meta` and the child's own OTLP records (tools and
 * usage) arrive in every possible order, with the sweeper ticking at any point.
 */
import type { Database } from "bun:sqlite";
import { Database as Sqlite } from "bun:sqlite";
import type { CrowEvent } from "../crow-event";
import { describe, expect, test } from "bun:test";
import { createUlidFactory } from "../ulid";
import { OTEL_HOLD_MS, promoteHeldUsage, stats } from "./store";
import type { IngestBatchDeps, PendingEvent } from "./store";
import { factRows, freshDb, IDLE_MS, ingest, pending, permutations, T0 } from "./testing";

const USAGE = { input: 10, output: 5, cacheRead: 0, cacheCreation: 0, model: "gpt-5" };
const codex = (p: PendingEvent): PendingEvent => ({ ...p, engine: "codex" });
const startKey = (id: string) => ({ key: `agent-start:${id}`, mode: "exact" }) as const;

interface Clock {
  t: number;
}

function clockDeps(clock: Clock): IngestBatchDeps {
  return {
    nextId: createUlidFactory("00000000000000000000000000", () => clock.t),
    now: () => clock.t,
    idleMs: IDLE_MS,
  };
}

/** The six contributions for a root thread `root` and its child `kid`. */
function childLanes(): Record<string, PendingEvent> {
  return {
    spawnOtel: codex(
      pending("otel", {
        sessionId: "root",
        agentId: "kid",
        kind: "agent.start",
        ts: T0 + 1,
        match: startKey("kid"),
      }),
    ),
    startHook: codex(
      pending("hook", {
        sessionId: "root",
        agentId: "kid",
        kind: "agent.start",
        ts: T0 + 2,
        agent: { type: "worker" },
        match: startKey("kid"),
      }),
    ),
    startRollout: codex(
      pending("transcript", {
        sessionId: "root",
        agentId: "kid",
        kind: "agent.start",
        ts: T0 + 3,
        agent: { type: "worker" },
        match: startKey("kid"),
      }),
    ),
    toolOtel: codex(
      pending("otel", {
        sessionId: "kid",
        kind: "tool.post",
        ts: T0 + 4,
        tool: { name: "exec", callId: "c9", ok: true },
        match: { key: "tool-post:c9", mode: "exact" },
      }),
    ),
    usageOtel: codex(
      pending("otel", {
        sessionId: "kid",
        kind: "api.request",
        ts: T0 + 5,
        otelUsage: USAGE,
        usageCallKey: "c1",
        reported: { metric: "api_request", input: 10, output: 5 },
      }),
    ),
    usageRollout: codex(
      pending("transcript", {
        sessionId: "root",
        agentId: "kid",
        kind: "assistant.message",
        ts: T0 + 6,
        text: "done",
        usage: USAGE,
        usageKey: "u:kid:c1",
        usageCallKey: "c1",
      }),
    ),
  };
}

// Any root-routed contribution naming `kid` creates its `agents` row; the rollout usage line does too.
const LINKS = ["spawnOtel", "startHook", "startRollout", "usageRollout"];

function count(db: Database, sql: string, ...args: string[]): number {
  return db.query<{ n: number }, string[]>(sql).get(...args)?.n ?? -1;
}

describe("Codex thread link: every order of the six contributions (R13, R35)", () => {
  test("720 orders with a final tick: one agent.start in codex:root, one kid row, each tool once", () => {
    // Covers: R13, R35
    const names = Object.keys(childLanes());
    const orders = permutations(names);
    expect(orders).toHaveLength(720);
    const template = freshDb().serialize();
    const problems: string[] = [];
    for (const order of orders) {
      const db = Sqlite.deserialize(template);
      const clock: Clock = { t: T0 };
      const deps = clockDeps(clock);
      const lanes = childLanes();
      for (const name of order) ingest(db, deps, lanes[name]!);
      clock.t += 10 * OTEL_HOLD_MS;
      promoteHeldUsage(db, deps);

      const label = order.join(",");
      const starts = factRows(db, "codex:root").filter((f) => f.kind === "agent.start").length;
      if (starts !== 1) problems.push(`${label}: ${starts} agent.start in codex:root`);
      const orphanStarts = count(
        db,
        "SELECT COUNT(*) AS n FROM events WHERE session_id = 'codex:kid' AND kind = 'agent.start'",
      );
      if (orphanStarts !== 0) problems.push(`${label}: agent.start in codex:kid`);
      const rows = count(db, "SELECT COUNT(*) AS n FROM agents WHERE agent_id = 'kid'");
      if (rows !== 1) problems.push(`${label}: ${rows} kid rows`);

      // The tool lands in the root once any lane linked the thread first; else in codex:kid (residual).
      const firstLink = Math.min(...LINKS.map((n) => order.indexOf(n)));
      const toolSession = order.indexOf("toolOtel") > firstLink ? "codex:root" : "codex:kid";
      const tools = db
        .query<{ session_id: string }, []>(
          "SELECT session_id FROM events WHERE kind = 'tool.post' AND call_id = 'c9'",
        )
        .all()
        .map((r) => r.session_id);
      if (tools.length !== 1 || tools[0] !== toolSession) {
        problems.push(`${label}: tool in ${tools.join("+")}, expected ${toolSession}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("Codex thread link: grandchildren in any order (D19)", () => {
  const grand = (): Record<string, PendingEvent> => ({
    spawnK: codex(
      pending("otel", {
        sessionId: "root",
        agentId: "K",
        kind: "agent.start",
        ts: T0 + 1,
        match: startKey("K"),
      }),
    ),
    spawnY: codex(
      pending("otel", {
        sessionId: "K",
        agentId: "Y",
        kind: "agent.start",
        ts: T0 + 2,
        match: startKey("Y"),
      }),
    ),
    hookY: codex(
      pending("hook", {
        sessionId: "root",
        agentId: "Y",
        parentAgentId: null,
        kind: "agent.start",
        ts: T0 + 3,
        match: startKey("Y"),
      }),
    ),
    rolloutY: codex(
      pending("transcript", {
        sessionId: "root",
        agentId: "Y",
        parentAgentId: null,
        kind: "agent.start",
        ts: T0 + 4,
        match: startKey("Y"),
      }),
    ),
  });

  test("with the spawn of K first, root/Y always has root/K as parent (hook first included)", () => {
    // Covers: R13, R35
    const orders = permutations(Object.keys(grand())).filter(
      (o) => o.indexOf("spawnK") < o.indexOf("spawnY"),
    );
    expect(orders).toHaveLength(12);
    for (const order of orders) {
      const db = freshDb();
      const deps = clockDeps({ t: T0 });
      const lanes = grand();
      for (const name of order) ingest(db, deps, lanes[name]!);
      const y = db
        .query<{ parent_id: string | null }, []>(
          "SELECT parent_id FROM agents WHERE id = 'codex:root/Y'",
        )
        .get();
      expect({ order: order.join(","), parent: y?.parent_id }).toEqual({
        order: order.join(","),
        parent: "codex:root/K",
      });
      const fact = factRows(db, "codex:root").filter(
        (f) => f.kind === "agent.start" && f.agentId === "Y",
      );
      expect(fact).toHaveLength(1);
      expect(fact[0]!.parentAgentId).toBe("K");
    }
  });
});

describe("Codex thread link: an orphan grandchild (residual R35, D19)", () => {
  const spawn = (sender: string, receiver: string, ts: number): PendingEvent =>
    codex(
      pending("otel", {
        sessionId: sender,
        agentId: receiver,
        kind: "agent.start",
        ts,
        match: startKey(receiver),
      }),
    );
  const rows = (db: Database, agentId: string): Array<{ id: string; parent_id: string | null }> =>
    db
      .query<{ id: string; parent_id: string | null }, [string]>(
        "SELECT id, parent_id FROM agents WHERE agent_id = ? ORDER BY id",
      )
      .all(agentId);

  test("the spawn of Y before the spawn of K leaves Y's start in codex:K; a later root lane then duplicates the row", () => {
    // Covers: R35
    const db = freshDb();
    const deps = clockDeps({ t: T0 });
    ingest(db, deps, spawn("K", "Y", T0 + 1), spawn("root", "K", T0 + 2));
    // Pinned residual: K was not linked when it spawned Y, so Y's start is a fact of codex:K.
    expect(factRows(db, "codex:K").filter((f) => f.kind === "agent.start")).toHaveLength(1);
    expect(factRows(db, "codex:root").filter((f) => f.agentId === "Y")).toEqual([]);
    expect(rows(db, "Y")).toEqual([{ id: "codex:K/Y", parent_id: null }]);
    expect(rows(db, "K")).toEqual([{ id: "codex:root/K", parent_id: null }]);

    // Another lane of Y under the root does not repair it: Y gets a second row and a second start.
    ingest(
      db,
      deps,
      codex(
        pending("hook", {
          sessionId: "root",
          agentId: "Y",
          parentAgentId: null,
          kind: "agent.start",
          ts: T0 + 3,
          match: startKey("Y"),
        }),
      ),
    );
    expect(rows(db, "Y").map((r) => r.id)).toEqual(["codex:K/Y", "codex:root/Y"]);
    expect(
      factRows(db, "codex:root").filter((f) => f.kind === "agent.start" && f.agentId === "Y"),
    ).toHaveLength(1);
  });
});

describe("Codex thread link: the usage ledger follows the thread in every order and tick (R12, R36, R37)", () => {
  const sum = (db: Database, sql: string, ...args: string[]): number =>
    db.query<{ t: number | null }, string[]>(sql).get(...args)?.t ?? 0;
  const projectInput = (db: Database): number =>
    sum(db, "SELECT SUM(t_input) AS t FROM project_daily");

  /** Every committed-state invariant of R37: session, agent and day totals agree and never exceed one call. */
  function committedProblems(db: Database, label: string): string[] {
    const day = projectInput(db);
    const sessions = sum(db, "SELECT SUM(t_input) AS t FROM sessions");
    const agents = sum(db, "SELECT SUM(t_input) AS t FROM agents");
    const out: string[] = [];
    if (day > 10) out.push(`${label}: day total ${day} > 10`);
    if (sessions !== day || agents !== day) {
      out.push(`${label}: day ${day}, sessions ${sessions}, agents ${agents}`);
    }
    return out;
  }

  test("720 orders x 7 tick positions (5040 runs): never above one call, finally 10 on root/kid", () => {
    // Covers: R12, R36, R37
    const names = Object.keys(childLanes());
    const orders = permutations(names);
    const template = freshDb().serialize();
    const problems: string[] = [];
    let runs = 0;
    for (const order of orders) {
      for (let tickAt = 0; tickAt <= names.length; tickAt++) {
        runs += 1;
        const label = `${order.join(",")} tick@${tickAt}`;
        const db = Sqlite.deserialize(template);
        const clock: Clock = { t: T0 };
        const deps = clockDeps(clock);
        const lanes = childLanes();
        const published: CrowEvent[] = [];
        order.forEach((name, i) => {
          published.push(...ingest(db, deps, lanes[name]!));
          problems.push(...committedProblems(db, `${label} after ${name}`));
          if (i + 1 === tickAt) {
            clock.t += OTEL_HOLD_MS + 1;
            published.push(...promoteHeldUsage(db, deps));
            problems.push(...committedProblems(db, `${label} after tick`));
          }
        });
        clock.t += 10 * OTEL_HOLD_MS;
        published.push(...promoteHeldUsage(db, deps));

        const finals = {
          day: projectInput(db),
          kid: sum(db, "SELECT t_input AS t FROM agents WHERE id = 'codex:root/kid'"),
          main: sum(db, "SELECT t_input AS t FROM agents WHERE id = 'codex:root/main'"),
          orphan: sum(db, "SELECT t_input AS t FROM sessions WHERE id = 'codex:kid'"),
        };
        if (finals.day !== 10 || finals.kid !== 10 || finals.main !== 0 || finals.orphan !== 0) {
          problems.push(`${label}: final ${JSON.stringify(finals)}`);
        }
        // No run retries a batch, so the published `usage` of each session equals its stored totals.
        for (const [sessionId, nativeId] of [
          ["codex:root", "root"],
          ["codex:kid", "kid"],
        ] as const) {
          const streamed = published
            .filter((e) => e.sessionId === nativeId && e.usage !== undefined)
            .reduce((acc, e) => acc + (e.usage?.input ?? 0), 0);
          const stored = sum(db, "SELECT t_input AS t FROM sessions WHERE id = ?", sessionId);
          if (streamed !== stored)
            problems.push(`${label}: ${sessionId} streamed ${streamed} != ${stored}`);
        }
        // `otelLateLinks` counts the thread link that moved usage: only when OTel usage preceded every link.
        const firstLink = Math.min(...LINKS.map((n) => order.indexOf(n)));
        const lateExpected = order.indexOf("usageOtel") < firstLink ? 1 : 0;
        if (stats(db).otelLateLinks !== lateExpected) {
          problems.push(
            `${label}: otelLateLinks ${stats(db).otelLateLinks}, expected ${lateExpected}`,
          );
        }
      }
    }
    expect(runs).toBe(5040);
    expect(problems).toEqual([]);
  }, 30_000); // 5040 runs with per-step invariants: ~4-5 s, far above bun's 5 s default under load

  test("a thread with no rollout loses nothing: OTel usage lands on the thread's agent, in any order", () => {
    // Covers: R37
    for (const order of permutations(["spawnOtel", "toolOtel", "usageOtel"])) {
      const db = freshDb();
      const clock: Clock = { t: T0 };
      const deps = clockDeps(clock);
      const lanes = childLanes();
      for (const name of order) ingest(db, deps, lanes[name]!);
      clock.t += 10 * OTEL_HOLD_MS;
      promoteHeldUsage(db, deps);
      const label = order.join(",");
      expect({
        label,
        day: projectInput(db),
        kid: sum(db, "SELECT t_input AS t FROM agents WHERE id = 'codex:root/kid'"),
        orphan: sum(db, "SELECT t_input AS t FROM sessions WHERE id = 'codex:kid'"),
      }).toEqual({ label, day: 10, kid: 10, orphan: 0 });
    }
  });
});
