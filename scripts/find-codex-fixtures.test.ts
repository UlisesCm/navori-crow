/**
 * `CodexFlagAccumulator`'s flag logic on synthetic envelopes (no file I/O):
 * main vs `thread_spawn` vs `guardian` classification, fork detection,
 * `subagent_history_start_ordinal` detection, first-`token_count`
 * fresh-vs-carried-over classification, and the "re-emitted `user_message`
 * that differs only in `timestamp`" detector.
 */
import { describe, expect, test } from "bun:test";
import { CodexFlagAccumulator } from "./find-codex-fixtures";

function sessionMeta(payload: Record<string, unknown>): Record<string, unknown> {
  return { timestamp: "2024-01-01T00:00:00.000Z", type: "session_meta", payload };
}

function tokenCount(
  total: Record<string, number>,
  last: Record<string, number>,
): Record<string, unknown> {
  return {
    timestamp: "2024-01-01T00:00:01.000Z",
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last } },
  };
}

function userMessage(ts: string, text: string): Record<string, unknown> {
  return { timestamp: ts, type: "event_msg", payload: { type: "user_message", message: text } };
}

describe("CodexFlagAccumulator: thread kind classification", () => {
  test("no source.subagent -> main", () => {
    const acc = new CodexFlagAccumulator();
    acc.feed(sessionMeta({ id: "t1", cli_version: "0.155.1" }));
    expect(acc.finalize()).toMatchObject({ kind: "main", cliVersion: "0.155.1", isFork: false });
  });

  test("source.subagent.thread_spawn -> thread_spawn, and its parent/session ids are captured", () => {
    const acc = new CodexFlagAccumulator();
    acc.feed(
      sessionMeta({
        id: "t2",
        session_id: "root1",
        source: { subagent: { thread_spawn: { parent_thread_id: "root1" } } },
      }),
    );
    const flags = acc.finalize();
    expect(flags.kind).toBe("thread_spawn");
    expect(flags.threadId).toBe("t2");
    expect(flags.rootSessionId).toBe("root1");
  });

  test('source.subagent.other === "guardian" -> guardian', () => {
    const acc = new CodexFlagAccumulator();
    acc.feed(
      sessionMeta({ id: "t3", session_id: "root1", source: { subagent: { other: "guardian" } } }),
    );
    expect(acc.finalize().kind).toBe("guardian");
  });

  test("more than one session_meta line -> isFork = true, and only the first is classified", () => {
    const acc = new CodexFlagAccumulator();
    acc.feed(sessionMeta({ id: "t1", cli_version: "0.155.1" }));
    acc.feed(sessionMeta({ id: "different-and-ignored" }));
    const flags = acc.finalize();
    expect(flags.isFork).toBe(true);
    expect(flags.threadId).toBe("t1");
  });

  test("subagent_history_start_ordinal presence is flagged", () => {
    const acc = new CodexFlagAccumulator();
    acc.feed(sessionMeta({ id: "t1", subagent_history_start_ordinal: 42 }));
    expect(acc.finalize().hasHistoryStart).toBe(true);
  });
});

describe("CodexFlagAccumulator: first token_count classification", () => {
  test("fresh: first total equals first last", () => {
    const acc = new CodexFlagAccumulator();
    const totals = {
      input_tokens: 10,
      cached_input_tokens: 2,
      cache_write_input_tokens: 0,
      output_tokens: 5,
    };
    acc.feed(tokenCount(totals, totals));
    expect(acc.finalize().firstTokenCount).toEqual({ totalEqualsLast: true, gap: 0 });
  });

  test("carried-over: first total exceeds first last by the accumulated gap", () => {
    const acc = new CodexFlagAccumulator();
    acc.feed(
      tokenCount(
        {
          input_tokens: 2_000_010,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 0,
        },
        { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 },
      ),
    );
    expect(acc.finalize().firstTokenCount).toEqual({ totalEqualsLast: false, gap: 2_000_000 });
  });

  test("only the first token_count is recorded; later ones don't overwrite it", () => {
    const acc = new CodexFlagAccumulator();
    const fresh = {
      input_tokens: 10,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 0,
    };
    const later = {
      input_tokens: 999,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 0,
    };
    acc.feed(tokenCount(fresh, fresh));
    acc.feed(tokenCount(later, fresh));
    expect(acc.finalize().firstTokenCount).toEqual({ totalEqualsLast: true, gap: 0 });
  });
});

describe("CodexFlagAccumulator: re-emitted user_message detection", () => {
  test("same text, only timestamp differs -> flagged", () => {
    const acc = new CodexFlagAccumulator();
    acc.feed(userMessage("2024-01-01T00:00:00.000Z", "fix the bug"));
    acc.feed(userMessage("2024-01-01T00:00:00.010Z", "fix the bug"));
    expect(acc.finalize().hasReemittedUserMessage).toBe(true);
  });

  test("different text at different timestamps -> not flagged", () => {
    const acc = new CodexFlagAccumulator();
    acc.feed(userMessage("2024-01-01T00:00:00.000Z", "fix the bug"));
    acc.feed(userMessage("2024-01-01T00:00:05.000Z", "review the PR"));
    expect(acc.finalize().hasReemittedUserMessage).toBe(false);
  });

  test("an exact byte-identical duplicate (same timestamp too) is not a re-emission", () => {
    const acc = new CodexFlagAccumulator();
    acc.feed(userMessage("2024-01-01T00:00:00.000Z", "fix the bug"));
    acc.feed(userMessage("2024-01-01T00:00:00.000Z", "fix the bug"));
    expect(acc.finalize().hasReemittedUserMessage).toBe(false);
  });
});

describe("CodexFlagAccumulator: malformed/unrelated lines", () => {
  test("lines that don't parse to a record still count toward lineCount", () => {
    const acc = new CodexFlagAccumulator();
    acc.feed(undefined);
    acc.feed("not-an-object");
    acc.feed(sessionMeta({ id: "t1" }));
    expect(acc.finalize().lineCount).toBe(3);
  });
});
