import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@crow/core";
import type { CrowConfig } from "@crow/core";
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
