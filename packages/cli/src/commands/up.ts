import { homedir } from "node:os";
import { loadConfig } from "@crow/core";
import type { ConfigEnv, CrowConfig } from "@crow/core";

/** Flags of `crow up` (D12). */
export interface UpFlags {
  otlp: boolean;
  otlpPort?: number;
  port?: number;
}

export const UP_HELP = `usage: crow up [--otlp] [--otlp-port <n>] [--port <n>]

  --otlp            enable the OTLP receiver flag (R34). NOTE: the receiver itself
                    ships with B4.T2; until then this only sets config.otlpEnabled.
  --otlp-port <n>   OTLP port (default 4318)
  --port <n>        crow HTTP port (default 7777)
`;

function portValue(flag: string, raw: string | undefined): number {
  const n = Number(raw);
  if (raw === undefined || !Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`${flag} needs a port between 0 and 65535`);
  }
  return n;
}

/** Parses the argv that follows `up`. Throws on unknown flags or bad ports. */
export function parseUpArgs(argv: readonly string[]): UpFlags {
  const flags: UpFlags = { otlp: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--otlp") flags.otlp = true;
    else if (arg === "--otlp-port") flags.otlpPort = portValue(arg, argv[++i]);
    else if (arg === "--port") flags.port = portValue(arg, argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return flags;
}

/**
 * Translates flags to a {@link CrowConfig} through `loadConfig` overrides.
 * `--otlp` is passed only when present so env / `config.json` still apply otherwise (R34).
 */
export function buildUpConfig(flags: UpFlags, env: ConfigEnv, homeDir: string): CrowConfig {
  const config = loadConfig(env, homeDir, {
    ...(flags.otlp ? { otlp: true } : {}),
    ...(flags.otlpPort !== undefined ? { otlpPort: flags.otlpPort } : {}),
  });
  return flags.port !== undefined ? { ...config, crowPort: flags.port } : config;
}

/** `crow up`: starts the existing server through `startApp` and stays alive until a signal. */
export async function runUp(argv: readonly string[]): Promise<void> {
  const { startApp } = await import("@crow/server/app");
  const config = buildUpConfig(parseUpArgs(argv), process.env, homedir());
  const handle = await startApp(config);
  // Paths and counts only (D17): never log event content or env values.
  console.log(`crow server listening on http://${handle.server.hostname}:${handle.server.port}`);
  console.log(`crow home: ${config.crowHome}`);
  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
