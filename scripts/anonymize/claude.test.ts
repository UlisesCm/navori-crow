/**
 * `anonymizeClaudeFixture` on a synthetic transcript (main + a sync
 * subagent + an async subagent, each with a `.meta.json`, a task
 * notification, a duplicated `message.id`, `is_error`, `compact_boundary`
 * and `attachment`): no original free text/path/email survives, ids are
 * consistently mapped everywhere they occur (including inside the
 * task-notification's XML-ish text and in file names), usage numbers are
 * untouched, and — the key property — running the anonymized output
 * through the real `claudeAdapter` pipeline yields the same event kinds/
 * counts, totals and agent tree as the original input (R11, R12).
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CrowEvent, EventBus as EventBusType, Totals } from "@crow/core";
import {
  EventBus,
  createUlidFactory,
  getSessionDetail,
  migrate,
  processFile,
  stats,
} from "@crow/core";
import { claudeAdapter } from "@crow/adapter-claude";
import type { AnonymizeOutputFile, AnonymizeSourceFile } from "./claude";
import { anonymizeClaudeFixture } from "./claude";

const NOW = Date.parse("2026-09-24T10:00:00.000Z");
const ORIGINAL_CWD = "/Users/dev/projA";
const ORIGINAL_BRANCH = "feature/x";
const SESSION_ID = "sess-real1";

function iso(offsetSec: number): string {
  return new Date(Date.parse("2024-03-01T09:00:00.000Z") + offsetSec * 1000).toISOString();
}

function line(obj: Record<string, unknown>): string {
  return `${JSON.stringify(obj)}\n`;
}

/** Builds the synthetic session's four files (main, two subagent transcripts, two sidecars). */
function buildOriginalFiles(): { path: string; content: string }[] {
  const base = { sessionId: SESSION_ID, cwd: ORIGINAL_CWD, gitBranch: ORIGINAL_BRANCH };

  const main =
    line({
      type: "user",
      timestamp: iso(0),
      ...base,
      uuid: "u0",
      promptSource: "typed",
      origin: { kind: "human" },
      message: { content: "explica el bug en /Users/dev/projA/secret.txt para test@example.com" },
    }) +
    line({
      type: "assistant",
      timestamp: iso(1),
      ...base,
      uuid: "u1",
      message: {
        id: "m1",
        role: "assistant",
        model: "claude-3.7-sonnet",
        content: [
          { type: "text", text: "voy a revisar con un subagente" },
          {
            type: "tool_use",
            id: "c1",
            name: "Agent",
            input: { subagent_type: "implementer", description: "fix bug" },
          },
        ],
        usage: {
          input_tokens: 11,
          output_tokens: 22,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 5,
        },
      },
    }) +
    // Duplicated message.id, different uuid/bytes (design.md's dedupe-by-usageKey case).
    line({
      type: "assistant",
      timestamp: iso(2),
      ...base,
      uuid: "u1dup",
      message: {
        id: "m1",
        role: "assistant",
        model: "claude-3.7-sonnet",
        content: [{ type: "text", text: "voy a revisar con un subagente" }],
        usage: {
          input_tokens: 11,
          output_tokens: 22,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 5,
        },
      },
    }) +
    line({
      type: "user",
      timestamp: iso(3),
      ...base,
      uuid: "u3",
      message: {
        content: [{ type: "tool_result", tool_use_id: "c1", content: "listo", is_error: false }],
      },
      toolUseResult: {
        agentId: "agentA",
        status: "completed",
        description: "fix bug for test@example.com",
        isAsync: false,
        canReadOutputFile: false,
        outputFile: null,
        prompt: "fix bug",
        resolvedModel: "claude-3.7-sonnet",
      },
    }) +
    line({
      type: "assistant",
      timestamp: iso(4),
      ...base,
      uuid: "u4",
      message: {
        id: "m2",
        role: "assistant",
        model: "claude-3.7-sonnet",
        content: [
          {
            type: "tool_use",
            id: "c9",
            name: "Agent",
            input: { subagent_type: "reviewer", description: "review Y" },
          },
        ],
        usage: {
          input_tokens: 7,
          output_tokens: 9,
          cache_read_input_tokens: 1,
          cache_creation_input_tokens: 2,
        },
      },
    }) +
    line({
      type: "user",
      timestamp: iso(5),
      ...base,
      uuid: "u5",
      message: { content: [{ type: "tool_result", tool_use_id: "c9", content: "launched" }] },
      toolUseResult: {
        agentId: "agentB",
        status: "async_launched",
        description: "review Y",
        isAsync: true,
        canReadOutputFile: true,
        outputFile: "/tmp/agentB.out",
        prompt: "review Y",
        resolvedModel: "claude-3.7-sonnet",
      },
    }) +
    line({
      type: "user",
      timestamp: iso(6),
      ...base,
      uuid: "u6",
      origin: { kind: "task-notification" },
      message: {
        content:
          "<task-notification><task-id>c9</task-id><tool-use-id>c9</tool-use-id>" +
          "<status>completed</status><summary>revisado por test@example.com</summary></task-notification>",
      },
    }) +
    line({
      type: "assistant",
      timestamp: iso(7),
      ...base,
      uuid: "u7",
      message: {
        id: "m3",
        role: "assistant",
        model: "claude-3.7-sonnet",
        content: [
          {
            type: "tool_use",
            id: "c-err",
            name: "Bash",
            input: { command: "rm -rf /nonexistent" },
          },
        ],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    }) +
    line({
      type: "user",
      timestamp: iso(8),
      ...base,
      uuid: "u8",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "c-err", content: "no such file", is_error: true },
        ],
      },
    }) +
    line({ type: "system", subtype: "compact_boundary", timestamp: iso(9), ...base, uuid: "u9" }) +
    line({
      type: "attachment",
      timestamp: iso(10),
      ...base,
      uuid: "u10",
      path: "/Users/dev/projA/image.png",
    });

  const agentA = line({
    type: "user",
    timestamp: iso(1.5),
    ...base,
    agentId: "agentA",
    uuid: "ua0",
    message: { content: "arregla el bug de /Users/dev/projA/secret.txt" },
  });
  const agentAMeta = JSON.stringify({
    agentType: "implementer",
    description: "fix bug for test@example.com",
    toolUseId: "c1",
    spawnDepth: 1,
  });

  const agentB = line({
    type: "user",
    timestamp: iso(4.5),
    ...base,
    agentId: "agentB",
    uuid: "ub0",
    message: { content: "revisa el PR" },
  });
  const agentBMeta = JSON.stringify({
    agentType: "reviewer",
    description: "review Y",
    toolUseId: "c9",
    spawnDepth: 1,
  });

  return [
    { path: "proj/sess-real1.jsonl", content: main },
    { path: "proj/sess-real1/subagents/agent-agentA.jsonl", content: agentA },
    { path: "proj/sess-real1/subagents/agent-agentA.meta.json", content: agentAMeta },
    { path: "proj/sess-real1/subagents/agent-agentB.jsonl", content: agentB },
    { path: "proj/sess-real1/subagents/agent-agentB.meta.json", content: agentBMeta },
  ];
}

