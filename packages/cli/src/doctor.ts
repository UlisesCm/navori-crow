/**
 * `crow doctor` (design.md D15, R15, R28): per-engine lane report from the running server's
 * `/api/stats` plus local read-only checks. Secrets never leave this module: only variable NAMES
 * and booleans are reported, never values (D17). Loopback only: the server and the port probe
 * both target 127.0.0.1.
 */
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { claudeAdapter } from "@crow/adapter-claude";
import { codexAdapter } from "@crow/adapter-codex";
import { loadConfig } from "@crow/core";
import type {
  ConfigEnv,
  CrowConfig,
  LaneCounters,
  SessionsResponse,
  StatsResponse,
} from "@crow/core";
import { CLAUDE_EVENTS, CODEX_EVENTS, isRecord } from "./attach-common";
import { isCrowClaudeHandler } from "./claude-config";
import { isCrowGroup } from "./codex-config";

export const DOCTOR_HELP = `usage: crow doctor [--json]

  --json   machine-readable report on stdout
  exit code: 0 when the server answers (warnings included), 1 when it is unreachable
`;

/** The four content-logging env flags of D14 (Claude `settings.json` `env`). */
export const CLAUDE_CONTENT_FLAGS = [
  "OTEL_LOG_USER_PROMPTS",
  "OTEL_LOG_ASSISTANT_RESPONSES",
  "OTEL_LOG_TOOL_DETAILS",
  "OTEL_LOG_TOOL_CONTENT",
] as const;
/** Codex content flag (`[otel] log_user_prompt` in `config.toml`). */
export const CODEX_CONTENT_FLAG = "log_user_prompt";

const ENGINES = ["claude", "codex"] as const;
type Engine = (typeof ENGINES)[number];
const FILE_SCAN_CAP = 20000;

export interface ContentFlagsReport {
  file: string;
  exists: boolean;
  /** Names of the flags that are enabled (never their values). */
  enabled: string[];
  /** Parse or read problem, if any (a warning, never a crash). */
  parseError: string | null;
}

export interface HooksConfigReport {
  file: string;
  exists: boolean;
  /** Units (events) with a crow handler vs the engine's full list (15 Claude, 10 Codex). */
  units: { present: number; expected: number; missing: string[] };
  /** Claude only: how the handler reaches crow; `null` when undetectable or not applicable. */
  transport: "command" | "http" | null;
  /** Claude only: `disableAllHooks` is on. */
  disableAllHooks: boolean;
  /** Claude only: `allowManagedHooksOnly` is on. */
  allowManagedHooksOnly: boolean;
  /** `true` when transport is `command` and `curl` is not in the PATH; else `null`/`false`. */
  curlMissing: boolean | null;
  /** The engine's own config has OTLP telemetry configured (names/booleans only, R34). */
  otlpConfigured: boolean;
  parseError: string | null;
}

export interface EngineReport {
  laneA: {
    root: string;
    rootExists: boolean;
    filesSeen: number;
    capped: boolean;
  };
  laneB: {
    /** Crow hook units found in the engine config (read-only inspection, D15). */
    config: HooksConfigReport;
    /** Codex live sessions per the server; `null` when unknown (server down) or not Codex. */
    liveSessions: number | null;
    /**
     * Codex "confianza pendiente probable" (D15): units configured, nothing received and live
     * sessions exist. `null` = unknown (server down) or not applicable (Claude).
     */
    trustPending: boolean | null;
    /** `null` when the server is unreachable. */
    counters: LaneCounters | null;
  };
  contentFlags: ContentFlagsReport;
}

export interface OtlpReport {
  configured: boolean;
  port: number;
  /** Server-reported state; `null` when the server is unreachable. */
  state: string | null;
  lastReceivedAt: number | null;
  requests: number | null;
  /** Server says `port-in-use`. */
  portInUse: boolean;
  /** Something other than crow listens on the OTLP port. */
  foreignListener: boolean;
}

export interface DoctorReport {
  server: { reachable: boolean; url: string; error: string | null };
  engines: Record<Engine, EngineReport>;
  otlp: OtlpReport;
  /** `OTEL_*` variable names in the shell environment (names only). */
  shellOtelVars: string[];
  warnings: string[];
}

