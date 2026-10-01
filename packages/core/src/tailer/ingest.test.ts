import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../bus";
import { migrate } from "../store/migrations";
import { getOffset, stats } from "../store/store";
import { createUlidFactory } from "../ulid";
import { processFile } from "./ingest";
import { makeTestAdapter, testLine } from "./testing/test-adapter";

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function withTempDir(fn: (dir: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "crow-ingest-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const NOW = Date.now();

function deps(db: Database, bus: EventBus, path: string, matchOverrides = {}) {
  const adapter = makeTestAdapter();
  return {
    db,
    bus,
    adapter,
    path,
    match: adapter.matches(path, "/")!,
    nextId: createUlidFactory("00000000000000000000000000", () => NOW),
    now: () => NOW,
    idleMs: 5 * 60_000,
    ...matchOverrides,
  };
}

describe("processFile: ingest.error on a broken line (R10)", () => {
  test("an invalid-JSON line becomes an ingest.error and the next line still ingests", async () => {
    // Covers: R10
    await withTempDir(async (dir) => {
      const path = join(dir, "f.jsonl");
      writeFileSync(path, `not-json\n${testLine({ sessionId: "s1", ts: NOW, text: "hi" })}\n`);

      const db = freshDb();
      const bus = new EventBus();
      const result = await processFile(deps(db, bus, path));

      expect(result.events).toHaveLength(2);
      const error = result.events.find((e) => e.kind === "ingest.error");
      expect(error?.error?.reason).toBe("invalid-json");
      expect(error?.error?.path).toBe(path);
      expect(error?.error?.offset).toBe(0);
      expect(error?.error?.line).toBe(1);
      expect(result.events.some((e) => e.kind === "prompt")).toBe(true);

      const ingestStats = stats(db);
      expect(ingestStats.errorsByReason["invalid-json"]).toBe(1);
    });
  });

  test("a line with an unrecognized shape becomes an ingest.error tagged bad-shape", async () => {
    // Covers: R10
    await withTempDir(async (dir) => {
      const path = join(dir, "f.jsonl");
      writeFileSync(
        path,
        `${JSON.stringify({ sessionId: "s1", ts: NOW, forceError: "bad-shape" })}\n`,
      );

      const db = freshDb();
      const bus = new EventBus();
      const result = await processFile(deps(db, bus, path));

      expect(result.events).toHaveLength(1);
      expect(result.events[0]?.kind).toBe("ingest.error");
      expect(result.events[0]?.error?.reason).toBe("bad-shape");
      expect(stats(db).errorsByReason["bad-shape"]).toBe(1);
    });
  });

  test("published events reach the bus only after the batch is stored", async () => {
    // Covers: R10, R22
    await withTempDir(async (dir) => {
      const path = join(dir, "f.jsonl");
      writeFileSync(path, `${testLine({ sessionId: "s1", ts: NOW, text: "hi" })}\n`);

      const db = freshDb();
      const bus = new EventBus();
      const received: unknown[] = [];
      bus.subscribe((events) => received.push(...events));

      const result = await processFile(deps(db, bus, path));
      expect(received).toEqual(result.events);
    });
  });

  test("persists the offset and state, so a restart resumes without re-reading ingested lines (R6)", async () => {
    // Covers: R6, R10
    await withTempDir(async (dir) => {
      const path = join(dir, "f.jsonl");
      writeFileSync(path, `${testLine({ sessionId: "s1", ts: NOW, text: "one" })}\n`);

      const db = freshDb();
      const bus = new EventBus();
      const first = await processFile(deps(db, bus, path));
      expect(first.events).toHaveLength(1);

      const offset = getOffset(db, path);
      expect(offset).not.toBeNull();
      expect(offset?.byteOffset).toBeGreaterThan(0);

      const second = await processFile(deps(db, bus, path));
      expect(second.events).toHaveLength(0); // nothing new to read
    });
  });
});

describe("processFile: line-too-long becomes an ingest.error (R10)", () => {
  test("an overlong line is reported and does not block the next line", async () => {
    // Covers: R10
    await withTempDir(async (dir) => {
      const path = join(dir, "f.jsonl");
      const overlong = testLine({ sessionId: "s1", ts: NOW, text: "y".repeat(200) });
      const normal = testLine({ sessionId: "s1", ts: NOW, text: "short" });
      writeFileSync(path, `${overlong}\n${normal}\n`);

      const db = freshDb();
      const bus = new EventBus();
      const result = await processFile({
        ...deps(db, bus, path),
        lineOptions: { chunkBytes: 8, maxLineBytes: 100 },
      });

      expect(
        result.events.some((e) => e.kind === "ingest.error" && e.error?.reason === "line-too-long"),
      ).toBe(true);
      expect(result.events.some((e) => e.kind === "prompt")).toBe(true);
      expect(stats(db).errorsByReason["line-too-long"]).toBe(1);
    });
  });
});

describe("processFile: gone or symlinked files (D5)", () => {
  test("a missing file yields no events instead of throwing", async () => {
    // Covers: R6
    const db = freshDb();
    const bus = new EventBus();
    const result = await processFile(deps(db, bus, "/nonexistent/path/f.jsonl"));
    expect(result.events).toHaveLength(0);
  });
});

describe("processFile: unknown entries (R7)", () => {
  test("N lines marked unknown add N to unknownEntries in the same transaction as the offset", async () => {
    // Covers: R7
    await withTempDir(async (dir) => {
      const path = join(dir, "f.jsonl");
      const lines = [1, 2, 3].map((n) => testLine({ sessionId: "s1", ts: NOW + n, text: `l${n}` }));
      writeFileSync(path, `${lines.join("\n")}\n`);

      const db = freshDb();
      const base = makeTestAdapter();
      // Lines 1 and 3 are "unknown"; line 2 is a normal entry.
      const adapter: typeof base = {
        ...base,
        parseLine(line, state, pos) {
          const result = base.parseLine(line, state, pos);
          return result.ok && pos.line !== 2 ? { ...result, unknown: true } : result;
        },
      };
      expect(stats(db).unknownEntries).toBe(0);
      await processFile({ ...deps(db, new EventBus(), path), adapter });

      expect(stats(db).unknownEntries).toBe(2);
      expect(getOffset(db, path)?.byteOffset).toBeGreaterThan(0);

      // Nothing new to read: the counter does not move.
      await processFile({ ...deps(db, new EventBus(), path), adapter });
      expect(stats(db).unknownEntries).toBe(2);

      // A failing transaction rolls back both the offset and the counter.
      const db2 = freshDb();
      let calls = 0;
      await expect(
        processFile({
          ...deps(db2, new EventBus(), path),
          adapter,
          nextId: () => {
            if (++calls > 1) throw new Error("boom");
            return "01AAAAAAAAAAAAAAAAAAAAAAAA";
          },
        }),
      ).rejects.toThrow("boom");
      expect(stats(db2).unknownEntries).toBe(0);
      expect(getOffset(db2, path)).toBeNull();
    });
  });
});
