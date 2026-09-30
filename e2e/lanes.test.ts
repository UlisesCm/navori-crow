/**
 * Three lanes, one session (G5b): the Codex session captured in B0 (`fixtures/codex/0.158.0`:
 * two rollouts, 17 hook payloads, one OTLP export) delivered through the real adapters and the
 * real OTLP router into the store, in seeded random order. The rollout files keep their line
 * order (a tailer reads them sequentially); every hook payload and every OTLP record is an
 * independent delivery, and a promotion sweep (D6) fires at a random point of the run.
 */
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BoundAdapter, CrowEvent, EngineAdapter, JsonValue } from "@crow/core";
import { bindAdapter } from "@crow/core";
import { codexAdapter } from "@crow/adapter-codex";
import { EpisodeLimiter, routeOtel } from "../apps/server/src/otlp-route";
import { createUlidFactory } from "../packages/core/src/ulid";
import { OTEL_HOLD_MS, promoteHeldUsage } from "../packages/core/src/store/store";
import type { IngestBatchDeps, PendingEvent } from "../packages/core/src/store/store";
import { freshDb, IDLE_MS, ingest, T0 } from "../packages/core/src/store/testing";
import { flattenOtlp } from "../packages/otlp/src/flatten";

const SESSION_DIR = join(import.meta.dir, "..", "fixtures", "codex", "0.158.0");
const ROLLOUTS = [
  "2025/12/31/rollout-2025-12-31T17-59-59-id0.jsonl",
  "2025/12/31/rollout-2025-12-31T18-00-14-id7.jsonl",
];
const ROOT = "codex:id0";
/** Epoch of the capture (`2026-01-01T00:00:00Z`, the anonymizer's fixed instant). */
const EPOCH = Date.parse("2026-01-01T00:00:00.000Z");
const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);

const codex: BoundAdapter = bindAdapter(codexAdapter as EngineAdapter<JsonValue>);
const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex");

/** Deterministic PRNG (mulberry32): a failing seed reproduces exactly. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lines = (path: string): string[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l !== "");

/** A delivery: the events one line, hook payload or OTLP record produces, committed together. */
type Delivery = PendingEvent[];

/** One rollout as an ordered stream of deliveries, through `parseLine` exactly as the tailer does. */
function rolloutStream(rel: string): Delivery[] {
  const path = join(SESSION_DIR, rel);
  const match = codex.matches(rel.replace(/^/, `${SESSION_DIR}/`), SESSION_DIR);
  if (match === null) throw new Error(`rollout path not matched: ${rel}`);
  let state = codex.initialState(match, null);
  let offset = 0;
  return lines(path).map((line, i) => {
    const pos = { path, offset, line: i + 1 };
    offset += line.length + 1;
    const res = codex.parseLine(line, state, pos);
    state = res.state;
    if (!res.ok) throw new Error(`${rel}:${i + 1} did not parse: ${res.reason}`);
    return res.events.map((event, part) => ({
      engine: "codex",
      source: "transcript" as const,
      lineHash: sha1(line),
      part: String(part),
      pos,
      event,
    }));
  });
}

/** Where each hook lands on the capture's timeline (hooks carry no timestamp: it is the receipt time). */
const HOOK_AT: Record<string, number> = {
  SessionStart: 250,
  UserPromptSubmit: 1955,
  SubagentStart: 15_200,
  SubagentStop: 23_300,
  SessionEnd: 27_600,
};

const otelRecords = (() => {
  const body: unknown = JSON.parse(readFileSync(join(SESSION_DIR, "otlp-logs.jsonl"), "utf8"));
  const flat = flattenOtlp("logs", body, { now: EPOCH });
  if (flat === null) throw new Error("otlp-logs.jsonl is not an OTLP logs body");
  return flat.records;
})();

/** Receipt time of a tool hook = the OTel decision/result of the same call (`tool_use_id` = `call_id`). */
function toolHookAt(callId: string, phase: "PreToolUse" | "PostToolUse"): number {
  const name = phase === "PreToolUse" ? "codex.tool_decision" : "codex.tool_result";
  const r =
    otelRecords.find((x) => x.name === name && x.attrs.call_id === callId) ??
    otelRecords.find((x) => x.attrs.call_id === callId);
  return r?.ts ?? EPOCH + 5000;
}

