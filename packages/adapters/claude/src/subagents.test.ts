/**
 * Subagent lifecycle (R12): sync/async `agent.start`/`agent.stop`, a late
 * sidecar rewrite, and a depth = 2 tree resolved in both processing orders
 * (B2's pending decision on store-side parent resolution, reconciled here).
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventBus as EventBusType } from "@crow/core";
import { EventBus, getSessionDetail, migrate, processSidecar } from "@crow/core";
import { createUlidFactory } from "@crow/core";
import { processFile } from "@crow/core";
import { claudeAdapter } from "./adapter";

const NOW = Date.parse("2026-09-24T10:00:00.000Z");

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function withTempDir(fn: (root: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "crow-claude-subagents-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

async function ingest(db: Database, bus: EventBusType, root: string, path: string) {
  const match = claudeAdapter.matches(path, root);
  if (match === null) throw new Error(`fixture path did not match the adapter: ${path}`);
  return processFile({
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

function line(obj: Record<string, unknown>): string {
  return `${JSON.stringify(obj)}\n`;
}

describe("agent.start / agent.stop: synchronous completion (R12)", () => {
  test("a main-transcript toolUseResult with status completed stops the subagent it names", async () => {
    // Covers: R12
    await withTempDir(async (root) => {
      const sid = "sess-sync1";
      mkdirSync(join(root, "proj", sid, "subagents"), { recursive: true });
      const mainPath = join(root, "proj", `${sid}.jsonl`);
      const agentPath = join(root, "proj", sid, "subagents", "agent-agentA.jsonl");
      writeFileSync(
        join(root, "proj", sid, "subagents", "agent-agentA.meta.json"),
        JSON.stringify({
          agentType: "implementer",
          description: "do X",
          toolUseId: "c1",
          spawnDepth: 1,
        }),
      );
      writeFileSync(
        mainPath,
        line({
          type: "user",
          timestamp: "2026-09-24T10:00:00.000Z",
          sessionId: sid,
          uuid: "u0",
          cwd: "/tmp/proj",
          promptSource: "typed",
          origin: { kind: "human" },
          message: { content: "go" },
        }) +
          line({
            type: "assistant",
            timestamp: "2026-09-24T10:00:01.000Z",
            sessionId: sid,
            uuid: "u1",
            message: {
              id: "m1",
              model: "claude-x",
              content: [
                {
                  type: "tool_use",
                  id: "c1",
                  name: "Agent",
                  input: { subagent_type: "implementer" },
                },
              ],
            },
          }) +
          line({
            type: "user",
            timestamp: "2026-09-24T10:00:05.000Z",
            sessionId: sid,
            uuid: "u2",
            message: { content: [{ type: "tool_result", tool_use_id: "c1", content: "done" }] },
            // Real shape (verified against ~150 real transcripts): no `toolUseId` field here —
            // the spawn call id is the sibling `tool_result` block's `tool_use_id` above.
            toolUseResult: {
              agentId: "agentA",
              status: "completed",
              description: "do X",
              isAsync: false,
              canReadOutputFile: false,
              outputFile: null,
              prompt: "do X",
              resolvedModel: "claude-x",
            },
          }),
      );
      writeFileSync(
        agentPath,
        line({
          type: "user",
          timestamp: "2026-09-24T10:00:02.000Z",
          sessionId: sid,
          agentId: "agentA",
          uuid: "ua0",
          message: { content: "do work" },
        }),
      );

      const db = freshDb();
      const bus = new EventBus();
      const mainResult = await ingest(db, bus, root, mainPath);
      await ingest(db, bus, root, agentPath);

      const stop = mainResult.events.find((e) => e.kind === "agent.stop");
      expect(stop?.agentId).toBe("agentA");
      expect(stop?.agent?.outcome).toBe("completed");
      expect(stop?.agent?.type).toBe("implementer");

      const detail = getSessionDetail(db, `claude:${sid}`);
      const agentA = detail?.agents.find((a) => a.agentId === "agentA");
      expect(agentA?.status).toBe("done");
      expect(agentA?.endedAt).not.toBeNull();
    });
  });
});

describe("agent.start / agent.stop: asynchronous completion via task-notification (R12)", () => {
  test("async_launched then a task-notification stops the right subagent", async () => {
    // Covers: R12
    await withTempDir(async (root) => {
      const sid = "sess-async1";
      mkdirSync(join(root, "proj"), { recursive: true });
      const mainPath = join(root, "proj", `${sid}.jsonl`);
      writeFileSync(
        mainPath,
        line({
          type: "assistant",
          timestamp: "2026-09-24T10:00:01.000Z",
          sessionId: sid,
          uuid: "u1",
          message: {
            id: "m1",
            model: "claude-x",
            content: [
              { type: "tool_use", id: "c9", name: "Agent", input: { subagent_type: "reviewer" } },
            ],
          },
        }) +
          line({
            type: "user",
            timestamp: "2026-09-24T10:00:02.000Z",
            sessionId: sid,
            uuid: "u2",
            message: { content: [{ type: "tool_result", tool_use_id: "c9", content: "launched" }] },
            // Real shape: no `toolUseId` field — the spawn call id is the sibling
            // `tool_result` block's `tool_use_id` above.
            toolUseResult: {
              agentId: "agentB",
              status: "async_launched",
              description: "review Y",
              isAsync: true,
              canReadOutputFile: true,
              outputFile: "/tmp/agentB.out",
              prompt: "review Y",
              resolvedModel: "claude-x",
            },
          }) +
          line({
            type: "user",
            timestamp: "2026-09-24T10:00:10.000Z",
            sessionId: sid,
            uuid: "u3",
            origin: { kind: "task-notification" },
            // Real shape: the payload is an XML-ish string inside `message.content`, not
            // top-level fields.
            message: {
              content:
                "<task-notification><task-id>c9</task-id><tool-use-id>c9</tool-use-id>" +
                "<status>completed</status><summary>done</summary></task-notification>",
            },
          }),
      );

      const db = freshDb();
      const bus = new EventBus();
      const result = await ingest(db, bus, root, mainPath);

      const stop = result.events.find((e) => e.kind === "agent.stop");
      expect(stop?.agentId).toBe("agentB");
      expect(stop?.agent?.outcome).toBe("completed");
      // The task-notification line's string content must not also be read as a prompt.
      expect(result.events.some((e) => e.kind === "prompt")).toBe(false);
    });
  });
});

describe("agent.start / agent.stop: asynchronous completion via the cc-2.1.281 attachment shape (R12)", () => {
  test("async_launched then an attachment/queued_command/task-notification line stops the right subagent", async () => {
    // Covers: R12
    await withTempDir(async (root) => {
      const sid = "sess-async281";
      mkdirSync(join(root, "proj"), { recursive: true });
      const mainPath = join(root, "proj", `${sid}.jsonl`);
      writeFileSync(
        mainPath,
        line({
          type: "assistant",
          timestamp: "2026-09-24T10:00:01.000Z",
          sessionId: sid,
          uuid: "u1",
          message: {
            id: "m1",
            model: "claude-x",
            content: [
              { type: "tool_use", id: "c9", name: "Agent", input: { subagent_type: "reviewer" } },
            ],
          },
        }) +
          line({
            type: "user",
            timestamp: "2026-09-24T10:00:02.000Z",
            sessionId: sid,
            uuid: "u2",
            message: { content: [{ type: "tool_result", tool_use_id: "c9", content: "launched" }] },
            toolUseResult: {
              agentId: "agentB",
              status: "async_launched",
              description: "review Y",
              isAsync: true,
              canReadOutputFile: true,
              outputFile: "/tmp/agentB.out",
              prompt: "review Y",
              resolvedModel: "claude-x",
            },
          }) +
          // The 8 real-world `queue-operation` echoes of the same notification (enqueue/dequeue):
          // must stay a no-op, never a stop on their own.
          line({
            type: "queue-operation",
            timestamp: "2026-09-24T10:00:09.000Z",
            sessionId: sid,
            operation: "enqueue",
            content:
              "<task-notification><tool-use-id>c9</tool-use-id>" +
              "<status>completed</status></task-notification>",
          }) +
          // cc-2.1.281's real shape: `type: "attachment"`, `attachment.type: "queued_command"`,
          // `attachment.commandMode: "task-notification"`, payload in `attachment.prompt`.
          line({
            type: "attachment",
            timestamp: "2026-09-24T10:00:10.000Z",
            sessionId: sid,
            uuid: "u3",
            attachment: {
              type: "queued_command",
              commandMode: "task-notification",
              prompt:
                "<task-notification><tool-use-id>c9</tool-use-id>" +
                "<status>completed</status><summary>done</summary></task-notification>",
              source_uuid: "irrelevant",
            },
            rendered: [{ content: "irrelevant, duplicate rendering" }],
          }),
      );

      const db = freshDb();
      const bus = new EventBus();
      const result = await ingest(db, bus, root, mainPath);

      const stops = result.events.filter((e) => e.kind === "agent.stop");
      expect(stops).toHaveLength(1); // queue-operation must not double-stop
      expect(stops[0]?.agentId).toBe("agentB");
      expect(stops[0]?.agent?.outcome).toBe("completed");
    });
  });

  test("two attachment/task-notification lines for the same call id stop the subagent exactly once", async () => {
    // Covers: R12
    await withTempDir(async (root) => {
      const sid = "sess-async281-dup";
      mkdirSync(join(root, "proj"), { recursive: true });
      const mainPath = join(root, "proj", `${sid}.jsonl`);
      const notificationLine = line({
        type: "attachment",
        timestamp: "2026-09-24T10:00:10.000Z",
        sessionId: sid,
        uuid: "u3",
        attachment: {
          type: "queued_command",
          commandMode: "task-notification",
          prompt:
            "<task-notification><tool-use-id>c9</tool-use-id>" +
            "<status>completed</status></task-notification>",
        },
      });
      writeFileSync(
        mainPath,
        line({
          type: "assistant",
          timestamp: "2026-09-24T10:00:01.000Z",
          sessionId: sid,
          uuid: "u1",
          message: {
            id: "m1",
            model: "claude-x",
            content: [
              { type: "tool_use", id: "c9", name: "Agent", input: { subagent_type: "reviewer" } },
            ],
          },
        }) +
          line({
            type: "user",
            timestamp: "2026-09-24T10:00:02.000Z",
            sessionId: sid,
            uuid: "u2",
            message: { content: [{ type: "tool_result", tool_use_id: "c9", content: "launched" }] },
            toolUseResult: {
              agentId: "agentB",
              status: "async_launched",
              description: "review Y",
              isAsync: true,
              canReadOutputFile: true,
              outputFile: "/tmp/agentB.out",
              prompt: "review Y",
              resolvedModel: "claude-x",
            },
          }) +
          notificationLine +
          notificationLine,
      );

      const db = freshDb();
      const bus = new EventBus();
      const result = await ingest(db, bus, root, mainPath);

      expect(result.events.filter((e) => e.kind === "agent.stop")).toHaveLength(1);
    });
  });

  test("an attachment line with an unrelated subtype yields no event and no error", async () => {
    // Covers: R12
    await withTempDir(async (root) => {
      const sid = "sess-attach-other";
      mkdirSync(join(root, "proj"), { recursive: true });
      const mainPath = join(root, "proj", `${sid}.jsonl`);
      writeFileSync(
        mainPath,
        line({
          type: "attachment",
          timestamp: "2026-09-24T10:00:00.000Z",
          sessionId: sid,
          uuid: "u0",
          attachment: { type: "total_tokens_reminder", text: "irrelevant" },
        }),
      );

      const db = freshDb();
      const bus = new EventBus();
      const result = await ingest(db, bus, root, mainPath);

      expect(result.events).toHaveLength(1); // only the implicit session.start
      expect(result.events[0]?.kind).toBe("session.start");
    });
  });
});

describe("late sidecar (R12)", () => {
  test("a sidecar that appears after the .jsonl is applied via upsertAgentMeta, with no event", async () => {
    // Covers: R12
    await withTempDir(async (root) => {
      const sid = "sess-late1";
      mkdirSync(join(root, "proj", sid, "subagents"), { recursive: true });
      const agentPath = join(root, "proj", sid, "subagents", "agent-agentC.jsonl");
      const sidecarPath = join(root, "proj", sid, "subagents", "agent-agentC.meta.json");
      writeFileSync(
        agentPath,
        line({
          type: "user",
          timestamp: "2026-09-24T10:00:00.000Z",
          sessionId: sid,
          agentId: "agentC",
          uuid: "uc0",
          message: { content: "start" },
        }),
      );

      const db = freshDb();
      const bus = new EventBus();
      const match = claudeAdapter.matches(agentPath, root);
      expect(match).not.toBeNull();
      await ingest(db, bus, root, agentPath);

      let detail = getSessionDetail(db, `claude:${sid}`);
      const before = detail?.agents.find((a) => a.agentId === "agentC");
      expect(before?.type).toBeNull(); // no sidecar yet: agent.start carried no type

      // The sidecar shows up later, rewriting the agent's metadata (design.md § Evidencia).
      writeFileSync(
        sidecarPath,
        JSON.stringify({
          agentType: "implementer",
          description: "late meta",
          toolUseId: "cX",
          spawnDepth: 1,
        }),
      );
      const patch = await processSidecar(db, claudeAdapter, match!, sidecarPath, () => NOW);
      expect(patch).not.toBeNull();

      detail = getSessionDetail(db, `claude:${sid}`);
      const after = detail?.agents.find((a) => a.agentId === "agentC");
      expect(after?.type).toBe("implementer");
      expect(after?.description).toBe("late meta");
    });
  });
});

/** Builds a depth = 2 tree's three files under `root`: main spawns agentA, agentA spawns agentB. */
function writeDepthTwoFixture(
  root: string,
  sid: string,
): { mainPath: string; aPath: string; bPath: string } {
  mkdirSync(join(root, "proj", sid, "subagents"), { recursive: true });
  const mainPath = join(root, "proj", `${sid}.jsonl`);
  const aPath = join(root, "proj", sid, "subagents", "agent-agentA.jsonl");
  const bPath = join(root, "proj", sid, "subagents", "agent-agentB.jsonl");

  writeFileSync(
    join(root, "proj", sid, "subagents", "agent-agentA.meta.json"),
    JSON.stringify({ agentType: "implementer", toolUseId: "c1", spawnDepth: 1 }),
  );
  writeFileSync(
    join(root, "proj", sid, "subagents", "agent-agentB.meta.json"),
    JSON.stringify({ agentType: "reviewer", toolUseId: "c2", spawnDepth: 2 }),
  );

  writeFileSync(
    mainPath,
    line({
      type: "assistant",
      timestamp: "2026-09-24T10:00:01.000Z",
      sessionId: sid,
      uuid: "u1",
      message: {
        id: "m1",
        model: "claude-x",
        content: [
          { type: "tool_use", id: "c1", name: "Agent", input: { subagent_type: "implementer" } },
        ],
      },
    }),
  );
  writeFileSync(
    aPath,
    line({
      type: "user",
      timestamp: "2026-09-24T10:00:02.000Z",
      sessionId: sid,
      agentId: "agentA",
      uuid: "ua0",
      message: { content: "start A" },
    }) +
      line({
        type: "assistant",
        timestamp: "2026-09-24T10:00:03.000Z",
        sessionId: sid,
        agentId: "agentA",
        uuid: "ua1",
        message: {
          id: "ma1",
          model: "claude-x",
          content: [
            { type: "tool_use", id: "c2", name: "Agent", input: { subagent_type: "reviewer" } },
          ],
        },
      }),
  );
  writeFileSync(
    bPath,
    line({
      type: "user",
      timestamp: "2026-09-24T10:00:04.000Z",
      sessionId: sid,
      agentId: "agentB",
      uuid: "ub0",
      message: { content: "start B" },
    }),
  );

  return { mainPath, aPath, bPath };
}

