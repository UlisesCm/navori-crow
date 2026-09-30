import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { runAttach } from "./attach";
import { CLAUDE_EVENTS } from "./attach-common";
import { modeOf, sandbox } from "./attach-test-helpers";
import type { Sandbox } from "./attach-test-helpers";

let sb: Sandbox;
afterEach(() => sb.cleanup());

interface Handler {
  type: string;
  command: string;
  async: boolean;
  timeout: number;
}
type Settings = { hooks: Record<string, Array<{ hooks: Handler[] }>>; [k: string]: unknown };

describe("crow attach claude", () => {
  // Covers: R21
  test("shows a diff and writes nothing without confirmation", async () => {
    sb = sandbox("claude", { interactive: false });
    sb.write('{\n  "model": "opus"\n}\n');
    const before = sb.read();
    expect(await runAttach(["claude"], sb.io)).toBe(1);
    expect(sb.read()).toBe(before);
    expect(sb.output.join("\n")).toContain("+++ ");
    expect(sb.output.join("\n")).toContain("confirmation required");
    expect(sb.backups()).toEqual([]);
    expect(existsSync(join(sb.crowHome, "attach"))).toBe(false);
  });

  // Covers: R21
  test("an interactive 'no' writes nothing; 'yes' writes", async () => {
    sb = sandbox("claude", { interactive: true, answer: false });
    sb.write("{}\n");
    expect(await runAttach(["claude"], sb.io)).toBe(1);
    expect(sb.read()).toBe("{}\n");
    const yes = sandbox("claude", { interactive: true, answer: true });
    try {
      yes.write("{}\n");
      expect(await runAttach(["claude"], yes.io)).toBe(0);
      expect(yes.read()).toContain("crow-ingest-hook claude");
    } finally {
      yes.cleanup();
    }
  });

  // Covers: R21, R8
  test("registers the command+async handler for the 15 events, keeping other settings", async () => {
    sb = sandbox("claude");
    sb.write(
      '{\n  "model": "opus",\n  "hooks": {\n    "Stop": [{ "hooks": [{ "type": "command", "command": "echo mine" }] }]\n  }\n}\n',
    );
    expect(await runAttach(["claude", "--yes"], sb.io)).toBe(0);
    const s = JSON.parse(sb.read()) as Settings;
    expect(s["model"]).toBe("opus");
    expect(Object.keys(s.hooks).sort()).toEqual([...CLAUDE_EVENTS].sort());
    const stop = s.hooks["Stop"]!;
    expect(stop[0]!.hooks[0]!.command).toBe("echo mine");
    const crow = stop[1]!.hooks[0]!;
    expect(crow).toEqual({
      type: "command",
      command: `${join(sb.crowHome, "hooks", "crow-ingest-hook")} claude`,
      async: true,
      timeout: 2,
    });
    expect(modeOf(join(sb.crowHome, "hooks", "crow-ingest-hook"))).toBe(0o700);
    expect(readFileSync(join(sb.crowHome, "hooks", "crow-ingest-hook"), "utf8")).toContain(
      "exit 0",
    );
  });

  // Covers: R21
  test("masks env values crow did not write in the diff", async () => {
    sb = sandbox("claude");
    sb.write(
      '{\n  "env": { "MY_API_KEY": "sk-supersecret", "ANTHROPIC_AUTH_TOKEN": "tok-123" }\n}\n',
    );
    await runAttach(["claude", "--yes"], sb.io);
    const shown = sb.output.join("\n");
    expect(shown).not.toContain("sk-supersecret");
    expect(shown).not.toContain("tok-123");
  });

  // Covers: R22
  test("saves a timestamped 0600 backup with the original content before writing", async () => {
    sb = sandbox("claude");
    sb.write('{ "model": "opus" }\n');
    await runAttach(["claude", "--yes"], sb.io);
    const [backup] = sb.backups();
    expect(sb.backups()).toHaveLength(1);
    expect(backup).toMatch(/settings\.json\.\d{8}T\d+Z\.bak$/);
    expect(modeOf(backup!)).toBe(0o600);
    expect(readFileSync(backup!, "utf8")).toBe('{ "model": "opus" }\n');
    expect(sb.output.join("\n")).toContain("copies the secrets");
  });

  // Covers: R22
  test("a missing config is created without backup", async () => {
    sb = sandbox("claude");
    expect(await runAttach(["claude", "--yes"], sb.io)).toBe(0);
    expect(sb.backups()).toEqual([]);
    expect(Object.keys((JSON.parse(sb.read()) as Settings).hooks)).toHaveLength(15);
  });

  // Covers: R25
  test("is idempotent: a second attach changes and backs up nothing", async () => {
    sb = sandbox("claude");
    sb.write("{}\n");
    await runAttach(["claude", "--yes"], sb.io);
    const after = sb.read();
    const backups = sb.backups().length;
    expect(await runAttach(["claude", "--yes"], sb.io)).toBe(0);
    expect(sb.read()).toBe(after);
    expect(sb.backups()).toHaveLength(backups);
    expect(sb.output.join("\n")).toContain("already attached");
  });

  // Covers: R25
  test("completes a partial attach without duplicating the present handlers", async () => {
    sb = sandbox("claude");
    const cmd = `${join(sb.crowHome, "hooks", "crow-ingest-hook")} claude`;
    sb.write(
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command: cmd, async: true, timeout: 2 }] }] },
      }),
    );
    await runAttach(["claude", "--yes"], sb.io);
    const s = JSON.parse(sb.read()) as Settings;
    expect(s.hooks["Stop"]).toHaveLength(1);
    expect(Object.keys(s.hooks)).toHaveLength(15);
  });

  // Covers: R23
  test("writes only the engine config and CROW_HOME", async () => {
    sb = sandbox("claude");
    const repo = join(sb.root, "repo");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    await runAttach(["claude", "--yes"], sb.io);
    expect(readdirSync(join(repo, ".claude"))).toEqual([]);
    expect(readdirSync(sb.root).sort()).toEqual(["claude-cfg", "crow-home", "repo"]);
    expect(readdirSync(sb.configDir)).toEqual(["settings.json"]);
  });

  // Covers: R23
  test("writes through a symlinked settings.json without replacing the link", async () => {
    sb = sandbox("claude");
    const real = join(sb.root, "dotfiles-settings.json");
    await Bun.write(real, "{}\n");
    symlinkSync(real, sb.configPath);
    await runAttach(["claude", "--yes"], sb.io);
    expect(Object.keys((JSON.parse(readFileSync(real, "utf8")) as Settings).hooks)).toHaveLength(
      15,
    );
    expect(readFileSync(sb.configPath, "utf8")).toBe(readFileSync(real, "utf8"));
  });

  // Covers: R24
  test("never writes content flags and warns when the user already has them", async () => {
    sb = sandbox("claude");
    sb.write('{ "env": { "OTEL_LOG_USER_PROMPTS": "1" } }\n');
    await runAttach(["claude", "--yes"], sb.io);
    const s = JSON.parse(sb.read()) as Settings;
    expect(s["env"]).toEqual({ OTEL_LOG_USER_PROMPTS: "1" }); // untouched, not added by crow
    expect(sb.output.join("\n")).toContain("OTEL_LOG_USER_PROMPTS is enabled");

    const clean = sandbox("claude");
    try {
      await runAttach(["claude", "--yes"], clean.io);
      const text = clean.read();
      for (const f of [
        "OTEL_LOG_USER_PROMPTS",
        "OTEL_LOG_TOOL_DETAILS",
        "OTEL_LOG_TOOL_CONTENT",
        "OTEL_LOG_ASSISTANT_RESPONSES",
      ]) {
        expect(text).not.toContain(f);
      }
    } finally {
      clean.cleanup();
    }
  });

  // Covers: R27
  test("unparseable settings abort with the reason and write nothing", async () => {
    sb = sandbox("claude");
    sb.write('{ "hooks": { oops }');
    expect(await runAttach(["claude", "--yes"], sb.io)).toBe(1);
    expect(sb.read()).toBe('{ "hooks": { oops }');
    expect(sb.output.join("\n")).toContain("cannot parse");
    expect(sb.backups()).toEqual([]);
    expect(existsSync(join(sb.crowHome, "hooks"))).toBe(false);
  });

  // Covers: R21
  test("warns about format-only line changes for hand-formatted JSON", async () => {
    sb = sandbox("claude");
    sb.write('{"model":"opus",\n      "theme":   "dark"}');
    await runAttach(["claude", "--yes"], sb.io);
    expect(sb.output.join("\n")).toMatch(/lines change only in format/);
  });
});