const ROOT = "/fake/projects";

function toSourceFiles(files: { path: string; content: string }[]): AnonymizeSourceFile[] {
  return files.map(({ path, content }) => {
    const absPath = join(ROOT, path);
    const match = claudeAdapter.matches(absPath, ROOT);
    if (match === null)
      throw new Error(`synthetic fixture path did not match the adapter: ${path}`);
    return { match, relPath: path, content };
  });
}

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "crow-claude-anon-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ROLE_PRIORITY = { main: 0, sidecar: 1, agent: 2 } as const;

/**
 * Writes `files` under `root`, then ingests the main and agent transcripts through the real adapter
 * pipeline (main first, then agents — every sidecar is on disk by the time its agent file's
 * `initialState` reads it, mirroring `subagents.test.ts`'s ordering).
 */
async function ingestAll(
  root: string,
  files: { relPath: string; content: string }[],
): Promise<{ db: Database; events: CrowEvent[]; sessionId: string }> {
  const db = freshDb();
  const bus: EventBusType = new EventBus();
  const events: CrowEvent[] = [];
  let sessionId: string | null = null;

  const withMatch = files.map((f) => {
    const absPath = join(root, f.relPath);
    const match = claudeAdapter.matches(absPath, root);
    if (match === null) throw new Error(`ingested path did not match the adapter: ${f.relPath}`);
    return { f, absPath, match };
  });
  const ordered = [...withMatch].sort(
    (a, b) => ROLE_PRIORITY[a.match.role] - ROLE_PRIORITY[b.match.role],
  );

  for (const { f, absPath } of ordered) {
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, f.content);
  }

  for (const { absPath, match } of ordered) {
    if (match.role === "sidecar") continue;
    if (match.sessionId !== null) sessionId = match.sessionId;
    const result = await processFile({
      db,
      bus,
      adapter: claudeAdapter,
      path: absPath,
      match,
      nextId: createUlidFactory("00000000000000000000000000", () => NOW),
      now: () => NOW,
      idleMs: 5 * 60_000,
    });
    events.push(...result.events);
  }
  if (sessionId === null) throw new Error("no main transcript found among the ingested files");
  return { db, events, sessionId };
}

