#!/usr/bin/env bun
/**
 * CLI: turns RAW B0 captures of Claude Code or Codex (`crow-b0/cap/run-NN/`, written by
 * `scripts/capture-receiver.ts`) into anonymized fixtures, through the allowlist anonymizers
 * `scripts/anonymize/{hooks,otlp,claude,codex}.ts`. Raw captures hold prompts, paths and ids: this is
 * the only way they may reach the repo.
 *
 *   bun scripts/anonymize-b0.ts hooks   --run <cap/run-NN> [--run ...] --out <dir> [--engine claude|codex] [--repo <name>] [--force]
 *   bun scripts/anonymize-b0.ts otlp    --run <cap/run-NN> [--run ...] --out <dir> [--engine claude|codex] [--max-per-event <n>] [--force]
 *   bun scripts/anonymize-b0.ts session --run <cap/run-NN> --transcript <projects/<slug>/<sessionId>.jsonl>
 *                                       --out <dir> [--repo <name>] [--max-per-event <n>] [--force]
 *   bun scripts/anonymize-b0.ts session --engine codex --run <cap/run-NN> --transcript <dir|rollout.jsonl> [--transcript ...]
 *                                       --out <dir> [--repo <name>] [--max-per-event <n>] [--force]
 *
 * - Codex `--transcript`: every `rollout-*.jsonl` found under the given directories/files (main thread
 *   and subagent threads); they land at `<out>/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`.
 * - `hooks`: first payload of each hook event across the runs → `<out>/<HookEvent>.json`.
 * - `otlp`: JSON bodies merged per signal → `<out>/{logs,metrics,traces}.json` (the `.bin` versions
 *   come from `bun scripts/encode-otlp-fixture.ts <out>`). Protobuf captures are skipped: the `.bin`
 *   is re-encoded from the anonymized JSON with the oracle.
 * - `session`: one coherent session (hooks + OTLP + transcript with subagents) sharing ONE id
 *   registry and ONE time offset → `<out>/{hooks.jsonl,otlp-logs.jsonl,otlp-metrics.jsonl}` and
 *   `<out>/<slug>/<sessionId>.jsonl` (+ `subagents/`).
 *
 * Nothing is written unless EVERY output passes its post-condition (`verifyHookPayload` /
 * `verifyOtlpBody`): a body that did not go through the allowlist aborts the run before touching
 * `--out`. Failure output lists JSON paths only, never values.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { claudeAdapter } from "@crow/adapter-claude";
import type { FileMatch, Rec } from "@crow/core";
import { isRec } from "@crow/core";
import type { AnonymizeSourceFile } from "./anonymize/claude";
import { anonymizeClaudeFixture, findMinTimestampMs } from "./anonymize/claude";
import type { AnonymizeSourceFile as CodexSourceFile } from "./anonymize/codex";
import {
  anonymizeCodexFixture,
  findMinTimestampMs as findMinCodexTimestampMs,
} from "./anonymize/codex";
import {
  anonymizeHookPayload,
  firstPerHookEvent,
  minRolloutPathMs,
  verifyHookPayload,
} from "./anonymize/hooks";
import {
  CODEX_NOISY_EVENTS,
  anonymizeOtlp,
  mergeAndTrimLogs,
  mergeFirstPerName,
  minOtlpTimeMs,
  otlpSignal,
  verifyOtlpBody,
} from "./anonymize/otlp";
import { DEFAULT_EPOCH_ISO, FixtureContext, IdRegistry, offsetToEpoch } from "./anonymize/shared";

/** Rollout keys (besides the ones `codex.ts` already pseudonymizes) that hooks/OTLP carry too. */
const CODEX_EXTRA_ID_KEYS = [
  "turn_id",
  "root_turn_id",
  "thread_id",
  "agent_thread_id",
  "sender_thread_id",
  "receiver_thread_id",
] as const;

type Engine = "claude" | "codex";

interface Cli {
  mode: string;
  engine: Engine;
  runs: string[];
  transcripts: string[];
  out: string;
  repo: string;
  force: boolean;
  max: number;
}

function parseArgs(argv: string[]): Cli {
  const get = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
  };
  const runs = argv.flatMap((a, i) => (a === "--run" && i + 1 < argv.length ? [argv[i + 1]!] : []));
  const transcripts = argv.flatMap((a, i) =>
    a === "--transcript" && i + 1 < argv.length ? [argv[i + 1]!] : [],
  );
  const out = get("out");
  const mode = argv[0] ?? "";
  const engine = get("engine") ?? "claude";
  if (
    !["hooks", "otlp", "session"].includes(mode) ||
    runs.length === 0 ||
    out === null ||
    (engine !== "claude" && engine !== "codex")
  ) {
    throw new Error(
      "usage: anonymize-b0 <hooks|otlp|session> --run <cap/run-NN> [--run ...] --out <dir> " +
        "[--engine claude|codex] [--transcript <main.jsonl|dir>] [--repo <name>] [--max-per-event <n>] [--force]",
    );
  }
  const max = Number(get("max-per-event") ?? (mode === "session" ? "2" : "1"));
  if (!Number.isInteger(max) || max < 1) throw new Error("--max-per-event must be an integer >= 1");
  return {
    mode,
    engine,
    runs,
    transcripts,
    out,
    repo: get("repo") ?? "b0-toy",
    force: argv.includes("--force"),
    max,
  };
}

