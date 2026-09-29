#!/usr/bin/env bun
/**
 * Prints the temporary engine configs of the B0 experiment (design.md D14) so
 * they are not copied by hand:
 *
 *   bun scripts/b0/gen-config.ts claude --transport http|command [--traces] [--otlp-protocol http/json|http/protobuf] > "$CLAUDE_CONFIG_DIR/settings.json"
 *   bun scripts/b0/gen-config.ts codex [--protocol json|binary] >> "$CODEX_HOME/config.toml"
 *
 * Options common to both: `--hook-port 7790`, `--otlp-port 4319`, `--shim <abs path>`.
 * Never enables content flags (`OTEL_LOG_USER_PROMPTS`, `log_user_prompt`, ...).
 */
import { join } from "node:path";

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

export interface ClaudeConfigOptions {
  transport: "http" | "command";
  hookPort: number;
  otlpPort: number;
  shim: string;
  traces: boolean;
  otlpProtocol: "http/json" | "http/protobuf";
}

interface ClaudeHandler {
  type: "http" | "command";
  url?: string;
  command?: string;
  async?: boolean;
  timeout: number;
}

export interface ClaudeSettings {
  env: Record<string, string>;
  hooks: Record<string, { hooks: ClaudeHandler[] }[]>;
}

/** Claude `settings.json` with all R8 events on the chosen transport plus OTel `env`. */
export function claudeSettings(o: ClaudeConfigOptions): ClaudeSettings {
  const hooks: ClaudeSettings["hooks"] = {};
  for (const ev of CLAUDE_EVENTS) {
    const timeout = ev === "SessionEnd" && o.transport === "http" ? 1 : 2;
    const handler: ClaudeHandler =
      o.transport === "http"
        ? { type: "http", url: `http://127.0.0.1:${o.hookPort}/hook/claude`, timeout }
        : { type: "command", command: `${o.shim} claude`, async: true, timeout };
    hooks[ev] = [{ hooks: [handler] }];
  }
  const env: Record<string, string> = {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: o.otlpProtocol,
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${o.otlpPort}`,
    OTEL_LOGS_EXPORT_INTERVAL: "1000",
  };
  if (o.traces) {
    env["CLAUDE_CODE_ENHANCED_TELEMETRY_BETA"] = "1";
    env["OTEL_TRACES_EXPORTER"] = "otlp";
  }
  return { env, hooks };
}

export interface CodexConfigOptions {
  shim: string;
  otlpPort: number;
  protocol: "json" | "binary";
}

/** Codex `config.toml` fragment: `[otel]` plus one nested hook group per R9 event. */
export function codexToml(o: CodexConfigOptions): string {
  const lines = [
    "[otel]",
    "log_user_prompt = false",
    `exporter = { otlp-http = { endpoint = "http://127.0.0.1:${o.otlpPort}/v1/logs", protocol = "${o.protocol}" } }`,
    "",
  ];
  for (const ev of CODEX_EVENTS) {
    lines.push(
      `[[hooks.${ev}]]`,
      `[[hooks.${ev}.hooks]]`,
      'type = "command"',
      `command = "${o.shim} codex"`,
      "timeout = 2",
      "",
    );
  }
  return lines.join("\n");
}

function main(argv: string[]): void {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const shim = get("shim") ?? join(import.meta.dir, "hook-shim.sh");
  // Engines may or may not split `command` through a shell (G2): avoid quoting questions.
  if (/\s/.test(shim))
    throw new Error(
      `--shim path has whitespace; copy the shim to a path without spaces (got a path of ${shim.length} chars)`,
    );
  const otlpPort = Number(get("otlp-port") ?? 4319);
  if (argv[0] === "claude") {
    const transport = get("transport");
    const otlpProtocol = get("otlp-protocol") ?? "http/json";
    if (transport !== "http" && transport !== "command")
      throw new Error("--transport http|command");
    if (otlpProtocol !== "http/json" && otlpProtocol !== "http/protobuf") {
      throw new Error("--otlp-protocol http/json|http/protobuf");
    }
    const s = claudeSettings({
      transport,
      hookPort: Number(get("hook-port") ?? 7790),
      otlpPort,
      shim,
      traces: argv.includes("--traces"),
      otlpProtocol,
    });
    console.log(JSON.stringify(s, null, 2));
  } else if (argv[0] === "codex") {
    const protocol = get("protocol") ?? "json";
    if (protocol !== "json" && protocol !== "binary") throw new Error("--protocol json|binary");
    console.log(codexToml({ shim, otlpPort, protocol }));
  } else {
    throw new Error("usage: gen-config.ts claude|codex [options]");
  }
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}
