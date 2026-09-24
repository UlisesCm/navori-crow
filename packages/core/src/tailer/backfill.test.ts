import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindAdapter } from "../adapter";
import { EventBus } from "../bus";
import { migrate } from "../store/migrations";
import { createUlidFactory } from "../ulid";
import { runBackfillOnce } from "./tailer";
import { makeTestAdapter, testLine } from "./testing/test-adapter";

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function withTempDir(fn: (dir: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "crow-backfill-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

function tailerDeps(db: Database) {
  return {
    db,
    bus: new EventBus(),
    nextId: createUlidFactory("00000000000000000000000000", () => NOW),
    now: () => NOW,
    idleMs: 5 * 60_000,
  };
}

describe("runBackfillOnce: hydration by window (R9)", () => {
  test("a file modified inside the window is ingested; one outside it is left alone", async () => {
    // Covers: R9
    await withTempDir(async (dir) => {
      const fresh = join(dir, "fresh.jsonl");
      const old = join(dir, "old.jsonl");
      writeFileSync(fresh, `${testLine({ sessionId: "fresh", ts: NOW, text: "recent" })}\n`);
      writeFileSync(old, `${testLine({ sessionId: "old", ts: NOW, text: "ancient" })}\n`);
      const oldTime = new Date(NOW - 48 * HOUR);
      utimesSync(old, oldTime, oldTime);

      const db = freshDb();
      const deps = tailerDeps(db);
      const adapter = bindAdapter(makeTestAdapter());
      const { processedPaths } = await runBackfillOnce(deps, [{ root: dir, adapter }], {
        windowMs: 24 * HOUR,
        now: () => NOW,
      });

      expect(processedPaths).toContain(fresh);
      expect(processedPaths).not.toContain(old);
    });
  });

  test("a file with a persisted offset that grew is caught up even if it's outside the window", async () => {
    // Covers: R9
    await withTempDir(async (dir) => {
      const path = join(dir, "grown.jsonl");
      writeFileSync(path, `${testLine({ sessionId: "s1", ts: NOW, text: "first" })}\n`);

      const db = freshDb();
      const deps = tailerDeps(db);
      const adapter = bindAdapter(makeTestAdapter());

      // First pass: fresh mtime, inside the window, so it gets a persisted offset.
      await runBackfillOnce(deps, [{ root: dir, adapter }], {
        windowMs: 24 * HOUR,
        now: () => NOW,
      });

      // Now it "ages out" of the window, but new content was appended (its offset would grow).
      writeFileSync(
        path,
        `${testLine({ sessionId: "s1", ts: NOW, text: "first" })}\n${testLine({ sessionId: "s1", ts: NOW, text: "second" })}\n`,
      );
      const oldTime = new Date(NOW - 48 * HOUR);
      utimesSync(path, oldTime, oldTime);

      const { processedPaths } = await runBackfillOnce(deps, [{ root: dir, adapter }], {
        windowMs: 24 * HOUR,
        now: () => NOW,
      });
      expect(processedPaths).toContain(path);
    });
  });

  test("groups are ingested main role before agent role", async () => {
    // Covers: R9
    await withTempDir(async (dir) => {
      const main = join(dir, "main.jsonl");
      const agent = join(dir, "agent.jsonl");
      writeFileSync(main, `${testLine({ sessionId: "s1", ts: NOW, text: "main" })}\n`);
      writeFileSync(
        agent,
        `${testLine({ sessionId: "s1", agentId: "a1", ts: NOW, text: "agent" })}\n`,
      );

      const db = freshDb();
      const deps = tailerDeps(db);
      const base = makeTestAdapter();
      const adapter = bindAdapter({
        ...base,
        matches(path: string, _root: string) {
          const role = path === main ? "main" : "agent";
          return {
            role,
            groupKey: "s1",
            sessionId: "s1",
            agentId: role === "agent" ? "a1" : null,
            sidecarPath: null,
          };
        },
      });

      const { processedPaths } = await runBackfillOnce(deps, [{ root: dir, adapter }], {
        windowMs: 24 * HOUR,
        now: () => NOW,
      });

      expect(processedPaths.indexOf(main)).toBeLessThan(processedPaths.indexOf(agent));
    });
  });
});
