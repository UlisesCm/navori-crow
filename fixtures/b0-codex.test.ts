/**
 * B0 Codex fixtures (hooks, OTLP, `0.158.0` session): (1) every string passes the anonymizers'
 * allowlist post-conditions — stricter than the generic "short token" rule of `hygiene.test.ts`;
 * (2) the 7 captured hook events are all present; (3) the protobuf `.bin` is the oracle's
 * re-encoding of the JSON and decodes to the same flattened records; (4) the session fixture keeps
 * the cross-lane id equalities of G5a (hook = OTLP = rollout), including the `exec-<id>` ↔
 * `item_completed` correspondence of shell commands.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Rec } from "../packages/core/src/narrow";
import { isRec } from "../packages/core/src/narrow";
import { flattenOtlp } from "../packages/otlp/src/flatten";
import { decodeOtlpProtobuf } from "../packages/otlp/src/protobuf";
import { CODEX_LOG_EVENT_NAMES, verifyOtlpBody } from "../scripts/anonymize/otlp";
import { verifyHookPayload } from "../scripts/anonymize/hooks";
import { encodeFixture } from "../scripts/encode-otlp-fixture";

const HERE = import.meta.dir;
const HOOKS_DIR = join(HERE, "codex", "hooks");
const OTLP_DIR = join(HERE, "otlp", "codex");
const SESSION_DIR = join(HERE, "codex", "0.158.0");

const readJson = (f: string): Rec => {
  const v: unknown = JSON.parse(readFileSync(f, "utf8"));
  if (!isRec(v)) throw new Error(`${f}: not an object`);
  return v;
};
const readJsonl = (f: string): Rec[] =>
  readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => {
      const v: unknown = JSON.parse(l);
      if (!isRec(v)) throw new Error(`${f}: line is not an object`);
      return v;
    });

/** The 7 hook events `codex exec` delivered in B0 (`PermissionRequest`, `PreCompact`, `PostCompact` did not fire). */
const CAPTURED_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
  "SessionEnd",
];

describe("fixtures/codex/hooks", () => {
  test("one payload per captured event, each passing the hook allowlist", () => {
    // Covers: B0.T1 (R8)
    const files = readdirSync(HOOKS_DIR).filter((f) => f.endsWith(".json"));
    expect(files.map((f) => f.replace(/\.json$/, "")).sort()).toEqual([...CAPTURED_EVENTS].sort());
    for (const f of files) {
      const payload = readJson(join(HOOKS_DIR, f));
      expect(payload.hook_event_name).toBe(f.replace(/\.json$/, ""));
      expect(verifyHookPayload(payload)).toEqual([]);
    }
  });
});

describe("fixtures/otlp/codex", () => {
  test("logs.json passes the OTLP allowlist and only carries codex_exec `codex.*` events", () => {
    // Covers: B0.T2, B0.T3 (D9)
    const json = readJson(join(OTLP_DIR, "logs.json"));
    expect(verifyOtlpBody(json)).toEqual([]);
    const flat = flattenOtlp("logs", json, { now: Date.parse("2026-01-01T00:00:00.000Z") });
    expect(flat).not.toBeNull();
    const names = new Set(
      (json.resourceLogs as Rec[]).flatMap((rl) =>
        (rl.scopeLogs as Rec[]).flatMap((sl) =>
          (sl.logRecords as Rec[]).flatMap((r) =>
            (r.attributes as Rec[])
              .filter((kv) => kv.key === "event.name")
              .map((kv) => (kv.value as Rec).stringValue as string),
          ),
        ),
      ),
    );
    expect([...names].sort()).toEqual([...CODEX_LOG_EVENT_NAMES].sort());
    expect(JSON.stringify(json)).toContain('"codex_exec"');
  });

  // Covers: B0.T3 (D9)
  test("logs.bin is up to date with logs.json and decodes to the same records", async () => {
    const bin = new Uint8Array(readFileSync(join(OTLP_DIR, "logs.bin")));
    expect(await encodeFixture("logs", OTLP_DIR)).toEqual(bin);
    const json = readJson(join(OTLP_DIR, "logs.json"));
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const fromBin = flattenOtlp("logs", decodeOtlpProtobuf("logs", bin), { now });
    const fromJson = flattenOtlp("logs", json, { now });
    expect(fromBin).not.toBeNull();
    expect(fromBin!.records.length).toBeGreaterThan(0);
    expect(fromBin).toEqual(fromJson);
  });

  test("only logs are fixtured (codex_exec sends no metrics/traces in B0)", () => {
    // Covers: B0.T2
    expect(existsSync(join(OTLP_DIR, "metrics.json"))).toBe(false);
    expect(existsSync(join(OTLP_DIR, "traces.json"))).toBe(false);
  });
});

