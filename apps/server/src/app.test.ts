import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@crow/core";
import type { CrowConfig, StatsResponse } from "@crow/core";
import { startApp } from "./app";

function withTempDir(fn: (dir: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "crow-app-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** A `CrowConfig` rooted entirely under `dir`, so no test ever touches a real `~/.claude` or `~/.codex`. */
function testConfig(dir: string, overrides: Partial<CrowConfig> = {}): CrowConfig {
  return {
    crowHome: join(dir, "home"),
    crowPort: 0, // let the OS pick a free port
    backfillHours: 24,
    idleMinutes: 5,
    allowedOrigins: [],
    claudeConfigDir: join(dir, "claude"), // empty: no real Claude root is ever read
    codexHome: join(dir, "codex"),
    piAgentDir: join(dir, "pi"),
    piSessionDir: join(dir, "pi", "sessions"),
    token: null,
    otlpEnabled: false,
    otlpPort: 4318,
    ...overrides,
  };
}

describe("startApp: migration failure blocks listening (R2)", () => {
  test("a database with a future user_version makes startApp reject and never binds a port", async () => {
    // Covers: R2
    await withTempDir(async (dir) => {
      const config = testConfig(dir, { crowPort: 18791 });

      // Pre-create the DB with a schema version newer than this build supports.
      const db = openDatabase(config.crowHome);
      db.exec("PRAGMA user_version = 999;");
      db.close();

      await expect(startApp(config)).rejects.toThrow();

      // Nothing is listening on the configured port.
      await expect(fetch(`http://127.0.0.1:${config.crowPort}/healthz`)).rejects.toThrow();
    });
  });
});

describe("startApp + handleRequest: guard and shutdown (R2, R28)", () => {
  test("a bad Host is rejected on /api/* through the running server, while /healthz stays reachable", async () => {
    // Covers: R28
    await withTempDir(async (dir) => {
      const handle = await startApp(testConfig(dir));
      try {
        const health = await fetch(`http://127.0.0.1:${handle.server.port}/healthz`);
        expect(health.status).toBe(200);

        const guarded = await fetch(`http://127.0.0.1:${handle.server.port}/api/stats`, {
          headers: { host: "evil.example.com" },
        });
        expect(guarded.status).toBe(403);
      } finally {
        await handle.stop();
      }
    });
  });

  test("startApp -> stop() shuts down the server, tailer and DB cleanly", async () => {
    // Covers: R2
    await withTempDir(async (dir) => {
      const handle = await startApp(testConfig(dir));
      const port = handle.server.port;

      await handle.stop();

      // The server no longer accepts connections.
      await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
      // The DB is closed: any further query throws.
      expect(() => handle.db.query("SELECT 1;").get()).toThrow();
    });
  });
});

describe("startApp: hook lane wiring (F2a B2)", () => {
  test("/api/stats carries lanes and an unregistered engine answers 404 on /ingest/hook", async () => {
    // Covers: R2, R28
    await withTempDir(async (dir) => {
      const handle = await startApp(testConfig(dir));
      try {
        const base = `http://127.0.0.1:${handle.server.port}`;
        const res = await fetch(`${base}/ingest/hook/gemini`, { method: "POST", body: "{}" });
        expect(res.status).toBe(404);
        const stats = (await (await fetch(`${base}/api/stats`)).json()) as StatsResponse;
        // Lane stats track registered engines only (bounded keys): the unknown id is not counted.
        expect(stats.lanes.engines.gemini).toBeUndefined();
        expect(stats.lanes.engines.claude?.hook.rejected["unknown-engine"]).toBeUndefined();
      } finally {
        await handle.stop();
      }
    });
  });

  test("a configured token guards /ingest/* through the running server", async () => {
    // Covers: R3
    await withTempDir(async (dir) => {
      const handle = await startApp(testConfig(dir, { token: "tok" }));
      try {
        const url = `http://127.0.0.1:${handle.server.port}/ingest/hook/claude`;
        expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(401);
      } finally {
        await handle.stop();
      }
    });
  });
});