interface Summary {
  totals: Totals;
  agents: { type: string | null; status: string; isRoot: boolean; totals: Totals }[];
  errors: number;
}

function summarize(db: Database, sessionId: string): Summary {
  const detail = getSessionDetail(db, `claude:${sessionId}`);
  if (detail === null) throw new Error(`no session detail for claude:${sessionId}`);
  return {
    totals: detail.session.totals,
    agents: detail.agents
      .filter((a) => a.agentId !== null)
      .map((a) => ({
        type: a.type,
        status: a.status,
        isRoot: a.parentAgentId === null,
        totals: a.totals,
      }))
      .sort((a, b) => (a.type ?? "").localeCompare(b.type ?? "")),
    errors: Object.values(stats(db).errorsByReason).reduce((sum, n) => sum + n, 0),
  };
}

function kindCounts(events: CrowEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) out[e.kind] = (out[e.kind] ?? 0) + 1;
  return out;
}

describe("anonymizeClaudeFixture: no PII survives (R11, R12)", () => {
  test("free text, the original cwd/branch, and emails/paths are gone from every output file", () => {
    const outputs = anonymizeClaudeFixture(toSourceFiles(buildOriginalFiles()), {
      repo: "navori-crow",
      epochIso: "2026-01-01T00:00:00.000Z",
    });
    const joined = outputs.map((o) => o.content).join("\n");

    for (const leaked of [
      ORIGINAL_CWD,
      ORIGINAL_BRANCH,
      "test@example.com",
      "secret.txt",
      "explica el bug",
      "arregla el bug",
      "revisa el PR",
      "revisado por",
      "image.png",
      "rm -rf /nonexistent",
    ]) {
      expect(joined).not.toContain(leaked);
    }
    expect(joined).toContain("/tmp/crow-fixture/navori-crow");
    expect(joined).toContain("fixture-branch");
  });

  test("structural strings the adapter branches on survive verbatim", () => {
    const outputs = anonymizeClaudeFixture(toSourceFiles(buildOriginalFiles()), {
      repo: "navori-crow",
    });
    const main = outputs.find(
      (o) => o.relPath.endsWith(".jsonl") && !o.relPath.includes("subagents"),
    );
    expect(main).toBeDefined();
    const lines = main!.content
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l.type)).toEqual([
      "user",
      "assistant",
      "assistant",
      "user",
      "assistant",
      "user",
      "user",
      "assistant",
      "user",
      "system",
      "attachment",
    ]);
    expect(lines[9]!.subtype).toBe("compact_boundary");
  });
});