/** Injectable edges, so tests never touch the real environment. */
export interface DoctorDeps {
  env: ConfigEnv;
  homeDir: string;
  /** Resolves `true` when something accepts TCP connections on 127.0.0.1:port. */
  probePort?: (port: number) => Promise<boolean>;
  fetchImpl?: typeof fetch;
  /** Resolves `true` when `cmd` is in the PATH (default: `Bun.which` over `env.PATH`). */
  pathLookup?: (cmd: string) => boolean;
}

/** Quick TCP connect probe on loopback, 500 ms budget. */
export function probeLoopback(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * Counts `.jsonl` files under `root` without blocking the event loop (bounded walk).
 * `capped` is true when the {@link FILE_SCAN_CAP} entry budget ran out, so the count is a floor.
 */
async function countJsonl(root: string): Promise<{ count: number; capped: boolean }> {
  let count = 0;
  const stack = [root];
  let visited = 0;
  while (stack.length > 0) {
    if (visited >= FILE_SCAN_CAP) return { count, capped: true };
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (entry.isDirectory()) stack.push(join(dir, entry.name));
      else if (entry.name.endsWith(".jsonl")) count += 1;
    }
  }
  return { count, capped: false };
}

function isEnabledValue(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true";
}

/** Read-only inspection of Claude `settings.json` `env` for content flags (D14). */
export function inspectClaudeFlags(configDir: string): ContentFlagsReport {
  const file = join(configDir, "settings.json");
  const report: ContentFlagsReport = {
    file,
    exists: existsSync(file),
    enabled: [],
    parseError: null,
  };
  if (!report.exists) return report;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const env = (parsed as { env?: unknown } | null)?.env;
    if (typeof env === "object" && env !== null) {
      const record = env as Record<string, unknown>;
      report.enabled = CLAUDE_CONTENT_FLAGS.filter((name) => isEnabledValue(record[name]));
    }
  } catch {
    report.parseError = "JSON inválido";
  }
  return report;
}

/** Read-only inspection of Codex `config.toml` for `log_user_prompt` (D14). */
export function inspectCodexFlags(codexHome: string): ContentFlagsReport {
  const file = join(codexHome, "config.toml");
  const report: ContentFlagsReport = {
    file,
    exists: existsSync(file),
    enabled: [],
    parseError: null,
  };
  if (!report.exists) return report;
  try {
    const parsed = Bun.TOML.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const otel = parsed["otel"];
    const inOtel =
      typeof otel === "object" && otel !== null ? (otel as Record<string, unknown>) : {};
    if (isEnabledValue(inOtel[CODEX_CONTENT_FLAG]) || isEnabledValue(parsed[CODEX_CONTENT_FLAG])) {
      report.enabled = [CODEX_CONTENT_FLAG];
    }
  } catch {
    report.parseError = "TOML inválido";
  }
  return report;
}

function emptyHooksReport(file: string, expected: number): HooksConfigReport {
  return {
    file,
    exists: existsSync(file),
    units: { present: 0, expected, missing: [] },
    transport: null,
    disableAllHooks: false,
    allowManagedHooksOnly: false,
    curlMissing: null,
    otlpConfigured: false,
    parseError: null,
  };
}

function unitsOf(events: readonly string[], hasCrow: (event: string) => boolean) {
  const missing = events.filter((e) => !hasCrow(e));
  return {
    present: events.length - missing.length,
    expected: events.length,
    missing,
  };
}

/** Claude telemetry pointing at OTLP: only key names and the boolean/exporter checks leave here. */
function claudeOtlpConfigured(env: Record<string, unknown>): boolean {
  if (isEnabledValue(env["CLAUDE_CODE_ENABLE_TELEMETRY"])) return true;
  return Object.entries(env).some(([key, value]) => {
    if (/^OTEL_EXPORTER_OTLP_.*ENDPOINT$/.test(key)) return true;
    return (
      /^OTEL_(METRICS|LOGS|TRACES)_EXPORTER$/.test(key) &&
      typeof value === "string" &&
      value.split(",").some((v) => v.trim().toLowerCase() === "otlp")
    );
  });
}

/**
 * Read-only inspection of Claude `settings.json` for crow's hook units (D15). The managed
 * settings file is not read: its path is an unverified doc claim (D15 warning), so it is an
 * open decision rather than a guess.
 */
