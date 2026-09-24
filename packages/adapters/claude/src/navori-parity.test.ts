/**
 * Runs the navori-harness audit fixture (copied literally into
 * `fixtures/claude/navori-audit/`) through the real B3 tailer pipeline
 * (`processFile`) with the real Claude adapter, and asserts the exact
 * totals design.md § Testing strategy computed by hand from the fixture's
 * usage numbers (R13, R16).
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventBus as EventBusType } from "@crow/core";
import { EventBus, getSessionDetail, migrate, stats } from "@crow/core";
import { createUlidFactory } from "@crow/core";
import { processFile } from "@crow/core";
import { claudeAdapter } from "./adapter";

const FIXTURE_ROOT = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "fixtures",
  "claude",
  "navori-audit",
);
const SLUG = "-tmp-fixture-repo";
const NOW = Date.parse("2026-08-25T10:10:00.000Z");

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

async function ingest(db: Database, bus: EventBusType, path: string): Promise<void> {
  const match = claudeAdapter.matches(path, FIXTURE_ROOT);
  if (match === null) throw new Error(`fixture path did not match the adapter: ${path}`);
  await processFile({
    db,
    bus,
    adapter: claudeAdapter,
    path,
    match,
    nextId: createUlidFactory("00000000000000000000000000", () => NOW),
    now: () => NOW,
    idleMs: 5 * 60_000,
  });
}

function withTempDir(fn: (dir: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "crow-claude-parity-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("navori-parity: usage totals and dedupe against the navori-audit fixture", () => {
  test("main, withmeta1, orphan2 and the session total match the hand-computed usage, and there are 2 ingest.error", async () => {
    // Covers: R13, R16
    const db = freshDb();
    const bus = new EventBus();

    await ingest(db, bus, join(FIXTURE_ROOT, SLUG, "sess-aaa11111.jsonl"));
    await ingest(
      db,
      bus,
      join(FIXTURE_ROOT, SLUG, "sess-aaa11111", "subagents", "agent-withmeta1.jsonl"),
    );
    await ingest(
      db,
      bus,
      join(FIXTURE_ROOT, SLUG, "sess-aaa11111", "subagents", "agent-orphan2.jsonl"),
    );

    const detail = getSessionDetail(db, "claude:sess-aaa11111");
    expect(detail).not.toBeNull();
    const { session, agents } = detail!;

    const main = agents.find((a) => a.agentId === null);
    const withmeta1 = agents.find((a) => a.agentId === "withmeta1");
    const orphan2 = agents.find((a) => a.agentId === "orphan2");
    expect(main).toBeDefined();
    expect(withmeta1).toBeDefined();
    expect(orphan2).toBeDefined();

    const pick = (t: {
      input: number;
      output: number;
      cacheRead: number;
      cacheCreation: number;
    }) => [t.input, t.output, t.cacheRead, t.cacheCreation];

    expect(pick(main!.totals)).toEqual([11, 22, 103, 54]);
    expect(pick(withmeta1!.totals)).toEqual([7, 8, 9, 1000]);
    expect(pick(orphan2!.totals)).toEqual([1, 1, 1, 500]);
    expect(pick(session.totals)).toEqual([19, 31, 113, 1554]);

    const ingestStats = stats(db);
    const errorTotal = Object.values(ingestStats.errorsByReason).reduce((sum, n) => sum + n, 0);
    expect(errorTotal).toBe(2);
    expect(ingestStats.errorsByReason["invalid-json"]).toBe(1);
    expect(ingestStats.errorsByReason["unknown-type"]).toBe(1);
  });
});

describe("navori-parity, Claude-real identity case (f): same uuid, reordered keys", () => {
  test("two byte-distinct real-shaped lines sharing a uuid are stored once (D7, R16)", async () => {
    // Covers: R16
    await withTempDir(async (dir) => {
      const root = join(dir, "projects");
      const path = join(root, "proj-x", "sess-dup1111.jsonl");
      const first =
        '{"type":"user","timestamp":"2026-08-25T10:10:00.000Z","sessionId":"sess-dup1111",' +
        '"uuid":"dup-uuid-1","promptSource":"typed","origin":{"kind":"human"},' +
        '"message":{"content":"hola mundo"}}';
      // Same logical line, keys reordered and re-serialized: different bytes, same `uuid`.
      const second =
        '{"sessionId":"sess-dup1111","type":"user","uuid":"dup-uuid-1",' +
        '"message":{"content":"hola mundo"},"origin":{"kind":"human"},' +
        '"timestamp":"2026-08-25T10:10:00.000Z","promptSource":"typed"}';
      mkdirSync(join(root, "proj-x"), { recursive: true });
      writeFileSync(path, `${first}\n${second}\n`);

      const db = freshDb();
      const bus = new EventBus();
      const match = claudeAdapter.matches(path, root);
      expect(match).not.toBeNull();

      const result = await processFile({
        db,
        bus,
        adapter: claudeAdapter,
        path,
        match: match!,
        nextId: createUlidFactory("00000000000000000000000000", () => NOW),
        now: () => NOW,
        idleMs: 5 * 60_000,
      });

      // 1 session.start + 1 prompt: the second line's prompt is a semantic duplicate.
      expect(result.events.filter((e) => e.kind === "prompt")).toHaveLength(1);
      expect(stats(db).semanticDuplicates).toBe(1);
    });
  });
});
