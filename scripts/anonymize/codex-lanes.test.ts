/**
 * Codex lanes of the B0 anonymizers on SYNTHETIC data (never real captures): hook payloads (`hooks.ts`),
 * OTLP/JSON logs (`otlp.ts`) and rollouts (`codex.ts`) share ONE id registry and ONE time offset, so
 * the G5a equalities survive anonymization — including a shell command's hook `tool_use_id =
 * exec-<id>` ↔ the rollout's `item_completed.payload.item.id` ↔ the OTLP `call_id`.
 */
import { describe, expect, test } from "bun:test";
import type { Rec } from "@crow/core";
import type { AnonymizeSourceFile } from "./codex";
import { anonymizeCodexFixture } from "./codex";
import { anonymizeHookPayload, minRolloutPathMs, verifyHookPayload } from "./hooks";
import { CODEX_NOISY_EVENTS, anonymizeOtlp, mergeAndTrimLogs, verifyOtlpBody } from "./otlp";
import { FixtureContext, IdRegistry } from "./shared";

const SECRET = "SENTINEL_secret_text with spaces";

/** Deterministic pseudo-random uuid-shaped ids (mulberry32), so the property runs are reproducible. */
function uuids(seed: number): () => string {
  let a = seed;
  const next = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const hex = (n: number): string =>
    Array.from({ length: n }, () => Math.floor(next() * 16).toString(16)).join("");
  return () => `${hex(8)}-${hex(4)}-7${hex(3)}-a${hex(3)}-${hex(12)}`;
}

const s = (key: string, v: string): Rec => ({ key, value: { stringValue: v } });

interface Raw {
  session: string;
  agent: string;
  turn: string;
  exec: string; // hook tool_use_id of a shell command = rollout item.id = OTLP call_id
  call: string; // function_call call_id (OTLP), real call id of a collaboration tool (hook)
}

function rawIds(next: () => string): Raw {
  return {
    session: next(),
    agent: next(),
    turn: next(),
    exec: `exec-${next()}`,
    call: `call_${next().replaceAll("-", "")}`,
  };
}

const MAIN_NAME = (r: Raw): string => `rollout-2026-09-29T21-55-28-${r.session}.jsonl`;
const CHILD_NAME = (r: Raw): string => `rollout-2026-09-29T21-55-43-${r.agent}.jsonl`;
const HOME = "/Users/dev/.codex/sessions/2026/09/29";

function rolloutFiles(r: Raw): AnonymizeSourceFile[] {
  const line = (o: Rec): string => `${JSON.stringify(o)}\n`;
  const t = (sec: number): string =>
    new Date(Date.parse("2026-09-30T03:55:28.000Z") + sec * 1000).toISOString();
  return [
    {
      relPath: `2026/09/29/${MAIN_NAME(r)}`,
      content:
        line({
          timestamp: t(0),
          type: "session_meta",
          payload: { id: r.session, session_id: r.session, cwd: "/Users/dev/p" },
        }) +
        line({
          timestamp: t(1),
          type: "event_msg",
          payload: { type: "task_started", turn_id: r.turn, root_turn_id: r.turn },
        }) +
        line({
          timestamp: t(2),
          type: "response_item",
          payload: { type: "function_call", call_id: r.call, name: "shell", arguments: SECRET },
        }) +
        line({
          timestamp: t(3),
          type: "event_msg",
          payload: {
            type: "item_completed",
            turn_id: r.turn,
            thread_id: r.session,
            item: { id: r.exec, type: "CommandExecution", stdout: SECRET },
          },
        }),
    },
    {
      relPath: `2026/09/29/${CHILD_NAME(r)}`,
      content:
        line({
          timestamp: t(4),
          type: "session_meta",
          payload: { id: r.agent, session_id: r.session, parent_thread_id: r.session },
        }) +
        line({
          timestamp: t(5),
          type: "event_msg",
          payload: { type: "task_started", turn_id: r.turn },
        }),
    },
  ];
}

