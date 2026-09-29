import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildUpConfig, parseUpArgs } from "./commands/up";

const home = mkdtempSync(join(tmpdir(), "crow-up-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const env = { CROW_HOME: join(home, "crow") };

describe("crow up config wiring", () => {
  // Covers: R34
  test("without --otlp the receiver stays off", () => {
    const cfg = buildUpConfig(parseUpArgs([]), env, home);
    expect(cfg.otlpEnabled).toBe(false);
  });

  // Covers: R34
  test("--otlp reaches loadConfig and beats CROW_OTLP=0", () => {
    const cfg = buildUpConfig(parseUpArgs(["--otlp"]), { ...env, CROW_OTLP: "0" }, home);
    expect(cfg.otlpEnabled).toBe(true);
    expect(cfg.otlpPort).toBe(4318);
  });

  // Covers: R34
  test("without the flag, CROW_OTLP=1 still enables it", () => {
    expect(buildUpConfig(parseUpArgs([]), { ...env, CROW_OTLP: "1" }, home).otlpEnabled).toBe(true);
  });

  test("--otlp-port and --port override the config", () => {
    const cfg = buildUpConfig(
      parseUpArgs(["--otlp", "--otlp-port", "4999", "--port", "0"]),
      env,
      home,
    );
    expect(cfg.otlpPort).toBe(4999);
    expect(cfg.crowPort).toBe(0);
  });

  test("bad arguments throw", () => {
    expect(() => parseUpArgs(["--nope"])).toThrow("unknown argument");
    expect(() => parseUpArgs(["--port", "x"])).toThrow("port");
  });
});
