#!/usr/bin/env bun
/**
 * CLI wrapper around `scripts/anonymize/claude.ts` and
 * `scripts/anonymize/codex.ts` (design.md § `fixtures/` y `scripts/`, R11,
 * R12, R14).
 *
 *   bun scripts/anonymize-fixture.ts --engine claude \
 *     --src <path/to/<slug>/<sessionId>.jsonl> --out <dir> [--repo <name>] [--force]
 *
 *   bun scripts/anonymize-fixture.ts --engine codex \
 *     --src <path/to/YYYY/MM/DD/rollout-...jsonl> [--src <path> ...] \
 *     --out <dir> [--repo <name>] [--force] [--max-token-counts <n>]
 *
 * For `--engine claude`, copies the main transcript plus its
 * `<sessionId>/subagents/agent-*.jsonl` and `agent-*.meta.json` siblings,
 * anonymized, preserving the `<slug>/<sessionId>.jsonl` +
 * `<sessionId>/subagents/...` layout under `--out` (the `<slug>` is
 * rewritten to match the rewritten `cwd`).
 *
 * For `--engine codex`, `--src` accepts one or more rollout files and/or
 * directories (searched recursively for `rollout-*.jsonl` files); every file
 * of the run is anonymized together so ids stay correlated across them, and
 * the `YYYY/MM/DD/rollout-<shifted-ts>-<pseudoThreadId>.jsonl` layout is
 * preserved under `--out`.
 *
 * Refuses to write into a non-empty `--out` unless `--force` is passed.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { claudeAdapter } from "@crow/adapter-claude";
import type { FileMatch } from "@crow/core";
import type { AnonymizeSourceFile as ClaudeSourceFile } from "./anonymize/claude";
import { anonymizeClaudeFixture } from "./anonymize/claude";
import type { AnonymizeSourceFile as CodexSourceFile } from "./anonymize/codex";
import { anonymizeCodexFixture } from "./anonymize/codex";

interface Cli {
  engine: string;
  src: string[];
  out: string;
  repo: string;
  force: boolean;
  maxTokenCounts: number | undefined;
}

function getAll(argv: string[], name: string): string[] {
  const out: string[] = [];
  const flag = `--${name}`;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag && i + 1 < argv.length) out.push(argv[i + 1]!);
  }
  return out;
}

function parseArgs(argv: string[]): Cli {
  const get = (name: string): string | null => {
    const idx = argv.indexOf(`--${name}`);
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1]! : null;
  };
  const engine = get("engine");
  const src = getAll(argv, "src");
  const out = get("out");
  if (engine === null || src.length === 0 || out === null) {
    throw new Error(
      "usage: anonymize-fixture --engine <claude|codex> --src <path> [--src <path> ...] " +
        "--out <dir> [--repo <name>] [--force] [--max-token-counts <n>]",
    );
  }
  const maxTokenCountsRaw = get("max-token-counts");
  const maxTokenCounts = maxTokenCountsRaw === null ? undefined : Number(maxTokenCountsRaw);
  if (maxTokenCounts !== undefined && (!Number.isInteger(maxTokenCounts) || maxTokenCounts < 1)) {
    throw new Error(`--max-token-counts must be a positive integer, got: ${maxTokenCountsRaw}`);
  }
  return {
    engine,
    src,
    out,
    repo: get("repo") ?? "fixture",
    force: argv.includes("--force"),
    maxTokenCounts,
  };
}

/** Refuses to write into a non-empty `--out` unless the caller passed `--force` (data-loss guard). */
function assertOutIsWritable(out: string, force: boolean): void {
  if (force || !existsSync(out)) return;
  if (readdirSync(out).length > 0) {
    throw new Error(`--out ${out} is not empty; pass --force to overwrite its contents`);
  }
}

