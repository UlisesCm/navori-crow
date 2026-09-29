/**
 * Runs the real, anonymized Codex rollouts under `fixtures/codex/` through the real B3 tailer
 * pipeline (`processFile`) with the real Codex adapter (R14, R4, R20, R21).
 *
 * The fixtures are real captures, only anonymized and trimmed to their first `token_count`s, so they
 * pin what Codex actually emits — including where it departs from `design.md`. Every departure found
 * is documented inline and in `.claude/progress/impl_f1-b7t2-contract.md`.
 */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { CrowEvent, EventBus as EventBusType } from "@crow/core";
import {
  EventBus,
  createUlidFactory,
  getSessionDetail,
  loadConfig,
  migrate,
  processFile,
  stats,
} from "@crow/core";
import { codexAdapter } from "./adapter";

const FIXTURES = join(import.meta.dir, "..", "..", "..", "..", "fixtures", "codex");
const NOW = Date.parse("2026-09-24T10:00:00.000Z");

/** `<FIXTURES>/<version>/2025/12/31/rollout-<stamp>-<id>.jsonl` */
const FILES = {
  "0.145.0": {
    main: "rollout-2025-12-31T17-59-21-id0.jsonl",
    carriedFork: "rollout-2025-12-31T18-19-53-id19.jsonl",
    main2: "rollout-2025-12-31T18-40-53-id23.jsonl",
    freshFork: "rollout-2025-12-31T18-40-58-id32.jsonl",
  },
  "0.155.1": {
    main: "rollout-2025-12-31T17-50-01-id0.jsonl",
    fork: "rollout-2025-12-31T23-59-41-id30.jsonl",
    guardian: "rollout-2025-12-31T23-59-41-id70.jsonl",
  },
  "0.146.0-alpha.3.1": { main: "rollout-2025-12-31T17-59-59-id0.jsonl" },
} as const;

function root(version: keyof typeof FILES): string {
  return join(FIXTURES, version);
}

function pathOf(version: keyof typeof FILES, file: string): string {
  return join(root(version), "2025", "12", "31", file);
}

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

async function ingest(
  db: Database,
  bus: EventBusType,
  version: keyof typeof FILES,
  file: string,
): Promise<CrowEvent[]> {
  const path = pathOf(version, file);
  const match = codexAdapter.matches(path, root(version));
  if (match === null) throw new Error(`fixture path did not match the adapter: ${path}`);
  const result = await processFile({
    db,
    bus,
    adapter: codexAdapter,
    path,
    match,
    nextId: createUlidFactory("00000000000000000000000000", () => NOW),
    now: () => NOW,
    idleMs: 5 * 60_000,
  });
  return result.events;
}

/** Sorted, compact view of a session's agent rows — stable across runs. */
function agentTree(db: Database, nativeId: string): unknown[] {
  const detail = getSessionDetail(db, `codex:${nativeId}`);
  expect(detail).not.toBeNull();
  return detail!.agents
    .slice()
    .sort((a, b) => (a.agentId ?? "").localeCompare(b.agentId ?? ""))
    .map((a) => ({
      agentId: a.agentId,
      parentAgentId: a.parentAgentId,
      type: a.type,
      hasStart: a.startedAt !== null,
      input: a.totals.input,
      output: a.totals.output,
      cacheRead: a.totals.cacheRead,
    }));
}

function countByKind(events: CrowEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) out[e.kind] = (out[e.kind] ?? 0) + 1;
  return out;
}

