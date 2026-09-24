import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindAdapter } from "../adapter";
import { EventBus } from "../bus";
import { migrate } from "../store/migrations";
import { createUlidFactory } from "../ulid";
import { HotSet, pollPaths } from "./tailer";
import { makeTestAdapter, testLine } from "./testing/test-adapter";

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function withTempDir(fn: (dir: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "crow-poll-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const NOW = Date.now();

function tailerDeps(db: Database) {
  return {
    db,
    bus: new EventBus(),
    nextId: createUlidFactory("00000000000000000000000000", () => NOW),
    now: () => NOW,
    idleMs: 5 * 60_000,
  };
}

describe("pollPaths: hot-file poll without a watcher (R5)", () => {
  test("a path that grew since the last pass is re-ingested by a poll pass alone", async () => {
    // Covers: R5
    await withTempDir(async (dir) => {
      const path = join(dir, "hot.jsonl");
      writeFileSync(path, `${testLine({ sessionId: "s1", ts: NOW, text: "first" })}\n`);

      const db = freshDb();
      const deps = tailerDeps(db);
      const adapter = bindAdapter(makeTestAdapter());

      const first = await pollPaths(deps, [{ root: dir, adapter }], [path]);
      expect(first.processedPaths).toEqual([path]);

      writeFileSync(
        path,
        `${testLine({ sessionId: "s1", ts: NOW, text: "first" })}\n${testLine({ sessionId: "s1", ts: NOW, text: "second" })}\n`,
      );
      const second = await pollPaths(deps, [{ root: dir, adapter }], [path]);
      expect(second.processedPaths).toEqual([path]);

      const received: unknown[] = [];
      deps.bus.subscribe((events) => received.push(...events));
      const third = await pollPaths(deps, [{ root: dir, adapter }], [path]);
      expect(third.processedPaths).toEqual([path]); // still polled...
      expect(received).toHaveLength(0); // ...but nothing new was left to ingest
    });
  });

  test("a path that no longer matches any adapter's roots is skipped, not an error", async () => {
    // Covers: R5
    await withTempDir(async (dir) => {
      const db = freshDb();
      const deps = tailerDeps(db);
      const adapter = bindAdapter({ ...makeTestAdapter(), matches: () => null });

      const { processedPaths } = await pollPaths(
        deps,
        [{ root: dir, adapter }],
        [join(dir, "gone.jsonl")],
      );
      expect(processedPaths).toEqual([]);
    });
  });
});

describe("HotSet", () => {
  test("drains every added path exactly once", () => {
    const hot = new HotSet();
    hot.add("/a");
    hot.add("/b");
    hot.add("/a"); // deduped
    expect(hot.size).toBe(2);
    expect(hot.drain().sort()).toEqual(["/a", "/b"]);
    expect(hot.drain()).toEqual([]);
  });
});