/** Finds the main transcript plus its subagent transcripts/sidecars next to `src`, each tagged with a `FileMatch`. */
function discoverClaudeFiles(src: string): { absPath: string; match: FileMatch }[] {
  const slugDir = dirname(src);
  const root = dirname(slugDir);
  const sessionId = basename(src, ".jsonl");
  const files: { absPath: string; match: FileMatch }[] = [];

  const mainMatch = claudeAdapter.matches(src, root);
  if (mainMatch === null) {
    throw new Error(
      `--src does not look like a Claude main transcript (<slug>/<sessionId>.jsonl): ${src}`,
    );
  }
  files.push({ absPath: src, match: mainMatch });

  const subagentsDir = join(slugDir, sessionId, "subagents");
  if (existsSync(subagentsDir)) {
    for (const entry of readdirSync(subagentsDir)) {
      const absPath = join(subagentsDir, entry);
      const match = claudeAdapter.matches(absPath, root);
      if (match !== null) files.push({ absPath, match });
    }
  }
  return files;
}

/** `YYYY/MM/DD/rollout-...jsonl`, anchored to the tail of an absolute path (mirrors
 * `packages/adapters/codex/src/adapter.ts`'s `ROLLOUT_RE`, but matched against any path prefix so a
 * `--src` file doesn't need to share a single common root with the others). */
const ROLLOUT_TAIL_RE =
  /(\d{4}\/\d{2}\/\d{2}\/rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-.+\.jsonl)$/;

function relPathForCodexFile(absPath: string): string {
  const norm = absPath.split(sep).join("/");
  const m = ROLLOUT_TAIL_RE.exec(norm);
  if (m === null) {
    throw new Error(
      `--src does not look like a codex rollout path (.../YYYY/MM/DD/rollout-...jsonl): ${absPath}`,
    );
  }
  return m[1]!;
}

/** Recursively lists every `.jsonl` file under `dir`. */
function walkJsonlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJsonlFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

/** Expands each `--src` entry into absolute rollout file paths: a directory is searched recursively, a file is used as-is. */
function collectCodexFiles(srcs: string[]): string[] {
  const files: string[] = [];
  for (const src of srcs) {
    if (!existsSync(src)) throw new Error(`--src not found: ${src}`);
    files.push(...(statSync(src).isDirectory() ? walkJsonlFiles(src) : [src]));
  }
  return files;
}

function runClaude(cli: Cli): AnonymizeOutputFile[] {
  if (cli.src.length !== 1) {
    throw new Error(`--engine claude takes exactly one --src, got ${cli.src.length}`);
  }
  const src = cli.src[0]!;
  const root = dirname(dirname(src));
  const discovered = discoverClaudeFiles(src);
  const sourceFiles: ClaudeSourceFile[] = discovered.map(({ absPath, match }) => ({
    match,
    relPath: absPath.slice(root.length + 1),
    content: readFileSync(absPath, "utf8"),
  }));
  return anonymizeClaudeFixture(sourceFiles, { repo: cli.repo });
}

function runCodex(cli: Cli): AnonymizeOutputFile[] {
  const absFiles = collectCodexFiles(cli.src);
  if (absFiles.length === 0) {
    throw new Error(`no rollout files found under: ${cli.src.join(", ")}`);
  }
  const sourceFiles: CodexSourceFile[] = absFiles.map((absPath) => ({
    relPath: relPathForCodexFile(absPath),
    content: readFileSync(absPath, "utf8"),
  }));
  return anonymizeCodexFixture(sourceFiles, {
    repo: cli.repo,
    maxTokenCounts: cli.maxTokenCounts,
  });
}

interface AnonymizeOutputFile {
  relPath: string;
  content: string;
}

function main(): void {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.engine !== "claude" && cli.engine !== "codex") {
    throw new Error(`unsupported --engine: ${cli.engine} (only "claude"/"codex" are implemented)`);
  }
  assertOutIsWritable(cli.out, cli.force);

  const outputs = cli.engine === "claude" ? runClaude(cli) : runCodex(cli);
  for (const file of outputs) {
    const dest = join(cli.out, file.relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, file.content);
  }

  // A CLI tool's stdout is its deliverable, not application logging.
  console.log(`wrote ${outputs.length} file(s) to ${cli.out}`);
}

main();
