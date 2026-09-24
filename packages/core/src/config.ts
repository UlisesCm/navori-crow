import { join } from "node:path";
import type { CrowConfig } from "./adapter";

export type { CrowConfig } from "./adapter";

/** A process environment view, narrowed to the shape `loadConfig` actually reads. */
export type ConfigEnv = Readonly<Record<string, string | undefined>>;

/** Parses a positive integer from an env var, falling back to `fallback` if absent or invalid. */
function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/** Splits a comma-separated env var into trimmed, non-empty entries. */
function csv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Builds a {@link CrowConfig} from `env` and `homeDir`. This is the **only**
 * place in the codebase that reads `env`/`homedir` for these settings
 * (design.md § Configuración) — everything else takes a `CrowConfig` value.
 */
export function loadConfig(env: ConfigEnv, homeDir: string): CrowConfig {
  return {
    crowHome: env["CROW_HOME"]?.trim() || join(homeDir, ".crow"), // R1, R3
    crowPort: positiveInt(env["CROW_PORT"], 7777),
    backfillHours: positiveInt(env["CROW_BACKFILL_HOURS"], 24), // R9
    idleMinutes: positiveInt(env["CROW_IDLE_MINUTES"], 5), // R18
    allowedOrigins: csv(env["CROW_ALLOWED_ORIGINS"]), // R28
    claudeConfigDir: env["CLAUDE_CONFIG_DIR"]?.trim() || join(homeDir, ".claude"), // R11
    codexHome: env["CODEX_HOME"]?.trim() || join(homeDir, ".codex"), // R14
  };
}
