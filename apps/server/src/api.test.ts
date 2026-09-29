import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUlidFactory, ingestBatch } from "@crow/core";
import type { CrowConfig, IngestBatchDeps, PartialCrowEvent, PendingEvent } from "@crow/core";
import { startApp } from "./app";

function withTempDir(fn: (dir: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "crow-api-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** A `CrowConfig` rooted entirely under `dir`, so no test ever touches a real `~/.claude` or `~/.codex`. */
function testConfig(dir: string, overrides: Partial<CrowConfig> = {}): CrowConfig {
  return {
    crowHome: join(dir, "home"),
    crowPort: 0, // let the OS pick a free port
    backfillHours: 24,
    idleMinutes: 5,
    allowedOrigins: [],
    claudeConfigDir: join(dir, "claude"),
    codexHome: join(dir, "codex"),
    ...overrides,
  };
}

function makeEvent(overrides: Partial<PartialCrowEvent> = {}): PartialCrowEvent {
  return {
    sessionId: "s1",
    agentId: null,
    parentAgentId: null,
    kind: "prompt",
    ts: Date.now(),
    text: "hi",
    ...overrides,
  };
}

function makePending(
  overrides: Partial<PendingEvent> = {},
  eventOverrides: Partial<PartialCrowEvent> = {},
): PendingEvent {
  return {
    engine: "claude",
    source: "transcript",
    lineHash: `hash-${Math.random()}`,
    part: "0",
    pos: { path: "/tmp/f.jsonl", offset: 0, line: 1 },
    event: makeEvent(eventOverrides),
    ...overrides,
  };
}

/** Seeds two sessions in two different projects, each with a prompt and an assistant.message + usage. */
function seedFixture(dbDeps: {
  db: Parameters<typeof ingestBatch>[0];
  deps: IngestBatchDeps;
}): void {
  const { db, deps } = dbDeps;
  ingestBatch(db, deps, {
    path: "/tmp/proj-a.jsonl",
    inode: "1",
    nextOffset: 10,
    state: null,
    events: [
      makePending(
        { lineHash: "h1" },
        { sessionId: "s1", cwd: "/tmp/proj-a", kind: "prompt", text: "hello a" },
      ),
      makePending(
        { lineHash: "h2" },
        {
          sessionId: "s1",
          cwd: "/tmp/proj-a",
          kind: "assistant.message",
          text: "hi back",
          usage: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0, model: "claude-sonnet-5" },
          usageKey: "u:main:m1",
        },
      ),
    ],
  });
  ingestBatch(db, deps, {
    path: "/tmp/proj-b.jsonl",
    inode: "2",
    nextOffset: 10,
    state: null,
    events: [
      makePending(
        { lineHash: "h3" },
        { sessionId: "s2", cwd: "/tmp/proj-b", kind: "prompt", text: "hello b" },
      ),
    ],
  });
}

describe("REST contracts (R25-R27, R33)", () => {
  test("full lifecycle: /api/projects, /api/sessions, /api/sessions/:id, /api/sessions/:id/events, /api/events, /api/stats", async () => {
    // Covers: R25, R26, R27, R33
    await withTempDir(async (dir) => {
      const now = Date.now();
      const handle = await startApp(testConfig(dir), { now: () => now });
      try {
        const deps: IngestBatchDeps = {
          nextId: createUlidFactory("00000000000000000000000000", () => now),
          now: () => now,
          idleMs: 5 * 60_000,
        };
        seedFixture({ db: handle.db, deps });

        const base = `http://127.0.0.1:${handle.server.port}`;

        const projectsRes = await fetch(`${base}/api/projects`);
        expect(projectsRes.status).toBe(200);
        const projectsBody = (await projectsRes.json()) as {
          cursor: string;
          idleMs: number;
          day: string;
          projects: Array<{ key: string; sessions: unknown[] }>;
        };
        expect(projectsBody.idleMs).toBe(5 * 60_000);
        expect(projectsBody.projects).toHaveLength(2);
        expect(projectsBody.cursor.length).toBe(26);

        const sessionsRes = await fetch(`${base}/api/sessions`);
        expect(sessionsRes.status).toBe(200);
        const sessionsBody = (await sessionsRes.json()) as { sessions: Array<{ id: string }> };
        expect(sessionsBody.sessions.map((s) => s.id).sort()).toEqual(["claude:s1", "claude:s2"]);

        const filteredRes = await fetch(`${base}/api/sessions?status=live&limit=1`);
        expect(filteredRes.status).toBe(200);
        const filteredBody = (await filteredRes.json()) as { sessions: unknown[] };
        expect(filteredBody.sessions).toHaveLength(1);

        const detailRes = await fetch(`${base}/api/sessions/claude:s1`);
        expect(detailRes.status).toBe(200);
        const detailBody = (await detailRes.json()) as {
          session: { id: string; totals: { input: number } };
        };
        expect(detailBody.session.id).toBe("claude:s1");
        expect(detailBody.session.totals.input).toBe(10);

        const missingRes = await fetch(`${base}/api/sessions/claude:does-not-exist`);
        expect(missingRes.status).toBe(404);

        const eventsPageRes = await fetch(`${base}/api/sessions/claude:s1/events?limit=1`);
        expect(eventsPageRes.status).toBe(200);
        const eventsPageBody = (await eventsPageRes.json()) as {
          events: Array<{ id: string }>;
          hasMore: boolean;
          nextAfter: string | null;
        };
        expect(eventsPageBody.events).toHaveLength(1);
        expect(eventsPageBody.hasMore).toBe(true);

        const badCursorRes = await fetch(
          `${base}/api/sessions/claude:s1/events?after=00000000000000000000000000`,
        );
        expect(badCursorRes.status).toBe(409);
        expect(await badCursorRes.json()).toEqual({ error: "unknown-cursor" });

        const recentRes = await fetch(`${base}/api/events?limit=10`);
        expect(recentRes.status).toBe(200);
        const recentBody = (await recentRes.json()) as { events: unknown[] };
        expect(recentBody.events.length).toBeGreaterThan(0);

        const statsRes = await fetch(`${base}/api/stats`);
        expect(statsRes.status).toBe(200);
        expect(await statsRes.json()).toEqual({
          ingest: { semanticDuplicates: 0, usageAnomalies: 0, errorsByReason: {} },
        });
      } finally {
        await handle.stop();
      }
    });
  });

  test("backward paging: tail, before, unknown before and conflicting cursors", async () => {
    // Covers: R27, R33
    await withTempDir(async (dir) => {
      const now = Date.now();
      const handle = await startApp(testConfig(dir), { now: () => now });
      try {
        const deps: IngestBatchDeps = {
          nextId: createUlidFactory("00000000000000000000000000", () => now),
          now: () => now,
          idleMs: 5 * 60_000,
        };
        seedFixture({ db: handle.db, deps });
        const base = `http://127.0.0.1:${handle.server.port}`;
        const url = `${base}/api/sessions/claude:s1/events`;
        type Page = { events: Array<{ id: string }>; hasMore: boolean; nextAfter: string | null };

        const all = (await (await fetch(url)).json()) as Page;
        expect(all.events).toHaveLength(2);
        const [first, second] = all.events.map((e) => e.id) as [string, string];

        const tail = (await (await fetch(`${url}?tail=1&limit=1`)).json()) as Page;
        expect(tail.events.map((e) => e.id)).toEqual([second]);
        expect(tail.hasMore).toBe(true);
        expect(tail.nextAfter).toBe(second);

        const older = (await (await fetch(`${url}?before=${second}&limit=1`)).json()) as Page;
        expect(older.events.map((e) => e.id)).toEqual([first]);
        expect(older.hasMore).toBe(false);

        const wide = (await (await fetch(`${url}?tail=1&limit=500`)).json()) as Page;
        expect(wide.events.map((e) => e.id)).toEqual([first, second]); // ascending
        expect(wide.hasMore).toBe(false);

        const unknown = await fetch(`${url}?before=00000000000000000000000000`);
        expect(unknown.status).toBe(409);
        expect(await unknown.json()).toEqual({ error: "unknown-cursor" });

        expect((await fetch(`${url}?before=nope`)).status).toBe(400);
        expect((await fetch(`${url}?tail=2`)).status).toBe(400);
        const both = await fetch(`${url}?tail=1&after=${first}`);
        expect(both.status).toBe(400);
        expect(await both.json()).toEqual({ error: "conflicting-cursors" });
      } finally {
        await handle.stop();
      }
    });
  });

  test("malformed query params return 400, unknown routes return 404", async () => {
    // Covers: R25, R26, R27
    await withTempDir(async (dir) => {
      const now = Date.now();
      const handle = await startApp(testConfig(dir), { now: () => now });
      try {
        const deps: IngestBatchDeps = {
          nextId: createUlidFactory("00000000000000000000000000", () => now),
          now: () => now,
          idleMs: 5 * 60_000,
        };
        seedFixture({ db: handle.db, deps });

        const base = `http://127.0.0.1:${handle.server.port}`;

        expect((await fetch(`${base}/api/sessions?project=not-a-key`)).status).toBe(400);
        expect((await fetch(`${base}/api/sessions?status=bogus`)).status).toBe(400);
        expect((await fetch(`${base}/api/sessions?since=abc`)).status).toBe(400);
        expect((await fetch(`${base}/api/sessions?limit=0`)).status).toBe(400);
        expect((await fetch(`${base}/api/sessions?limit=99999`)).status).toBe(400);
        expect((await fetch(`${base}/api/sessions/claude:s1/events?after=not-a-ulid`)).status).toBe(
          400,
        );
        expect((await fetch(`${base}/api/nope`)).status).toBe(404);
        expect((await fetch(`${base}/api/projects`, { method: "POST" })).status).toBe(405);
      } finally {
        await handle.stop();
      }
    });
  });

  test("percent-encoded session ids resolve; a malformed escape is 400 invalid-id", async () => {
    // Covers: R26, R27
    await withTempDir(async (dir) => {
      const now = Date.now();
      const handle = await startApp(testConfig(dir), { now: () => now });
      try {
        const deps: IngestBatchDeps = {
          nextId: createUlidFactory("00000000000000000000000000", () => now),
          now: () => now,
          idleMs: 5 * 60_000,
        };
        seedFixture({ db: handle.db, deps });
        const base = `http://127.0.0.1:${handle.server.port}`;

        for (const id of ["claude%3As1", "claude:s1"]) {
          expect((await fetch(`${base}/api/sessions/${id}`)).status).toBe(200);
          expect((await fetch(`${base}/api/sessions/${id}/events`)).status).toBe(200);
        }
        expect((await fetch(`${base}/api/sessions/claude%3Anope`)).status).toBe(404);
        for (const path of ["/api/sessions/%E0%A4%A", "/api/sessions/%E0%A4%A/events"]) {
          const res = await fetch(`${base}${path}`);
          expect(res.status).toBe(400);
          expect(((await res.json()) as { error: string }).error).toBe("invalid-id");
        }
      } finally {
        await handle.stop();
      }
    });
  });

  test("the Host/Origin guard still applies to REST routes (R28)", async () => {
    // Covers: R28
    await withTempDir(async (dir) => {
      const handle = await startApp(testConfig(dir));
      try {
        const res = await fetch(`http://127.0.0.1:${handle.server.port}/api/projects`, {
          headers: { host: "evil.example.com" },
        });
        expect(res.status).toBe(403);
      } finally {
        await handle.stop();
      }
    });
  });
});