export function inspectClaudeHooks(
  configDir: string,
  curlInPath: () => boolean,
): HooksConfigReport {
  const report = emptyHooksReport(join(configDir, "settings.json"), CLAUDE_EVENTS.length);
  if (!report.exists) {
    report.units = unitsOf(CLAUDE_EVENTS, () => false);
    return report;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(report.file, "utf8"));
    const settings = isRecord(parsed) ? parsed : {};
    const hooks = isRecord(settings["hooks"]) ? settings["hooks"] : {};
    const crowHandlers = (event: string): unknown[] => {
      const groups = hooks[event];
      if (!Array.isArray(groups)) return [];
      return groups
        .flatMap((g) => (isRecord(g) && Array.isArray(g["hooks"]) ? (g["hooks"] as unknown[]) : []))
        .filter(isCrowClaudeHandler);
    };
    report.units = unitsOf(CLAUDE_EVENTS, (e) => crowHandlers(e).length > 0);
    for (const event of CLAUDE_EVENTS) {
      const first = crowHandlers(event)[0];
      if (isRecord(first)) {
        report.transport = first["type"] === "http" ? "http" : "command";
        break;
      }
    }
    report.disableAllHooks = settings["disableAllHooks"] === true;
    report.allowManagedHooksOnly = settings["allowManagedHooksOnly"] === true;
    if (report.transport === "command") report.curlMissing = !curlInPath();
    if (isRecord(settings["env"])) report.otlpConfigured = claudeOtlpConfigured(settings["env"]);
  } catch {
    report.parseError = "JSON inválido";
    report.units = unitsOf(CLAUDE_EVENTS, () => false);
  }
  return report;
}

/** Read-only inspection of Codex `config.toml` for crow's `[[hooks.X.hooks]]` units (D15). */
export function inspectCodexHooks(codexHome: string): HooksConfigReport {
  const report = emptyHooksReport(join(codexHome, "config.toml"), CODEX_EVENTS.length);
  if (!report.exists) {
    report.units = unitsOf(CODEX_EVENTS, () => false);
    return report;
  }
  try {
    const parsed = Bun.TOML.parse(readFileSync(report.file, "utf8")) as Record<string, unknown>;
    const hooks = isRecord(parsed["hooks"]) ? parsed["hooks"] : {};
    report.units = unitsOf(CODEX_EVENTS, (e) => {
      const groups = hooks[e];
      return Array.isArray(groups) && groups.some(isCrowGroup);
    });
    const otel = parsed["otel"];
    if (isRecord(otel)) {
      report.otlpConfigured = Object.entries(otel).some(
        ([key, value]) =>
          /exporter$/.test(key) &&
          value !== undefined &&
          !(typeof value === "string" && value.trim().toLowerCase() === "none"),
      );
    }
  } catch {
    report.parseError = "TOML inválido";
    report.units = unitsOf(CODEX_EVENTS, () => false);
  }
  return report;
}

