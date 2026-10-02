import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../.pi/extensions/navori.ts", import.meta.url), "utf8");

interface FactoryProbe {
  tools: Record<string, unknown>[];
  hooks: string[];
  diagnostics: string[];
}

/** Evaluate the shipped extension with fake Pi imports, without accessing auth or spawning children. */
function probeFactory(piVersion: string, nodeVersion: string): FactoryProbe {
  const result: FactoryProbe = { tools: [], hooks: [], diagnostics: [] };
  const exports: { default?: (pi: unknown) => void } = {};
  const js = new Bun.Transpiler({ loader: "ts" })
    .transformSync(source)
    .replace(/^import \{([^}]+)\} from "([^"]+)";$/gm, 'const {$1} = require("$2");')
    .replace("export default function", "exports.default = function");
  const schema = (): Record<string, unknown> => ({});
  const imports: Record<string, unknown> = {
    "@earendil-works/pi-coding-agent": {
      VERSION: piVersion,
      defineTool: (tool: unknown): unknown => tool,
    },
    "@earendil-works/pi-ai": {
      Type: { Object: schema, Union: schema, Literal: schema, String: schema, Optional: schema },
    },
    "node:child_process": {},
    "node:fs": {},
    "node:path": {},
  };
  runInNewContext(
    js,
    {
      exports,
      require: (id: string): unknown => {
        if (!Object.hasOwn(imports, id)) throw new Error(`Unexpected extension import: ${id}`);
        return imports[id];
      },
      process: {
        env: {},
        versions: { node: nodeVersion },
        stderr: {
          write: (message: string): void => {
            result.diagnostics.push(message);
          },
        },
      },
    },
    { timeout: 1000 },
  );
  if (typeof exports.default !== "function") throw new Error("Missing extension factory");
  exports.default({
    on: (name: string, _handler: unknown): void => {
      result.hooks.push(name);
    },
    registerTool: (tool: Record<string, unknown>): void => {
      result.tools.push(tool);
    },
  });
  return result;
}

describe("generated Pi subagent extension", (): void => {
  test("the shipped artifact registers navori_subagent on supported runtimes", (): void => {
    for (const [piVersion, nodeVersion] of [
      ["0.87.1", "22.19.0"],
      ["1.0.0", "24.20.0"],
    ]) {
      const result = probeFactory(piVersion!, nodeVersion!);
      expect(result.diagnostics).toEqual([]);
      expect(result.hooks).toEqual(["tool_call", "before_agent_start"]);
      expect(result.tools.map((tool: Record<string, unknown>): unknown => tool.name)).toEqual([
        "navori_subagent",
      ]);
      expect(typeof result.tools[0]?.execute).toBe("function");
    }
  });

  test("old runtimes fail closed with version diagnostics, not broken identifiers", (): void => {
    for (const [piVersion, nodeVersion, expected] of [
      ["0.87.0", "22.19.0", "requires @earendil-works/pi-coding-agent 0.87.1"],
      ["1.0.0", "22.18.9", "requires Node.js 22.19.0"],
    ]) {
      const result = probeFactory(piVersion!, nodeVersion!);
      expect(result.tools).toEqual([]);
      expect(result.hooks).toEqual([]);
      expect(result.diagnostics.join("\n")).toContain(expected!);
      expect(result.diagnostics.join("\n")).not.toContain("is not defined");
    }
  });

  test("the regenerated source retains its managed ownership hash", (): void => {
    const marker = /^\/\/ navori:managed-file id="pi-extension" hash="([a-f0-9]{64})"\n/.exec(
      source,
    );
    if (!marker || !marker[1]) throw new Error("Missing managed ownership marker");
    const hash = createHash("sha256").update(source.slice(marker[0].length)).digest("hex");
    expect(hash).toBe(marker[1]);
  });
});