describe("anonymizeClaudeFixture: id correlation and usage (R11, R12)", () => {
  test("ids stay consistent across files and inside the task-notification text; usage numbers are untouched", () => {
    const outputs = anonymizeClaudeFixture(toSourceFiles(buildOriginalFiles()), {
      repo: "navori-crow",
    });
    const main = outputs.find(
      (o) => o.relPath.endsWith(".jsonl") && !o.relPath.includes("subagents"),
    )!;
    const agentAFile = outputs.find(
      (o) => o.relPath.endsWith(".jsonl") && o.relPath.includes("subagents"),
    )!;
    const mainLines = main.content
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    // Same sessionId pseudonym on every line, and it names the rewritten slug/file.
    const sessionPseudonym = mainLines[0]!.sessionId;
    expect(mainLines.every((l) => l.sessionId === sessionPseudonym)).toBe(true);
    expect(main.relPath).toBe(`-tmp-crow-fixture-navori-crow/${sessionPseudonym}.jsonl`);

    // The sync spawn call id ("c1") is the same pseudonym on the tool_use block and the tool_result.
    const spawnMsg = mainLines[1]!.message as { content: { type: string; id: string }[] };
    const spawnCallId: string = spawnMsg.content.find((b) => b.type === "tool_use")!.id;
    const resultMsg = mainLines[3]!.message as { content: { tool_use_id: string }[] };
    expect(resultMsg.content[0]!.tool_use_id).toBe(spawnCallId);

    // The async spawn call id ("c9") is the same pseudonym on the tool_use block, the tool_result,
    // and inside the task-notification's <tool-use-id> tag.
    const asyncSpawnMsg = mainLines[4]!.message as { content: { type: string; id: string }[] };
    const asyncSpawnCallId: string = asyncSpawnMsg.content.find((b) => b.type === "tool_use")!.id;
    const asyncResultMsg = mainLines[5]!.message as { content: { tool_use_id: string }[] };
    expect(asyncResultMsg.content[0]!.tool_use_id).toBe(asyncSpawnCallId);
    const notificationContent = (mainLines[6]!.message as { content: string }).content;
    expect(notificationContent).toContain(`<tool-use-id>${asyncSpawnCallId}</tool-use-id>`);
    expect(notificationContent).toContain("<status>completed</status>");
    expect(notificationContent).not.toContain("<task-id>");
    expect(notificationContent).not.toContain("revisado");

    // The agentA transcript's own agentId pseudonym matches its filename and the main transcript's
    // toolUseResult.agentId for the same subagent.
    const agentALine = JSON.parse(agentAFile.content.trim()) as Record<string, unknown>;
    const syncToolUseResult = mainLines[3]!.toolUseResult as { agentId: string };
    expect(agentALine.agentId).toBe(syncToolUseResult.agentId);
    expect(agentAFile.relPath).toContain(`agent-${syncToolUseResult.agentId}.jsonl`);

    // Usage numbers are numerically untouched.
    const originalUsage = {
      input_tokens: 11,
      output_tokens: 22,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 5,
    };
    const anonUsage = (mainLines[1]!.message as { usage: typeof originalUsage }).usage;
    expect(anonUsage).toEqual(originalUsage);
  });
});

describe("anonymizeClaudeFixture: round-trip parity through the real adapter pipeline (R11, R12)", () => {
  test("the anonymized session yields the same event kinds/counts, totals and agent tree as the original", async () => {
    await withTempDir(async (origRoot) => {
      await withTempDir(async (anonRoot) => {
        const originalFiles = buildOriginalFiles();
        const orig = await ingestAll(
          origRoot,
          originalFiles.map((f) => ({ relPath: f.path, content: f.content })),
        );
        const origSummary = summarize(orig.db, orig.sessionId);
        const origKinds = kindCounts(orig.events);

        const outputs: AnonymizeOutputFile[] = anonymizeClaudeFixture(
          toSourceFiles(originalFiles),
          {
            repo: "navori-crow",
          },
        );
        const anon = await ingestAll(
          anonRoot,
          outputs.map((o) => ({ relPath: o.relPath, content: o.content })),
        );
        const anonSummary = summarize(anon.db, anon.sessionId);
        const anonKinds = kindCounts(anon.events);

        expect(anon.sessionId).not.toBe(orig.sessionId); // it's a pseudonym, not the original id
        expect(anonSummary).toEqual(origSummary);
        expect(anonKinds).toEqual(origKinds);
      });
    });
  });
});

/** Anonymizes a single synthetic main-transcript line and returns its one output file's content. */
function anonymizeSingleLine(obj: Record<string, unknown>): string {
  const files = toSourceFiles([{ path: "proj/sess-str1.jsonl", content: line(obj) }]);
  return anonymizeClaudeFixture(files, { repo: "navori-crow" })[0]!.content;
}

