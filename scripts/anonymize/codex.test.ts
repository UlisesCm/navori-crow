/**
 * `anonymizeCodexFixture` on synthetic rollout files (a main + a
 * `thread_spawn` fork sharing a call/output pair, mirroring design.md §
 * Evidencia: Codex CLI): ids stay correlated across files (including the
 * filename's thread id), usage numbers are byte-identical, no free text
 * survives in values or keys, trimming keeps only the first N
 * `token_count`s, the run is deterministic, `cwd` is rewritten, and
 * timestamp shifting preserves ordering/deltas.
 */
import { describe, expect, test } from "bun:test";
import type { AnonymizeSourceFile } from "./codex";
import { anonymizeCodexFixture } from "./codex";

const ORIGINAL_CWD = "/Users/dev/projA";
const ROOT_ID = "thread-root-aaa";
const FORK_ID = "thread-fork-bbb";

function iso(offsetSec: number): string {
  return new Date(Date.parse("2024-03-01T09:00:00.000Z") + offsetSec * 1000).toISOString();
}

function line(obj: Record<string, unknown>): string {
  return `${JSON.stringify(obj)}\n`;
}

/** Builds a main rollout (session_meta, a user_message, a function_call/output pair, two
 * `token_count`s) and a `thread_spawn` fork rollout that shares the tool call id. */
function buildFiles(): AnonymizeSourceFile[] {
  const main =
    line({
      timestamp: iso(0),
      type: "session_meta",
      payload: {
        id: ROOT_ID,
        cwd: ORIGINAL_CWD,
        cli_version: "0.155.1",
        git: { repository_url: "git@github.com:acme/secret-repo.git", branch: "feature/x" },
      },
    }) +
    line({
      timestamp: iso(1),
      type: "turn_context",
      payload: { model: "gpt-5.6-sol", cwd: ORIGINAL_CWD, instructions: "you are a helpful agent" },
    }) +
    line({
      timestamp: iso(2),
      type: "event_msg",
      payload: { type: "user_message", message: "explica el bug en /Users/dev/projA/secret.txt" },
    }) +
    line({
      timestamp: iso(3),
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "call-1",
        name: "shell",
        arguments: "rm -rf /nonexistent",
      },
    }) +
    line({
      timestamp: iso(4),
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call-1", output: "no such file" },
    }) +
    line({
      timestamp: iso(5),
      type: "event_msg",
      ordinal: 5,
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 10,
            cache_write_input_tokens: 0,
            output_tokens: 40,
          },
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 10,
            cache_write_input_tokens: 0,
            output_tokens: 40,
          },
        },
      },
    }) +
    line({
      timestamp: iso(6),
      type: "event_msg",
      ordinal: 6,
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 150,
            cached_input_tokens: 10,
            cache_write_input_tokens: 0,
            output_tokens: 60,
          },
          last_token_usage: {
            input_tokens: 50,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 20,
          },
        },
      },
    });

  const fork = line({
    timestamp: iso(2.5),
    type: "session_meta",
    payload: {
      id: FORK_ID,
      session_id: ROOT_ID,
      forked_from_id: ROOT_ID,
      cwd: ORIGINAL_CWD,
      cli_version: "0.155.1",
      subagent_history_start_ordinal: 3,
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: ROOT_ID,
            depth: 1,
            agent_role: "explorer",
            agent_nickname: "el investigador",
          },
        },
      },
    },
  });

  return [
    { relPath: `2024/03/01/rollout-2024-03-01T09-00-00-${ROOT_ID}.jsonl`, content: main },
    { relPath: `2024/03/01/rollout-2024-03-01T09-00-02-${FORK_ID}.jsonl`, content: fork },
  ];
}