interface Captured {
  hooks: Rec[];
  otlp: { signal: "logs" | "metrics" | "traces"; body: Rec }[];
}

/** Reads the JSON bodies of one capture run in arrival order. Non-JSON (protobuf) bodies are skipped. */
function readRun(runDir: string, engine: Engine): Captured {
  const metas = readdirSync(runDir)
    .filter((f) => /^\d+\.json$/.test(f))
    .sort();
  const out: Captured = { hooks: [], otlp: [] };
  for (const f of metas) {
    const meta: unknown = JSON.parse(readFileSync(join(runDir, f), "utf8"));
    if (!isRec(meta) || typeof meta.path !== "string") continue;
    const headers = isRec(meta.headers) ? meta.headers : {};
    if (!String(headers["content-type"] ?? "").includes("json")) continue;
    const file = typeof meta.decodedFile === "string" ? meta.decodedFile : meta.bodyFile;
    if (typeof file !== "string") continue;
    let body: unknown;
    try {
      body = JSON.parse(readFileSync(join(runDir, file), "utf8"));
    } catch {
      continue;
    }
    if (!isRec(body)) continue;
    if (meta.path.startsWith("/hook/")) {
      if (meta.path === `/hook/${engine}`) out.hooks.push(body);
    } else {
      const signal = otlpSignal(body);
      if (signal !== null) out.otlp.push({ signal, body });
    }
  }
  return out;
}

function collect(runs: string[], engine: Engine): Captured {
  const all: Captured = { hooks: [], otlp: [] };
  for (const r of runs) {
    const c = readRun(r, engine);
    all.hooks.push(...c.hooks);
    all.otlp.push(...c.otlp);
  }
  return all;
}

function bodiesOf(c: Captured, signal: "logs" | "metrics" | "traces"): Rec[] {
  return c.otlp.filter((o) => o.signal === signal).map((o) => o.body);
}

/** Main transcript plus its subagent transcripts/sidecars, each tagged with a `FileMatch`. */
function discoverTranscript(src: string): AnonymizeSourceFile[] {
  const slugDir = dirname(src);
  const root = dirname(slugDir);
  const sessionId = basename(src, ".jsonl");
  const found: { absPath: string; match: FileMatch }[] = [];
  const main = claudeAdapter.matches(src, root);
  if (main === null)
    throw new Error("--transcript is not a Claude main transcript (<slug>/<sessionId>.jsonl)");
  found.push({ absPath: src, match: main });
  const subDir = join(slugDir, sessionId, "subagents");
  if (existsSync(subDir)) {
    for (const entry of readdirSync(subDir)) {
      const absPath = join(subDir, entry);
      const match = claudeAdapter.matches(absPath, root);
      if (match !== null) found.push({ absPath, match });
    }
  }
  return found.map(({ absPath, match }) => ({
    match,
    relPath: absPath.slice(root.length + 1),
    content: readFileSync(absPath, "utf8"),
  }));
}

/** Every `rollout-*.jsonl` under the given files/directories, keyed as `YYYY/MM/DD/<file>` (the layout the anonymizer expects). */
function discoverRollouts(paths: string[]): CodexSourceFile[] {
  const files: string[] = [];
  const walk = (p: string): void => {
    if (statSync(p).isDirectory()) {
      for (const e of readdirSync(p).sort()) walk(join(p, e));
    } else if (/^rollout-.+\.jsonl$/.test(basename(p))) files.push(p);
  };
  for (const p of paths) walk(p);
  const out: { relPath: string; content: string }[] = [];
  for (const f of new Set(files)) {
    const m = /^rollout-(\d{4})-(\d{2})-(\d{2})T/.exec(basename(f));
    if (m === null) continue;
    out.push({
      relPath: `${m[1]}/${m[2]}/${m[3]}/${basename(f)}`,
      content: readFileSync(f, "utf8"),
    });
  }
  return out;
}

type Outputs = Map<string, string>;

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;
const jsonl = (rows: unknown[]): string => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

function buildHooks(cli: Cli, cap: Captured): { outputs: Outputs; problems: string[] } {
  // Codex hook paths embed a rollout stamp: shift it to the epoch (Claude payloads carry no instant).
  const offset = offsetToEpoch(minRolloutPathMs(cap.hooks), DEFAULT_EPOCH_ISO);
  const ctx = new FixtureContext(cli.repo, new IdRegistry(), offset);
  const outputs: Outputs = new Map();
  const problems: string[] = [];
  for (const p of firstPerHookEvent(cap.hooks)) {
    const anon = anonymizeHookPayload(p, ctx);
    const event = String(anon.hook_event_name);
    problems.push(...verifyHookPayload(anon).map((x) => `${event}: ${x}`));
    outputs.set(`${event}.json`, json(anon));
  }
  return { outputs, problems };
}

