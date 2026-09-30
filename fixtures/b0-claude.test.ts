/**
 * B0 Claude fixtures (hooks, OTLP, `cc-2.1.285` session): (1) every string passes the anonymizers'
 * allowlist post-conditions — stricter than the generic "short token" rule of `hygiene.test.ts`;
 * (2) the 14 captured R8 events are all present; (3) the protobuf `.bin` files are the oracle's
 * re-encoding of the JSON and decode to the same flattened records; (4) the session fixture keeps
 * the cross-lane id equalities of G5a (hook = OTLP = transcript).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Rec } from "../packages/core/src/narrow";
import { isRec } from "../packages/core/src/narrow";
import { HOOK_EVENTS, verifyHookPayload } from "../scripts/anonymize/hooks";
import { verifyOtlpBody } from "../scripts/anonymize/otlp";
import { OTLP_SIGNALS, encodeFixture } from "../scripts/encode-otlp-fixture";
import { decodeOtlpProtobuf } from "../packages/otlp/src/protobuf";
import { flattenOtlp } from "../packages/otlp/src/flatten";

const HERE = import.meta.dir;
const HOOKS_DIR = join(HERE, "claude", "hooks");
const OTLP_DIR = join(HERE, "otlp", "claude");
const SESSION_DIR = join(HERE, "claude", "cc-2.1.285");

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

/** The 14 of the 15 R8 events captured in B0 (`PermissionDenied` was not reproducible in `-p` mode). */
const CAPTURED_EVENTS = [...HOOK_EVENTS].filter((e) => e !== "PermissionDenied");

describe("fixtures/claude/hooks", () => {
  test("one payload per captured R8 event, each passing the hook allowlist", () => {
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

describe("fixtures/otlp/claude", () => {
  for (const signal of OTLP_SIGNALS) {
    // Covers: B0.T2, B0.T3 (D9)
    test(`${signal}.json passes the OTLP allowlist`, () => {
      expect(verifyOtlpBody(readJson(join(OTLP_DIR, `${signal}.json`)))).toEqual([]);
    });

    // Covers: B0.T3 (D9)
    test(`${signal}.bin is up to date with ${signal}.json and decodes to the same records`, async () => {
      const bin = new Uint8Array(readFileSync(join(OTLP_DIR, `${signal}.bin`)));
      expect(await encodeFixture(signal, OTLP_DIR)).toEqual(bin);
      const json = readJson(join(OTLP_DIR, `${signal}.json`));
      const now = Date.parse("2026-01-01T00:00:00.000Z");
      const fromBin = flattenOtlp(signal, decodeOtlpProtobuf(signal, bin), { now });
      const fromJson = flattenOtlp(signal, json, { now });
      expect(fromBin).not.toBeNull();
      expect(fromBin!.records.length).toBeGreaterThan(0);
      expect(fromBin).toEqual(fromJson);
    });
  }
});

describe("fixtures/claude/cc-2.1.285 (session: hooks + OTLP + transcript)", () => {
  const hooks = readJsonl(join(SESSION_DIR, "hooks.jsonl"));
  const logs = readJsonl(join(SESSION_DIR, "otlp-logs.jsonl"));
  const metrics = readJsonl(join(SESSION_DIR, "otlp-metrics.jsonl"));

  test("every hook payload and OTLP body passes its allowlist", () => {
    // Covers: B0.T1, B0.T2
    expect(hooks.length).toBeGreaterThan(0);
    for (const h of hooks) expect(verifyHookPayload(h)).toEqual([]);
    for (const b of [...logs, ...metrics]) expect(verifyOtlpBody(b)).toEqual([]);
  });

  /** Every string value of attribute `key` across the log records. */
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

  function transcriptValues(field: string): Set<string> {
    const files: string[] = [];
    const walkDir = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walkDir(p);
        else if (
          e.name.endsWith(".jsonl") &&
          !["hooks.jsonl"].includes(e.name) &&
          !e.name.startsWith("otlp-")
        ) {
          files.push(p);
        }
      }
    };
    walkDir(SESSION_DIR);
    const out = new Set<string>();
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) n.forEach(walk);
      else if (isRec(n)) {
        if (typeof n[field] === "string") out.add(n[field]);
        Object.values(n).forEach(walk);
      }
    };
    for (const f of files) readJsonl(f).forEach(walk);
    return out;
  }

  const hookValues = (k: string): Set<string> =>
    new Set(hooks.flatMap((h) => (typeof h[k] === "string" ? [h[k] as string] : [])));
  const both = (a: Set<string>, b: Set<string>): number => [...a].filter((x) => b.has(x)).length;

  test("session ids are shared between the hook, OTLP and transcript lanes (G5a)", () => {
    // Covers: B0.T3 (G5a)
    expect(both(hookValues("session_id"), transcriptValues("sessionId"))).toBe(1);
    expect(both(otlpValues("session.id"), transcriptValues("sessionId"))).toBe(1);
    expect(both(hookValues("session_id"), otlpValues("session.id"))).toBe(1);
  });

  test("tool_use_id: every hook id also appears in OTLP and in the transcript", () => {
    // Covers: B0.T3 (G5a)
    const h = hookValues("tool_use_id");
    expect(h.size).toBeGreaterThan(0);
    expect(both(h, otlpValues("tool_use_id"))).toBe(h.size);
    expect(both(h, transcriptValues("id"))).toBe(h.size);
  });

  test("prompt_id, agent_id and request_id line up across lanes", () => {
    // Covers: B0.T3 (G5a)
    const prompts = hookValues("prompt_id");
    expect(both(prompts, otlpValues("prompt.id"))).toBe(prompts.size);
    expect(both(prompts, transcriptValues("promptId"))).toBe(prompts.size);
    const agents = hookValues("agent_id");
    expect(agents.size).toBeGreaterThan(0);
    expect(both(agents, transcriptValues("agentId"))).toBe(agents.size);
    const requests = otlpValues("request_id");
    expect(requests.size).toBeGreaterThan(0);
    expect(both(requests, transcriptValues("requestId"))).toBe(requests.size);
  });

  test("the fixture sandbox layout exists", () => {
    // Covers: B0.T1
    expect(existsSync(join(SESSION_DIR, "-tmp-crow-fixture-b0-toy"))).toBe(true);
  });
});
