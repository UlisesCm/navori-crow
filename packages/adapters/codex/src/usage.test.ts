/**
 * `mapCodexLine` usage cases (a)-(d) from design.md § Testing strategy
 * ("Acumulado heredado de un fork inflando tokens") plus the § Mapeo Codex
 * mapping rows: session_meta (main/subagent), `ordinal < historyStart`
 * skipping, the `user_message` dedupe window, `function_call`/`*_call_output`
 * pairing via `openCalls`, unknown types, and the no-`session_meta` fallback.
 *
 * Lines are synthetic (built from the shapes documented in design.md §
 * Evidencia "Codex CLI"): the real anonymized fixtures are B7.T2, out of
 * scope here.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { IngestErrorReason, LineResult, PartialCrowEvent } from "@crow/core";
import { createUlidFactory, getSessionDetail, ingestBatch, migrate } from "@crow/core";
import type { PendingEvent } from "@crow/core";
import { initialCodexState, mapCodexLine } from "./map-line";
import type { CodexState } from "./map-line";

const POS = { path: "/tmp/rollout.jsonl", offset: 0, line: 1 };

interface TotalsInput {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
}

function totals(t: TotalsInput): TotalsInput {
  return t;
}

function sessionMetaMain(id: string, cwd: string, ts: string): string {
  return JSON.stringify({ timestamp: ts, type: "session_meta", payload: { id, cwd }, ordinal: 0 });
}

function sessionMetaSubagent(opts: {
  id: string;
  sessionId: string;
  cwd: string;
  ts: string;
  role?: string;
  nickname?: string;
  other?: string;
  historyStart?: number;
  parentThreadId?: string;
  depth?: number;
}): string {
  const subagent =
    opts.other !== undefined
      ? { other: opts.other }
      : {
          thread_spawn: {
            agent_role: opts.role,
            agent_nickname: opts.nickname,
            parent_thread_id: opts.parentThreadId,
            depth: opts.depth,
          },
        };
  return JSON.stringify({
    timestamp: opts.ts,
    type: "session_meta",
    payload: {
      id: opts.id,
      session_id: opts.sessionId,
      cwd: opts.cwd,
      source: { subagent },
      subagent_history_start_ordinal: opts.historyStart,
    },
    ordinal: 0,
  });
}

function tokenCount(ts: string, ordinal: number, total: TotalsInput, last: TotalsInput): string {
  return JSON.stringify({
    timestamp: ts,
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last } },
    ordinal,
  });
}

function userMessage(ts: string, ordinal: number, text: string): string {
  return JSON.stringify({
    timestamp: ts,
    type: "event_msg",
    payload: { type: "user_message", message: text },
    ordinal,
  });
}

function responseItem(ts: string, ordinal: number, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: ts, type: "response_item", payload, ordinal });
}

/** Folds `mapCodexLine` over `lines`, asserting every line parses ok, and returns the stored events. */
function runOk(
  lines: string[],
  initial: CodexState,
): { events: PartialCrowEvent[]; state: CodexState } {
  let state = initial;
  const events: PartialCrowEvent[] = [];
  for (const line of lines) {
    const result: LineResult<CodexState> = mapCodexLine(line, state, POS);
    if (!result.ok) {
      throw new Error(`expected ok line, got ${result.reason}: ${result.detail ?? ""}`);
    }
    state = result.state;
    events.push(...result.events);
  }
  return { events, state };
}