describe("anonymizeCodexFixture: no free text survives, structural strings kept (R14)", () => {
  test("free text, the original cwd/git remote/branch, and instructions are gone", () => {
    const outputs = anonymizeCodexFixture(buildFiles(), { repo: "navori-crow" });
    const joined = outputs.map((o) => o.content).join("\n");

    for (const leaked of [
      ORIGINAL_CWD,
      "secret-repo",
      "feature/x",
      "you are a helpful agent",
      "explica el bug",
      "secret.txt",
      "rm -rf /nonexistent",
      "no such file",
      "el investigador",
      ROOT_ID,
      FORK_ID,
    ]) {
      expect(joined).not.toContain(leaked);
    }
    expect(joined).toContain("/tmp/crow-fixture/navori-crow");
  });

  test("type/subtype, model, cli_version and agent_role survive verbatim", () => {
    const outputs = anonymizeCodexFixture(buildFiles(), { repo: "navori-crow" });
    const main = outputs.find(
      (o) => !o.relPath.includes("t09-00-02") && !o.relPath.endsWith("2.jsonl"),
    );
    const lines = outputs
      .flatMap((o) => o.content.trim().split("\n"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    expect(lines.map((l) => l.type)).toEqual([
      "session_meta",
      "turn_context",
      "event_msg",
      "response_item",
      "response_item",
      "event_msg",
      "event_msg",
      "session_meta",
    ]);
    const turnContext = lines[1]!.payload as { model: string };
    expect(turnContext.model).toBe("gpt-5.6-sol");
    const sessionMetaFork = lines[7]!.payload as {
      cli_version: string;
      source: { subagent: { thread_spawn: { agent_role: string; depth: number } } };
    };
    expect(sessionMetaFork.cli_version).toBe("0.155.1");
    expect(sessionMetaFork.source.subagent.thread_spawn.agent_role).toBe("explorer");
    expect(sessionMetaFork.source.subagent.thread_spawn.depth).toBe(1);
    void main;
  });
});

describe("anonymizeCodexFixture: id correlation across files and filename (R14, R16)", () => {
  test("root/fork thread ids, parent_thread_id, session_id and the call/output pair stay correlated", () => {
    const outputs = anonymizeCodexFixture(buildFiles(), { repo: "navori-crow" });
    const mainFile = outputs.find((o) => o.relPath.includes("00-00"))!;
    const forkFile = outputs.find((o) => o.relPath.includes("00-02"))!;

    const mainLines = mainFile.content
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const forkLine = JSON.parse(forkFile.content.trim()) as Record<string, unknown>;

    const rootPseudonym = (mainLines[0]!.payload as { id: string }).id;
    // The filename's thread id carries the same pseudonym as session_meta.payload.id.
    expect(mainFile.relPath).toContain(`-${rootPseudonym}.jsonl`);

    const forkPayload = forkLine.payload as {
      id: string;
      session_id: string;
      source: { subagent: { thread_spawn: { parent_thread_id: string } } };
    };
    expect(forkFile.relPath).toContain(`-${forkPayload.id}.jsonl`);
    expect(forkPayload.session_id).toBe(rootPseudonym);
    expect(forkPayload.source.subagent.thread_spawn.parent_thread_id).toBe(rootPseudonym);

    // The tool call id is the same pseudonym on the function_call and its output.
    const callLine = mainLines[3]!.payload as { call_id: string };
    const outputLine = mainLines[4]!.payload as { call_id: string };
    expect(outputLine.call_id).toBe(callLine.call_id);
    expect(callLine.call_id).not.toBe(rootPseudonym);
  });

  // Covers: R14
  test("session_meta.payload.forked_from_id maps to the parent's pseudonymized thread id", () => {
    const outputs = anonymizeCodexFixture(buildFiles(), { repo: "navori-crow" });
    const mainFile = outputs.find((o) => o.relPath.includes("00-00"))!;
    const forkFile = outputs.find((o) => o.relPath.includes("00-02"))!;
    const rootPseudonym = (
      JSON.parse(mainFile.content.trim().split("\n")[0]!) as { payload: { id: string } }
    ).payload.id;
    const forkPayload = (
      JSON.parse(forkFile.content.trim()) as {
        payload: {
          forked_from_id: string;
          source: { subagent: { thread_spawn: { parent_thread_id: string } } };
        };
      }
    ).payload;
    expect(forkPayload.forked_from_id).toBe(rootPseudonym);
    expect(forkPayload.forked_from_id).toBe(
      forkPayload.source.subagent.thread_spawn.parent_thread_id,
    );
  });

  test("usage numbers are numerically untouched", () => {
    const outputs = anonymizeCodexFixture(buildFiles(), { repo: "navori-crow" });
    const mainFile = outputs.find((o) => o.relPath.includes("00-00"))!;
    const mainLines = mainFile.content
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const secondTokenCount = mainLines[6]!.payload as {
      info: { total_token_usage: Record<string, number>; last_token_usage: Record<string, number> };
    };
    expect(secondTokenCount.info.total_token_usage).toEqual({
      input_tokens: 150,
      cached_input_tokens: 10,
      cache_write_input_tokens: 0,
      output_tokens: 60,
    });
    expect(secondTokenCount.info.last_token_usage).toEqual({
      input_tokens: 50,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 20,
    });
  });
});

describe("anonymizeCodexFixture: fail-closed default for free text (values and keys)", () => {
  test("a non-identifier-shaped key (free text in key position) is key-markered, value too", () => {
    const files: AnonymizeSourceFile[] = [
      {
        relPath: `2024/03/01/rollout-2024-03-01T09-00-00-${ROOT_ID}.jsonl`,
        content: line({
          timestamp: iso(0),
          type: "world_state",
          payload: { "question about the repo?": "a free-text answer" },
        }),
      },
    ];
    const out = anonymizeCodexFixture(files, { repo: "navori-crow" })[0]!.content;
    expect(out).not.toContain("question about the repo");
    expect(out).not.toContain("a free-text answer");
    const parsed = JSON.parse(out.trim()) as { payload: Record<string, unknown> };
    const keys = Object.keys(parsed.payload);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^«key:\d+»$/);
  });

  test("a bare string inside an array is markered, not passed through", () => {
    const files: AnonymizeSourceFile[] = [
      {
        relPath: `2024/03/01/rollout-2024-03-01T09-00-00-${ROOT_ID}.jsonl`,
        content: line({
          timestamp: iso(0),
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: ["free text leak", "another leak"],
          },
        }),
      },
    ];
    const out = anonymizeCodexFixture(files, { repo: "navori-crow" })[0]!.content;
    expect(out).not.toContain("free text leak");
    expect(out).not.toContain("another leak");
  });
});