function mergedOtlp(
  cli: Cli,
  cap: Captured,
  onlyNoisy: boolean,
): Map<"logs" | "metrics" | "traces", Rec> {
  const merged = new Map<"logs" | "metrics" | "traces", Rec>();
  const logs = bodiesOf(cap, "logs");
  if (logs.length > 0) {
    const noisy = cli.engine === "codex" ? CODEX_NOISY_EVENTS : undefined;
    merged.set("logs", mergeAndTrimLogs(logs, cli.max, onlyNoisy, noisy));
  }
  const metrics = bodiesOf(cap, "metrics");
  if (metrics.length > 0) merged.set("metrics", mergeFirstPerName(metrics, "metrics"));
  const traces = bodiesOf(cap, "traces");
  if (traces.length > 0) merged.set("traces", mergeFirstPerName(traces, "traces"));
  return merged;
}

function minMs(...values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null);
  return nums.length === 0 ? null : Math.min(...nums);
}

function buildOtlp(cli: Cli, cap: Captured): { outputs: Outputs; problems: string[] } {
  const merged = mergedOtlp(cli, cap, false);
  const offset = offsetToEpoch(
    minMs(...[...merged.values()].map(minOtlpTimeMs)),
    DEFAULT_EPOCH_ISO,
  );
  const ctx = new FixtureContext(cli.repo, new IdRegistry(), offset);
  const outputs: Outputs = new Map();
  const problems: string[] = [];
  for (const [signal, body] of merged) {
    const anon = anonymizeOtlp(body, ctx);
    problems.push(...verifyOtlpBody(anon).map((x) => `${signal}: ${x}`));
    outputs.set(`${signal}.json`, json(anon));
  }
  return { outputs, problems };
}

function buildSession(cli: Cli, cap: Captured): { outputs: Outputs; problems: string[] } {
  if (cli.transcripts.length === 0) throw new Error("session mode needs --transcript <main.jsonl>");
  const codex = cli.engine === "codex";
  const transcript = codex ? [] : discoverTranscript(cli.transcripts[0]!);
  const rollouts = codex ? discoverRollouts(cli.transcripts) : [];
  if (codex && rollouts.length === 0) throw new Error("--transcript held no rollout-*.jsonl");
  const merged = mergedOtlp(cli, cap, true);
  merged.delete("traces"); // a session fixture carries the lanes crow ingests by default
  const offset = offsetToEpoch(
    minMs(
      codex ? findMinCodexTimestampMs(rollouts) : findMinTimestampMs(transcript),
      ...[...merged.values()].map(minOtlpTimeMs),
    ),
    DEFAULT_EPOCH_ISO,
  );
  const ids = new IdRegistry();
  const ctx = new FixtureContext(cli.repo, ids, offset);
  const outputs: Outputs = new Map();
  const problems: string[] = [];

  const hooks = cap.hooks.map((p) => anonymizeHookPayload(p, ctx));
  hooks.forEach((h, i) => problems.push(...verifyHookPayload(h).map((x) => `hook[${i}]: ${x}`)));
  outputs.set("hooks.jsonl", jsonl(hooks));

  for (const [signal, body] of merged) {
    const anon = anonymizeOtlp(body, ctx);
    problems.push(...verifyOtlpBody(anon).map((x) => `${signal}: ${x}`));
    outputs.set(`otlp-${signal}.jsonl`, jsonl([anon]));
  }
  const files = codex
    ? anonymizeCodexFixture(rollouts, {
        repo: cli.repo,
        ids,
        tsOffsetMs: offset,
        extraIdKeys: CODEX_EXTRA_ID_KEYS,
      })
    : anonymizeClaudeFixture(transcript, { repo: cli.repo, ids, tsOffsetMs: offset });
  for (const f of files) outputs.set(f.relPath, f.content);
  return { outputs, problems };
}

function main(): void {
  const cli = parseArgs(process.argv.slice(2));
  if (!cli.force && existsSync(cli.out) && readdirSync(cli.out).length > 0) {
    throw new Error(`--out ${cli.out} is not empty; pass --force to overwrite its contents`);
  }
  const cap = collect(cli.runs, cli.engine);
  const build = { hooks: buildHooks, otlp: buildOtlp, session: buildSession }[
    cli.mode as "hooks" | "otlp" | "session"
  ];
  const { outputs, problems } = build(cli, cap);
  if (outputs.size === 0) throw new Error("nothing to write: the runs held no matching captures");
  if (problems.length > 0) {
    // Paths only, never values: the raw bodies hold prompts.
    throw new Error(
      `refusing to write: ${problems.length} value(s) did not pass the allowlist:\n${problems.slice(0, 20).join("\n")}`,
    );
  }
  for (const [rel, content] of outputs) {
    const dest = join(cli.out, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
  console.log(`wrote ${outputs.size} file(s) to ${cli.out}`);
}

if (import.meta.main) main();