function hookPayloads(r: Raw): Rec[] {
  const base = {
    session_id: r.session,
    turn_id: r.turn,
    transcript_path: `${HOME}/${MAIN_NAME(r)}`,
    cwd: "/Users/dev/p",
    model: "gpt-6-astra",
    permission_mode: "bypassPermissions",
  };
  return [
    { ...base, hook_event_name: "SessionStart", source: "startup" },
    { ...base, hook_event_name: "UserPromptSubmit", prompt: SECRET },
    {
      ...base,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: SECRET },
      tool_use_id: r.exec,
    },
    {
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: SECRET },
      tool_response: SECRET,
      tool_use_id: r.exec,
    },
    {
      ...base,
      hook_event_name: "PreToolUse",
      tool_name: "collaborationspawn_agent",
      tool_input: { message: SECRET, timeout_ms: 5 },
      tool_use_id: r.call,
    },
    { ...base, hook_event_name: "SubagentStart", agent_id: r.agent, agent_type: "default" },
    {
      ...base,
      hook_event_name: "SubagentStop",
      agent_id: r.agent,
      agent_type: "default",
      agent_transcript_path: `${HOME}/${CHILD_NAME(r)}`,
      stop_hook_active: false,
      last_assistant_message: SECRET,
    },
    {
      session_id: r.session,
      transcript_path: `${HOME}/${MAIN_NAME(r)}`,
      cwd: "/Users/dev/p",
      hook_event_name: "SessionEnd",
      reason: "other",
    },
  ];
}

function otlpLogs(r: Raw): Rec {
  const common = [
    s("event.timestamp", "2026-09-30T03:55:29.000Z"),
    s("conversation.id", r.session),
    s("app.version", "0.158.0"),
    s("auth_mode", "Chatgpt"),
    s("originator", "codex_exec"),
    s("user.account_id", SECRET),
    s("user.email", "someone@example.com"),
    s("terminal.type", SECRET),
    s("model", "gpt-6-astra"),
    s("slug", "gpt-6-astra"),
  ];
  const record = (attrs: Rec[], body: unknown = null): Rec => ({
    timeUnixNano: "1790740529000000000",
    observedTimeUnixNano: "1790740529000000001",
    severityNumber: 9,
    severityText: "INFO",
    body,
    attributes: attrs,
    droppedAttributesCount: 0,
    flags: 0,
    traceId: "",
    spanId: "",
    eventName: `event ${SECRET}`,
  });
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            s("service.name", "codex_exec"),
            s("service.version", "0.158.0"),
            s("host.name", "secret-host"),
            s("env", "dev"),
          ],
        },
        scopeLogs: [
          {
            scope: { name: "codex_otel.log_only", version: "", attributes: [] },
            logRecords: [
              record([
                s("event.name", "codex.user_prompt"),
                s("prompt", SECRET),
                s("prompt_length", "9"),
                ...common,
              ]),
              record([
                s("event.name", "codex.tool_result"),
                s("tool_name", "exec_command"),
                s("call_id", r.exec),
                s("duration_ms", "194"),
                s("success", "true"),
                s("agent_name", "/root/secret_child"),
                s("arguments", SECRET),
                s("output", SECRET),
                s("mcp_server", ""),
                ...common,
              ]),
              record([
                s("event.name", "codex.tool_result"),
                s("tool_name", "wait_agent"),
                s("call_id", r.call),
                ...common,
              ]),
              record([
                s("event.name", "codex.websocket_connect"),
                s("endpoint", `wss://secret.example/${SECRET}`),
                ...common,
              ]),
              record(
                [
                  s("event.name", "codex.agent_communication"),
                  s("communication_id", "comm-1"),
                  s("sender_thread_id", r.session),
                  s("receiver_thread_id", r.agent),
                  s("content", SECRET),
                ],
                { stringValue: SECRET },
              ),
              record([s("event.name", "codex.something_new"), s("novel_key", SECRET)]),
            ],
          },
        ],
      },
    ],
  };
}

