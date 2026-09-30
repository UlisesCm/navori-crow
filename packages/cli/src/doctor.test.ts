import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CrowConfig } from "@crow/core";
import { startApp } from "@crow/server/app";
import { collectReport, formatReport, runDoctor } from "./doctor";
import type { DoctorDeps } from "./doctor";

const root = mkdtempSync(join(tmpdir(), "crow-doctor-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
/** A fresh temp home with `claude/` and `codex/` dirs; nothing here is a real `~/.claude`. */
function sandbox(): { dir: string; env: Record<string, string> } {
  const dir = join(root, `t${n++}`);
  mkdirSync(join(dir, "claude"), { recursive: true });
  mkdirSync(join(dir, "codex"), { recursive: true });
  return {
    dir,
    env: {
      CROW_HOME: join(dir, "home"),
      CLAUDE_CONFIG_DIR: join(dir, "claude"),
      CODEX_HOME: join(dir, "codex"),
    },
  };
}

function serverConfig(dir: string, over: Partial<CrowConfig> = {}): CrowConfig {
  return {
    crowHome: join(dir, "home"),
    crowPort: 0,
    backfillHours: 24,
    idleMinutes: 5,
    allowedOrigins: [],
    claudeConfigDir: join(dir, "claude"),
    codexHome: join(dir, "codex"),
    token: null,
    otlpEnabled: false,
    otlpPort: 4318,
    ...over,
  };
}

/** Listens on an OS-picked loopback port, standing in for a foreign collector. */
function listenForeign(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      resolve({
        port: (srv.address() as AddressInfo).port,
        close: () => new Promise((r) => srv.close(() => r())),
      });
    });
  });
}

/** A closed port: bind then release. */
async function freePort(): Promise<number> {
  const s = await listenForeign();
  await s.close();
  return s.port;
}

function deps(env: Record<string, string>, extra: Partial<DoctorDeps> = {}): DoctorDeps {
  return { env, homeDir: join(root, "nohome"), probePort: async () => false, ...extra };
}