describe("mapCodexLine: token baseline and regression (design.md D7 'Usage de Codex')", () => {
  test("(a) fresh fork: first total_token_usage equals last_token_usage, so the first usage equals last_token_usage", () => {
    // Covers: R14, R16
    const t = totals({
      input_tokens: 100,
      cached_input_tokens: 20,
      cache_write_input_tokens: 0,
      output_tokens: 30,
    });
    const lines = [
      sessionMetaSubagent({
        id: "thread-b",
        sessionId: "thread-a",
        cwd: "/tmp/crow-fixture/repo",
        ts: "2026-09-24T10:00:00.000Z",
        role: "reviewer",
        nickname: "Rev",
        historyStart: 5,
      }),
      // ordinal 1 < historyStart 5: inherited history, no event (design.md § Mapeo Codex row "ordinal < historyStart").
      responseItem("2026-09-24T10:00:01.000Z", 1, {
        type: "message",
        role: "assistant",
        id: "hist-1",
      }),
      tokenCount("2026-09-24T10:00:02.000Z", 6, t, t),
    ];
    const { events } = runOk(lines, initialCodexState("thread-b"));
    const usageEvents = events.filter(
      (e) => e.kind === "assistant.message" && e.usage !== undefined,
    );
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]!.usage).toEqual({
      input: 80,
      output: 30,
      cacheRead: 20,
      cacheCreation: 0,
    });
    // The inherited-history response_item produced no event (only the agent.start + this usage line did).
    expect(
      events.filter((e) => e.kind === "assistant.message" && e.text !== undefined),
    ).toHaveLength(0);
  });

  test("(b) fork with a carried-over accumulator: the first usage equals last_token_usage, not total_token_usage", () => {
    // Covers: R14
    const total = totals({
      input_tokens: 500_000,
      cached_input_tokens: 100_000,
      cache_write_input_tokens: 0,
      output_tokens: 80_000,
    });
    const last = totals({
      input_tokens: 1_000,
      cached_input_tokens: 200,
      cache_write_input_tokens: 0,
      output_tokens: 300,
    });
    const lines = [
      sessionMetaMain("thread-root", "/tmp/crow-fixture/repo", "2026-09-24T10:00:00.000Z"),
      tokenCount("2026-09-24T10:00:01.000Z", 1, total, last),
    ];
    const { events } = runOk(lines, initialCodexState("thread-root"));
    const usageEvent = events.find((e) => e.kind === "assistant.message" && e.usage !== undefined);
    expect(usageEvent?.usage).toEqual({
      input: 800,
      output: 300,
      cacheRead: 200,
      cacheCreation: 0,
    });
  });

  test("(c) repeated totals count once: a second token_count with the same total_token_usage emits no further usage", () => {
    // Covers: R14
    const t1 = totals({
      input_tokens: 100,
      cached_input_tokens: 10,
      cache_write_input_tokens: 0,
      output_tokens: 20,
    });
    const t2 = totals({
      input_tokens: 150,
      cached_input_tokens: 10,
      cache_write_input_tokens: 0,
      output_tokens: 40,
    });
    const lines = [
      sessionMetaMain("thread-root", "/tmp/crow-fixture/repo", "2026-09-24T10:00:00.000Z"),
      tokenCount("2026-09-24T10:00:01.000Z", 1, t1, t1),
      tokenCount("2026-09-24T10:00:02.000Z", 2, t2, t2), // grows: delta counted
      tokenCount("2026-09-24T10:00:03.000Z", 3, t2, t2), // repeated total: delta zero, no event
    ];
    const { events } = runOk(lines, initialCodexState("thread-root"));
    const usageEvents = events.filter(
      (e) => e.kind === "assistant.message" && e.usage !== undefined,
    );
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[0]!.usage).toEqual({
      input: 90,
      output: 20,
      cacheRead: 10,
      cacheCreation: 0,
    });
    // Delta of t2 vs t1: input 150-10=140 vs prior stored 90 -> new usage.input = (150-10)-90=50, output 40-20=20
    expect(usageEvents[1]!.usage).toEqual({
      input: 50,
      output: 20,
      cacheRead: 0,
      cacheCreation: 0,
    });
  });

  test("(d) a synthetic regression of the accumulator raises usage-anomaly and counts last_token_usage", () => {
    // Covers: R14
    const t1 = totals({
      input_tokens: 200,
      cached_input_tokens: 20,
      cache_write_input_tokens: 0,
      output_tokens: 50,
    });
    const regressed = totals({
      input_tokens: 100, // went backwards vs. t1.input
      cached_input_tokens: 20,
      cache_write_input_tokens: 0,
      output_tokens: 60,
    });
    const last = totals({
      input_tokens: 30,
      cached_input_tokens: 5,
      cache_write_input_tokens: 0,
      output_tokens: 10,
    });
    let state = initialCodexState("thread-root");
    const first = mapCodexLine(
      sessionMetaMain("thread-root", "/tmp/crow-fixture/repo", "2026-09-24T10:00:00.000Z"),
      state,
      POS,
    );
    if (!first.ok) throw new Error("expected ok");
    state = first.state;
    const baseline = mapCodexLine(tokenCount("2026-09-24T10:00:01.000Z", 1, t1, t1), state, POS);
    if (!baseline.ok) throw new Error("expected ok");
    state = baseline.state;

    const result = mapCodexLine(
      tokenCount("2026-09-24T10:00:02.000Z", 2, regressed, last),
      state,
      POS,
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.warnings).toEqual([
      {
        reason: "usage-anomaly" satisfies IngestErrorReason,
        detail: "codex token_count total_token_usage regressed against the tracked baseline",
      },
    ]);
    const usageEvent = result.events.find(
      (e) => e.kind === "assistant.message" && e.usage !== undefined,
    );
    expect(usageEvent?.usage).toEqual({ input: 25, output: 10, cacheRead: 5, cacheCreation: 0 });
  });
});