describe("codex contract: real 0.155.1 fixture through the real pipeline", () => {
  test("thread_spawn fork and guardian map to their own agentId, parent and depth (R14)", async () => {
    // Covers: R14
    const db = freshDb();
    const bus = new EventBus();
    const files = FILES["0.155.1"];
    const mainEvents = await ingest(db, bus, "0.155.1", files.main);
    const forkEvents = await ingest(db, bus, "0.155.1", files.fork);
    const guardianEvents = await ingest(db, bus, "0.155.1", files.guardian);

    // Main: a root session, no agent.start.
    expect(mainEvents.filter((e) => e.kind === "session.start")).toHaveLength(1);
    expect(mainEvents.every((e) => e.sessionId === "id0" && e.agentId === null)).toBe(true);

    // `thread_spawn` fork id30: session_meta.payload.source.subagent.thread_spawn.{parent_thread_id,
    // depth} = {"id0", 1}; the parent is the root session itself, so `parentAgentId` stays null.
    const forkStart = forkEvents.filter((e) => e.kind === "agent.start");
    expect(forkStart).toHaveLength(1);
    expect(forkStart[0]).toMatchObject({
      sessionId: "id0",
      agentId: "id30",
      parentAgentId: null,
      agent: { depth: 1, type: "reviewer" },
    });

    // `guardian` id70 has no `thread_spawn`: its parent (id30, a thread, not the root) is only at the
    // top-level `payload.parent_thread_id`, so it nests one level under id30 (depth falls back to 2).
    const guardianStart = guardianEvents.filter((e) => e.kind === "agent.start");
    expect(guardianStart).toHaveLength(1);
    expect(guardianStart[0]).toMatchObject({
      sessionId: "id0",
      agentId: "id70",
      parentAgentId: "id30",
      agent: { depth: 2, type: "guardian" },
    });

    // Every event of a thread file is attributed to that thread, not to the root.
    expect(forkEvents.every((e) => e.agentId === "id30")).toBe(true);
    expect(guardianEvents.every((e) => e.agentId === "id70")).toBe(true);
  });

  test("id30 skips its inherited ordinals 1..40 (copied session_meta at ordinal 1) and ingests from 41 (R14)", async () => {
    // Covers: R14
    const db = freshDb();
    const bus = new EventBus();
    const files = FILES["0.155.1"];
    const mainEvents = await ingest(db, bus, "0.155.1", files.main);
    const forkEvents = await ingest(db, bus, "0.155.1", files.fork);

    // Raw oracle: id30 has two `session_meta` (its own at ordinal 0, the parent's copy at ordinal 1) and
    // `subagent_history_start_ordinal: 41`. Lines 2..40 are inherited assistant messages / tool calls.
    const raw = readFileSync(pathOf("0.155.1", files.fork), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l): { ordinal: number; type: string; role?: string } => {
        const o = JSON.parse(l);
        return { ordinal: o.ordinal, type: o.type, role: o.payload?.role };
      });
    expect(raw.filter((r) => r.type === "session_meta").map((r) => r.ordinal)).toEqual([0, 1]);
    const inheritedAssistant = raw.filter(
      (r) => r.ordinal < 41 && r.type === "response_item" && r.role === "assistant",
    );
    expect(inheritedAssistant.length).toBeGreaterThan(0);

    // Nothing of the copies becomes an event: the fork has one agent.start (its own), no session.start,
    // and every assistant message with text (only inherited ones carry text here) is absent.
    expect(forkEvents.filter((e) => e.kind === "session.start")).toHaveLength(0);
    expect(forkEvents.filter((e) => e.kind === "agent.start")).toHaveLength(1);
    expect(
      forkEvents.filter((e) => e.kind === "assistant.message" && e.text !== undefined),
    ).toHaveLength(0);
    // Its own lines (ordinal >= 41) do ingest: 5 tool calls and 5 usages.
    expect(forkEvents.filter((e) => e.kind === "tool.pre")).toHaveLength(5);
    expect(
      forkEvents.filter((e) => e.kind === "assistant.message" && e.usage !== undefined),
    ).toHaveLength(5);
    // The fork's tool calls are its own, never the parent's copies.
    const mainCalls = new Set(mainEvents.map((e) => e.tool?.callId).filter((c) => c !== undefined));
    for (const e of forkEvents) {
      if (e.tool?.callId !== undefined) expect(mainCalls.has(e.tool.callId)).toBe(false);
    }
    expect(stats(db).semanticDuplicates).toBe(0);
  });

  test("a fork with a single session_meta (guardian id70, start ordinal 14) ingests all its lines (R14, R4)", async () => {
    // Covers: R14, R4
    const db = freshDb();
    const bus = new EventBus();
    const events = await ingest(db, bus, "0.155.1", FILES["0.155.1"].guardian);
    const usages = events.filter((e) => e.kind === "assistant.message" && e.usage !== undefined);
    expect(usages).toHaveLength(1);
    // token_count at ordinal 12 (< start ordinal 14): first total == last.
    expect(usages[0]!.usage).toMatchObject({ input: 19406, output: 164, cacheRead: 4864 });
  });

  test("project root resolves from CODEX_HOME, watching <CODEX_HOME>/sessions (R14)", () => {
    // Covers: R14
    expect(
      codexAdapter.watchRoots(loadConfig({ CODEX_HOME: "/tmp/crow-fixture/codex" }, "/h")),
    ).toEqual(["/tmp/crow-fixture/codex/sessions"]);
    expect(codexAdapter.watchRoots(loadConfig({}, "/h"))).toEqual(["/h/.codex/sessions"]);
  });

  test("stable summary snapshot", async () => {
    // Covers: R14
    const db = freshDb();
    const bus = new EventBus();
    const files = FILES["0.155.1"];
    const all = [
      ...(await ingest(db, bus, "0.155.1", files.main)),
      ...(await ingest(db, bus, "0.155.1", files.fork)),
      ...(await ingest(db, bus, "0.155.1", files.guardian)),
    ];
    // Real rollouts carry `response_item.reasoning`/`agent_message`/`tool_search_*`: known, no event.
    expect({
      eventCountsByKind: countByKind(all),
      agents: agentTree(db, "id0"),
      ingestErrorCountsByReason: stats(db).errorsByReason,
    }).toMatchSnapshot();
  });
});

