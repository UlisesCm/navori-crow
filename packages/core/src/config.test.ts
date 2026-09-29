import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoundAdapter, EngineAdapter, FlatOtelRecord, JsonValue } from "./index";
import { bindAdapter, loadConfig } from "./index";

const roots: string[] = [];
function home(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "crow-cfg-"));
  roots.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, ".crow"), { recursive: true });
    writeFileSync(join(dir, ".crow", name), text);
  }
  return dir;
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("ingest token", () => {
  // Covers: R3
  test("none configured -> null", () => {
    expect(loadConfig({}, home()).token).toBeNull();
  });
  // Covers: R3
  test("CROW_TOKEN from env", () => {
    expect(loadConfig({ CROW_TOKEN: " abc " }, home()).token).toBe("abc");
  });
  // Covers: R3
  test("file $CROW_HOME/token, trimmed", () => {
    expect(loadConfig({}, home({ token: "filetok\n" })).token).toBe("filetok");
  });
  // Covers: R3
  test("env wins over file", () => {
    expect(loadConfig({ CROW_TOKEN: "env" }, home({ token: "file" })).token).toBe("env");
  });
  // Covers: R3
  test("empty env or empty file counts as none", () => {
    expect(loadConfig({ CROW_TOKEN: "  " }, home({ token: "\n" })).token).toBeNull();
  });
  // Covers: R3
  test("file is read from the CROW_HOME override", () => {
    const h = home();
    const other = mkdtempSync(join(tmpdir(), "crow-cfg-"));
    roots.push(other);
    writeFileSync(join(other, "token"), "x");
    expect(loadConfig({ CROW_HOME: other }, h).token).toBe("x");
  });
});

describe("OTLP opt-in", () => {
  // Covers: R34
  test("nothing configured -> off, port 4318", () => {
    const c = loadConfig({}, home());
    expect(c.otlpEnabled).toBe(false);
    expect(c.otlpPort).toBe(4318);
  });
  // Covers: R34
  test("flag enables", () => {
    expect(loadConfig({}, home(), { otlp: true }).otlpEnabled).toBe(true);
  });
  // Covers: R34
  test("CROW_OTLP=1 enables", () => {
    expect(loadConfig({ CROW_OTLP: "1" }, home()).otlpEnabled).toBe(true);
  });
  // Covers: R34
  test("config.json enables", () => {
    const h = home({ "config.json": JSON.stringify({ otlp: { enabled: true, port: 4999 } }) });
    const c = loadConfig({}, h);
    expect(c.otlpEnabled).toBe(true);
    expect(c.otlpPort).toBe(4999);
  });
  // Covers: R34
  test("precedence: flag > env > file", () => {
    const h = home({ "config.json": JSON.stringify({ otlp: { enabled: true } }) });
    expect(loadConfig({ CROW_OTLP: "0" }, h).otlpEnabled).toBe(false);
    expect(loadConfig({ CROW_OTLP: "0" }, h, { otlp: true }).otlpEnabled).toBe(true);
  });
  // Covers: R34
  test("malformed config.json and junk env fall back to off", () => {
    expect(loadConfig({ CROW_OTLP: "yes" }, home({ "config.json": "{nope" })).otlpEnabled).toBe(
      false,
    );
    expect(loadConfig({}, home({ "config.json": '{"otlp":{"enabled":"true"}}' })).otlpEnabled).toBe(
      false,
    );
  });
  // Covers: R34
  test("port parsing: env, override, invalid", () => {
    expect(loadConfig({ CROW_OTLP_PORT: "4400" }, home()).otlpPort).toBe(4400);
    expect(loadConfig({ CROW_OTLP_PORT: "4400" }, home(), { otlpPort: 5000 }).otlpPort).toBe(5000);
    expect(loadConfig({ CROW_OTLP_PORT: "abc" }, home()).otlpPort).toBe(4318);
    expect(loadConfig({ CROW_OTLP_PORT: "70000" }, home()).otlpPort).toBe(4318);
  });
});

describe("adapter contract (type-level)", () => {
  // Covers: R3
  test("an F1-shaped adapter (no new members) still binds; new members are optional", () => {
    const f1: EngineAdapter<JsonValue> = {
      id: "x",
      watchRoots: () => [],
      matches: () => null,
      initialState: () => null,
      restoreState: () => null,
      parseLine: (_l, s) => ({ ok: true, events: [], state: s }),
    };
    const rec: FlatOtelRecord = {
      signal: "log",
      name: "n",
      ts: 0,
      attrs: {},
      service: null,
      scope: null,
      hash: "h",
    };
    const withNew: BoundAdapter = bindAdapter({
      ...f1,
      fromHook: () => ({ ok: true, events: [] }),
      ownsOtel: () => true,
      fromOtel: () => ({ ok: true, events: [] }),
    });
    expect(bindAdapter(f1).fromHook).toBeUndefined();
    expect(withNew.fromOtel?.(rec).ok).toBe(true);
  });
});
