import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAttach } from "./attach";
import { buildContext, manifestPath } from "./attach-common";
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

type Parsed = { hooks?: Record<string, unknown[]>; [k: string]: unknown };
const parse = (): Parsed => Bun.TOML.parse(sb.read()) as Parsed;

async function attached(initial: string): Promise<void> {
  sb = sandbox("codex");
  sb.write(initial);
  await runAttach(["codex", "--yes"], sb.io);
  sb.output.length = 0;
}

describe("crow detach codex", () => {
  // Covers: R26
  test("attach then detach restores the original file", async () => {
    const original = 'model = "gpt-5"\n\n[projects."/x"]\ntrust_level = "trusted"\n';
    await attached(original);
    expect(await runDetach(["codex", "--yes"], sb.io)).toBe(0);
    expect(sb.read()).toBe(original);
  });

  // Covers: R21, R26
  test("writes nothing without confirmation", async () => {
    await attached('model = "x"\n');
    const withCrow = sb.read();
    expect(await runDetach(["codex"], sb.io)).toBe(1);
    expect(sb.read()).toBe(withCrow);
  });

  // Covers: R22, R26
  test("backs the config up before writing", async () => {
    await attached('model = "x"\n');
    const n = sb.backups().length;
    await runDetach(["codex", "--yes"], sb.io);
    // The engine config and crow's own config.json (turned off) are both backed up.
    expect(sb.backups().length).toBe(n + 2);
  });

  // Covers: R26
  test("preserves what the user added after the attach, inside and outside the block", async () => {
    await attached('model = "x"\n');
    const withCrow = sb.read();
    sb.write(
      `${withCrow}\n[mcp_servers.mine]\ncommand = "echo"\n`.replace(
        "# <<< crow <<<\n",
        "# <<< crow <<<\n",
      ),
    );
    await runDetach(["codex", "--yes"], sb.io);
    const after = parse();
    expect(after["model"]).toBe("x");
    expect(after["mcp_servers"]).toEqual({ mine: { command: "echo" } });
    expect(after.hooks).toBeUndefined();
    expect(sb.read()).not.toContain("crow v1");
  });

  // Covers: R26
  test("keeps and reports an edited group, removes the intact ones, drops the markers", async () => {
    await attached('model = "x"\n');
    sb.write(
      sb
        .read()
        .replace("[[hooks.Stop]]", "[[hooks.Stop]]")
        .replace(
          /(\[\[hooks\.PreToolUse\.hooks\]\]\n(?:.*\n){2}timeout = 2)/,
          '$1\nmatcher = "Bash"',
        ),
    );
    await runDetach(["codex", "--yes"], sb.io);
    const after = parse();
    expect(Object.keys(after.hooks ?? {})).toEqual(["PreToolUse"]);
    expect(sb.read()).toContain('matcher = "Bash"');
    expect(sb.read()).not.toContain("crow v1");
    expect(sb.output.join("\n")).toContain("kept crow entry PreToolUse");
  });

  // Covers: R26
  test("a line the user added inside the block is kept", async () => {
    await attached('model = "x"\n');
    sb.write(sb.read().replace("# <<< crow <<<", "# my own note\n# <<< crow <<<"));
    await runDetach(["codex", "--yes"], sb.io);
    expect(sb.read()).toContain("# my own note");
    expect(parse().hooks).toBeUndefined();
  });

  // Covers: R26
  test("aborts without writing when the manifest cannot be read", async () => {
    await attached('model = "x"\n');
    writeFileSync(manifestPath(buildContext({ engine: "codex", yes: true }, sb.io)), "{bad");
    const before = sb.read();
    expect(await runDetach(["codex", "--yes"], sb.io)).toBe(1);
    expect(sb.read()).toBe(before);
  });

  // Covers: R26
  test("nothing to do without a crow block", async () => {
    sb = sandbox("codex");
    sb.write('model = "x"\n');
    expect(await runDetach(["codex", "--yes"], sb.io)).toBe(0);
    expect(sb.backups()).toEqual([]);
  });

  // Covers: R27
  test("unparseable config.toml aborts and writes nothing", async () => {
    sb = sandbox("codex");
    sb.write("[[hooks");
    expect(await runDetach(["codex", "--yes"], sb.io)).toBe(1);
    expect(readFileSync(sb.configPath, "utf8")).toBe("[[hooks");
    expect(sb.output.join("\n")).toContain("cannot parse");
    expect(sb.backups()).toEqual([]);
  });

  // Covers: R26, R34
  test("removes [otel] and turns config.json off", async () => {
    await attached('model = "x"\n');
    expect(sb.read()).toContain("[otel]");
    expect(await runDetach(["codex", "--yes"], sb.io)).toBe(0);
    expect(sb.read()).toBe('model = "x"\n');
    expect(readFileSync(join(sb.crowHome, "config.json"), "utf8")).toBe("{}\n");
  });

  // Covers: R26, R34
  test("a [otel] the user deleted by hand is forgotten and config.json still turns off", async () => {
    await attached('model = "x"\n');
    sb.write(sb.read().replace(/\[otel\]\nexporter = .*\n\n/, ""));
    expect(sb.read()).not.toContain("[otel]");
    expect(await runDetach(["codex", "--yes"], sb.io)).toBe(0);
    expect(readFileSync(join(sb.crowHome, "config.json"), "utf8")).toBe("{}\n");
    expect(sb.read()).toBe('model = "x"\n');
  });

  // Covers: R26, R34
  test("with only the stale [otel] unit left, detach still updates the manifest and config.json", async () => {
    await attached('model = "x"\n');
    sb.write(sb.read().replace(/\[otel\]\nexporter = .*\n\n/, ""));
    const ctx = buildContext({ engine: "codex", yes: true }, sb.io);
    // Drop the hook groups too, so no engine entry is left to remove.
    sb.write('model = "x"\n');
    expect(await runDetach(["codex", "--yes"], sb.io)).toBe(0);
    expect(readFileSync(join(sb.crowHome, "config.json"), "utf8")).toBe("{}\n");
    expect(
      existsSync(manifestPath(ctx)) ? readFileSync(manifestPath(ctx), "utf8") : "",
    ).not.toContain('"otel"');
  });

  // Covers: R26
  test("keeps an edited [otel] and reports it", async () => {
    await attached('model = "x"\n');
    sb.write(sb.read().replace("4318/v1/logs", "9999/v1/logs"));
    expect(await runDetach(["codex", "--yes"], sb.io)).toBe(0);
    expect(sb.read()).toContain("127.0.0.1:9999/v1/logs");
    expect(Object.keys(parse()).sort()).toEqual(["model", "otel"]);
    expect(sb.output.join("\n")).toContain("kept crow entry otel");
    expect(existsSync(join(sb.crowHome, "config.json"))).toBe(true);
  });

  // Covers: R21, D17
  test("never shows a literal token outside crow's block in the detach diff", async () => {
    await attached('model = "x"\n');
    sb.write(`${sb.read()}\n[mcp]\nkey = "tok-ingest-777"\n`);
    await runDetach(["codex", "--yes"], withToken());
    expect(sb.output.join("\n")).not.toContain("tok-ingest-777");
  });
});