describe("crow doctor", () => {
  // Covers: R28
  test("server running: lanes per engine from /api/stats", async () => {
    const { dir, env } = sandbox();
    mkdirSync(join(dir, "claude", "projects", "p"), { recursive: true });
    writeFileSync(join(dir, "claude", "projects", "p", "s.jsonl"), "{}\n");
    const app = await startApp(serverConfig(dir));
    try {
      const report = await collectReport(deps({ ...env, CROW_PORT: String(app.server.port) }));
      expect(report.server.reachable).toBe(true);
      expect(report.engines.claude.laneA).toMatchObject({ rootExists: true, filesSeen: 1 });
      expect(report.engines.codex.laneA.rootExists).toBe(false);
      expect(report.engines.claude.laneB.counters?.received).toBe(0);
      expect(report.engines.claude.laneB.hooksConfigured).toBe("pending");
      expect(report.engines.codex.laneB.trustPending).toBe("pending");
      expect(report.otlp.state).toBe("disabled");
      const lines: string[] = [];
      const code = await runDoctor([], deps({ ...env, CROW_PORT: String(app.server.port) }), (l) =>
        lines.push(l),
      );
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("pendiente");
    } finally {
      await app.stop();
    }
  });

  // Covers: R28
  test("server not running: clear message, local checks, exit 1", async () => {
    const { env } = sandbox();
    const port = await freePort();
    const lines: string[] = [];
    const code = await runDoctor([], deps({ ...env, CROW_PORT: String(port) }), (l) =>
      lines.push(l),
    );
    expect(code).toBe(1);
    const text = lines.join("\n");
    expect(text).toContain("NO responde");
    expect(text).toContain("Carril A");
  });

  // Covers: R15, R28
  test("port-in-use is surfaced through doctor", async () => {
    const { dir, env } = sandbox();
    const foreign = await listenForeign();
    const app = await startApp(serverConfig(dir, { otlpEnabled: true, otlpPort: foreign.port }));
    try {
      const report = await collectReport(
        deps({
          ...env,
          CROW_PORT: String(app.server.port),
          CROW_OTLP: "1",
          CROW_OTLP_PORT: String(foreign.port),
        }),
      );
      expect(report.otlp.state).toBe("port-in-use");
      expect(report.otlp.portInUse).toBe(true);
      expect(report.warnings.join("\n")).toContain("collector ajeno");
      expect(formatReport(report)).toContain("port-in-use");
    } finally {
      await app.stop();
      await foreign.close();
    }
  });

  // Covers: R15
  test("OTLP disabled but a foreign process listens on the port (real TCP probe)", async () => {
    const { dir, env } = sandbox();
    const foreign = await listenForeign();
    const app = await startApp(serverConfig(dir));
    try {
      const report = await collectReport({
        env: { ...env, CROW_PORT: String(app.server.port), CROW_OTLP_PORT: String(foreign.port) },
        homeDir: join(root, "nohome"),
      });
      expect(report.otlp.state).toBe("disabled");
      expect(report.otlp.foreignListener).toBe(true);
    } finally {
      await app.stop();
      await foreign.close();
    }
  });

  // Covers: R15
  test("nobody on the OTLP port: no foreign listener", async () => {
    const { env } = sandbox();
    const report = await collectReport({
      env: {
        ...env,
        CROW_PORT: String(await freePort()),
        CROW_OTLP_PORT: String(await freePort()),
      },
      homeDir: join(root, "nohome"),
    });
    expect(report.otlp.foreignListener).toBe(false);
  });

  // Covers: R28
  test("OTEL_* names are listed and their values never leak", async () => {
    const { env } = sandbox();
    const secret = "s3cr3t-value-Zx9";
    const e = {
      ...env,
      CROW_PORT: String(await freePort()),
      OTEL_EXPORTER_OTLP_HEADERS: `Authorization=${secret}`,
      OTEL_LOGS_EXPORTER: secret,
    };
    const report = await collectReport(deps(e));
    expect(report.shellOtelVars).toEqual(["OTEL_EXPORTER_OTLP_HEADERS", "OTEL_LOGS_EXPORTER"]);
    const lines: string[] = [];
    await runDoctor([], deps(e), (l) => lines.push(l));
    await runDoctor(["--json"], deps(e), (l) => lines.push(l));
    expect(lines.join("\n")).not.toContain(secret);
    expect(lines.join("\n")).toContain("OTEL_LOGS_EXPORTER");
  });

  // Covers: R28
  test("content flags detected in JSON and TOML, values not reported", async () => {
    const { dir, env } = sandbox();
    writeFileSync(
      join(dir, "claude", "settings.json"),
      JSON.stringify({
        env: {
          OTEL_LOG_USER_PROMPTS: "1",
          OTEL_LOG_TOOL_DETAILS: "true",
          OTEL_LOG_TOOL_CONTENT: "0",
          OTEL_EXPORTER_OTLP_HEADERS: "tok-secret-777",
        },
      }),
    );
    writeFileSync(
      join(dir, "codex", "config.toml"),
      '[otel]\nlog_user_prompt = true\nendpoint = "tok-secret-777"\n',
    );
    const e = { ...env, CROW_PORT: String(await freePort()) };
    const report = await collectReport(deps(e));
    expect(report.engines.claude.contentFlags.enabled).toEqual([
      "OTEL_LOG_USER_PROMPTS",
      "OTEL_LOG_TOOL_DETAILS",
    ]);
    expect(report.engines.codex.contentFlags.enabled).toEqual(["log_user_prompt"]);
    const lines: string[] = [];
    await runDoctor([], deps(e), (l) => lines.push(l));
    expect(lines.join("\n")).not.toContain("tok-secret-777");
  });

  // Covers: R28
  test("unparseable settings and config produce warnings, not a crash", async () => {
    const { dir, env } = sandbox();
    writeFileSync(join(dir, "claude", "settings.json"), "{ not json");
    writeFileSync(join(dir, "codex", "config.toml"), "[otel\nbroken = ");
    const report = await collectReport(deps({ ...env, CROW_PORT: String(await freePort()) }));
    expect(report.engines.claude.contentFlags.parseError).not.toBeNull();
    expect(report.engines.codex.contentFlags.parseError).not.toBeNull();
    expect(report.warnings.filter((w) => w.includes("no se pudo leer"))).toHaveLength(2);
  });

  // Covers: R28
  test("parse errors never leak file content into text or --json", async () => {
    const { dir, env } = sandbox();
    writeFileSync(join(dir, "claude", "settings.json"), "{ SECRETVAL123 }");
    writeFileSync(
      join(dir, "codex", "config.toml"),
      "token = SECRETVAL123\n[otel\nx = SECRETVAL123",
    );
    const e = { ...env, CROW_PORT: String(await freePort()) };
    const lines: string[] = [];
    await runDoctor([], deps(e), (l) => lines.push(l));
    await runDoctor(["--json"], deps(e), (l) => lines.push(l));
    const out = lines.join("\n");
    expect(out).not.toContain("SECRETVAL123");
    expect(out).toContain("JSON inválido");
    expect(out).toContain("TOML inválido");
  });

  // Covers: R28
  test("--json emits the machine shape", async () => {
    const { dir, env } = sandbox();
    const app = await startApp(serverConfig(dir));
    try {
      const lines: string[] = [];
      const code = await runDoctor(
        ["--json"],
        deps({ ...env, CROW_PORT: String(app.server.port) }),
        (l) => lines.push(l),
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(lines.join("\n")) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual([
        "engines",
        "otlp",
        "server",
        "shellOtelVars",
        "warnings",
      ]);
      const engines = parsed["engines"] as Record<
        string,
        { laneA: unknown; laneB: unknown; contentFlags: unknown }
      >;
      expect(Object.keys(engines).sort()).toEqual(["claude", "codex"]);
      expect(engines["claude"]).toHaveProperty("laneB.hooksConfigured", "pending");
    } finally {
      await app.stop();
    }
  });

  test("unknown argument throws", async () => {
    const { env } = sandbox();
    await expect(runDoctor(["--x"], deps(env))).rejects.toThrow("unknown argument");
  });
});
