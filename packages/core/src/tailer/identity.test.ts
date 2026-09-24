import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../bus";
import { migrate } from "../store/migrations";
import { stats } from "../store/store";
import { createUlidFactory } from "../ulid";
import { processFile } from "./ingest";
import { makeTestAdapter, testLine } from "./testing/test-adapter";

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function withTempDir(fn: (dir: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "crow-identity-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const NOW = Date.now();

function makeDeps(
  db: Database,
  bus: EventBus,
  path: string,
  adapter = makeTestAdapter(),
  overrides = {},
) {
  return {
    db,
    bus,
    adapter,
    path,
    match: adapter.matches(path, "/")!,
    nextId: createUlidFactory("00000000000000000000000000", () => NOW),
    now: () => NOW,
    idleMs: 5 * 60_000,
    ...overrides,
  };
}

describe("identity (a): chunk-size invariance", () => {
  test("the same file ingests to the same stored events regardless of the read chunk size", async () => {
    // Covers: R6, R16
    const content = [
      testLine({ sessionId: "s1", ts: NOW, text: "one" }),
      testLine({ sessionId: "s1", ts: NOW, text: "two" }),
      testLine({ sessionId: "s1", ts: NOW, text: "three" }),
    ].join("\n");

    await withTempDir(async (dir) => {
      const pathA = join(dir, "a.jsonl");
      writeFileSync(pathA, `${content}\n`);
      const dbA = freshDb();
      const resultA = await processFile({
        ...makeDeps(dbA, new EventBus(), pathA),
        lineOptions: { chunkBytes: 4 },
      });

      const pathB = join(dir, "b.jsonl");
      writeFileSync(pathB, `${content}\n`);
      const dbB = freshDb();
      const resultB = await processFile({
        ...makeDeps(dbB, new EventBus(), pathB),
        lineOptions: { chunkBytes: 4096 },
      });

      expect(resultA.events.map((e) => e.text)).toEqual(resultB.events.map((e) => e.text));
      expect(resultA.events).toHaveLength(3);
    });
  });
});

describe("identity (b): reingesting with no new bytes", () => {
  test("processing the same unchanged file twice yields no new events the second time", async () => {
    // Covers: R6
    await withTempDir(async (dir) => {
      const path = join(dir, "f.jsonl");
      writeFileSync(path, `${testLine({ sessionId: "s1", ts: NOW, text: "hi" })}\n`);

      const db = freshDb();
      const bus = new EventBus();
      const first = await processFile(makeDeps(db, bus, path));
      expect(first.events).toHaveLength(1);

      const second = await processFile(makeDeps(db, bus, path));
      expect(second.events).toHaveLength(0);
    });
  });
});

describe("identity (c): copy to a new inode, same content", () => {
  test("a byte-identical copy under a new inode is treated as a new file but stores no new events", async () => {
    // Covers: R7, R16
    await withTempDir(async (dir) => {
      const path = join(dir, "f.jsonl");
      const line = testLine({ sessionId: "s1", ts: NOW, text: "hi" });
      writeFileSync(path, `${line}\n`);

      const db = freshDb();
      const bus = new EventBus();
      const first = await processFile(makeDeps(db, bus, path));
      expect(first.events).toHaveLength(1);

      // Simulate a log-rotation copy: same path, brand-new inode, identical bytes.
      const tmpPath = join(dir, "f.jsonl.new");
      writeFileSync(tmpPath, `${line}\n`);
      renameSync(tmpPath, path); // rename onto the same path swaps the inode

      const second = await processFile(makeDeps(db, bus, path));
      expect(second.events).toHaveLength(0); // R7 resets the offset, but R16's content hash still dedupes it
    });
  });
});

describe("identity (d): truncation and rewrite with different content", () => {
  test("a truncated-then-rewritten file is re-ingested from 0, and its genuinely new content is stored", async () => {
    // Covers: R7
    await withTempDir(async (dir) => {
      const path = join(dir, "f.jsonl");
      writeFileSync(path, `${testLine({ sessionId: "s1", ts: NOW, text: "original" })}\n`);

      const db = freshDb();
      const bus = new EventBus();
      const first = await processFile(makeDeps(db, bus, path));
      expect(first.events).toHaveLength(1);

      // A short single-digit `ts` keeps the rewritten line's byte size below the
      // persisted offset, so R7's "size dropped" branch actually triggers even
      // though the file wasn't renamed (same inode).
      truncateSync(path, 0);
      writeFileSync(path, `${testLine({ sessionId: "s1", ts: 1, text: "z" })}\n`);

      const second = await processFile(makeDeps(db, bus, path));
      expect(second.events).toHaveLength(1);
      expect(second.events[0]?.text).toBe("z");
    });
  });
});

describe("identity (e)/(f): same semantic key, different bytes", () => {
  test("two byte-distinct lines sharing a semanticKey are stored once, and the discard is counted (D7)", async () => {
    // Covers: R16
    await withTempDir(async (dir) => {
      const path = join(dir, "f.jsonl");
      const first = testLine({
        sessionId: "s1",
        ts: NOW,
        text: "hello world",
        semanticKey: "uuid:abc:0",
      });
      // Different bytes (reordered/rewritten), same logical identity per the adapter's semanticKey.
      const second = testLine({
        semanticKey: "uuid:abc:0",
        ts: NOW,
        text: "hello world",
        sessionId: "s1",
      });
      writeFileSync(path, `${first}\n${second}\n`);

      const db = freshDb();
      const bus = new EventBus();
      const result = await processFile(makeDeps(db, bus, path));

      expect(result.events).toHaveLength(1);
      expect(stats(db).semanticDuplicates).toBe(1);
    });
  });
});

describe("identity (g): same semantic key across two different agents is not deduped", () => {
  test("the same semanticKey string in two different agents' files both get stored (agent-scoped identity, D7)", async () => {
    // Covers: R16
    await withTempDir(async (dir) => {
      const pathMain = join(dir, "main.jsonl");
      const pathAgent = join(dir, "agent.jsonl");
      writeFileSync(
        pathMain,
        `${testLine({ sessionId: "s1", agentId: null, ts: NOW, text: "from main", semanticKey: "id:shared:0" })}\n`,
      );
      writeFileSync(
        pathAgent,
        `${testLine({ sessionId: "s1", agentId: "sub-1", ts: NOW, text: "from agent", semanticKey: "id:shared:0" })}\n`,
      );

      const db = freshDb();
      const bus = new EventBus();
      const adapter = makeTestAdapter();
      const resultMain = await processFile(makeDeps(db, bus, pathMain, adapter));
      const resultAgent = await processFile(makeDeps(db, bus, pathAgent, adapter));

      expect(resultMain.events).toHaveLength(1);
      expect(resultAgent.events).toHaveLength(1); // different agent scope: not a semantic duplicate
      expect(stats(db).semanticDuplicates).toBe(0);
    });
  });
});