/**
 * The anonymizer numbers its `«str:n»` markers per file, so the same real prompt reads differently in
 * the rollout and in the hook. Both lanes saw one prompt: the hook is given the rollout's text so the
 * cross-lane fingerprint (sha1 of the text) can match, as it does for real content.
 */
function rolloutPromptText(): string {
  for (const line of lines(join(SESSION_DIR, ROLLOUTS[0]!))) {
    const item = (
      JSON.parse(line) as {
        payload?: { item?: { type?: string; content?: unknown } };
      }
    ).payload?.item;
    const first = Array.isArray(item?.content)
      ? (item.content[0] as { text?: unknown })
      : undefined;
    if (item?.type === "UserMessage" && typeof first?.text === "string") return first.text;
  }
  throw new Error("no UserMessage in the main rollout");
}

function hookDeliveries(): Delivery[] {
  const promptText = rolloutPromptText();
  return lines(join(SESSION_DIR, "hooks.jsonl")).map((line, i) => {
    const body = JSON.parse(line) as Record<string, unknown>;
    if (body.hook_event_name === "UserPromptSubmit") body.prompt = promptText;
    const name = String(body.hook_event_name);
    const receivedAt =
      HOOK_AT[name] !== undefined
        ? EPOCH + HOOK_AT[name]
        : toolHookAt(String(body.tool_use_id), name as "PreToolUse" | "PostToolUse");
    const res = codex.fromHook!({ body, receivedAt });
    if (!res.ok) throw new Error(`hook ${i} did not map: ${res.reason}`);
    return res.events.map((event, part) => ({
      engine: "codex",
      source: "hook" as const,
      lineHash: sha1(line),
      part: String(part),
      pos: { path: "hook:codex", offset: i, line: 1 },
      event,
    }));
  });
}

/** Each OTLP record is its own delivery, routed through the server's real `routeOtel`. */
function otelDeliveries(): Delivery[] {
  const limiter = new EpisodeLimiter();
  return otelRecords
    .map((record) => routeOtel([record], [codex], limiter, EPOCH).events)
    .filter((d) => d.length > 0);
}

interface Plan {
  ordered: Delivery[][];
  free: Delivery[];
}

const PLAN: Plan = {
  ordered: ROLLOUTS.map(rolloutStream),
  free: [...hookDeliveries(), ...otelDeliveries()],
};

/**
 * Seeded random merge: ordered streams keep their internal order, free deliveries go anywhere.
 * OTLP deliveries are released only after the subagent's rollout has started (its `agent.start`
 * is the first line of the last ordered stream): the store links a child's `conversation.id` to its
 * root through that row, and the opposite order is the residual limit (pinned in `store.test.ts`).
 */
function shuffle(plan: Plan, rnd: () => number): Delivery[] {
  const child = plan.ordered.length - 1;
  const queues: Delivery[][] = [...plan.ordered.map((s) => [...s]), ...plan.free.map((d) => [d])];
  const childStarted = (): boolean => queues[child]!.length < plan.ordered[child]!.length;
  const out: Delivery[] = [];
  for (;;) {
    const live = queues.filter(
      (q) => q.length > 0 && (q[0]![0]?.source !== "otel" || childStarted()),
    );
    if (live.length === 0) return out;
    const q = live[Math.floor(rnd() * live.length)]!;
    out.push(q.shift()!);
  }
}

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

/** Runs `order` into a fresh store; a promotion sweep after `sweepAfter` deliveries and one at the end. */
function run(order: readonly Delivery[], sweepAfter: number): Database {
  const db = freshDb();
  const clock: Clock = { t: T0 };
  const deps = clockDeps(clock);
  order.forEach((delivery, i) => {
    ingest(db, deps, ...delivery);
    if (i + 1 === sweepAfter) {
      clock.t += OTEL_HOLD_MS + 1;
      promoteHeldUsage(db, deps);
    }
  });
  clock.t += 10 * OTEL_HOLD_MS;
  promoteHeldUsage(db, deps);
  return db;
}

interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

function totals(db: Database): Totals {
  const row = db
    .query<Totals, [string]>(
      `SELECT t_input AS input, t_output AS output, t_cache_read AS cacheRead,
              t_cache_creation AS cacheCreation FROM sessions WHERE id = ?`,
    )
    .get(ROOT);
  if (row === null) throw new Error(`no session ${ROOT}`);
  return row;
}

function facts(db: Database, session = ROOT): CrowEvent[] {
  return db
    .query<{ body_json: string }, [string]>(
      "SELECT body_json FROM events WHERE session_id = ? AND kind != 'revision' ORDER BY id ASC",
    )
    .all(session)
    .map((r) => JSON.parse(r.body_json) as CrowEvent);
}

/** One label per logical fact of the timeline, so two runs compare as multisets. */
function factLabels(list: readonly CrowEvent[]): string[] {
  return list
    .filter((e) => e.kind !== "usage" && e.kind !== "ingest.error")
    .map((e) => `${e.kind}|${e.agentId ?? "main"}|${e.tool?.callId ?? e.agent?.type ?? ""}`)
    .sort();
}

// Reference: the transcript lane alone (what F1 would count).
const TRANSCRIPT_ONLY = run(
  PLAN.ordered.flatMap((s) => s),
  0,
);
const EXPECTED = totals(TRANSCRIPT_ONLY);

describe("three lanes over the B0 Codex session, random delivery order", () => {
  test("the capture has all three lanes and real usage", () => {
    // Covers: R11, R12
    expect(PLAN.free.some((d) => d[0]?.source === "hook")).toBe(true);
    expect(PLAN.free.some((d) => d[0]?.source === "otel")).toBe(true);
    expect(EXPECTED.input + EXPECTED.cacheRead).toBeGreaterThan(0);
  });

  test("usage is counted once whatever the order and the sweep point (R11, R12)", () => {
    // Covers: R11, R12
    for (const seed of SEEDS) {
      const rnd = prng(seed);
      const order = shuffle(PLAN, rnd);
      const db = run(order, Math.floor(rnd() * order.length));
      expect({ seed, ...totals(db) }).toEqual({ seed, ...EXPECTED });
    }
  });

  test("OTel alone counts its usage after the hold; a later transcript replaces it with no double count (R12)", () => {
    // Covers: R12
    const otel = PLAN.free.filter((d) => d[0]?.source === "otel");
    const transcript = PLAN.ordered.flat();
    const otelOnly = totals(run(otel, 0));
    expect(otelOnly.input + otelOnly.cacheRead).toBeGreaterThan(0);
    // OTel first, promoted (counted) at the sweep, then the whole transcript arrives.
    const counted = run([...otel, ...transcript], otel.length);
    expect(totals(counted)).toEqual(EXPECTED);
  });

  test("the timeline has one entry per logical fact in every order (R13)", () => {
    // Covers: R13
    const reference = factLabels(facts(run(shuffle(PLAN, prng(1000)), 0)));
    for (const seed of SEEDS) {
      const rnd = prng(seed);
      const order = shuffle(PLAN, rnd);
      const labels = factLabels(facts(run(order, Math.floor(rnd() * order.length))));
      expect({ seed, labels }).toEqual({ seed, labels: reference });
    }
  });

  test("main-session facts: each tool call, the prompt, session start and end appear exactly once (R13)", () => {
    // Covers: R13
    const list = facts(run(shuffle(PLAN, prng(7)), 0));
    const count = (pred: (e: CrowEvent) => boolean): number => list.filter(pred).length;
    for (const kind of ["prompt", "session.start", "session.end"] as const) {
      expect({ kind, n: count((e) => e.kind === kind) }).toEqual({
        kind,
        n: 1,
      });
    }
    const perCall = new Map<string, number>();
    for (const e of list) {
      if ((e.kind === "tool.pre" || e.kind === "tool.post") && e.tool?.callId !== undefined) {
        const key = `${e.kind}:${e.tool.callId}`;
        perCall.set(key, (perCall.get(key) ?? 0) + 1);
      }
    }
    expect(perCall.size).toBeGreaterThan(0);
    for (const [key, n] of perCall) expect({ key, n }).toEqual({ key, n: 1 });
  });

  test("a subagent's OTLP records land on the root session once its rollout has started (R13)", () => {
    // Covers: R13
    // fromOtel is stateless; the store links `conversation.id` id7 to its parent through the `agents`
    // row the child's rollout created. Precondition: rollout before OTLP (the reverse order is the
    // residual limit, pinned in store.test.ts); `shuffle` keeps that precondition.
    for (const seed of SEEDS) {
      const db = run(shuffle(PLAN, prng(seed)), 0);
      expect({ seed, orphan: facts(db, "codex:id7") }).toEqual({
        seed,
        orphan: [],
      });
      const orphanSession = db.query("SELECT 1 FROM sessions WHERE id = 'codex:id7'").get();
      expect({ seed, orphanSession }).toEqual({ seed, orphanSession: null });
      expect(facts(db, ROOT).some((e) => e.source === "otel")).toBe(true);
    }
  });

  test("OTel adds no content: no fact of any lane holds a prompt or tool output from OTLP (R24)", () => {
    // Covers: R24
    const db = run(shuffle(PLAN, prng(3)), 0);
    const otelRows = db
      .query<{ body_json: string }, []>("SELECT body_json FROM events WHERE source = 'otel'")
      .all();
    expect(otelRows.length).toBeGreaterThan(0);
    for (const r of otelRows) expect(r.body_json).not.toContain("«");
  });
});

