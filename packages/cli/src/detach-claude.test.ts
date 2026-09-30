import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAttach } from "./attach";
import { manifestPath, buildContext } from "./attach-common";
import { sandbox } from "./attach-test-helpers";
import type { Sandbox } from "./attach-test-helpers";
import { runDetach } from "./detach";

let sb: Sandbox;
afterEach(() => sb.cleanup());

type Settings = {
  hooks?: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
  [k: string]: unknown;
};
const settings = (): Settings => JSON.parse(sb.read()) as Settings;

async function attached(initial: string): Promise<void> {
  sb = sandbox("claude");
  sb.write(initial);
  await runAttach(["claude", "--yes"], sb.io);
  sb.output.length = 0;
}

describe("crow detach claude", () => {
  // Covers: R26
  test("attach then detach restores the original file", async () => {
    const original = '{\n  "model": "opus"\n}\n';
    await attached(original);
    expect(await runDetach(["claude", "--yes"], sb.io)).toBe(0);
    expect(sb.read()).toBe(original);
  });

  // Covers: R21, R26
  test("writes nothing without confirmation", async () => {
    await attached("{}\n");
    const with_ = sb.read();
    expect(await runDetach(["claude"], sb.io)).toBe(1);
    expect(sb.read()).toBe(with_);
    expect(sb.output.join("\n")).toContain("confirmation required");
  });

  // Covers: R22, R26
  test("backs the config up before writing", async () => {
    await attached("{}\n");
    const backupsBefore = sb.backups().length;
    await runDetach(["claude", "--yes"], sb.io);
    expect(sb.backups().length).toBe(backupsBefore + 1);
  });

  // Covers: R26
  test("preserves everything the user changed after the attach", async () => {
    await attached('{\n  "model": "opus"\n}\n');
    const s = settings();
    s["theme"] = "dark";
    s.hooks!["Stop"]!.push({ hooks: [{ type: "command", command: "echo later" }] });
    s.hooks!["MyNewEvent"] = [{ hooks: [{ type: "command", command: "echo x" }] }];
    sb.write(`${JSON.stringify(s, null, 2)}\n`);
    await runDetach(["claude", "--yes"], sb.io);
    const after = settings();
    expect(after["model"]).toBe("opus");
    expect(after["theme"]).toBe("dark");
    expect(after.hooks).toEqual({
      Stop: [{ hooks: [{ type: "command", command: "echo later" }] }],
      MyNewEvent: [{ hooks: [{ type: "command", command: "echo x" }] }],
    });
  });

  // Covers: R26
  test("keeps and reports a crow handler the user edited, removes the rest", async () => {
    await attached("{}\n");
    const s = settings();
    s.hooks!["PreToolUse"]![0]!.hooks[0]!["if"] = "Bash(git *)";
    sb.write(`${JSON.stringify(s, null, 2)}\n`);
    await runDetach(["claude", "--yes"], sb.io);
    const after = settings();
    expect(Object.keys(after.hooks!)).toEqual(["PreToolUse"]);
    expect(after.hooks!["PreToolUse"]![0]!.hooks[0]!["if"]).toBe("Bash(git *)");
    expect(sb.output.join("\n")).toContain("kept crow entry PreToolUse");
    // The manifest keeps the edited unit's identity? No: only removed units leave it.
    expect(readdirSync(join(sb.crowHome, "attach"))).toHaveLength(1);
  });

  // Covers: R26
  test("a changed timeout counts as an edit", async () => {
    await attached("{}\n");
    const s = settings();
    s.hooks!["Stop"]![0]!.hooks[0]!["timeout"] = 30;
    sb.write(`${JSON.stringify(s, null, 2)}\n`);
    await runDetach(["claude", "--yes"], sb.io);
    expect(settings().hooks!["Stop"]![0]!.hooks[0]!["timeout"]).toBe(30);
  });

  // Covers: R26
  test("without a manifest it falls back to the command signature", async () => {
    await attached("{}\n");
    const ctx = buildContext({ engine: "claude", yes: true }, sb.io);
    await Bun.file(manifestPath(ctx)).delete();
    expect(await runDetach(["claude", "--yes"], sb.io)).toBe(0);
    expect(settings()).toEqual({});
  });

  // Covers: R26
  test("aborts without writing when the manifest cannot be read", async () => {
    await attached("{}\n");
    const ctx = buildContext({ engine: "claude", yes: true }, sb.io);
    writeFileSync(manifestPath(ctx), "not json");
    const before = sb.read();
    expect(await runDetach(["claude", "--yes"], sb.io)).toBe(1);
    expect(sb.read()).toBe(before);
    expect(sb.output.join("\n")).toContain("cannot verify");
  });

  // Covers: R26
  test("reports nothing to do when crow is not attached", async () => {
    sb = sandbox("claude");
    sb.write('{ "model": "opus" }\n');
    expect(await runDetach(["claude", "--yes"], sb.io)).toBe(0);
    expect(sb.read()).toBe('{ "model": "opus" }\n');
    expect(sb.backups()).toEqual([]);
  });

  // Covers: R27
  test("unparseable settings abort and write nothing", async () => {
    sb = sandbox("claude");
    sb.write("{ nope");
    expect(await runDetach(["claude", "--yes"], sb.io)).toBe(1);
    expect(readFileSync(sb.configPath, "utf8")).toBe("{ nope");
    expect(sb.output.join("\n")).toContain("cannot parse");
    expect(sb.backups()).toEqual([]);
  });
});