describe("anonymizeClaudeFixture: fail-closed default for bare strings (review round 2)", () => {
  test("bare strings inside a plain array are markered, not passed through", () => {
    const out = anonymizeSingleLine({
      type: "user",
      timestamp: iso(0),
      sessionId: "sess-str1",
      uuid: "u0",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "c1",
            content: ["/Users/dev/projA/secret line one", "leak@example.com"],
          },
        ],
      },
    });
    expect(out).not.toContain("/Users/dev/projA");
    expect(out).not.toContain("leak@example.com");

    const parsed = JSON.parse(out.trim()) as Record<string, unknown>;
    const message = parsed.message as { content: { content: unknown[] }[] };
    const resultContent = message.content[0]!.content;
    expect(resultContent).toHaveLength(2);
    expect(resultContent.every((v) => typeof v === "string" && v.startsWith("«str:"))).toBe(true);
  });

  test("bare strings inside a nested array (array of arrays) are markered", () => {
    const out = anonymizeSingleLine({
      type: "user",
      timestamp: iso(0),
      sessionId: "sess-str1",
      uuid: "u0",
      toolUseResult: {
        agentId: "irrelevant",
        status: "irrelevant-status",
        matrix: [["/Users/a/b", "plain"], ["nested@example.com"]],
      },
    });
    expect(out).not.toContain("/Users/a/b");
    expect(out).not.toContain("nested@example.com");
  });

  test("a path-/email-shaped object key (non-identifier-shaped) is key-markered, value too", () => {
    const out = anonymizeSingleLine({
      type: "user",
      timestamp: iso(0),
      sessionId: "sess-str1",
      uuid: "u0",
      toolUseResult: {
        agentId: "irrelevant",
        status: "irrelevant-status",
        fileMap: { "/Users/attacker/secret.txt": "sensitive value here" },
      },
    });
    expect(out).not.toContain("/Users/attacker/secret.txt");
    expect(out).not.toContain("sensitive value here");

    const parsed = JSON.parse(out.trim()) as {
      toolUseResult: { fileMap: Record<string, unknown> };
    };
    const fileMapKeys = Object.keys(parsed.toolUseResult.fileMap);
    expect(fileMapKeys).toHaveLength(1);
    expect(fileMapKeys[0]).toMatch(/^«key:\d+»$/);
    expect(Object.values(parsed.toolUseResult.fileMap)[0]).toBe("«str:0»");
  });

  test("a real-transcript shape (round 3): AskUserQuestion's `answers` map keyed by the question sentence", () => {
    const question = "R15 — ¿Cómo se asigna el proyecto cuando el cwd no resuelve a un repo git?";
    const out = anonymizeSingleLine({
      type: "user",
      timestamp: iso(0),
      sessionId: "sess-str1",
      uuid: "u0",
      toolUseResult: {
        agentId: "irrelevant",
        status: "irrelevant-status",
        answers: { [question]: "unresolved, con el primer cwd" },
      },
    });
    expect(out).not.toContain("Cómo se asigna el proyecto");
    expect(out).not.toContain("unresolved, con el primer cwd");

    const parsed = JSON.parse(out.trim()) as {
      toolUseResult: { answers: Record<string, unknown> };
    };
    const answerKeys = Object.keys(parsed.toolUseResult.answers);
    expect(answerKeys).toHaveLength(1);
    expect(answerKeys[0]).toMatch(/^«key:\d+»$/);
  });

  test("a real-transcript shape (round 3): a modelUsage-style map keyed by a model id", () => {
    const out = anonymizeSingleLine({
      type: "user",
      timestamp: iso(0),
      sessionId: "sess-str1",
      uuid: "u0",
      toolUseResult: {
        agentId: "irrelevant",
        status: "irrelevant-status",
        modelUsage: { "claude-opus-5-5[1m]": { inputTokens: 10, outputTokens: 20 } },
      },
    });
    expect(out).not.toContain("claude-opus-5-5[1m]");

    const parsed = JSON.parse(out.trim()) as {
      toolUseResult: { modelUsage: Record<string, unknown> };
    };
    const modelKeys = Object.keys(parsed.toolUseResult.modelUsage);
    expect(modelKeys).toHaveLength(1);
    expect(modelKeys[0]).toMatch(/^«key:\d+»$/);
    // Numbers nested under a markered key are still untouched (design.md: usage numbers never change).
    expect(Object.values(parsed.toolUseResult.modelUsage)[0]).toEqual({
      inputTokens: 10,
      outputTokens: 20,
    });
  });

  test("cc-2.1.281 shape: an attachment/queued_command/task-notification line preserves the <tool-use-id> correlation and drops <summary>/<result>", () => {
    const sentinel = "SENTINEL_summary_leak";
    const out = anonymizeSingleLine({
      type: "attachment",
      timestamp: iso(0),
      sessionId: "sess-str1",
      uuid: "u0",
      attachment: {
        type: "queued_command",
        commandMode: "task-notification",
        prompt:
          "<task-notification><task-id>c9</task-id><tool-use-id>c9</tool-use-id>" +
          `<status>completed</status><summary>${sentinel}</summary>` +
          `<result>also ${sentinel}</result></task-notification>`,
        source_uuid: "src-uuid-1",
      },
      rendered: [{ content: `duplicate rendering of ${sentinel}` }],
      renderedInHumanTurn: [{ content: `human-turn rendering of ${sentinel}` }],
    });
    expect(out).not.toContain(sentinel);
    expect(out).not.toContain("<task-id>");
    expect(out).not.toContain("<summary>");
    expect(out).not.toContain("<result>");
    expect(out).toContain("task-notification");
    expect(out).toContain("<status>completed</status>");

    const parsed = JSON.parse(out.trim()) as {
      attachment: { type: string; commandMode: string; prompt: string };
    };
    expect(parsed.attachment.type).toBe("queued_command"); // structural key: not markered
    expect(parsed.attachment.commandMode).toBe("task-notification"); // now allowlisted
    expect(parsed.attachment.prompt).toMatch(
      /^<task-notification><tool-use-id>id\d+<\/tool-use-id>/,
    );
  });

  test("cc-2.1.281 shape: the same call id gets the same pseudonym across the tool_use block and the attachment's <tool-use-id>", () => {
    const files = toSourceFiles([
      {
        path: "proj/sess-corr1.jsonl",
        content:
          line({
            type: "assistant",
            timestamp: iso(0),
            sessionId: "sess-corr1",
            cwd: ORIGINAL_CWD,
            uuid: "u1",
            message: {
              id: "m1",
              role: "assistant",
              model: "claude-x",
              content: [{ type: "tool_use", id: "call-9", name: "Agent", input: {} }],
            },
          }) +
          line({
            type: "attachment",
            timestamp: iso(1),
            sessionId: "sess-corr1",
            cwd: ORIGINAL_CWD,
            uuid: "u2",
            attachment: {
              type: "queued_command",
              commandMode: "task-notification",
              prompt:
                "<task-notification><tool-use-id>call-9</tool-use-id>" +
                "<status>completed</status></task-notification>",
            },
          }),
      },
    ]);
    const out = anonymizeClaudeFixture(files, { repo: "navori-crow" })[0]!.content;
    const lines = out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const toolUseId = (
      (lines[0]!.message as { content: { id: string }[] }).content[0] as { id: string }
    ).id;
    const attachment = lines[1]!.attachment as { prompt: string };
    expect(attachment.prompt).toContain(`<tool-use-id>${toolUseId}</tool-use-id>`);
  });

  test("an attachment line that isn't a task-notification (e.g. total_tokens_reminder) still gets its free text markered", () => {
    const out = anonymizeSingleLine({
      type: "attachment",
      timestamp: iso(0),
      sessionId: "sess-str1",
      uuid: "u0",
      attachment: { type: "total_tokens_reminder", text: "some free text here" },
    });
    expect(out).not.toContain("some free text here");
  });

  test("property-style: a sentinel planted in every shape — values AND non-identifier keys, at several depths — never survives verbatim", () => {
    const sentinels = Array.from({ length: 12 }, (_, i) => `SENTINEL_${i}`);
    // Sentence-shaped: spaces + `?` guarantee it never accidentally matches IDENTIFIER_KEY_RE.
    const keyWith = (n: number): string => `question ${sentinels[n]}?`;

    const out = anonymizeSingleLine({
      type: "user",
      timestamp: iso(0),
      sessionId: "sess-str1",
      uuid: "u0",
      extraField: sentinels[0], // unknown top-level key (identifier-shaped), sentinel only in the value
      [keyWith(8)]: "answer at depth 1", // sentinel inside a non-identifier key, depth 1 (top-level)
      message: {
        content: [
          { type: "text", text: sentinels[1] }, // free text inside an array of objects
          { type: "tool_use", id: "c1", name: "Bash", input: { command: sentinels[2] } }, // free text nested in input
          sentinels[3], // bare string directly in the array
          [sentinels[4], sentinels[5]], // nested array
          { [keyWith(11)]: "answer inside an array element" }, // sentinel in a key nested inside an array
        ],
      },
      toolUseResult: {
        agentId: "irrelevant",
        status: "irrelevant-status",
        description: sentinels[6],
        nested: { deeper: { evenDeeper: sentinels[7] } },
        // AskUserQuestion-shaped: sentinel in a key nested 2 levels deep (round 3's real leak shape).
        answers: { [keyWith(9)]: "answer at depth 2" },
        // modelUsage-shaped: sentinel in a key nested 3 levels deep.
        nested2: { deeperMap: { [keyWith(10)]: "answer at depth 3" } },
      },
    });
    for (const sentinel of sentinels) {
      expect(out).not.toContain(sentinel);
    }
  });
});