describe("depth = 2 agent tree (R12)", () => {
  test("resolves in the parent-before-child processing order", async () => {
    // Covers: R12
    await withTempDir(async (root) => {
      const sid = "sess-depth-pf";
      const { mainPath, aPath, bPath } = writeDepthTwoFixture(root, sid);

      const db = freshDb();
      const bus = new EventBus();
      await ingest(db, bus, root, mainPath);
      await ingest(db, bus, root, aPath); // agentA's tool.pre for c2 lands before agentB's agent.start
      await ingest(db, bus, root, bPath);

      const detail = getSessionDetail(db, `claude:${sid}`);
      const agentA = detail?.agents.find((a) => a.agentId === "agentA");
      const agentB = detail?.agents.find((a) => a.agentId === "agentB");
      expect(agentA?.parentAgentId).toBeNull(); // depth 1: main
      expect(agentB?.parentAgentId).toBe("agentA"); // depth 2: resolved by call_id
    });
  });

  test("resolves in the child-before-parent processing order", async () => {
    // Covers: R12
    await withTempDir(async (root) => {
      const sid = "sess-depth-cf";
      const { mainPath, aPath, bPath } = writeDepthTwoFixture(root, sid);

      const db = freshDb();
      const bus = new EventBus();
      await ingest(db, bus, root, mainPath);
      await ingest(db, bus, root, bPath); // agentB's agent.start lands before agentA's tool.pre for c2
      await ingest(db, bus, root, aPath);

      const detail = getSessionDetail(db, `claude:${sid}`);
      const agentA = detail?.agents.find((a) => a.agentId === "agentA");
      const agentB = detail?.agents.find((a) => a.agentId === "agentB");
      expect(agentA?.parentAgentId).toBeNull();
      expect(agentB?.parentAgentId).toBe("agentA");
    });
  });
});