function attrs(rec: unknown): Map<string, string> {
  const m = new Map<string, string>();
  for (const kv of (rec as Rec).attributes as Rec[]) {
    const v = (kv.value as Rec).stringValue;
    if (typeof v === "string") m.set(kv.key as string, v);
  }
  return m;
}
const records = (body: Rec): Rec[] =>
  ((body.resourceLogs as Rec[])[0]!.scopeLogs as Rec[]).flatMap((sl) => sl.logRecords as Rec[]);

describe("Codex hook payloads", () => {
  test("every event passes its allowlist; content is markered, structure and ids survive", () => {
    // Covers: B0.T1 (R8)
    const r = rawIds(uuids(1));
    const ctx = new FixtureContext("demo", new IdRegistry(), 0);
    const out = hookPayloads(r).map((p) => anonymizeHookPayload(p, ctx));
    for (const o of out) expect(verifyHookPayload(o)).toEqual([]);
    const all = JSON.stringify(out);
    for (const raw of [SECRET, r.session, r.agent, r.turn, r.exec, r.call, "/Users/dev"]) {
      expect(all).not.toContain(raw);
    }
    const pre = out[2]!;
    expect(pre).toMatchObject({
      tool_name: "Bash",
      model: "gpt-6-astra",
      cwd: "/tmp/crow-fixture/demo",
    });
    expect(pre.tool_use_id).toMatch(/^id\d+$/);
    expect((pre.tool_input as Rec).command).toMatch(/^«str:\d+»$/);
    expect(out[4]!.tool_name).toBe("collaborationspawn_agent");
    expect((out[4]!.tool_input as Rec).timeout_ms).toBe(5);
    expect(out[6]!.stop_hook_active).toBe(false);
  });

  test("transcript_path is the rollout's own anonymized relative path under codex-home", () => {
    // Covers: B0.T3 (G5a)
    const r = rawIds(uuids(2));
    const ids = new IdRegistry();
    const offset = 5_000;
    const ctx = new FixtureContext("demo", ids, offset);
    const stop = anonymizeHookPayload(hookPayloads(r)[6]!, ctx);
    const files = anonymizeCodexFixture(rolloutFiles(r), { repo: "demo", ids, tsOffsetMs: offset });
    const [main, child] = files.map((f) => f.relPath).sort();
    const rels = files.map((f) => f.relPath);
    expect(rels).toContain(
      (stop.transcript_path as string).replace("/tmp/crow-fixture/codex-home/sessions/", ""),
    );
    expect(rels).toContain(
      (stop.agent_transcript_path as string).replace("/tmp/crow-fixture/codex-home/sessions/", ""),
    );
    expect(main).not.toBe(child);
  });

  test("verifyHookPayload flags a Codex payload that skipped the allowlist, by path and never by value", () => {
    // Covers: B0.T1
    const r = rawIds(uuids(3));
    const problems = verifyHookPayload(hookPayloads(r)[6]!);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).not.toContain(SECRET);
    expect(problems.join("\n")).not.toContain(r.session);
  });

  test("minRolloutPathMs reads the stamp of the rollout file name (null without one)", () => {
    // Covers: B0.T3
    const r = rawIds(uuids(4));
    expect(minRolloutPathMs(hookPayloads(r))).toBe(
      Date.parse("2026-09-29T21-55-28".replace(/T(\d+)-(\d+)-(\d+)/, "T$1:$2:$3") + ".000Z"),
    );
    expect(minRolloutPathMs([{ transcript_path: "/x/claude/s.jsonl" }])).toBeNull();
  });
});