/** Live Codex sessions per `/api/sessions?status=live`; `null` when the server does not answer. */
async function fetchLiveCount(
  config: CrowConfig,
  fetchImpl: typeof fetch,
  engine: Engine,
): Promise<number | null> {
  const headers: Record<string, string> = {};
  if (config.token !== null) headers["Authorization"] = `Bearer ${config.token}`;
  try {
    const res = await fetchImpl(`http://127.0.0.1:${config.crowPort}/api/sessions?status=live`, {
      headers,
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as SessionsResponse;
    return body.sessions.filter((s) => s.engine === engine).length;
  } catch {
    return null;
  }
}

async function fetchStats(
  config: CrowConfig,
  fetchImpl: typeof fetch,
): Promise<{ stats: StatsResponse | null; error: string | null }> {
  const headers: Record<string, string> = {};
  if (config.token !== null) headers["Authorization"] = `Bearer ${config.token}`;
  try {
    const res = await fetchImpl(`http://127.0.0.1:${config.crowPort}/api/stats`, {
      headers,
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return { stats: null, error: `HTTP ${res.status}` };
    return { stats: (await res.json()) as StatsResponse, error: null };
  } catch (err) {
    return { stats: null, error: err instanceof Error ? err.name : "error" };
  }
}

/** Builds the full report. Never throws for environmental problems. */
export async function collectReport(deps: DoctorDeps): Promise<DoctorReport> {
  const config = loadConfig(deps.env, deps.homeDir);
  const probe = deps.probePort ?? probeLoopback;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const { stats, error } = await fetchStats(config, fetchImpl);
  const curlInPath =
    deps.pathLookup ??
    ((cmd: string): boolean =>
      Bun.which(cmd, deps.env.PATH !== undefined ? { PATH: deps.env.PATH } : {}) !== null);
  const warnings: string[] = [];

  const roots: Record<Engine, string> = {
    claude: claudeAdapter.watchRoots(config)[0] ?? "",
    codex: codexAdapter.watchRoots(config)[0] ?? "",
  };
  const flags: Record<Engine, ContentFlagsReport> = {
    claude: inspectClaudeFlags(config.claudeConfigDir),
    codex: inspectCodexFlags(config.codexHome),
  };
  const hookConfig: Record<Engine, HooksConfigReport> = {
    claude: inspectClaudeHooks(config.claudeConfigDir, () => curlInPath("curl")),
    codex: inspectCodexHooks(config.codexHome),
  };
  const engines = {} as Record<Engine, EngineReport>;
  for (const engine of ENGINES) {
    const { count, capped } = await countJsonl(roots[engine]);
    const laneFiles = { filesSeen: count, capped };
    const cfg = hookConfig[engine];
    const counters = stats?.lanes.engines[engine]?.hook ?? null;
    const liveSessions =
      engine === "codex" && stats !== null ? await fetchLiveCount(config, fetchImpl, engine) : null;
    const trustPending =
      engine !== "codex" || counters === null || liveSessions === null
        ? null
        : cfg.units.present > 0 && counters.received === 0 && liveSessions > 0;
    engines[engine] = {
      laneA: {
        root: roots[engine],
        rootExists: existsSync(roots[engine]),
        ...laneFiles,
      },
      laneB: {
        config: cfg,
        liveSessions,
        trustPending,
        counters,
      },
      contentFlags: flags[engine],
    };
    if (!engines[engine].laneA.rootExists)
      warnings.push(`${engine}: la raíz ${roots[engine]} no existe`);
    if (flags[engine].parseError !== null) {
      warnings.push(
        `${engine}: no se pudo leer ${flags[engine].file} (${flags[engine].parseError})`,
      );
    }
    if (cfg.parseError === null && cfg.exists) {
      const { present, expected, missing } = cfg.units;
      if (present === 0) {
        warnings.push(
          `${engine}: ${cfg.file} no tiene unidades de crow; ejecuta \`crow attach ${engine}\``,
        );
      } else if (present < expected) {
        warnings.push(
          `${engine}: attach parcial o editado, faltan ${missing.length} de ${expected} unidades (${missing.join(", ")})`,
        );
      }
    }
    if (cfg.disableAllHooks) {
      warnings.push(`${engine}: disableAllHooks está activo; el motor no ejecuta ningún hook`);
    }
    if (cfg.allowManagedHooksOnly) {
      warnings.push(
        `${engine}: allowManagedHooksOnly está activo; los hooks de usuario no se ejecutan`,
      );
    }
    if (cfg.curlMissing === true) {
      warnings.push(`${engine}: curl no está en el PATH; el script de hooks no enviará nada`);
    }
    if (trustPending === true) {
      warnings.push(
        `${engine}: confianza pendiente probable: hay hooks configurados, ninguno recibido y sesiones vivas; revisa /hooks en Codex`,
      );
    }
    if (cfg.otlpConfigured && !config.otlpEnabled) {
      warnings.push(
        `${engine}: el motor tiene OTLP configurado pero crow lo tiene apagado (CROW_OTLP); se perderá ese carril`,
      );
    }
    for (const reason of ["unauthorized", "too-large"] as const) {
      const n = counters?.rejected[reason] ?? 0;
      if (n > 0) {
        warnings.push(
          `${engine}: ${n} hooks rechazados (${reason}): posibles errores visibles en el motor`,
        );
      }
    }
    for (const name of flags[engine].enabled) {
      warnings.push(`${engine}: flag de contenido activo ${name} (registra texto del usuario)`);
    }
  }

  const otlpState = stats?.lanes.otlp.state ?? null;
  const portInUse = otlpState === "port-in-use";
  // Only probe when crow itself is not the one listening (loopback only).
  const foreignListener =
    portInUse || (otlpState !== "listening" && (await probe(config.otlpPort)));
  if (foreignListener) {
    warnings.push(
      `otro proceso ocupa el puerto OTLP ${config.otlpPort} en 127.0.0.1 (collector ajeno)`,
    );
  }

  const shellOtelVars = Object.keys(deps.env)
    .filter((k) => k.startsWith("OTEL_") && deps.env[k] !== undefined)
    .sort();
  if (shellOtelVars.length > 0) {
    warnings.push(
      `variables OTEL_* en el shell pueden pisar la telemetría del motor: ${shellOtelVars.join(", ")}`,
    );
  }

  return {
    server: {
      reachable: stats !== null,
      url: `http://127.0.0.1:${config.crowPort}`,
      error,
    },
    engines,
    otlp: {
      configured: config.otlpEnabled,
      port: config.otlpPort,
      state: otlpState,
      lastReceivedAt: stats?.lanes.otlp.lastReceivedAt ?? null,
      requests: stats?.lanes.otlp.requests ?? null,
      portInUse,
      foreignListener,
    },
    shellOtelVars,
    warnings,
  };
}

const when = (ts: number | null): string => (ts === null ? "nunca" : new Date(ts).toISOString());

/** Human-readable Spanish rendering of a report. */
export function formatReport(r: DoctorReport): string {
  const out: string[] = [];
  if (r.server.reachable) out.push(`Servidor crow: activo en ${r.server.url}`);
  else {
    out.push(`Servidor crow: NO responde en ${r.server.url} (${r.server.error ?? "sin detalle"}).`);
    out.push("Inicia con `crow up`. Solo se muestran verificaciones locales.");
  }
  for (const engine of ENGINES) {
    const e = r.engines[engine];
    out.push("", `Motor ${engine}`);
    out.push(
      `  Carril A (archivos): raíz ${e.laneA.rootExists ? "existe" : "NO existe"} (${e.laneA.root}), ${e.laneA.filesSeen}${e.laneA.capped ? "+" : ""} archivos .jsonl`,
    );
    const c = e.laneB.counters;
    const b = e.laneB.config;
    const cfgText =
      b.parseError !== null
        ? `config ilegible (${b.parseError})`
        : `hooks configurados ${b.units.present}/${b.units.expected}${b.transport !== null ? `, transporte ${b.transport}` : ""}`;
    const trustText =
      engine !== "codex"
        ? ""
        : `; confianza: ${e.laneB.trustPending === null ? "desconocida" : e.laneB.trustPending ? "PENDIENTE probable" : "sin señales de pendiente"}`;
    out.push(
      c === null
        ? `  Carril B (hooks): sin datos del servidor; ${cfgText}${trustText}`
        : `  Carril B (hooks): último recibido ${when(c.lastReceivedAt)}, recibidos ${c.received}, rechazados ${JSON.stringify(c.rejected)}; ${cfgText}${trustText}`,
    );
    const f = e.contentFlags;
    const flagText =
      f.parseError !== null
        ? `ilegible (${f.parseError})`
        : f.enabled.length > 0
          ? `ACTIVOS ${f.enabled.join(", ")}`
          : "ninguno activo";
    out.push(`  Flags de contenido (${f.file}): ${flagText}`);
  }
  const o = r.otlp;
  out.push(
    "",
    `Carril C (OTLP): ${o.configured ? "configurado" : "apagado"}, puerto ${o.port}, estado ${o.state ?? "desconocido"}, último registro ${when(o.lastReceivedAt)}`,
  );
  if (o.portInUse) out.push("  puerto en uso (port-in-use)");
  if (o.foreignListener) out.push("  otro proceso escucha en ese puerto (collector ajeno)");
  if (r.warnings.length > 0) out.push("", "Avisos:", ...r.warnings.map((w) => `  - ${w}`));
  return out.join("\n");
}

/** `crow doctor [--json]`. Returns the exit code: 0 when the server answers, 1 otherwise. */
export async function runDoctor(
  argv: readonly string[],
  deps: DoctorDeps,
  print: (line: string) => void = console.log,
): Promise<number> {
  const unknown = argv.find((a) => a !== "--json");
  if (unknown !== undefined) throw new Error(`unknown argument: ${unknown}`);
  const report = await collectReport(deps);
  print(argv.includes("--json") ? JSON.stringify(report, null, 2) : formatReport(report));
  return report.server.reachable ? 0 : 1;
}
