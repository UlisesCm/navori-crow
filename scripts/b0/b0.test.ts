/**
 * B0 tooling: receiver (verbatim capture, modes, no body echo), shim (exit 0
 * with the receiver down) and summarizer (shapes only, no value leaks, G5a
 * counts).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startReceiver, type ReceiverMode, type RunningReceiver } from "../capture-receiver";
import { CLAUDE_EVENTS, CODEX_EVENTS, claudeSettings, codexToml } from "./gen-config";
import {
  CLAUDE_PAIRS,
  CODEX_PAIRS,
  checkIds,
  summarizeCaptures,
  toolLatency,
} from "./summarize-captures";

describe("gen-config", () => {
  const base = { hookPort: 7790, otlpPort: 4319, shim: "/b0/hook-shim.sh", traces: false } as const;

  test("claude: every R8 event on the chosen transport, OTel env without content flags", () => {
    const http = claudeSettings({ ...base, transport: "http", otlpProtocol: "http/json" });
    expect(Object.keys(http.hooks)).toEqual([...CLAUDE_EVENTS]);
    expect(http.hooks["SessionEnd"]![0]!.hooks[0]).toMatchObject({ type: "http", timeout: 1 });
    expect(http.hooks["PreToolUse"]![0]!.hooks[0]).toMatchObject({
      type: "http",
      url: "http://127.0.0.1:7790/hook/claude",
      timeout: 2,
    });
    const cmd = claudeSettings({
      ...base,
      transport: "command",
      otlpProtocol: "http/protobuf",
      traces: true,
    });
    expect(cmd.hooks["Stop"]![0]!.hooks[0]).toEqual({
      type: "command",
      command: "/b0/hook-shim.sh claude",
      async: true,
      timeout: 2,
    });
    expect(cmd.env["OTEL_TRACES_EXPORTER"]).toBe("otlp");
    expect(Object.keys(cmd.env).join(" ")).not.toContain("OTEL_LOG_USER");
  });

  test("codex: nested hook groups for the 10 R9 events, prompts off", () => {
    const toml = codexToml({ shim: "/b0/hook-shim.sh", otlpPort: 4319, protocol: "binary" });
    for (const ev of CODEX_EVENTS) expect(toml).toContain(`[[hooks.${ev}.hooks]]`);
    expect(toml.match(/\[\[hooks\.\w+\.hooks\]\]/g)).toHaveLength(10);
    expect(toml).toContain("log_user_prompt = false");
    expect(toml).toContain('protocol = "binary"');
  });
});

describe("toolLatency", () => {
  test("p50/p95 from tool_use to tool_result, numbers only", () => {
    const dir = mkdtempSync(join(tmpdir(), "b0-lat-"));
    const f = join(dir, "t.jsonl");
    const rec = (ts: number, block: object) =>
      JSON.stringify({ timestamp: new Date(ts).toISOString(), message: { content: [block] } });
    writeFileSync(
      f,
      [
        rec(1000, { type: "tool_use", id: "a" }),
        rec(1100, { type: "tool_result", tool_use_id: "a", content: SECRET }),
        rec(2000, { type: "tool_use", id: "b" }),
        rec(2300, { type: "tool_result", tool_use_id: "b" }),
      ].join("\n"),
    );
    const out = toolLatency([f]);
    expect(out).toContain("n=2 p50=100 p95=300");
    expect(out).not.toContain(SECRET);
  });
});

const SECRET = "sk-secret-PROMPT-do-not-leak-123";
const running: RunningReceiver[] = [];

function start(
  mode: ReceiverMode,
  lines: string[] = [],
  hangMs = 300,
): { r: RunningReceiver; out: string } {
  const out = mkdtempSync(join(tmpdir(), "b0-cap-"));
  const r = startReceiver({ out, port: 0, otlpPort: 0, mode, hangMs, log: (l) => lines.push(l) });
  running.push(r);
  return { r, out };
}

afterEach(async () => {
  while (running.length > 0) await running.pop()!.stop();
});

describe("capture-receiver", () => {
  test("writes each request verbatim, redacts auth, never logs the body", async () => {
    const lines: string[] = [];
    const { r, out } = start("ok", lines);
    const body = JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: SECRET });
    const res = await fetch(`http://127.0.0.1:${r.port}/hook/claude`, {
      method: "POST",
      headers: { authorization: "Bearer topsecret", "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(204);
    expect(readFileSync(join(out, "000001.body"), "utf8")).toBe(body);
    const meta = JSON.parse(readFileSync(join(out, "000001.json"), "utf8"));
    expect(meta.path).toBe("/hook/claude");
    expect(meta.headers.authorization).toBe("[redacted]");
    expect(readFileSync(join(out, "000001.json"), "utf8")).not.toContain("topsecret");
    expect(lines.join("\n")).not.toContain(SECRET);
    expect(lines).toHaveLength(1);
  });

  test("unknown header and query values never reach the .json; names are kept", async () => {
    const { r, out } = start("ok");
    await fetch(`http://127.0.0.1:${r.port}/hook/claude?tok=QSECRET&a=1`, {
      method: "POST",
      headers: { "x-foo-token": "HSECRET", "content-type": "application/json" },
      body: "{}",
    });
    const raw = readFileSync(join(out, "000001.json"), "utf8");
    expect(raw).not.toContain("HSECRET");
    expect(raw).not.toContain("QSECRET");
    const meta = JSON.parse(raw);
    expect(meta.headers["x-foo-token"]).toBe("[redacted]");
    expect(meta.headers["content-type"]).toBe("application/json");
    expect(meta.query).toBe("?tok=[redacted]&a=[redacted]");
  });

  test("refuses an --out inside a git worktree", () => {
    const repo = mkdtempSync(join(tmpdir(), "b0-repo-"));
    mkdirSync(join(repo, ".git"));
    expect(() =>
      startReceiver({ out: join(repo, "deep", "cap"), port: 0, otlpPort: 0, mode: "ok" }),
    ).toThrow(/git worktree/);
    const proc = Bun.spawnSync(
      ["bun", join(import.meta.dir, "..", "capture-receiver.ts"), "--out", join(repo, "cap")],
      { stderr: "pipe" },
    );
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr.toString()).toContain("git worktree");
  });

  test("stop() releases a hung request immediately", async () => {
    const { r } = start("hang", [], 60_000);
    const pending = fetch(`http://127.0.0.1:${r.port}/hook/claude`, { method: "POST", body: "{}" });
    while (r.count() === 0) await Bun.sleep(10);
    const t0 = Date.now();
    await r.stop();
    await pending.catch(() => {});
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  test("OTLP: 200 in the request content type, gzip kept plus decoded copy, counter is monotonic", async () => {
    const { r, out } = start("ok");
    const payload = JSON.stringify({ resourceLogs: [] });
    const gz = Bun.gzipSync(payload);
    const res = await fetch(`http://127.0.0.1:${r.otlpPort}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: gz,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const pb = await fetch(`http://127.0.0.1:${r.otlpPort}/v1/metrics`, {
      method: "POST",
      headers: { "content-type": "application/x-protobuf" },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(pb.status).toBe(200);
    expect(pb.headers.get("content-type")).toContain("protobuf");
    expect((await pb.arrayBuffer()).byteLength).toBe(0);
    expect(new Uint8Array(readFileSync(join(out, "000001.body")))).toEqual(gz);
    expect(readFileSync(join(out, "000001.body.decoded"), "utf8")).toBe(payload);
    expect(existsSync(join(out, "000002.json"))).toBe(true);
    expect(r.count()).toBe(2);
  });

  test("modes 401 / 413 answer with the status and still record; hang delays", async () => {
    for (const [mode, status] of [
      ["401", 401],
      ["413", 413],
    ] as const) {
      const { r, out } = start(mode);
      const res = await fetch(`http://127.0.0.1:${r.port}/hook/claude`, {
        method: "POST",
        body: "{}",
      });
      expect(res.status).toBe(status);
      expect(existsSync(join(out, "000001.body"))).toBe(true);
    }
    const { r } = start("hang", [], 300);
    const t0 = Date.now();
    const res = await fetch(`http://127.0.0.1:${r.port}/hook/claude`, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(204);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
  });
});

describe("hook-shim.sh", () => {
  const shim = join(import.meta.dir, "hook-shim.sh");

  test("exit 0, no output, with the receiver down", async () => {
    const proc = Bun.spawn(["sh", shim, "claude"], {
      stdin: new Blob(["{}"]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CROW_B0_HOOK_URL: "http://127.0.0.1:1/hook" },
    });
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe("");
    expect(await new Response(proc.stderr).text()).toBe("");
  });

  test("POSTs the stdin payload to the receiver", async () => {
    const { r, out } = start("ok");
    const proc = Bun.spawn(["sh", shim, "codex"], {
      stdin: new Blob([`{"hook_event_name":"Stop"}`]),
      env: { ...process.env, CROW_B0_HOOK_URL: `http://127.0.0.1:${r.port}/hook` },
    });
    expect(await proc.exited).toBe(0);
    expect(readFileSync(join(out, "000001.body"), "utf8")).toBe(`{"hook_event_name":"Stop"}`);
    expect(JSON.parse(readFileSync(join(out, "000001.json"), "utf8")).path).toBe("/hook/codex");
  });
});

describe("summarize-captures", () => {
  async function fixtureDir(): Promise<string> {
    const { r, out } = start("ok");
    const post = (path: string, body: unknown, port = r.port) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    await post("/hook/claude", {
      hook_event_name: "PreToolUse",
      session_id: "S1",
      tool_use_id: "toolu_A",
      tool_name: "Bash",
      tool_input: { [`/home/${SECRET}/file`]: SECRET, command: SECRET },
    });
    await post("/hook/claude", {
      hook_event_name: "UserPromptSubmit",
      prompt: SECRET,
      prompt_id: "p1",
    });
    await post(
      "/v1/logs",
      {
        resourceLogs: [
          {
            resource: {
              attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }],
            },
            scopeLogs: [
              {
                logRecords: [
                  {
                    timeUnixNano: "1700000000000000000",
                    body: { stringValue: SECRET },
                    attributes: [
                      { key: "event.name", value: { stringValue: "tool_result" } },
                      { key: "tool_use_id", value: { stringValue: "toolu_A" } },
                      { key: "tool_input", value: { stringValue: SECRET } },
                      { key: "duration_ms", value: { intValue: "12" } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      r.otlpPort,
    );
    return out;
  }

  test("prints shapes and counts, never values", async () => {
    const out = await fixtureDir();
    const report = summarizeCaptures(out);
    expect(report).not.toContain(SECRET);
    expect(report).toContain("== hook:claude:PreToolUse x1");
    expect(report).toContain("$.tool_use_id: stringx1");
    expect(report).toContain("== log:tool_result x1");
    expect(report).toContain("tool_use_id: stringValuex1");
    expect(report).toContain("duration_ms: intValuex1");
    expect(report).toContain("service.name:\n  claude-code: 1");
  });

  test("G5a: counts matching ids without printing them", async () => {
    const out = await fixtureDir();
    const tdir = mkdtempSync(join(tmpdir(), "b0-tr-"));
    const tfile = join(tdir, "t.jsonl");
    writeFileSync(
      tfile,
      [
        JSON.stringify({
          promptId: "p1",
          message: { content: [{ type: "tool_use", id: "toolu_A", input: SECRET }] },
        }),
        JSON.stringify({ requestId: "req_9", agentId: "a1" }),
        "not json",
      ].join("\n"),
    );
    const report = checkIds(out, [tfile], CLAUDE_PAIRS);
    expect(report).not.toContain(SECRET);
    expect(report).not.toContain("toolu_A");
    expect(report).toContain(
      "tool_use_id <-> tool_use.id [hook]: captured=1 transcript=1 matched=1",
    );
    expect(report).toContain(
      "tool_use_id <-> tool_use.id [otel]: captured=1 transcript=1 matched=1",
    );
    expect(report).toContain("prompt_id <-> promptId [hook]: captured=1 transcript=1 matched=1");
    expect(report).toContain("request_id <-> requestId [hook]: captured=0 transcript=1 matched=0");
  });

  test("G5a Codex: a Bash hook's exec-<id> matches the rollout's item_completed item id, a collaboration call_id its call_id", () => {
    const dir = mkdtempSync(join(tmpdir(), "b0-codex-"));
    const capture = (n: number, path: string, body: unknown): void => {
      const stem = String(n).padStart(6, "0");
      writeFileSync(join(dir, `${stem}.body`), JSON.stringify(body));
      writeFileSync(
        join(dir, `${stem}.json`),
        JSON.stringify({
          n,
          method: "POST",
          path,
          headers: { "content-type": "application/json" },
          bodyFile: `${stem}.body`,
          decodedFile: null,
        }),
      );
    };
    capture(1, "/hook/codex", { hook_event_name: "PreToolUse", tool_use_id: "exec-AAA" });
    capture(2, "/hook/codex", { hook_event_name: "PreToolUse", tool_use_id: "call_BBB" });
    capture(3, "/hook/codex", { hook_event_name: "PreToolUse", tool_use_id: "exec-NOPE" });
    capture(4, "/v1/logs", {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                { attributes: [{ key: "call_id", value: { stringValue: "call_CCC" } }] },
              ],
            },
          ],
        },
      ],
    });
    const rollout = join(dir, "rollout.jsonl");
    writeFileSync(
      rollout,
      [
        JSON.stringify({
          type: "event_msg",
          payload: { type: "item_completed", item: { id: "exec-AAA", type: "CommandExecution" } },
        }),
        JSON.stringify({
          type: "response_item",
          payload: { type: "function_call", call_id: "call_BBB" },
        }),
        JSON.stringify({
          type: "response_item",
          payload: { type: "function_call", call_id: "call_CCC" },
        }),
      ].join("\n"),
    );
    const report = checkIds(dir, [rollout], CODEX_PAIRS);
    expect(report).not.toContain("exec-AAA");
    expect(report).toContain("call_id|item.id [hook]: captured=3 transcript=3 matched=2");
    expect(report).toContain("call_id|item.id [otel]: captured=1 transcript=3 matched=1");
  });
});