describe("Codex OTLP logs", () => {
  test("names/enums/ids survive; identity, content, endpoints and child agent names are markers", () => {
    // Covers: B0.T2 (G3)
    const r = rawIds(uuids(5));
    const out = anonymizeOtlp(otlpLogs(r), new FixtureContext("demo", new IdRegistry(), 0));
    expect(verifyOtlpBody(out)).toEqual([]);
    const all = JSON.stringify(out);
    for (const raw of [
      SECRET,
      "someone@example.com",
      "secret-host",
      r.session,
      r.exec,
      r.call,
      "secret.example",
    ]) {
      expect(all).not.toContain(raw);
    }
    const [prompt, result, wait, ws, comm, unknown] = records(out);
    expect(Object.fromEntries(attrs(prompt))).toMatchObject({
      "event.name": "codex.user_prompt",
      "app.version": "0.158.0",
      prompt_length: "9",
    });
    expect(attrs(prompt).get("prompt")).toMatch(/^«str:\d+»$/);
    expect(attrs(prompt).get("user.email")).toMatch(/^«str:\d+»$/);
    expect(attrs(result).get("call_id")).toMatch(/^id\d+$/);
    expect(attrs(result).get("agent_name")).toMatch(/^«str:\d+»$/); // only `/root` is structural
    expect(attrs(result).get("mcp_server")).toBe("");
    expect(attrs(wait).get("tool_name")).toBe("wait_agent");
    expect(attrs(ws).get("endpoint")).toMatch(/^«str:\d+»$/);
    expect(attrs(comm).get("communication_id")).toMatch(/^id\d+$/);
    expect(attrs(unknown).get("event.name")).toMatch(/^«str:\d+»$/); // unknown Codex event
    expect(JSON.stringify(unknown)).toContain("«key:");
    expect((prompt as Rec).eventName).toMatch(/^«str:\d+»$/);
  });

  test("`/root` and `/responses` style values are kept", () => {
    // Covers: B0.T2
    const body = otlpLogs(rawIds(uuids(6)));
    const rec = records(body)[1]!;
    (rec.attributes as Rec[]).push(s("endpoint", "/responses"));
    const kv = (rec.attributes as Rec[]).find((a) => a.key === "agent_name")!;
    kv.value = { stringValue: "/root" };
    const out = records(anonymizeOtlp(body, new FixtureContext("demo")))[1]!;
    expect(attrs(out).get("agent_name")).toBe("/root");
    expect(attrs(out).get("endpoint")).toBe("/responses");
  });

  test("verifyOtlpBody flags the raw Codex body by path, never by value", () => {
    // Covers: B0.T2
    const r = rawIds(uuids(7));
    const problems = verifyOtlpBody(otlpLogs(r));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).not.toContain(SECRET);
    expect(problems.join("\n")).not.toContain(r.session);
  });

  test("mergeAndTrimLogs caps Codex noisy events (and the unnamed metrics-client log) only", () => {
    // Covers: B0.T2
    const rec = (name: string | null): Rec => ({
      attributes: name === null ? [] : [s("event.name", name)],
    });
    const body = (recs: Rec[]): Rec => ({
      resourceLogs: [{ scopeLogs: [{ logRecords: recs }] }],
    });
    const merged = mergeAndTrimLogs(
      [
        body([
          rec("codex.sse_event"),
          rec("codex.sse_event"),
          rec(null),
          rec(null),
          rec("codex.tool_result"),
          rec("codex.tool_result"),
        ]),
      ],
      1,
      true,
      CODEX_NOISY_EVENTS,
    );
    const names = records(merged).map((x) => attrs(x).get("event.name") ?? "(unnamed)");
    expect(names).toEqual([
      "codex.sse_event",
      "(unnamed)",
      "codex.tool_result",
      "codex.tool_result",
    ]);
    // default noisy set (Claude's) leaves unnamed and Codex records alone
    expect(records(mergeAndTrimLogs([body([rec(null), rec(null)])], 1, true))).toHaveLength(2);
  });
});