describe("codex contract: real 0.145.0 fixture through the real pipeline", () => {
  test("mains map to a session; thread_spawn forks map to their own agentId and depth (R14)", async () => {
    // Covers: R14
    const db = freshDb();
    const bus = new EventBus();
    const files = FILES["0.145.0"];
    const main = await ingest(db, bus, "0.145.0", files.main);
    const main2 = await ingest(db, bus, "0.145.0", files.main2);
    const carried = await ingest(db, bus, "0.145.0", files.carriedFork);
    const fresh = await ingest(db, bus, "0.145.0", files.freshFork);

    expect(main.filter((e) => e.kind === "session.start")[0]?.sessionId).toBe("id0");
    expect(main2.filter((e) => e.kind === "session.start")[0]?.sessionId).toBe("id23");
    expect(carried.find((e) => e.kind === "agent.start")).toMatchObject({
      sessionId: "id0",
      agentId: "id19",
      parentAgentId: null,
      agent: { depth: 1 },
    });
    expect(fresh.find((e) => e.kind === "agent.start")).toMatchObject({
      sessionId: "id23",
      agentId: "id32",
      parentAgentId: null,
      agent: { depth: 1 },
    });
  });

  test("forks with a single session_meta keep their own usage despite subagent_history_start_ordinal (R14, R4)", async () => {
    // Covers: R14, R4
    // id19 (start ordinal 111) and id32 (26) carry no copied history: their token_counts (ordinals
    // 7..13 and 20/24) are their own and all count.
    const db = freshDb();
    const bus = new EventBus();
    const files = FILES["0.145.0"];
    await ingest(db, bus, "0.145.0", files.main);
    await ingest(db, bus, "0.145.0", files.carriedFork);
    await ingest(db, bus, "0.145.0", files.main2);
    await ingest(db, bus, "0.145.0", files.freshFork);
    const perAgent = (nativeId: string, agentId: string) =>
      getSessionDetail(db, `codex:${nativeId}`)!.agents.find((a) => a.agentId === agentId)!.totals;
    const carried = perAgent("id0", "id19");
    expect([carried.input, carried.output, carried.cacheRead]).toEqual([8609, 4086, 596_736]);
    const fresh = perAgent("id23", "id32");
    expect([fresh.input, fresh.output, fresh.cacheRead]).toEqual([23_226, 200, 15_104]);
  });

  test("mains: stable summary snapshot", async () => {
    // Covers: R14
    const db = freshDb();
    const bus = new EventBus();
    const files = FILES["0.145.0"];
    const all = [
      ...(await ingest(db, bus, "0.145.0", files.main)),
      ...(await ingest(db, bus, "0.145.0", files.main2)),
    ];
    expect({
      eventCountsByKind: countByKind(all),
      sessions: [agentTree(db, "id0"), agentTree(db, "id23")],
      ingestErrorCountsByReason: stats(db).errorsByReason,
    }).toMatchSnapshot();
  });
});

describe("codex contract: real 0.146.0-alpha.3.1 fixture", () => {
  // Moved to B7.T3 (tasks.md): fixture/design contradiction, see .claude/progress/impl_f1-b7t2-contract.md:
  // design.md § Testing strategy (identity (e)) and "Fixtures que hay que crear" item 3 expect a real
  // re-emitted `event_msg.user_message` pair, but NO fixture under fixtures/codex/ contains a
  // `user_message` line at all. This capture delivers its 5 prompts as `event_msg.item_completed`
  // (`item.type: "UserMessage"`) plus `response_item.message` role `user`, neither of which the
  // adapter maps to a `prompt` (design: prompt = `event_msg.user_message`), so the dedupe window
  // can't be exercised on real data.
  test.todo("B7.T3: the re-emitted user_message block is stored once (semanticDuplicates = 1)", () => {});

  test("ingests the whole file without invalid-json/bad-shape errors and without semantic duplicates (R14)", async () => {
    // Covers: R14
    const db = freshDb();
    const bus = new EventBus();
    const events = await ingest(db, bus, "0.146.0-alpha.3.1", FILES["0.146.0-alpha.3.1"].main);
    const ingestStats = stats(db);
    expect(events.filter((e) => e.kind === "session.start")).toHaveLength(1);
    // 46 assistant `response_item.message` lines, each its own `id:<payload.id>:0`, plus one usage.
    expect(events.filter((e) => e.kind === "assistant.message")).toHaveLength(47);
    expect(ingestStats.semanticDuplicates).toBe(0);
    expect(ingestStats.errorsByReason["invalid-json"]).toBeUndefined();
    expect(ingestStats.errorsByReason["bad-shape"]).toBeUndefined();
  });
});
