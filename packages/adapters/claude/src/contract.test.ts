/**
 * Runs the real, anonymized Claude Code 2.1.281 fixture
 * (`fixtures/claude/cc-2.1.281/-tmp-crow-fixture-demo/`) through the real B3
 * tailer pipeline (`processFile`) with the real Claude adapter (R11, R12).
 *
 * The fixture was captured from a real session and only anonymized (never
 * hand-written), so it exercises whatever the current Claude Code build
 * actually emits — including shapes `design.md`'s Mapeo Claude table was
 * written against an older capture and doesn't cover. Any drift found here
 * is documented inline and in `.claude/progress/impl_f1-b4t3-contract.md`.
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
  isRec,
  migrate,
  processFile,
  stats,
} from "@crow/core";
import { claudeAdapter } from "./adapter";

const FIXTURE_ROOT = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "fixtures",
  "claude",
  "cc-2.1.281",
);
const SLUG = "-tmp-crow-fixture-demo";
const SESSION_ID = "id0";
const AGENT_IDS = ["id114", "id132", "id208", "id232", "id299"] as const;
const NOW = Date.parse("2026-09-24T10:00:00.000Z");

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

async function ingest(db: Database, bus: EventBusType, path: string): Promise<CrowEvent[]> {
  const match = claudeAdapter.matches(path, FIXTURE_ROOT);
  if (match === null) throw new Error(`fixture path did not match the adapter: ${path}`);
  const result = await processFile({
    db,
    bus,
    adapter: claudeAdapter,
    path,
    match,
    nextId: createUlidFactory("00000000000000000000000000", () => NOW),
    now: () => NOW,
    idleMs: 5 * 60_000,
  });
  return result.events;
}

/** Token totals independently summed from raw fixture lines — not derived from the adapter. */
interface OracleTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

const ZERO_TOTALS: OracleTotals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

/** `next`'s components are all ≥ `cur`'s — the store's `usageDelta` non-anomaly condition. */
function dominates(cur: OracleTotals, next: OracleTotals): boolean {
  return (
    next.input >= cur.input &&
    next.output >= cur.output &&
    next.cacheRead >= cur.cacheRead &&
    next.cacheCreation >= cur.cacheCreation
  );
}

/**
 * Per `message.id`, tracks the component-wise MAX usage seen across every `assistant` line in
 * `path` (in file order) — mirrors the store's `usageKey` max-tracking (round 4, D7/R13): a later
 * occurrence whose components are all ≥ the tracked max advances the max (the store counts its
 * positive delta, which sums to the same final max); a later occurrence with any component below
 * the tracked max is an anomaly and is skipped entirely (the tracked max — and hence the counted
 * total for that id — doesn't move). Summing the final tracked max per id equals the store's
 * cumulative total for that id, since every accepted step's delta telescopes back to it. Not
 * derived from the adapter or the store — computed independently from the raw fixture lines.
 */
function oracleUsageTotals(path: string): OracleTotals {
  const tracked = new Map<string, OracleTotals>();
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const parsed: unknown = JSON.parse(line);
    if (!isRec(parsed) || parsed.type !== "assistant") continue;
    const message = parsed.message;
    if (!isRec(message) || typeof message.id !== "string") continue;
    const usage = message.usage;
    if (!isRec(usage)) continue;
    const next: OracleTotals = {
      input: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
      output: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
      cacheRead:
        typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0,
      cacheCreation:
        typeof usage.cache_creation_input_tokens === "number"
          ? usage.cache_creation_input_tokens
          : 0,
    };
    const cur = tracked.get(message.id);
    if (cur === undefined || dominates(cur, next)) tracked.set(message.id, next);
  }
  let total = ZERO_TOTALS;
  for (const v of tracked.values()) {
    total = {
      input: total.input + v.input,
      output: total.output + v.output,
      cacheRead: total.cacheRead + v.cacheRead,
      cacheCreation: total.cacheCreation + v.cacheCreation,
    };
  }
  return total;
}

function pick(t: OracleTotals): [number, number, number, number] {
  return [t.input, t.output, t.cacheRead, t.cacheCreation];
}