describe("shared registry across hook, OTLP and rollout (Codex)", () => {
  test("property: for random raw ids, every lane maps the same raw id to the same pseudonym", () => {
    // Covers: B0.T3 (G5a)
    for (let seed = 100; seed < 130; seed += 1) {
      const r = rawIds(uuids(seed));
      const ids = new IdRegistry();
      const offset = 12_345;
      const ctx = new FixtureContext("demo", ids, offset);
      const hooks = hookPayloads(r).map((p) => anonymizeHookPayload(p, ctx));
      const otlp = anonymizeOtlp(otlpLogs(r), ctx);
      const files = anonymizeCodexFixture(rolloutFiles(r), {
        repo: "demo",
        ids,
        tsOffsetMs: offset,
        extraIdKeys: ["turn_id", "root_turn_id", "thread_id"],
      });
      const rollout = files.flatMap((f) =>
        f.content
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Rec),
      );
      const meta = rollout
        .filter((l) => l.type === "session_meta")
        .map((l) => (l.payload as Rec).id);
      const started = rollout.find((l) => (l.payload as Rec).type === "task_started")!;
      const done = rollout.find((l) => (l.payload as Rec).type === "item_completed")!;
      const call = rollout.find((l) => (l.payload as Rec).type === "function_call")!;
      const otlpRecs = records(otlp);

      const pre = hooks[2]!;
      const stop = hooks[6]!;
      // shell command: hook exec-<id> = rollout item.id = OTLP call_id
      expect(pre.tool_use_id).toBe(((done.payload as Rec).item as Rec).id as string);
      expect(pre.tool_use_id).toBe(attrs(otlpRecs[1]).get("call_id") as string);
      // collaboration tool: hook call id = rollout function_call call_id = OTLP call_id
      expect(hooks[4]!.tool_use_id).toBe((call.payload as Rec).call_id as string);
      expect(hooks[4]!.tool_use_id).toBe(attrs(otlpRecs[2]).get("call_id") as string);
      // session / turn / agent
      expect(meta).toContain(pre.session_id as string);
      expect(attrs(otlpRecs[0]).get("conversation.id")).toBe(pre.session_id as string);
      expect(pre.turn_id).toBe((started.payload as Rec).turn_id as string);
      expect(meta).toContain(stop.agent_id as string);
      expect(attrs(otlpRecs[4]).get("receiver_thread_id")).toBe(stop.agent_id as string);
      expect(attrs(otlpRecs[4]).get("sender_thread_id")).toBe(pre.session_id as string);
      // nothing raw survives anywhere
      const all = JSON.stringify([hooks, otlp, files]);
      for (const raw of Object.values(r)) expect(all).not.toContain(raw);
      // rollout filename ids agree with session_meta ids
      expect(
        files.map((f) => f.relPath).some((p) => p.endsWith(`-${stop.agent_id as string}.jsonl`)),
      ).toBe(true);
    }
  });
});

describe("anonymizeCodexFixture: shared-context options", () => {
  test("defaults are unchanged: turn/thread ids are markers, ids private to the run", () => {
    // Covers: B0.T3
    const r = rawIds(uuids(8));
    const out = anonymizeCodexFixture(rolloutFiles(r), { repo: "demo" });
    const text = out.map((f) => f.content).join("");
    expect(text).not.toContain(r.turn);
    expect(text).toMatch(/"turn_id":"«str:\d+»"/);
    expect(text).toMatch(/"id":"id0"/);
  });

  test("tsOffsetMs replaces the epoch-derived offset; extraIdKeys pseudonymizes those keys only", () => {
    // Covers: B0.T3
    const r = rawIds(uuids(9));
    const files = rolloutFiles(r);
    const shifted = anonymizeCodexFixture(files, {
      repo: "demo",
      tsOffsetMs: 3_600_000,
      extraIdKeys: ["turn_id"],
    });
    const first = JSON.parse(shifted[0]!.content.split("\n")[0]!) as Rec;
    expect(first.timestamp).toBe("2026-09-30T04:55:28.000Z");
    const text = shifted.map((f) => f.content).join("");
    expect(text).toMatch(/"turn_id":"id\d+"/);
    expect(text).toMatch(/"root_turn_id":"«str:\d+»"/); // not in extraIdKeys
  });
});
