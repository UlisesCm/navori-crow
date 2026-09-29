import { readFileSync } from "node:fs";
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

/** Explicit overrides that beat env and `config.json` (`crow up --otlp`, D12). */
export interface ConfigOverrides {
  otlp?: boolean;
  otlpPort?: number;
}

/** Reads a UTF-8 file, `null` if missing or unreadable. */
function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** R3: `CROW_TOKEN` wins; else the trimmed `$CROW_HOME/token`; empty means none. */
function resolveToken(env: ConfigEnv, crowHome: string): string | null {
  const fromEnv = env["CROW_TOKEN"]?.trim();
  if (fromEnv) return fromEnv;
  return readText(join(crowHome, "token"))?.trim() || null;
}

/** `$CROW_HOME/config.json` `{ otlp: { enabled?, port? } }`; malformed content is ignored. */
function readOtlpFile(crowHome: string): { enabled?: boolean; port?: number } {
  const text = readText(join(crowHome, "config.json"));
  if (text === null) return {};
  try {
    const otlp: unknown = (JSON.parse(text) as { otlp?: unknown } | null)?.otlp;
    if (typeof otlp !== "object" || otlp === null) return {};
    const { enabled, port } = otlp as { enabled?: unknown; port?: unknown };
    return {
      ...(typeof enabled === "boolean" ? { enabled } : {}),
      ...(typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536
        ? { port }
        : {}),
    };
  } catch {
    return {};
  }
}

/** Parses a boolean-ish env var: `1`/`true` on, `0`/`false` off, anything else undefined. */
function envFlag(raw: string | undefined): boolean | undefined {
  const v = raw?.trim().toLowerCase();
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return undefined;
}

/** A TCP port (1-65535) from an env var, `undefined` if absent or invalid. */
function portFrom(raw: string | undefined): number | undefined {
  const n = positiveInt(raw, 0);
  return n > 0 && n < 65536 ? n : undefined;
}

/**
 * Builds a {@link CrowConfig} from `env` and `homeDir`. This is the **only**
 * place in the codebase that reads `env`/`homedir` for these settings
 * (design.md § Configuración) — everything else takes a `CrowConfig` value.
 */
export function loadConfig(
  env: ConfigEnv,
  homeDir: string,
  overrides: ConfigOverrides = {},
): CrowConfig {
  const crowHome = env["CROW_HOME"]?.trim() || join(homeDir, ".crow"); // R1, R3
  const file = readOtlpFile(crowHome);
  return {
    crowHome,
    crowPort: positiveInt(env["CROW_PORT"], 7777),
    backfillHours: positiveInt(env["CROW_BACKFILL_HOURS"], 24), // R9
    idleMinutes: positiveInt(env["CROW_IDLE_MINUTES"], 5), // R18
    allowedOrigins: csv(env["CROW_ALLOWED_ORIGINS"]), // R28
    claudeConfigDir: env["CLAUDE_CONFIG_DIR"]?.trim() || join(homeDir, ".claude"), // R11
    codexHome: env["CODEX_HOME"]?.trim() || join(homeDir, ".codex"), // R14
    token: resolveToken(env, crowHome), // R3
    // R34: precedence flag > env > config.json > off.
    otlpEnabled: overrides.otlp ?? envFlag(env["CROW_OTLP"]) ?? file.enabled ?? false,
    otlpPort: overrides.otlpPort ?? portFrom(env["CROW_OTLP_PORT"]) ?? file.port ?? 4318,
  };
}
