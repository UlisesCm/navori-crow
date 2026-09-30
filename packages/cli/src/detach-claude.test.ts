import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { runAttach } from "./attach";
import { manifestPath, buildContext } from "./attach-common";
import { sandbox } from "./attach-test-helpers";
import type { Sandbox } from "./attach-test-helpers";
import type { AttachIo } from "./attach-common";
import { runDetach } from "./detach";

let sb: Sandbox;
const withToken = (): AttachIo => ({
  ...sb.io,
  env: { ...sb.io.env, CROW_TOKEN: "tok-ingest-777" },
});
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
    // The engine config and crow's own config.json (turned off) are both backed up.
    expect(sb.backups().length).toBe(backupsBefore + 2);
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
    // Hooks go by signature; without a manifest crow cannot tell its env keys from the user's.
    expect(Object.keys(settings())).toEqual(["env"]);
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

  // Covers: R26, R34
  test("removes the env keys crow wrote, keeps the user's, and turns config.json off", async () => {
    const original = '{\n  "env": {\n    "MY_VAR": "1"\n  }\n}\n';
    await attached(original);
    expect(existsSync(join(sb.crowHome, "config.json"))).toBe(true);
    expect(await runDetach(["claude", "--yes"], sb.io)).toBe(0);
    expect(sb.read()).toBe(original);
    expect(readFileSync(join(sb.crowHome, "config.json"), "utf8")).toBe("{}\n");
  });

  // Covers: R26
  test("keeps an env key the user edited and reports it", async () => {
    await attached("{}\n");
    const s = settings();
    (s["env"] as Record<string, string>)["OTEL_LOGS_EXPORT_INTERVAL"] = "5000";
    sb.write(`${JSON.stringify(s, null, 2)}\n`);
    expect(await runDetach(["claude", "--yes"], sb.io)).toBe(0);
    expect(settings()).toEqual({ env: { OTEL_LOGS_EXPORT_INTERVAL: "5000" } });
    expect(sb.output.join("\n")).toContain("kept crow entry env:OTEL_LOGS_EXPORT_INTERVAL");
    // A unit is still there, so the receiver stays on.
    expect(existsSync(join(sb.crowHome, "config.json"))).toBe(true);
  });

  // Covers: R34
  test("config.json is shared: it stays until no engine keeps OTLP units", async () => {
    await attached("{}\n");
    const codex = sandbox("codex");
    const both = { ...sb.io, env: { ...sb.io.env, CODEX_HOME: codex.configDir } };
    try {
      expect(await runAttach(["codex", "--yes"], both)).toBe(0);
      expect(await runDetach(["claude", "--yes"], both)).toBe(0);
      expect(existsSync(join(sb.crowHome, "config.json"))).toBe(true);
      expect(sb.output.join("\n")).toContain("an engine still has OTLP settings");
      expect(await runDetach(["codex", "--yes"], both)).toBe(0);
      expect(readFileSync(join(sb.crowHome, "config.json"), "utf8")).toBe("{}\n");
    } finally {
      codex.cleanup();
    }
  });

  // Covers: R34
  test("a config.json the user edited is kept", async () => {
    await attached("{}\n");
    writeFileSync(
      join(sb.crowHome, "config.json"),
      '{ "otlp": { "enabled": true, "port": 5000 } }\n',
    );
    expect(await runDetach(["claude", "--yes"], sb.io)).toBe(0);
    expect(readFileSync(join(sb.crowHome, "config.json"), "utf8")).toContain("5000");
    expect(sb.output.join("\n")).toContain("kept config.json");
  });

  // Covers: R26, R34
  test("env keys the user deleted by hand are forgotten and config.json still turns off", async () => {
    await attached("{}\n");
    const again = settings();
    delete again["env"];
    delete again["hooks"];
    sb.write(`${JSON.stringify(again, null, 2)}\n`);
    expect(await runDetach(["claude", "--yes"], sb.io)).toBe(0);
    expect(readFileSync(join(sb.crowHome, "config.json"), "utf8")).toBe("{}\n");
    const manifest = readFileSync(
      manifestPath(buildContext({ engine: "claude", yes: true }, sb.io)),
      "utf8",
    );
    expect(manifest).not.toContain("env:");
  });

  // Covers: R34, R23
  test("writes config.json through a symlink, with backups, never replacing the link", async () => {
    sb = sandbox("claude");
    mkdirSync(sb.crowHome, { recursive: true });
    const real = join(sb.root, "dotfiles-crow.json");
    writeFileSync(real, '{ "keep": 1 }\n');
    symlinkSync(real, join(sb.crowHome, "config.json"));
    await runAttach(["claude", "--yes"], sb.io);
    expect(lstatSync(join(sb.crowHome, "config.json")).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf8"))).toEqual({ keep: 1, otlp: { enabled: true } });
    await runDetach(["claude", "--yes"], sb.io);
    expect(lstatSync(join(sb.crowHome, "config.json")).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf8"))).toEqual({ keep: 1 });
    expect(sb.backups().length).toBeGreaterThanOrEqual(2);
  });

  // Covers: R21, D17
  test("an edited env value that may carry a secret stays masked in the detach diff", async () => {
    await attached("{}\n");
    const s = settings();
    (s["env"] as Record<string, string>)["OTEL_EXPORTER_OTLP_ENDPOINT"] =
      "http://u:s3cr3t-pass@127.0.0.1:4318";
    sb.write(`${JSON.stringify(s, null, 2)}\n`);
    await runDetach(["claude", "--yes"], sb.io);
    expect(sb.output.join("\n")).not.toContain("s3cr3t-pass");
    expect(readFileSync(sb.configPath, "utf8")).toContain("s3cr3t-pass"); // kept, as edited
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

  // Covers: R21, D17
  test("masks user env values without a secret-looking name in the detach diff", async () => {
    await attached("{}\n");
    // The user compacts the file to one line, so detach re-serializes (and shows) the env lines.
    sb.write(`${JSON.stringify({ ...settings(), env: { MY_DIR: "plainvalue-42" } })}\n`);
    await runDetach(["claude", "--yes"], sb.io);
    const shown = sb.output.join("\n");
    expect(shown).toContain("MY_DIR");
    expect(shown).not.toContain("plainvalue-42");
  });

  // Covers: R21, D17
  test("never shows CROW_TOKEN from the environment in the detach diff", async () => {
    await attached('{"model":"opus","note":"tok-ingest-777"}\n');
    await runDetach(["claude", "--yes"], withToken());
    expect(sb.output.join("\n")).not.toContain("tok-ingest-777");
  });
});