describe("Codex exec container versus its nested exec_command", () => {
  test("a Bash command is two facts: transcript+otel container, hook+otel item; never fused (R11)", () => {
    // Covers: R11
    // In Codex >= 0.155 a rollout `exec` (keyed by `call_id`) contains an `exec_command` item whose
    // `item.id` is the hook's `tool_use_id`: two real calls with nested durations, not a duplicate.
    const itemIds = new Set(
      hookDeliveries()
        .flat()
        .filter((p) => p.event.tool?.name === "Bash" && p.event.tool.callId !== undefined)
        .map((p) => p.event.tool!.callId as string),
    );
    expect(itemIds.size).toBeGreaterThan(0);
    const srcs = (e: CrowEvent): string => [...(e.sources ?? [e.source])].sort().join("+");
    for (const seed of SEEDS) {
      const rnd = prng(seed);
      const order = shuffle(PLAN, rnd);
      const post = facts(run(order, Math.floor(rnd() * order.length))).filter(
        (e) => e.kind === "tool.post" && e.tool?.callId !== undefined,
      );
      const items = post.filter((e) => itemIds.has(e.tool!.callId!));
      const containers = post.filter((e) => e.tool!.name === "exec");
      expect({ seed, items: items.length }).toEqual({
        seed,
        items: itemIds.size,
      });
      expect({ seed, containers: containers.length }).toEqual({
        seed,
        containers: itemIds.size,
      });
      for (const i of items) {
        expect({ seed, id: i.tool!.callId, sources: srcs(i) }).toEqual({
          seed,
          id: i.tool!.callId,
          sources: "hook+otel",
        });
      }
      for (const c of containers) {
        expect({ seed, id: c.tool!.callId, sources: srcs(c) }).toEqual({
          seed,
          id: c.tool!.callId,
          sources: "otel+transcript",
        });
      }
      const itemIdSet = new Set(items.map((e) => e.tool!.callId));
      expect({
        seed,
        shared: containers.filter((c) => itemIdSet.has(c.tool!.callId)).length,
      }).toEqual({
        seed,
        shared: 0,
      });
      const ms = (list: CrowEvent[]): number[] =>
        list.map((e) => e.tool!.ms ?? -1).sort((a, b) => a - b);
      const cm = ms(containers);
      const im = ms(items);
      expect({ seed, missing: im.includes(-1) }).toEqual({
        seed,
        missing: false,
      });
      im.forEach((v, k) => expect({ seed, k, ok: cm[k]! >= v }).toEqual({ seed, k, ok: true }));
    }
  });
});
