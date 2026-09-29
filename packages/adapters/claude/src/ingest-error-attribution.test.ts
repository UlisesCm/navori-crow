/**
 * A line-level `ingest.error` belongs to the file's session and to the project of the last known
 * `cwd`, never to phantom `unknown`/`unresolved` rows (R10, R15).
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus, createUlidFactory, listProjects, migrate, processFile } from "@crow/core";
import { claudeAdapter } from "./adapter";

const NOW = Date.parse("2026-09-24T10:00:00.000Z");

function withTempRoot(fn: (root: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "crow-claude-errattr-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

async function ingestFile(db: Database, root: string, path: string) {
  const match = claudeAdapter.matches(path, root);
  if (match === null) throw new Error(`path did not match the adapter: ${path}`);
  return processFile({
    db,
    bus: new EventBus(),
    adapter: claudeAdapter,
    path,
    match,
    nextId: createUlidFactory("00000000000000000000000000", () => NOW),
    now: () => NOW,
    idleMs: 5 * 60_000,
  });
}

const userLine = (sid: string, cwd: string): string =>
  `${JSON.stringify({
    type: "user",
    timestamp: "2026-09-24T10:00:00.000Z",
    sessionId: sid,
    uuid: "u1",
    cwd,
    promptSource: "typed",
    origin: { kind: "human" },
    message: { content: "hi" },
  })}\n`;

function setup(root: string, sid: string, body: string): string {
  mkdirSync(join(root, "proj"), { recursive: true });
  const path = join(root, "proj", `${sid}.jsonl`);
  writeFileSync(path, body);
  return path;
}

describe("ingest.error attribution", () => {
  test("an invalid-JSON line after valid ones keeps the file's session and project", async () => {
    // Covers: R10, R15
    await withTempRoot(async (root) => {
      const sid = "sess-errattr1";
      const path = setup(root, sid, `${userLine(sid, "/tmp/errattr-repo")}not-json\n`);
      const db = new Database(":memory:");
      migrate(db);
      const result = await ingestFile(db, root, path);

      const error = result.events.find((e) => e.kind === "ingest.error");
      const prompt = result.events.find((e) => e.kind === "prompt");
      expect(error?.sessionId).toBe(sid);
      expect(error?.error?.line).toBe(2);
      expect(error?.projectKey).toBe(prompt?.projectKey ?? "missing");
      expect(error?.projectKey).not.toBe("unresolved");

      const projects = listProjects(db, 0);
      expect(projects.map((p) => p.key)).not.toContain("unresolved");
      const sessions = db.query<{ id: string }, []>("SELECT id FROM sessions").all();
      expect(sessions.map((s) => s.id)).toEqual([`claude:${sid}`]);
    });
  });

  test("an error-only file gets the path's session and is not marked live (D10)", async () => {
    // Covers: R10, R17
    await withTempRoot(async (root) => {
      const sid = "sess-errattr2";
      const path = setup(root, sid, "not-json\n");
      const db = new Database(":memory:");
      migrate(db);
      const result = await ingestFile(db, root, path);

      expect(result.events[0]?.sessionId).toBe(sid);
      const rows = db
        .query<{ id: string; status: string }, []>("SELECT id, status FROM sessions")
        .all();
      expect(rows).toEqual([{ id: `claude:${sid}`, status: "idle" }]);
    });
  });
});
