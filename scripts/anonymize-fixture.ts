#!/usr/bin/env bun
/**
 * CLI wrapper around `scripts/anonymize/claude.ts` (design.md § `fixtures/`
 * y `scripts/`, R11, R12).
 *
 *   bun scripts/anonymize-fixture.ts --engine claude \
 *     --src <path/to/<slug>/<sessionId>.jsonl> --out <dir> [--repo <name>] [--force]
 *
 * Copies the main transcript plus its `<sessionId>/subagents/agent-*.jsonl`
 * and `agent-*.meta.json` siblings, anonymized, preserving the
 * `<slug>/<sessionId>.jsonl` + `<sessionId>/subagents/...` layout under
 * `--out` (the `<slug>` is rewritten to match the rewritten `cwd`). Refuses
 * to write into a non-empty `--out` unless `--force` is passed.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { claudeAdapter } from "@crow/adapter-claude";
import type { FileMatch } from "@crow/core";
import type { AnonymizeSourceFile } from "./anonymize/claude";
import { anonymizeClaudeFixture } from "./anonymize/claude";

interface Cli {
  engine: string;
  src: string;
  out: string;
  repo: string;
  force: boolean;
}

function parseArgs(argv: string[]): Cli {
  const get = (name: string): string | null => {
    const idx = argv.indexOf(`--${name}`);
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1]! : null;
  };
  const engine = get("engine");
  const src = get("src");
  const out = get("out");
  if (engine === null || src === null || out === null) {
    throw new Error(
      "usage: anonymize-fixture --engine claude --src <path> --out <dir> [--repo <name>] [--force]",
    );
  }
  return { engine, src, out, repo: get("repo") ?? "fixture", force: argv.includes("--force") };
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

function main(): void {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.engine !== "claude") {
    throw new Error(`unsupported --engine: ${cli.engine} (only "claude" is implemented)`);
  }
  assertOutIsWritable(cli.out, cli.force);

  const root = dirname(dirname(cli.src));
  const discovered = discoverClaudeFiles(cli.src);
  const sourceFiles: AnonymizeSourceFile[] = discovered.map(({ absPath, match }) => ({
    match,
    relPath: absPath.slice(root.length + 1),
    content: readFileSync(absPath, "utf8"),
  }));

  const outputs = anonymizeClaudeFixture(sourceFiles, { repo: cli.repo });
  for (const file of outputs) {
    const dest = join(cli.out, file.relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, file.content);
  }

  // A CLI tool's stdout is its deliverable, not application logging.
  console.log(`wrote ${outputs.length} file(s) to ${cli.out}`);
}

main();