describe("anonymizeCodexFixture: trimming to the first N token_counts (design.md item 2)", () => {
  test("maxTokenCounts=1 keeps only the lines up to and including the first token_count", () => {
    const outputs = anonymizeCodexFixture(buildFiles(), { repo: "navori-crow", maxTokenCounts: 1 });
    const mainFile = outputs.find((o) => o.relPath.includes("00-00"))!;
    const lines = mainFile.content.trim().split("\n");
    expect(lines).toHaveLength(6); // session_meta, turn_context, user_message, call, output, 1st token_count
    const parsed = lines.map((l) => JSON.parse(l) as { payload?: { type?: string } });
    expect(parsed.filter((l) => l.payload?.type === "token_count")).toHaveLength(1);
  });

  test("a file with fewer token_counts than the cap is kept whole", () => {
    const outputs = anonymizeCodexFixture(buildFiles(), {
      repo: "navori-crow",
      maxTokenCounts: 99,
    });
    const mainFile = outputs.find((o) => o.relPath.includes("00-00"))!;
    expect(mainFile.content.trim().split("\n")).toHaveLength(7);
  });
});

describe("anonymizeCodexFixture: determinism and timestamp shifting (R11, R14)", () => {
  test("the same input produces byte-identical output on two separate runs", () => {
    const a = anonymizeCodexFixture(buildFiles(), { repo: "navori-crow" });
    const b = anonymizeCodexFixture(buildFiles(), { repo: "navori-crow" });
    expect(a).toEqual(b);
  });

  test("relative ordering and deltas between timestamps are preserved after shifting", () => {
    const outputs = anonymizeCodexFixture(buildFiles(), { repo: "navori-crow" });
    const mainFile = outputs.find((o) => o.relPath.includes("00-00"))!;
    const timestamps = mainFile.content
      .trim()
      .split("\n")
      .map((l) => Date.parse((JSON.parse(l) as { timestamp: string }).timestamp));

    for (let i = 1; i < timestamps.length; i += 1) {
      expect(timestamps[i]).toBeGreaterThan(timestamps[i - 1]!);
    }
    const originalDeltaMs = 1000; // iso(0) -> iso(1)
    expect(timestamps[1]! - timestamps[0]!).toBe(originalDeltaMs);

    // The earliest event lands at the default epoch.
    expect(new Date(timestamps[0]!).toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  test("the rollout filename's embedded timestamp shifts consistently with the content", () => {
    const outputs = anonymizeCodexFixture(buildFiles(), { repo: "navori-crow" });
    const mainFile = outputs.find((o) => o.relPath.includes("2026"))!;
    expect(mainFile.relPath).toMatch(/^2026\/01\/01\/rollout-2026-01-01T00-00-00-id\d+\.jsonl$/);
  });
});
