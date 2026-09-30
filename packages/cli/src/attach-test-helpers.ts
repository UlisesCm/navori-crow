/** Test harness for attach/detach: every path lives in a temp dir, never the real home. */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttachIo, Engine } from "./attach-common";

export interface Sandbox {
  root: string;
  /** CLAUDE_CONFIG_DIR or CODEX_HOME. */
  configDir: string;
  crowHome: string;
  configPath: string;
  output: string[];
  io: AttachIo;
  cleanup: () => void;
  read: () => string;
  write: (text: string) => void;
  backups: () => string[];
}

/** Creates an isolated sandbox; `answer` drives the interactive confirmation. */
export function sandbox(
  engine: Engine,
  opts: { interactive?: boolean; answer?: boolean } = {},
): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "crow-attach-"));
  const configDir = join(root, engine === "claude" ? "claude-cfg" : "codex-home");
  const crowHome = join(root, "crow-home");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, engine === "claude" ? "settings.json" : "config.toml");
  const output: string[] = [];
  let tick = 0;
  const io: AttachIo = {
    env: {
      CROW_HOME: crowHome,
      ...(engine === "claude" ? { CLAUDE_CONFIG_DIR: configDir } : { CODEX_HOME: configDir }),
    },
    homeDir: join(root, "home"),
    interactive: opts.interactive ?? false,
    out: (line) => output.push(line),
    confirm: async () => opts.answer ?? false,
    now: () => new Date(Date.UTC(2026, 8, 30, 12, 0, 0, tick++)),
  };
  return {
    root,
    configDir,
    crowHome,
    configPath,
    output,
    io,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    read: () => readFileSync(configPath, "utf8"),
    write: (text) => writeFileSync(configPath, text),
    backups: () => {
      try {
        const dir = join(crowHome, "backups", engine);
        return readdirSync(dir).map((f) => join(dir, f));
      } catch {
        return [];
      }
    },
  };
}

export function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}