describe("mapCodexLine: session_meta, threads as agents of the root, and semanticKey identity", () => {
  test("main session_meta emits session.start; sessionId comes from payload.id", () => {
    // Covers: R14
    const { events } = runOk(
      [sessionMetaMain("thread-root", "/tmp/crow-fixture/repo", "2026-09-24T10:00:00.000Z")],
      initialCodexState("fallback-from-filename"),
    );
    expect(events).toEqual([
      expect.objectContaining({ kind: "session.start", sessionId: "thread-root", agentId: null }),
    ]);
  });

  test("a thread attached to the root (no parent_thread_id) emits agent.start with parentAgentId null and depth 1", () => {
    // Covers: R14
    const { events } = runOk(
      [
        sessionMetaSubagent({
          id: "thread-b",
          sessionId: "thread-a",
          cwd: "/tmp/crow-fixture/repo",
          ts: "2026-09-24T10:00:00.000Z",
          role: "reviewer",
          nickname: "Rev",
        }),
      ],
      initialCodexState("thread-b"),
    );
    expect(events).toEqual([
      expect.objectContaining({
        kind: "agent.start",
        sessionId: "thread-a",
        agentId: "thread-b",
        parentAgentId: null,
        agent: { depth: 1, type: "reviewer", description: "Rev" },
      }),
    ]);
  });

  test("a thread spawned by another thread (parent_thread_id != root session_id) emits agent.start with that parentAgentId and the field's own depth", () => {
    // Covers: R14
    const { events } = runOk(
      [
        sessionMetaSubagent({
          id: "thread-c",
          sessionId: "thread-a",
          cwd: "/tmp/crow-fixture/repo",
          ts: "2026-09-24T10:00:00.000Z",
          role: "reviewer",
          parentThreadId: "thread-b", // spawned by thread-b, not by the root (thread-a)
          depth: 3,
        }),
      ],
      initialCodexState("thread-c"),
    );
    expect(events).toEqual([
      expect.objectContaining({
        kind: "agent.start",
        sessionId: "thread-a",
        agentId: "thread-c",
        parentAgentId: "thread-b",
        agent: { depth: 3, type: "reviewer" },
      }),
    ]);
  });

  test("a nested thread with no explicit depth field falls back to depth 2", () => {
    // Covers: R14
    const { events } = runOk(
      [
        sessionMetaSubagent({
          id: "thread-c",
          sessionId: "thread-a",
          cwd: "/tmp/crow-fixture/repo",
          ts: "2026-09-24T10:00:00.000Z",
          role: "reviewer",
          parentThreadId: "thread-b",
        }),
      ],
      initialCodexState("thread-c"),
    );
    expect(events).toEqual([
      expect.objectContaining({
        kind: "agent.start",
        parentAgentId: "thread-b",
        agent: { depth: 2, type: "reviewer" },
      }),
    ]);
  });

  test("a parent_thread_id equal to the root session_id is treated as root-attached (parentAgentId null)", () => {
    // Covers: R14
    const { events } = runOk(
      [
        sessionMetaSubagent({
          id: "thread-b",
          sessionId: "thread-a",
          cwd: "/tmp/crow-fixture/repo",
          ts: "2026-09-24T10:00:00.000Z",
          role: "reviewer",
          parentThreadId: "thread-a", // same as the root session_id
        }),
      ],
      initialCodexState("thread-b"),
    );
    expect(events).toEqual([
      expect.objectContaining({
        kind: "agent.start",
        parentAgentId: null,
        agent: { depth: 1, type: "reviewer" },
      }),
    ]);
  });

  test("subagent session_meta with source.subagent.other ('guardian') uses it as the agent type", () => {
    // Covers: R14
    const { events } = runOk(
      [
        sessionMetaSubagent({
          id: "thread-g",
          sessionId: "thread-a",
          cwd: "/tmp/crow-fixture/repo",
          ts: "2026-09-24T10:00:00.000Z",
          other: "guardian",
        }),
      ],
      initialCodexState("thread-g"),
    );
    expect(events).toEqual([
      expect.objectContaining({
        kind: "agent.start",
        agentId: "thread-g",
        agent: { depth: 1, type: "guardian" },
      }),
    ]);
  });

  test("assistant response_item.message carries semanticKey id:<payload.id>:0", () => {
    // Covers: R16
    const lines = [
      sessionMetaMain("thread-root", "/tmp/crow-fixture/repo", "2026-09-24T10:00:00.000Z"),
      responseItem("2026-09-24T10:00:01.000Z", 1, {
        type: "message",
        role: "assistant",
        id: "msg_1",
        content: [{ type: "output_text", text: "hello" }],
      }),
    ];
    const { events } = runOk(lines, initialCodexState("thread-root"));
    const assistantEvent = events.find((e) => e.kind === "assistant.message" && e.text === "hello");
    expect(assistantEvent?.semanticKey).toBe("id:msg_1:0");
  });

  test("function_call / *_call_output pair via openCalls: tool.pre then tool.post with matching name and semanticKeys", () => {
    // Covers: R14, R16
    const lines = [
      sessionMetaMain("thread-root", "/tmp/crow-fixture/repo", "2026-09-24T10:00:00.000Z"),
      responseItem("2026-09-24T10:00:01.000Z", 1, {
        type: "function_call",
        call_id: "call-1",
        name: "shell",
        arguments: "{}",
      }),
      responseItem("2026-09-24T10:00:02.500Z", 2, {
        type: "function_call_output",
        call_id: "call-1",
        output: "ok",
      }),
    ];
    const { events } = runOk(lines, initialCodexState("thread-root"));
    const pre = events.find((e) => e.kind === "tool.pre");
    const post = events.find((e) => e.kind === "tool.post");
    expect(pre?.semanticKey).toBe("call:call-1");
    expect(pre?.tool).toEqual({ name: "shell", callId: "call-1", input: "{}" });
    expect(post?.semanticKey).toBe("out:call-1");
    expect(post?.tool).toEqual({ name: "shell", callId: "call-1", ms: 1500, ok: true });
  });

  test("a user_message reemitted within 1000ms with identical text reuses the earlier semanticKey", () => {
    // Covers: R16
    const lines = [
      sessionMetaMain("thread-root", "/tmp/crow-fixture/repo", "2026-09-24T10:00:00.000Z"),
      userMessage("2026-09-24T10:00:01.000Z", 1, "do the thing"),
      userMessage("2026-09-24T10:00:01.500Z", 2, "do the thing"), // 500ms later, same text
    ];
    const { events } = runOk(lines, initialCodexState("thread-root"));
    const prompts = events.filter((e) => e.kind === "prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts[0]!.semanticKey).toBe(prompts[1]!.semanticKey);
  });

  test("a user_message with identical text more than 1000ms apart gets its own semanticKey", () => {
    // Covers: R16
    const lines = [
      sessionMetaMain("thread-root", "/tmp/crow-fixture/repo", "2026-09-24T10:00:00.000Z"),
      userMessage("2026-09-24T10:00:01.000Z", 1, "do the thing"),
      userMessage("2026-09-24T10:00:05.000Z", 2, "do the thing"), // 4000ms later
    ];
    const { events } = runOk(lines, initialCodexState("thread-root"));
    const prompts = events.filter((e) => e.kind === "prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts[0]!.semanticKey).not.toBe(prompts[1]!.semanticKey);
  });
});

describe("mapCodexLine: errors and the no-session_meta fallback", () => {
  test("an unknown top-level type is reported as ingest.error unknown-type", () => {
    // Covers: R14
    const state = initialCodexState("thread-root");
    const line = JSON.stringify({
      timestamp: "2026-09-24T10:00:00.000Z",
      type: "not_a_real_type",
      payload: {},
    });
    const result = mapCodexLine(line, state, POS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unknown-type");
  });

  test("an unknown response_item subtype is reported as ingest.error unknown-type", () => {
    // Covers: R14
    const lines = [
      sessionMetaMain("thread-root", "/tmp/crow-fixture/repo", "2026-09-24T10:00:00.000Z"),
    ];
    let state = initialCodexState("thread-root");
    for (const line of lines) {
      const r = mapCodexLine(line, state, POS);
      if (!r.ok) throw new Error("expected ok");
      state = r.state;
    }
    const result = mapCodexLine(
      responseItem("2026-09-24T10:00:01.000Z", 1, { type: "reasoning" }),
      state,
      POS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unknown-type");
  });

  test("without a preceding session_meta, sessionId falls back to the file-derived id and no cwd is ever set", () => {
    // Covers: R14
    const state = initialCodexState("thread-from-filename");
    const line = userMessage("2026-09-24T10:00:00.000Z", 0, "hi");
    const result = mapCodexLine(line, state, POS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.events[0]!.sessionId).toBe("thread-from-filename");
      expect(result.events[0]!.cwd).toBeUndefined();
    }
  });
});

describe("ingestBatch: a nested Codex thread links to its real parent regardless of file processing order", () => {
  function pending(event: PartialCrowEvent, path: string, offset: number): PendingEvent {
    return {
      engine: "codex",
      source: "transcript",
      lineHash: `hash-${path}-${offset}`,
      part: "0",
      pos: { path, offset, line: 1 },
      event,
    };
  }

  test("a child thread ingested before its parent's own file still ends up with the right parent_id (design.md D7-style order independence)", () => {
    // Covers: R14
    const db = new Database(":memory:");
    migrate(db);
    const now = Date.parse("2026-09-24T10:00:00.000Z");
    const deps = {
      nextId: createUlidFactory("00000000000000000000000000", () => now),
      now: () => now,
      idleMs: 5 * 60_000,
    };

    // thread-c is a grandchild spawned by thread-b, which is itself spawned by the root (thread-a).
    const rootMeta = mapCodexLine(
      sessionMetaMain("thread-a", "/tmp/crow-fixture/repo", "2026-09-24T10:00:00.000Z"),
      initialCodexState("thread-a"),
      POS,
    );
    if (!rootMeta.ok) throw new Error("expected ok");
    const childMeta = mapCodexLine(
      sessionMetaSubagent({
        id: "thread-c",
        sessionId: "thread-a",
        cwd: "/tmp/crow-fixture/repo",
        ts: "2026-09-24T10:00:01.000Z",
        role: "worker",
        parentThreadId: "thread-b",
        depth: 3,
      }),
      initialCodexState("thread-c"),
      POS,
    );
    if (!childMeta.ok) throw new Error("expected ok");
    const parentMeta = mapCodexLine(
      sessionMetaSubagent({
        id: "thread-b",
        sessionId: "thread-a",
        cwd: "/tmp/crow-fixture/repo",
        ts: "2026-09-24T10:00:02.000Z",
        role: "reviewer",
      }),
      initialCodexState("thread-b"),
      POS,
    );
    if (!parentMeta.ok) throw new Error("expected ok");

    // Ingest the child's file (thread-c.jsonl) BEFORE the parent's (thread-b.jsonl): the child's
    // agent.start arrives with parentAgentId "thread-b" while no row for "thread-b" exists yet.
    ingestBatch(db, deps, {
      path: "/root/thread-a.jsonl",
      inode: "1",
      nextOffset: 1,
      state: null,
      events: [pending(rootMeta.events[0]!, "/root/thread-a.jsonl", 0)],
    });
    ingestBatch(db, deps, {
      path: "/root/thread-c.jsonl",
      inode: "3",
      nextOffset: 1,
      state: null,
      events: [pending(childMeta.events[0]!, "/root/thread-c.jsonl", 0)],
    });
    ingestBatch(db, deps, {
      path: "/root/thread-b.jsonl",
      inode: "2",
      nextOffset: 1,
      state: null,
      events: [pending(parentMeta.events[0]!, "/root/thread-b.jsonl", 0)],
    });

    const sessionRow = db.query<{ id: string }, []>("SELECT id FROM sessions LIMIT 1").get();
    if (sessionRow === null) throw new Error("expected a session row");
    const detail = getSessionDetail(db, sessionRow.id);
    if (detail === null) throw new Error("expected a session detail");

    const child = detail.agents.find((a) => a.agentId === "thread-c");
    const parent = detail.agents.find((a) => a.agentId === "thread-b");
    expect(child?.parentAgentId).toBe("thread-b");
    expect(parent?.parentAgentId).toBeNull();
  });
});
