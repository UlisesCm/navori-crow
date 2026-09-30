/**
 * Shared plumbing of `crow attach|detach` (design.md D13/D14): engine event lists,
 * context, manifest, confirmation gate and the guarded write. Engine-specific unit
 * logic lives in `claude-config.ts` and `codex-config.ts`.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { loadConfig } from "@crow/core";
import type { ConfigEnv } from "@crow/core";
import type { DiffOptions } from "./diff";
import { atomicWrite, resolveTarget, safeWrite } from "./fs-safe";
import { generateHookScript } from "./hook-script";

export type Engine = "claude" | "codex";

/** The 15 Claude hook events of R8. */
export const CLAUDE_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "InstructionsLoaded",
  "Stop",
  "StopFailure",
] as const;

/** The 10 Codex hook events of R9. */
export const CODEX_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
] as const;

/** Per-hook timeout in seconds (R20: at most 2 s of added latency). */
export const HOOK_TIMEOUT_S = 2;

/** An expected abort: the message is shown as is, nothing was written. */
export class AttachError extends Error {}

/** Injectable edges so tests never touch the real environment or terminal. */
export interface AttachIo {
  env: ConfigEnv;
  homeDir: string;
  /** Whether a human can answer the confirmation prompt. */
  interactive: boolean;
  out: (line: string) => void;
  confirm: (question: string) => Promise<boolean>;
  now?: () => Date;
}

/** Real-terminal {@link AttachIo}. */
export function defaultIo(env: ConfigEnv, homeDir: string): AttachIo {
  return {
    env,
    homeDir,
    interactive: process.stdin.isTTY === true,
    out: (line) => console.log(line),
    confirm: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^y(es)?$/i.test((await rl.question(question)).trim());
      } finally {
        rl.close();
      }
    },
  };
}

/** Parsed argv of `attach`/`detach`. */
export interface ChangeArgs {
  engine: Engine;
  yes: boolean;
  port?: number;
}

export const ATTACH_HELP = `usage: crow attach <claude|codex> [--yes] [--port <n>]
       crow detach <claude|codex> [--yes]

  Shows a diff of the engine's user-level config and writes nothing until you confirm
  (--yes confirms without asking; without a terminal or --yes the command aborts).
  A backup of the config is saved under $CROW_HOME/backups/<engine>/ before writing;
  it copies whatever secrets the file holds.
`;

/** Parses the argv that follows `attach`/`detach`. */
export function parseChangeArgs(argv: readonly string[]): ChangeArgs {
  let engine: Engine | undefined;
  let yes = false;
  let port: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "claude" || arg === "codex") engine = arg;
    else if (arg === "--yes" || arg === "-y") yes = true;
    else if (arg === "--port") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new AttachError("--port needs 1-65535");
      port = n;
    } else throw new AttachError(`unknown argument: ${arg}`);
  }
  if (engine === undefined) throw new AttachError("missing engine: claude or codex");
  return { engine, yes, ...(port !== undefined ? { port } : {}) };
}

/** Everything an engine planner needs to know about this run. */
export interface AttachContext {
  engine: Engine;
  crowHome: string;
  port: number;
  /** User-level config file of the engine (R23: the only engine file ever written). */
  configPath: string;
  /** `$CROW_HOME/hooks/crow-ingest-hook`. */
  hookPath: string;
  /** Command string registered in the engine's config (path quoted when needed). */
  hookCommand: string;
}

/** Signature of a crow hook command, whatever the install path (D13). */
export function crowCommandRe(engine: Engine): RegExp {
  return new RegExp(`crow-ingest-hook'?\\s+${engine}$`);
}

