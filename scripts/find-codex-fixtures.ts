#!/usr/bin/env bun
/**
 * Scans a Codex sessions root and prints, per rollout file, the structural
 * flags a human needs to pick a coherent set of fixture candidates for
 * `fixtures/codex/0.145.0/` and `fixtures/codex/0.155.1/` (design.md §
 * Evidencia: Codex CLI, § Testing strategy "Fixtures que hay que crear",
 * B7.T2 stage 1). Prints ONLY paths and structural flags — never content:
 * `cli_version`, whether the file is a main/`thread_spawn`/`guardian`
 * thread, whether it's a fork (more than one `session_meta`), whether it
 * carries `subagent_history_start_ordinal`, whether its first `token_count`
 * is "fresh" (`total == last`) or carries a stale accumulator (with the
 * gap), whether a `user_message` is re-emitted with only its `timestamp`
 * differing, line/byte counts, and which files share a root `session_id` so
 * a coherent set can be picked.
 *
 *   bun scripts/find-codex-fixtures.ts <sessions-root>
 *
 * Reads line by line (`node:readline` over a stream): Codex lines run up to
 * 4.46 MB and files up to 26.5 MB (design.md § Evidencia), so nothing here
 * loads a whole file into memory at once.
 */
import { createReadStream, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import { isRec, num, path, str } from "@crow/core";

/** `YYYY/MM/DD/rollout-<YYYY-MM-DDTHH-MM-SS>-<threadId>.jsonl`, mirrors `packages/adapters/codex/src/adapter.ts`. */
const ROLLOUT_RE = /^\d{4}\/\d{2}\/\d{2}\/rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/;

/** The four `token_count` components (design.md § Evidencia). */
interface TokenTotals {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
}

function readTotals(rec: Record<string, unknown>): TokenTotals {
  return {
    input: num(rec.input_tokens),
    cached: num(rec.cached_input_tokens),
    cacheWrite: num(rec.cache_write_input_tokens),
    output: num(rec.output_tokens),
  };
}

function totalsGap(total: TokenTotals, last: TokenTotals): number {
  return (
    total.input -
    last.input +
    (total.cached - last.cached) +
    (total.cacheWrite - last.cacheWrite) +
    (total.output - last.output)
  );
}

/** One rollout file's structural flags. */
export interface CodexFileFlags {
  cliVersion: string | null;
  kind: "main" | "thread_spawn" | "guardian" | "unknown";
  isFork: boolean;
  threadId: string | null;
  rootSessionId: string | null;
  hasHistoryStart: boolean;
  firstTokenCount: { totalEqualsLast: boolean; gap: number } | null;
  hasReemittedUserMessage: boolean;
  lineCount: number;
}

/** Accumulates {@link CodexFileFlags} incrementally, one parsed envelope at a time, so the CLI can
 * stream a file instead of holding it in memory (unit-testable independent of any file I/O). */
export class CodexFlagAccumulator {
  private sessionMetaCount = 0;
  private cliVersion: string | null = null;
  private kind: CodexFileFlags["kind"] = "unknown";
  private threadId: string | null = null;
  private rootSessionId: string | null = null;
  private hasHistoryStart = false;
  private firstTokenCount: CodexFileFlags["firstTokenCount"] = null;
  private hasReemittedUserMessage = false;
  private lineCount = 0;
  /** `fp -> [{ ts, withoutTs }]` of every `user_message` seen so far, to detect a re-emission that
   * differs only in `timestamp` (design.md § Evidencia: 14 such pairs found in Codex CLI's evidence). */
  private readonly userMessages = new Map<string, { ts: number; withoutTs: string }[]>();

  /** Feeds one already-parsed line. Malformed/non-envelope lines are ignored (counted, not classified). */
  feed(parsed: unknown): void {
    this.lineCount += 1;
    if (!isRec(parsed)) return;

    if (parsed.type === "session_meta" && isRec(parsed.payload)) {
      this.feedSessionMeta(parsed.payload);
    } else if (parsed.type === "event_msg" && isRec(parsed.payload)) {
      this.feedEventMsg(parsed);
    }
  }

  private feedSessionMeta(payload: Record<string, unknown>): void {
    this.sessionMetaCount += 1;
    if (this.sessionMetaCount > 1) return; // forks copy the parent's session_meta verbatim: ignore it
    this.cliVersion = str(payload.cli_version);
    this.threadId = str(payload.id);
    this.rootSessionId = str(payload.session_id);
    const historyStart = payload.subagent_history_start_ordinal;
    this.hasHistoryStart = typeof historyStart === "number";

    const subagent = path(payload, "source", "subagent");
    if (subagent === undefined) {
      this.kind = "main";
      this.rootSessionId ??= this.threadId;
    } else if (isRec(subagent) && isRec(subagent.thread_spawn)) {
      this.kind = "thread_spawn";
    } else if (isRec(subagent) && subagent.other === "guardian") {
      this.kind = "guardian";
    } else {
      this.kind = "unknown";
    }
  }

  private feedEventMsg(parsed: Record<string, unknown>): void {
    const payload = parsed.payload as Record<string, unknown>;
    if (payload.type === "user_message") {
      const text = str(payload.message);
      const ts = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : Number.NaN;
      if (text !== null && Number.isFinite(ts)) this.feedUserMessage(text, ts, parsed);
    } else if (payload.type === "token_count" && this.firstTokenCount === null) {
      const info = payload.info;
      if (isRec(info) && isRec(info.total_token_usage) && isRec(info.last_token_usage)) {
        const total = readTotals(info.total_token_usage);
        const last = readTotals(info.last_token_usage);
        const gap = totalsGap(total, last);
        this.firstTokenCount = { totalEqualsLast: gap === 0, gap };
      }
    }
  }

  private feedUserMessage(text: string, ts: number, rawEnvelope: Record<string, unknown>): void {
    const { timestamp: _ts, ...withoutTs } = rawEnvelope;
    const withoutTsJson = JSON.stringify(withoutTs);
    const seen = this.userMessages.get(text) ?? [];
    if (seen.some((s) => s.withoutTs === withoutTsJson && s.ts !== ts)) {
      this.hasReemittedUserMessage = true;
    }
    seen.push({ ts, withoutTs: withoutTsJson });
    this.userMessages.set(text, seen);
  }

  finalize(): CodexFileFlags {
    return {
      cliVersion: this.cliVersion,
      kind: this.kind,
      isFork: this.sessionMetaCount > 1,
      threadId: this.threadId,
      rootSessionId: this.rootSessionId,
      hasHistoryStart: this.hasHistoryStart,
      firstTokenCount: this.firstTokenCount,
      hasReemittedUserMessage: this.hasReemittedUserMessage,
      lineCount: this.lineCount,
    };
  }
}

/** Recursively lists every file under `dir` whose path (relative to `dir`) matches {@link ROLLOUT_RE}. */
function findRolloutFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findRolloutFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Streams `absPath` line by line into a fresh {@link CodexFlagAccumulator}. */
async function analyzeFile(absPath: string): Promise<CodexFileFlags> {
  const acc = new CodexFlagAccumulator();
  const rl = createInterface({ input: createReadStream(absPath, { encoding: "utf8" }) });
  for await (const rawLine of rl) {
    if (rawLine.trim() === "") continue;
    try {
      acc.feed(JSON.parse(rawLine));
    } catch {
      acc.feed(undefined); // counts the line without classifying it (malformed JSON)
    }
  }
  return acc.finalize();
}

function formatFlags(flags: CodexFileFlags, byteCount: number): string {
  const tokenCount =
    flags.firstTokenCount === null
      ? "no-token-count"
      : flags.firstTokenCount.totalEqualsLast
        ? "fresh"
        : `carried-over(gap=${flags.firstTokenCount.gap})`;
  return [
    `cli=${flags.cliVersion ?? "?"}`,
    `kind=${flags.kind}`,
    flags.isFork ? "fork" : "not-fork",
    flags.hasHistoryStart ? "has-history-start" : "no-history-start",
    `first-token-count=${tokenCount}`,
    flags.hasReemittedUserMessage ? "has-reemitted-user-message" : "no-reemitted-user-message",
    `lines=${flags.lineCount}`,
    `bytes=${byteCount}`,
    `thread=${flags.threadId ?? "?"}`,
    `root=${flags.rootSessionId ?? "?"}`,
  ].join(" ");
}

async function main(): Promise<void> {
  const root = process.argv[2];
  if (root === undefined) {
    throw new Error("usage: find-codex-fixtures <sessions-root>");
  }
  const files = findRolloutFiles(root).filter((f) => ROLLOUT_RE.test(relative(root, f)));
  const byRoot = new Map<string, string[]>();

  for (const absPath of files) {
    const relPath = relative(root, absPath);
    const flags = await analyzeFile(absPath);
    const byteCount = statSync(absPath).size;
    // A CLI tool's stdout is its deliverable, not application logging.
    console.log(`${relPath}  ${formatFlags(flags, byteCount)}`);

    const groupKey = flags.rootSessionId ?? flags.threadId ?? relPath;
    const group = byRoot.get(groupKey) ?? [];
    group.push(relPath);
    byRoot.set(groupKey, group);
  }

  console.log("\n--- files grouped by shared root session_id ---");
  for (const [root_, group] of byRoot) {
    if (group.length > 1) console.log(`${root_}: ${group.join(", ")}`);
  }
}

// Guarded so this module can be imported by `find-codex-fixtures.test.ts` (for `CodexFlagAccumulator`)
// without running the CLI.
if (import.meta.main) void main();
