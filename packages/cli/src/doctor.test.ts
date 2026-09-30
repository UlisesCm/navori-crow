import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CrowConfig } from "@crow/core";
import { startApp } from "@crow/server/app";
import { CLAUDE_EVENTS, CODEX_EVENTS } from "./attach-common";
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
function listenForeign(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
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
  return {
    env,
    homeDir: join(root, "nohome"),
    probePort: async () => false,
    ...extra,
  };
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
      expect(report.engines.claude.laneA).toMatchObject({
        rootExists: true,
        filesSeen: 1,
      });
      expect(report.engines.codex.laneA.rootExists).toBe(false);
      expect(report.engines.claude.laneB.counters?.received).toBe(0);
      expect(report.engines.claude.laneB.config.units).toMatchObject({
        present: 0,
        expected: 15,
      });
      expect(report.engines.codex.laneB.trustPending).toBe(false);
      expect(report.otlp.state).toBe("disabled");
      const lines: string[] = [];
      const code = await runDoctor([], deps({ ...env, CROW_PORT: String(app.server.port) }), (l) =>
        lines.push(l),
      );
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("hooks configurados 0/15");
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
        env: {
          ...env,
          CROW_PORT: String(app.server.port),
          CROW_OTLP_PORT: String(foreign.port),
        },
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
      expect(engines["claude"]).toHaveProperty("laneB.config.units.expected", 15);
      expect(engines["codex"]).toHaveProperty("laneB.trustPending", false);
    } finally {
      await app.stop();
    }
  });

  test("unknown argument throws", async () => {
    const { env } = sandbox();
    await expect(runDoctor(["--x"], deps(env))).rejects.toThrow("unknown argument");
  });

  const CLAUDE_CMD = "/h/crow-ingest-hook claude";
  const claudeSettings = (events: readonly string[], extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      hooks: Object.fromEntries(
        events.map((e) => [
          e,
          [{ hooks: [{ type: "command", command: CLAUDE_CMD, async: true }] }],
        ]),
      ),
      ...extra,
    });
  const codexToml = (events: readonly string[], extra = ""): string =>
    events
      .map(
        (e) =>
          `[[hooks.${e}]]\n[[hooks.${e}.hooks]]\ntype = "command"\ncommand = "/h/crow-ingest-hook codex"\ntimeout = 2\n`,
      )
      .join("\n") + extra;
  const down = async (env: Record<string, string>) => ({
    ...env,
    CROW_PORT: String(await freePort()),
  });

  // Covers: R28
  test("Claude: full 15/15, command transport, curl present", async () => {
    const { dir, env } = sandbox();
    writeFileSync(join(dir, "claude", "settings.json"), claudeSettings(CLAUDE_EVENTS));
    const report = await collectReport(deps(await down(env), { pathLookup: () => true }));
    const cfg = report.engines.claude.laneB.config;
    expect(cfg.units).toEqual({ present: 15, expected: 15, missing: [] });
    expect(cfg.transport).toBe("command");
    expect(cfg.curlMissing).toBe(false);
    expect(report.warnings.join("\n")).not.toContain("attach parcial");
    expect(formatReport(report)).toContain("hooks configurados 15/15, transporte command");
  });

  // Covers: R28
  test("Claude: partial attach warns with the missing events; foreign handlers do not count", async () => {
    const { dir, env } = sandbox();
    const settings = JSON.parse(claudeSettings(CLAUDE_EVENTS.slice(0, 12))) as {
      hooks: Record<string, unknown>;
    };
    settings.hooks["Stop"] = [{ hooks: [{ type: "command", command: "echo other" }] }];
    writeFileSync(join(dir, "claude", "settings.json"), JSON.stringify(settings));
    const report = await collectReport(deps(await down(env), { pathLookup: () => true }));
    const cfg = report.engines.claude.laneB.config;
    expect(cfg.units.present).toBe(12);
    expect(cfg.units.missing).toContain("Stop");
    expect(report.warnings.join("\n")).toContain("attach parcial o editado, faltan 3 de 15");
  });

  // Covers: R28
  test("Claude: disableAllHooks and allowManagedHooksOnly are flagged", async () => {
    const { dir, env } = sandbox();
    writeFileSync(
      join(dir, "claude", "settings.json"),
      claudeSettings(CLAUDE_EVENTS, {
        disableAllHooks: true,
        allowManagedHooksOnly: true,
      }),
    );
    const report = await collectReport(deps(await down(env), { pathLookup: () => true }));
    const w = report.warnings.join("\n");
    expect(report.engines.claude.laneB.config.disableAllHooks).toBe(true);
    expect(w).toContain("disableAllHooks");
    expect(w).toContain("allowManagedHooksOnly");
  });

  // Covers: R28
  test("Claude: curl missing from PATH with command transport warns; http transport does not", async () => {
    const { dir, env } = sandbox();
    writeFileSync(join(dir, "claude", "settings.json"), claudeSettings(CLAUDE_EVENTS));
    const looked: string[] = [];
    const report = await collectReport(
      deps(await down(env), {
        pathLookup: (c) => {
          looked.push(c);
          return false;
        },
      }),
    );
    expect(looked).toEqual(["curl"]);
    expect(report.engines.claude.laneB.config.curlMissing).toBe(true);
    expect(report.warnings.join("\n")).toContain("curl no está en el PATH");

    const http = sandbox();
    writeFileSync(
      join(http.dir, "claude", "settings.json"),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "http",
                  url: "http://127.0.0.1:7777/ingest/hook/claude",
                },
              ],
            },
          ],
        },
      }),
    );
    const r2 = await collectReport(deps(await down(http.env), { pathLookup: () => false }));
    expect(r2.engines.claude.laneB.config.transport).toBe("http");
    expect(r2.engines.claude.laneB.config.curlMissing).toBeNull();
    expect(r2.warnings.join("\n")).not.toContain("curl");
  });

  // Covers: R28
  test("Codex: 10/10 units counted from nested [[hooks.X.hooks]]", async () => {
    const { dir, env } = sandbox();
    writeFileSync(join(dir, "codex", "config.toml"), codexToml(CODEX_EVENTS));
    const report = await collectReport(deps(await down(env)));
    expect(report.engines.codex.laneB.config.units).toEqual({
      present: 10,
      expected: 10,
      missing: [],
    });
    // server down: trust cannot be judged
    expect(report.engines.codex.laneB.trustPending).toBeNull();
    expect(formatReport(report)).toContain("confianza: desconocida");
  });

  // Covers: R28
  test("Codex: trust pending probable only with hooks, zero received and live Codex sessions", async () => {
    const { dir, env } = sandbox();
    writeFileSync(join(dir, "codex", "config.toml"), codexToml(CODEX_EVENTS));
    const app = await startApp(serverConfig(dir));
    const e = { ...env, CROW_PORT: String(app.server.port) };
    try {
      const base = `http://127.0.0.1:${app.server.port}`;
      // no live sessions yet
      const before = await collectReport(deps(e));
      expect(before.engines.codex.laneB.liveSessions).toBe(0);
      expect(before.engines.codex.laneB.trustPending).toBe(false);

      // a live Codex session appears through lane B... but that would count as a received hook,
      // so stub the sessions answer to isolate the rule: zero received + live sessions.
      const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith(`${base}/api/sessions`)) {
          return Response.json({
            sessions: [{ engine: "codex" }, { engine: "claude" }],
          });
        }
        return fetch(input, init);
      }) as typeof fetch;
      const live = await collectReport(deps(e, { fetchImpl }));
      expect(live.engines.codex.laneB.liveSessions).toBe(1);
      expect(live.engines.codex.laneB.counters?.received).toBe(0);
      expect(live.engines.codex.laneB.trustPending).toBe(true);
      expect(live.engines.claude.laneB.trustPending).toBeNull();
      expect(live.warnings.join("\n")).toContain("confianza pendiente probable");
      expect(formatReport(live)).toContain("PENDIENTE probable");

      // no hooks configured: never pending
      writeFileSync(join(dir, "codex", "config.toml"), "");
      const none = await collectReport(deps(e, { fetchImpl }));
      expect(none.engines.codex.laneB.trustPending).toBe(false);
    } finally {
      await app.stop();
    }
  });

  // Covers: R15, R28
  test("Codex: hooks received clear the pending trust", async () => {
    const { dir, env } = sandbox();
    writeFileSync(join(dir, "codex", "config.toml"), codexToml(CODEX_EVENTS));
    const app = await startApp(serverConfig(dir));
    try {
      const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/sessions"))
          return Response.json({ sessions: [{ engine: "codex" }] });
        if (url.includes("/api/stats")) {
          const real = (await (await fetch(input, init)).json()) as {
            lanes: { engines: Record<string, { hook: { received: number } }> };
          };
          real.lanes.engines["codex"] = {
            hook: {
              received: 3,
              lastReceivedAt: 1,
              lastStoredAt: 1,
              rejected: {},
            },
          } as never;
          return Response.json(real);
        }
        return fetch(input, init);
      }) as typeof fetch;
      const report = await collectReport(
        deps({ ...env, CROW_PORT: String(app.server.port) }, { fetchImpl }),
      );
      expect(report.engines.codex.laneB.trustPending).toBe(false);
    } finally {
      await app.stop();
    }
  });

  // Covers: R15
  test("R34: engine has OTLP configured but crow has it off", async () => {
    const { dir, env } = sandbox();
    writeFileSync(
      join(dir, "claude", "settings.json"),
      JSON.stringify({
        env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_LOGS_EXPORTER: "otlp" },
      }),
    );
    writeFileSync(join(dir, "codex", "config.toml"), '[otel]\nexporter = "otlp-http"\n');
    const report = await collectReport(deps(await down(env)));
    expect(report.engines.claude.laneB.config.otlpConfigured).toBe(true);
    expect(report.engines.codex.laneB.config.otlpConfigured).toBe(true);
    const w = report.warnings.filter((x) =>
      x.includes("OTLP configurado pero crow lo tiene apagado"),
    );
    expect(w).toHaveLength(2);

    // crow with OTLP on: no warning
    const on = await collectReport(deps({ ...(await down(env)), CROW_OTLP: "1" }));
    expect(on.warnings.join("\n")).not.toContain("tiene apagado");

    // engine without telemetry: no warning
    const clean = sandbox();
    writeFileSync(join(clean.dir, "codex", "config.toml"), '[otel]\nexporter = "none"\n');
    const r3 = await collectReport(deps(await down(clean.env)));
    expect(r3.engines.codex.laneB.config.otlpConfigured).toBe(false);
    expect(r3.warnings.join("\n")).not.toContain("tiene apagado");
  });

  // Covers: R15, R28
  test("401 and 413 rejections on the hook lane warn about engine-visible errors", async () => {
    const { dir, env } = sandbox();
    const app = await startApp(serverConfig(dir));
    try {
      const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (String(input).includes("/api/stats")) {
          const real = (await (await fetch(input, init)).json()) as {
            lanes: {
              engines: Record<string, { hook: { rejected: Record<string, number> } }>;
            };
          };
          const claude = real.lanes.engines["claude"];
          if (claude !== undefined) claude.hook.rejected = { unauthorized: 2, "too-large": 1 };
          return Response.json(real);
        }
        return fetch(input, init);
      }) as typeof fetch;
      const report = await collectReport(
        deps({ ...env, CROW_PORT: String(app.server.port) }, { fetchImpl }),
      );
      const w = report.warnings.join("\n");
      expect(w).toContain(
        "2 hooks rechazados (unauthorized): posibles errores visibles en el motor",
      );
      expect(w).toContain("1 hooks rechazados (too-large)");
    } finally {
      await app.stop();
    }
  });

  // Covers: R28
  test("no sensitive value reaches text or --json (token, OTEL_*, handler paths)", async () => {
    const { dir, env } = sandbox();
    const secret = "TOPSECRET-v4lue-Q7";
    writeFileSync(
      join(dir, "claude", "settings.json"),
      claudeSettings(CLAUDE_EVENTS.slice(0, 5), {
        env: {
          CLAUDE_CODE_ENABLE_TELEMETRY: "1",
          OTEL_EXPORTER_OTLP_ENDPOINT: `http://${secret}.example`,
          OTEL_EXPORTER_OTLP_HEADERS: `Authorization=${secret}`,
        },
      }),
    );
    writeFileSync(
      join(dir, "codex", "config.toml"),
      codexToml(CODEX_EVENTS, `\n[otel]\nexporter = "otlp-http"\nendpoint = "${secret}"\n`),
    );
    const e = {
      ...(await down(env)),
      CROW_TOKEN: secret,
      OTEL_LOGS_EXPORTER: secret,
    };
    const report = await collectReport(deps(e, { pathLookup: () => false }));
    const all = `${JSON.stringify(report)}\n${formatReport(report)}`;
    expect(all).not.toContain(secret);
    expect(all).not.toContain("echo");
    expect(all).toContain("OTEL_LOGS_EXPORTER");
  });
});