describe("fixtures/codex/0.158.0 (session: hooks + OTLP + rollouts)", () => {
  const hooks = readJsonl(join(SESSION_DIR, "hooks.jsonl"));
  const logs = readJsonl(join(SESSION_DIR, "otlp-logs.jsonl"));

  const rolloutFiles: string[] = [];
  const walkDir = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walkDir(p);
      else if (e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) rolloutFiles.push(p);
    }
  };
  walkDir(SESSION_DIR);
  const rollouts = rolloutFiles.map((f) => readJsonl(f));

  /** Every string under `field` (plain property) anywhere in the rollouts. */
  function rolloutValues(field: string): Set<string> {
    const out = new Set<string>();
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) n.forEach(walk);
      else if (isRec(n)) {
        if (typeof n[field] === "string") out.add(n[field]);
        Object.values(n).forEach(walk);
      }
    };
    rollouts.forEach((r) => r.forEach(walk));
    return out;
  }

  /** `payload.item.id` of every `item_completed` event: what a Codex shell `tool_use_id` (`exec-…`) equals. */
  function itemIds(): Set<string> {
    const out = new Set<string>();
    for (const line of rollouts.flat()) {
      const p = line.payload;
      if (
        isRec(p) &&
        p.type === "item_completed" &&
        isRec(p.item) &&
        typeof p.item.id === "string"
      ) {
        out.add(p.item.id);
      }
    }
    return out;
  }

  /** `session_meta.payload.id` of every rollout (root thread first is not guaranteed). */
  function threadIds(): Set<string> {
    const out = new Set<string>();
    for (const line of rollouts.flat()) {
      if (
        line.type === "session_meta" &&
        isRec(line.payload) &&
        typeof line.payload.id === "string"
      ) {
        out.add(line.payload.id);
      }
    }
    return out;
  }

  function otlpValues(key: string): Set<string> {
    const out = new Set<string>();
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) n.forEach(walk);
      else if (isRec(n)) {
        if (n.key === key && isRec(n.value) && typeof n.value.stringValue === "string") {
          out.add(n.value.stringValue);
        }
        Object.values(n).forEach(walk);
      }
    };
    logs.forEach(walk);
    return out;
  }

  const hookValues = (k: string): Set<string> =>
    new Set(hooks.flatMap((h) => (typeof h[k] === "string" ? [h[k] as string] : [])));
  const both = (a: Set<string>, b: Set<string>): number => [...a].filter((x) => b.has(x)).length;

  test("every hook payload and OTLP body passes its allowlist, and two rollouts are present", () => {
    // Covers: B0.T1, B0.T2
    expect(hooks.length).toBeGreaterThan(0);
    for (const h of hooks) expect(verifyHookPayload(h)).toEqual([]);
    for (const b of logs) expect(verifyOtlpBody(b)).toEqual([]);
    expect(rolloutFiles.length).toBe(2);
  });

  test("session id is shared by the hook, OTLP `conversation.id` and rollout lanes (G5a)", () => {
    // Covers: B0.T3 (G5a)
    const session = hookValues("session_id");
    expect(session.size).toBe(1);
    expect(both(session, threadIds())).toBe(1);
    expect(both(session, otlpValues("conversation.id"))).toBe(1);
    expect(both(session, rolloutValues("session_id"))).toBe(1);
  });

  test("tool_use_id: shell `exec-<id>` equals item_completed item.id, collaboration ids equal call_id", () => {
    // Covers: B0.T3 (G5a)
    const h = hookValues("tool_use_id");
    expect(h.size).toBe(6);
    const items = itemIds();
    const calls = rolloutValues("call_id");
    expect([...h].every((id) => items.has(id) || calls.has(id))).toBe(true);
    // both correspondences occur: some hook ids are only item ids (Bash), some only call ids (spawn/wait)
    expect([...h].some((id) => items.has(id) && !calls.has(id))).toBe(true);
    expect([...h].some((id) => calls.has(id))).toBe(true);
  });

  test("OTLP call_id carries every rollout call_id AND every hook tool_use_id (shell `exec-<id>` too)", () => {
    // Covers: B0.T3 (G5a)
    const calls = rolloutValues("call_id");
    const otel = otlpValues("call_id");
    expect(calls.size).toBeGreaterThan(0);
    expect(both(calls, otel)).toBe(calls.size);
    const h = hookValues("tool_use_id");
    expect(both(h, otel)).toBe(h.size);
  });

  test("turn_id lines up between hooks and rollouts; OTLP has none", () => {
    // Covers: B0.T3 (G5a)
    const turns = hookValues("turn_id");
    expect(turns.size).toBeGreaterThan(0);
    expect(both(turns, rolloutValues("turn_id"))).toBe(turns.size);
    expect(otlpValues("turn_id").size).toBe(0);
  });

  test("agent_id is the subagent thread: rollout session_meta id, OTLP receiver_thread_id, agent_transcript_path", () => {
    // Covers: B0.T3 (G5a)
    const agents = hookValues("agent_id");
    expect(agents.size).toBe(1);
    expect(both(agents, threadIds())).toBe(1);
    expect(both(agents, otlpValues("receiver_thread_id"))).toBe(1);
    const [agent] = [...agents];
    expect(hookValues("agent_transcript_path").size).toBe(1);
    expect([...hookValues("agent_transcript_path")][0]).toMatch(new RegExp(`-${agent}\\.jsonl$`));
  });

  test("hook transcript paths point at the fixture's own rollout files", () => {
    // Covers: B0.T1, B0.T3
    const prefix = "/tmp/crow-fixture/codex-home/sessions/";
    const paths = new Set([
      ...hookValues("transcript_path"),
      ...hookValues("agent_transcript_path"),
    ]);
    expect(paths.size).toBe(2);
    for (const p of paths) {
      expect(p.startsWith(prefix)).toBe(true);
      expect(existsSync(join(SESSION_DIR, p.slice(prefix.length)))).toBe(true);
    }
  });
});