describe("claude contract: real cc-2.1.281 fixture through the real pipeline", () => {
  test("stable summary snapshot + explicit per-row assertions (R11, R12)", async () => {
    // Covers: R11, R12, R33
    const db = freshDb();
    const bus = new EventBus();

    const mainPath = join(FIXTURE_ROOT, SLUG, `${SESSION_ID}.jsonl`);
    const agentPaths = AGENT_IDS.map((id) =>
      join(FIXTURE_ROOT, SLUG, SESSION_ID, "subagents", `agent-${id}.jsonl`),
    );

    const mainEvents = await ingest(db, bus, mainPath);
    const agentEventsById = new Map<string, CrowEvent[]>();
    for (const [index, path] of agentPaths.entries()) {
      agentEventsById.set(AGENT_IDS[index]!, await ingest(db, bus, path));
    }
    const allEvents = [mainEvents, ...agentEventsById.values()].flat();

    // --- per-row assertions (independent of the snapshot) ---

    // 5 subagent files, each yielding exactly one agent.start linked to the main session.
    const agentStarts = allEvents.filter((e) => e.kind === "agent.start");
    expect(agentStarts).toHaveLength(5);
    for (const id of AGENT_IDS) {
      const start = agentStarts.find((e) => e.agentId === id);
      expect(start).toBeDefined();
      expect(start?.parentAgentId).toBeNull(); // depth 1: spawned directly by main
      expect(start?.agent?.depth).toBe(1);
    }

    // Real Claude 2.1.281 signals async subagent completion via a `type: "attachment"` line
    // (`attachment.type: "queued_command"`, `attachment.commandMode: "task-notification"`,
    // `<tool-use-id>`/`<status>` in `attachment.prompt`) — mapped by `mapAttachment` (`map-line.ts`,
    // round 2). The `origin.kind: "peer"`/`handback: true` lines in this fixture are the
    // SubagentHandback relay, not the canonical stop signal, and are correctly ignored. The fixture
    // was regenerated (round 3) after the anonymizer learned to preserve `attachment.prompt`'s
    // `<tool-use-id>` correlation, so all 5 subagents now resolve to a stop.
    const stops = allEvents.filter((e) => e.kind === "agent.stop");
    expect(stops).toHaveLength(5);
    for (const id of AGENT_IDS) {
      const stop = stops.find((e) => e.agentId === id);
      expect(stop).toBeDefined();
      expect(stop?.parentAgentId).toBeNull();
      expect(stop?.agent?.outcome).toBe("completed");
    }

    // No unknown-type ingest.error: every line type/subtype this real capture uses (including
    // `system`/`turn_duration`, and the state-only types last-prompt, mode, permission-mode,
    // attachment, file-history-snapshot/-delta, atis-latch, ai-title, queue-operation, pr-link,
    // cost-state) is already mapped by `KNOWN_NO_EVENT_TYPES` or the `system` branch.
    const ingestStats = stats(db);
    expect(ingestStats.errorsByReason["unknown-type"]).toBeUndefined();
    expect(ingestStats.errorsByReason["bad-shape"]).toBeUndefined();
    expect(ingestStats.errorsByReason["invalid-json"]).toBeUndefined();

    // Round 3's `usage-anomaly` × 2 conclusion was wrong (`.claude/progress/impl_f1-b4t3-contract.md`
    // round 4): real Claude re-emits the same streamed `message.id` with `output_tokens` genuinely
    // growing (never shrinking) as generation continues — that's normal streaming, not a data
    // problem, and the old "first wins" rule silently dropped that growth (~21% of this fixture's
    // total `output` was undercounted; 20 of the 22 growing ids were never even flagged, because
    // `mapAssistant` used to skip `tool_use`-only continuation lines entirely). Round 4 replaced
    // "first wins" with per-`(agent, message.id)` component-wise MAX tracking (D7/R13,
    // `map-line.ts` + `store.ts`): every component non-decreasing → count the positive delta;
    // any component decreasing → THAT's the actual anomaly (kept, not this fixture's case). Since
    // every duplicate in this real fixture only ever grows, there are zero anomalies now.
    expect(ingestStats.errorsByReason["usage-anomaly"]).toBeUndefined();

    // Correction to this task's own premise: unlike the synthetic subagents.test.ts coverage,
    // this real fixture DOES contain `tool_result` blocks with `is_error: true` (4, across 3 of
    // the 5 subagent files) — verified by grep before writing this assertion.
    const toolErrors = allEvents.filter((e) => e.kind === "tool.error");
    expect(toolErrors).toHaveLength(4);
    expect(toolErrors.every((e) => e.tool?.ok === false)).toBe(true);

    // D18/R33: the 8 `hook_success` records map to `hook` events (name, phase, ms, exit code) and
    // nothing of the hook's stdout/stderr/command/content survives; the 4 `hook_additional_context`
    // records map to nothing.
    const hooks = allEvents.filter((e) => e.kind === "hook");
    expect(hooks).toHaveLength(8);
    for (const e of hooks) {
      expect(e.hook?.verdict).toBe("success");
      expect(typeof e.hook?.name).toBe("string");
      expect(typeof e.hook?.phase).toBe("string");
      expect(typeof e.hook?.ms).toBe("number");
      expect(e.hook?.exitCode).toBe(0);
      expect(e.hook?.blocking).toBe(false);
      expect(Object.keys(e.hook ?? {}).sort()).toEqual(
        ["blocking", "exitCode", "ms", "name", "phase", "verdict"].sort(),
      );
    }

    // --- token totals: independent oracle vs. the store's totals ---
    const detail = getSessionDetail(db, `claude:${SESSION_ID}`);
    expect(detail).not.toBeNull();
    const { session, agents } = detail!;

    const mainAgent = agents.find((a) => a.agentId === null);
    expect(mainAgent).toBeDefined();
    expect(pick(oracleUsageTotals(mainPath))).toEqual([
      mainAgent!.totals.input,
      mainAgent!.totals.output,
      mainAgent!.totals.cacheRead,
      mainAgent!.totals.cacheCreation,
    ]);

    let oracleSessionTotal = oracleUsageTotals(mainPath);
    for (const [index, path] of agentPaths.entries()) {
      const id = AGENT_IDS[index]!;
      const agentNode = agents.find((a) => a.agentId === id);
      expect(agentNode).toBeDefined();
      const oracle = oracleUsageTotals(path);
      expect(pick(oracle)).toEqual([
        agentNode!.totals.input,
        agentNode!.totals.output,
        agentNode!.totals.cacheRead,
        agentNode!.totals.cacheCreation,
      ]);
      oracleSessionTotal = {
        input: oracleSessionTotal.input + oracle.input,
        output: oracleSessionTotal.output + oracle.output,
        cacheRead: oracleSessionTotal.cacheRead + oracle.cacheRead,
        cacheCreation: oracleSessionTotal.cacheCreation + oracle.cacheCreation,
      };
    }
    expect(pick(oracleSessionTotal)).toEqual([
      session.totals.input,
      session.totals.output,
      session.totals.cacheRead,
      session.totals.cacheCreation,
    ]);

    // --- stable, compact snapshot ---
    const eventCountsByKind: Record<string, number> = {};
    for (const e of allEvents) {
      eventCountsByKind[e.kind] = (eventCountsByKind[e.kind] ?? 0) + 1;
    }

    const agentTree = agents
      .slice()
      .sort((a, b) => (a.agentId ?? "").localeCompare(b.agentId ?? ""))
      .map((a) => ({
        agentId: a.agentId,
        parentAgentId: a.parentAgentId,
        type: a.type,
        hasStart: a.startedAt !== null,
        hasStop: a.endedAt !== null,
      }));

    const perAgentTokenTotals = agents
      .slice()
      .sort((a, b) => (a.agentId ?? "").localeCompare(b.agentId ?? ""))
      .map((a) => ({
        agentId: a.agentId,
        input: a.totals.input,
        output: a.totals.output,
        cacheRead: a.totals.cacheRead,
        cacheCreation: a.totals.cacheCreation,
      }));

    const summary = {
      eventCountsByKind,
      agentTree,
      perAgentTokenTotals,
      ingestErrorCountsByReason: ingestStats.errorsByReason,
      sessionMeta: {
        engine: session.engine,
        nativeId: session.nativeId,
        status: session.status,
        agentCount: agents.length,
      },
    };

    expect(summary).toMatchSnapshot();
  });
});