function shArg(path: string): string {
  return /^[\w./@:+-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

/** Resolves paths and port for one run (never reads the engine config here). */
export function buildContext(args: ChangeArgs, io: AttachIo): AttachContext {
  const config = loadConfig(io.env, io.homeDir);
  const dir =
    args.engine === "claude"
      ? io.env["CLAUDE_CONFIG_DIR"]?.trim() || join(io.homeDir, ".claude")
      : io.env["CODEX_HOME"]?.trim() || join(io.homeDir, ".codex");
  const hookPath = join(config.crowHome, "hooks", "crow-ingest-hook");
  return {
    engine: args.engine,
    crowHome: config.crowHome,
    port: args.port ?? config.crowPort,
    configPath: join(dir, args.engine === "claude" ? "settings.json" : "config.toml"),
    hookPath,
    hookCommand: `${shArg(hookPath)} ${args.engine}`,
  };
}

/** Structural equality on plain data, immune to prototype differences of parsers. */
export function sameData(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Current config file: text (`null` when missing) and its hash for the race check. */
export interface ConfigSnapshot {
  text: string | null;
  sha: string | null;
}

export function readSnapshot(path: string): ConfigSnapshot {
  if (!existsSync(path)) return { text: null, sha: null };
  const text = readFileSync(path, "utf8");
  return { text, sha: createHash("sha256").update(text).digest("hex") };
}

/** One unit crow wrote (D13): the exact value, so detach can tell if the user edited it. */
export interface ManifestUnit {
  event: string;
  value: unknown;
}

export interface Manifest {
  version: 1;
  engine: Engine;
  configPath: string;
  units: ManifestUnit[];
  /** Containers crow created (Claude); detach removes them only when they end up empty. */
  created: { hooks: boolean; events: string[] };
}

/** `$CROW_HOME/attach/<engine>-<sha1(realpath of the config)[:8]>.json`. */
export function manifestPath(ctx: AttachContext): string {
  const id = createHash("sha1").update(resolveTarget(ctx.configPath)).digest("hex").slice(0, 8);
  return join(ctx.crowHome, "attach", `${ctx.engine}-${id}.json`);
}

/** Reads the manifest; `null` when absent, throws when present but unusable. */
export function readManifest(ctx: AttachContext): Manifest | null {
  const path = manifestPath(ctx);
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      isRecord(raw) &&
      raw["version"] === 1 &&
      Array.isArray(raw["units"]) &&
      isRecord(raw["created"]) &&
      Array.isArray(raw["created"]["events"])
    ) {
      return raw as unknown as Manifest;
    }
  } catch {
    // Falls through to the error below.
  }
  throw new AttachError(`cannot verify: attach manifest ${path} is unreadable; nothing written`);
}

export function writeManifest(ctx: AttachContext, manifest: Manifest): void {
  const path = manifestPath(ctx);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWrite(path, `${JSON.stringify(manifest, null, 2)}\n`);
  chmodSync(path, 0o600);
}

/** Hook script content, and whether the installed file differs from it. */
export function hookScriptState(ctx: AttachContext): { content: string; changed: boolean } {
  const content = generateHookScript({ crowHome: ctx.crowHome, port: ctx.port });
  const changed = !existsSync(ctx.hookPath) || readFileSync(ctx.hookPath, "utf8") !== content;
  return { content, changed };
}

/** Writes the hook script atomically with mode 0700 (under `$CROW_HOME`, never a repo). */
export function writeHookScript(ctx: AttachContext, content: string): void {
  mkdirSync(dirname(ctx.hookPath), { recursive: true, mode: 0o700 });
  atomicWrite(ctx.hookPath, content);
  chmodSync(ctx.hookPath, 0o700);
}

/** The confirmation gate (R21): `--yes`, or an interactive yes; otherwise abort. */
export async function confirmChange(io: AttachIo, yes: boolean): Promise<void> {
  if (yes) return;
  if (!io.interactive) {
    throw new AttachError(
      "confirmation required: pass --yes or run in a terminal; nothing written",
    );
  }
  if (!(await io.confirm("Apply this change? [y/N] "))) {
    throw new AttachError("not confirmed; nothing written");
  }
}

/** Race check plus guarded write of the engine config (R22 backup through `safeWrite`). */
export function writeConfig(
  ctx: AttachContext,
  snapshot: ConfigSnapshot,
  after: string,
  io: AttachIo,
): { backup: string | null } {
  // TOCTOU window between this reread and the rename is accepted (D13).
  if (readSnapshot(ctx.configPath).sha !== snapshot.sha) {
    throw new AttachError(`${ctx.configPath} changed while waiting; nothing written, retry`);
  }
  mkdirSync(dirname(ctx.configPath), { recursive: true });
  const { backup } = safeWrite(ctx.configPath, after, {
    crowHome: ctx.crowHome,
    engine: ctx.engine,
    ...(io.now ? { now: io.now } : {}),
  });
  return { backup };
}

/** Prints the backup notice shared by attach and detach. */
export function reportBackup(io: AttachIo, backup: string | null): void {
  if (backup !== null) {
    io.out(`backup: ${backup} (0600; it copies the secrets the file holds)`);
  }
}

/**
 * Masking options of the diff shown by attach and detach (D17): every key of the settings
 * `env` object (`envBlock`, Claude only) plus the ingest token from the environment.
 */
export function maskOptions(
  label: string,
  envBlock: unknown,
  io: AttachIo,
): DiffOptions & { label: string } {
  const token = io.env["CROW_TOKEN"];
  return {
    label,
    maskKeys: isRecord(envBlock) ? Object.keys(envBlock) : [],
    ...(token ? { secrets: [token] } : {}),
  };
}
