import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAttach } from "./attach";
import { CODEX_EVENTS, buildContext, manifestPath } from "./attach-common";
import { modeOf, sandbox } from "./attach-test-helpers";
import type { Sandbox } from "./attach-test-helpers";

let sb: Sandbox;
afterEach(() => sb.cleanup());

type Parsed = {
  hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
  [k: string]: unknown;
};
const parse = (text: string): Parsed => Bun.TOML.parse(text) as Parsed;

describe("crow attach codex", () => {
  // Covers: R21
  test("shows a diff and writes nothing without confirmation", async () => {
    sb = sandbox("codex", { interactive: false });
    sb.write('model = "gpt-5"\n');
    expect(await runAttach(["codex"], sb.io)).toBe(1);
    expect(sb.read()).toBe('model = "gpt-5"\n');
    expect(sb.output.join("\n")).toContain("[[hooks.PreToolUse.hooks]]");
    expect(sb.backups()).toEqual([]);
  });

  // Covers: R21, R9
  test("appends a marked block with nested groups for the 10 events and the trust hint", async () => {
    sb = sandbox("codex");
    sb.write('model = "gpt-5"\n\n[projects."/x"]\ntrust_level = "trusted"\n');
    expect(await runAttach(["codex", "--yes"], sb.io)).toBe(0);
    const text = sb.read();
    const hooks = parse(text).hooks;
    expect(Object.keys(hooks).sort()).toEqual([...CODEX_EVENTS].sort());
    const handler = hooks["PreToolUse"]![0]!.hooks[0]!;
    expect(handler).toEqual({
      type: "command",
      command: `${join(sb.crowHome, "hooks", "crow-ingest-hook")} codex`,
      timeout: 2,
    });
    expect(text).toContain("# >>> crow v1");
    expect(text.trimEnd().endsWith("# <<< crow <<<")).toBe(true);
    expect(text.startsWith('model = "gpt-5"\n')).toBe(true);
    expect(parse(text)["projects"]).toEqual({ "/x": { trust_level: "trusted" } });
    expect(sb.output.join("\n")).toContain("/hooks");
    expect(modeOf(join(sb.crowHome, "hooks", "crow-ingest-hook"))).toBe(0o700);
  });

  // Covers: R22
  test("saves a 0600 backup before writing", async () => {
    sb = sandbox("codex");
    sb.write('model = "gpt-5"\n');
    await runAttach(["codex", "--yes"], sb.io);
    const [backup] = sb.backups();
    expect(sb.backups()).toHaveLength(1);
    expect(modeOf(backup!)).toBe(0o600);
    expect(readFileSync(backup!, "utf8")).toBe('model = "gpt-5"\n');
  });

  // Covers: R25
  test("is idempotent", async () => {
    sb = sandbox("codex");
    sb.write('model = "gpt-5"\n');
    await runAttach(["codex", "--yes"], sb.io);
    const after = sb.read();
    expect(await runAttach(["codex", "--yes"], sb.io)).toBe(0);
    expect(sb.read()).toBe(after);
    expect(sb.backups()).toHaveLength(1);
    expect(sb.output.join("\n")).toContain("already attached");
  });

  // Covers: R25
  test("does not duplicate crow groups that live outside the marked block", async () => {
    sb = sandbox("codex");
    const cmd = `${join(sb.crowHome, "hooks", "crow-ingest-hook")} codex`;
    sb.write(
      `[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "echo mine"\n\n[[hooks.PreToolUse]]\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "${cmd}"\n`,
    );
    await runAttach(["codex", "--yes"], sb.io);
    const hooks = parse(sb.read()).hooks;
    expect(hooks["PreToolUse"]).toHaveLength(1);
    expect(hooks["Stop"]).toHaveLength(1);
    expect(hooks["SessionStart"]).toHaveLength(1);
  });

  // Covers: R23
  test("writes only config.toml under CODEX_HOME and CROW_HOME", async () => {
    sb = sandbox("codex");
    await runAttach(["codex", "--yes"], sb.io);
    expect(readdirSync(sb.configDir)).toEqual(["config.toml"]);
    expect(readdirSync(sb.root).sort()).toEqual(["codex-home", "crow-home"]);
  });

  // Covers: R24
  test("never enables log_user_prompt and warns if the user has it on", async () => {
    sb = sandbox("codex");
    sb.write("[otel]\nlog_user_prompt = true\n");
    await runAttach(["codex", "--yes"], sb.io);
    expect(sb.output.join("\n")).toContain("log_user_prompt is enabled");
    // The user's own [otel] is a conflict: crow adds no second table (that would be invalid TOML).
    expect(sb.read().match(/\[otel\]/g)).toHaveLength(1);
    expect(sb.output.join("\n")).toContain("OTLP lane was omitted for codex");
    const clean = sandbox("codex");
    try {
      await runAttach(["codex", "--yes"], clean.io);
      expect(clean.read()).not.toContain("log_user_prompt");
      expect(clean.read()).toContain("[otel]");
    } finally {
      clean.cleanup();
    }
  });

  // Covers: R34, R24
  test("writes [otel] first in the marked block, with the otlpPort and no content flag", async () => {
    sb = sandbox("codex");
    sb.write('model = "gpt-5"\n');
    expect(await runAttach(["codex", "--yes"], sb.io)).toBe(0);
    const text = sb.read();
    expect(text.indexOf("[otel]")).toBeGreaterThan(text.indexOf("# >>> crow v1"));
    expect(text.indexOf("[otel]")).toBeLessThan(text.indexOf("[[hooks."));
    expect(parse(text)["otel"]).toEqual({
      exporter: { "otlp-http": { endpoint: "http://127.0.0.1:4318/v1/logs", protocol: "json" } },
    });
    expect(text).not.toContain("log_user_prompt");
    expect(JSON.parse(readFileSync(join(sb.crowHome, "config.json"), "utf8"))).toEqual({
      otlp: { enabled: true },
    });
    expect(sb.output.join("\n")).toContain("restart crow");
  });

  // Covers: R34
  test("follows CROW_OTLP_PORT in the endpoint", async () => {
    sb = sandbox("codex");
    sb.io = { ...sb.io, env: { ...sb.io.env, CROW_OTLP_PORT: "4999" } };
    await runAttach(["codex", "--yes"], sb.io);
    expect(sb.read()).toContain("http://127.0.0.1:4999/v1/logs");
  });

  // Covers: R34
  test("a user [otel] omits the lane: no second table and no config.json", async () => {
    sb = sandbox("codex");
    sb.write('[otel]\nenvironment = "dev"\n');
    expect(await runAttach(["codex", "--yes"], sb.io)).toBe(0);
    expect(sb.read().match(/\[otel\]/g)).toHaveLength(1);
    expect(parse(sb.read())["otel"]).toEqual({ environment: "dev" });
    expect(existsSync(join(sb.crowHome, "config.json"))).toBe(false);
    expect(Object.keys(parse(sb.read()).hooks)).toHaveLength(10);
  });

  // Covers: R34
  test("adds only [otel] to a block from an older attach", async () => {
    sb = sandbox("codex");
    await runAttach(["codex", "--yes"], sb.io);
    const withLane = sb.read();
    const old = withLane.replace(/\[otel\]\nexporter = .*\n\n/, "");
    expect(old).not.toContain("[otel]");
    sb.write(old);
    rmSync(manifestPath(buildContext({ engine: "codex", yes: true }, sb.io)));
    expect(await runAttach(["codex", "--yes"], sb.io)).toBe(0);
    expect(sb.read()).toBe(withLane);
  });

  // Covers: R34
  test("warns when hooks.json exists next to config.toml", async () => {
    sb = sandbox("codex");
    writeFileSync(join(sb.configDir, "hooks.json"), "{}\n");
    await runAttach(["codex", "--yes"], sb.io);
    expect(sb.output.join("\n")).toContain("hooks.json exists");
    const quiet = sandbox("codex");
    try {
      await runAttach(["codex", "--yes"], quiet.io);
      expect(quiet.output.join("\n")).not.toContain("hooks.json");
    } finally {
      quiet.cleanup();
    }
  });

  // Covers: R27
  test("unparseable config.toml aborts with the reason and writes nothing", async () => {
    sb = sandbox("codex");
    sb.write("model = = broken\n[[hooks");
    expect(await runAttach(["codex", "--yes"], sb.io)).toBe(1);
    expect(sb.read()).toBe("model = = broken\n[[hooks");
    expect(sb.output.join("\n")).toContain("cannot parse");
    expect(sb.backups()).toEqual([]);
    expect(existsSync(join(sb.crowHome, "hooks"))).toBe(false);
  });

  // Covers: R27
  test("a crow block without end marker aborts", async () => {
    sb = sandbox("codex");
    sb.write('# >>> crow v1 — half a block\nmodel = "x"\n');
    expect(await runAttach(["codex", "--yes"], sb.io)).toBe(1);
    expect(sb.output.join("\n")).toContain("no end marker");
  });
});
