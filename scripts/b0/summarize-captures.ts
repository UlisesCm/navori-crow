#!/usr/bin/env bun
/**
 * Shapes-and-counts summary of a B0 capture dir (written by
 * `scripts/capture-receiver.ts`), safe to paste to someone who must not see
 * prompts or code: per event it prints key paths and value TYPES, never
 * values. The only values ever printed are event/span/metric names, the
 * `service.name` resource attribute, and content-type/encoding headers.
 *
 *   bun scripts/b0/summarize-captures.ts <captureDir>
 *   bun scripts/b0/summarize-captures.ts <captureDir> --transcript <file|dir> [--transcript ...] [--engine claude|codex]
 *
 * With `--transcript` it also runs the G5a id-equality check: for each id
 * pair, how many distinct ids were captured, how many the transcript has and
 * how many are in both (counts only, ids are never printed).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_DEPTH = 6;
const SAFE_KEY = /^[A-Za-z_][\w.-]{0,63}$/;
const SAFE_NAME = /^[\w.:/-]{1,80}$/;
/** Containers whose keys are user data: descend one level only. */
const OPAQUE_KEYS = new Set(["tool_input", "tool_response", "input", "output", "arguments"]);

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** path -> type -> count */
export type Shape = Map<string, Map<string, number>>;

function typeOf(v: Json): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function bump(shape: Shape, path: string, type: string): void {
  let types = shape.get(path);
  if (!types) {
    types = new Map();
    shape.set(path, types);
  }
  types.set(type, (types.get(type) ?? 0) + 1);
}

/** Adds the key paths and value types of `v` to `shape`. Never records values. */
export function addShape(shape: Shape, v: Json, path = "$", depth = 0, opaque = false): void {
  bump(shape, path, typeOf(v));
  if (depth >= MAX_DEPTH) return;
  if (Array.isArray(v)) {
    for (const item of v) addShape(shape, item, `${path}[]`, depth + 1, opaque);
    return;
  }
  if (v !== null && typeof v === "object") {
    for (const [k, child] of Object.entries(v)) {
      const key = SAFE_KEY.test(k) ? k : "<key>";
      const childOpaque = opaque || OPAQUE_KEYS.has(k);
      if (opaque) {
        bump(shape, `${path}.<key>`, typeOf(child));
        continue;
      }
      addShape(shape, child, `${path}.${key}`, depth + 1, childOpaque);
    }
  }
}

function safeName(v: unknown): string {
  return typeof v === "string" && SAFE_NAME.test(v) ? v : "(other)";
}

/** OTLP JSON attribute list -> `key -> value-type` (e.g. `stringValue`). */
function attrTypes(attrs: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(attrs)) return out;
  for (const a of attrs as Json[]) {
    if (a === null || typeof a !== "object" || Array.isArray(a)) continue;
    const key = a["key"];
    const val = a["value"];
    if (typeof key !== "string") continue;
    const kind =
      val !== null && typeof val === "object" && !Array.isArray(val)
        ? (Object.keys(val)[0] ?? "empty")
        : "?";
    out.set(SAFE_KEY.test(key) ? key : "<key>", kind);
  }
  return out;
}

function attrString(attrs: unknown, name: string): string | null {
  if (!Array.isArray(attrs)) return null;
  for (const a of attrs as Json[]) {
    if (a === null || typeof a !== "object" || Array.isArray(a)) continue;
    if (a["key"] !== name) continue;
    const val = a["value"];
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      const s = val["stringValue"];
      if (typeof s === "string") return s;
    }
  }
  return null;
}

interface Group {
  count: number;
  shape: Shape;
  attrs: Map<string, Map<string, number>>;
}

function group(groups: Map<string, Group>, name: string): Group {
  let g = groups.get(name);
  if (!g) {
    g = { count: 0, shape: new Map(), attrs: new Map() };
    groups.set(name, g);
  }
  return g;
}

function addAttrs(g: Group, attrs: unknown): void {
  for (const [k, t] of attrTypes(attrs)) {
    const m = g.attrs.get(k) ?? new Map<string, number>();
    m.set(t, (m.get(t) ?? 0) + 1);
    g.attrs.set(k, m);
  }
}

function asObj(v: Json | undefined): { [k: string]: Json } | null {
  return v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v) ? v : null;
}

function asArr(v: Json | undefined): Json[] {
  return Array.isArray(v) ? v : [];
}

/** Groups an OTLP JSON body's records by event / span / metric name. */
function addOtlp(
  groups: Map<string, Group>,
  services: Map<string, number>,
  signal: string,
  body: Json,
): void {
  const root = asObj(body);
  if (!root) return;
  const resKey =
    signal === "logs" ? "resourceLogs" : signal === "traces" ? "resourceSpans" : "resourceMetrics";
  const scopeKey =
    signal === "logs" ? "scopeLogs" : signal === "traces" ? "scopeSpans" : "scopeMetrics";
  const recKey = signal === "logs" ? "logRecords" : signal === "traces" ? "spans" : "metrics";
  for (const rs of asArr(root[resKey])) {
    const rsObj = asObj(rs);
    if (!rsObj) continue;
    const svc = attrString(asObj(rsObj["resource"])?.["attributes"], "service.name");
    if (svc !== null) services.set(safeName(svc), (services.get(safeName(svc)) ?? 0) + 1);
    for (const ss of asArr(rsObj[scopeKey])) {
      for (const rec of asArr(asObj(ss)?.[recKey])) {
        const r = asObj(rec);
        if (!r) continue;
        let name: string;
        if (signal === "logs") {
          name = `log:${safeName(attrString(r["attributes"], "event.name") ?? attrString(r["attributes"], "event_name"))}`;
        } else if (signal === "traces") {
          name = `span:${safeName(r["name"])}`;
        } else {
          name = `metric:${safeName(r["name"])}`;
        }
        const g = group(groups, name);
        g.count += 1;
        const { attributes, ...rest } = r;
        addAttrs(g, attributes);
        addShape(g.shape, rest as Json);
        if (signal === "metrics") {
          // Data-point attribute names/types live one level down.
          for (const kind of ["sum", "gauge", "histogram", "summary"]) {
            for (const dp of asArr(asObj(r[kind])?.["dataPoints"]))
              addAttrs(g, asObj(dp)?.["attributes"]);
          }
        }
      }
    }
  }
}

interface CaptureMeta {
  n: number;
  kind: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyBytes: number;
  bodyFile: string;
  decodedFile: string | null;
}

function readCaptures(dir: string): { meta: CaptureMeta; body: Buffer }[] {
  const out: { meta: CaptureMeta; body: Buffer }[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!/^\d{6}\.json$/.test(f)) continue;
    const meta = JSON.parse(readFileSync(join(dir, f), "utf8")) as CaptureMeta;
    const file = meta.decodedFile ?? meta.bodyFile;
    const p = join(dir, file);
    out.push({ meta, body: existsSync(p) ? readFileSync(p) : Buffer.alloc(0) });
  }
  return out;
}

function tryParse(body: Buffer): Json | undefined {
  try {
    return JSON.parse(body.toString("utf8")) as Json;
  } catch {
    return undefined;
  }
}

function fmtShape(shape: Shape, indent: string): string[] {
  return [...shape.entries()].map(
    ([path, types]) =>
      `${indent}${path}: ${[...types.entries()].map(([t, c]) => `${t}x${c}`).join(" | ")}`,
  );
}

/** Shapes-and-counts report for a capture dir. */
export function summarizeCaptures(dir: string): string {
  const caps = readCaptures(dir);
  const lines: string[] = [];
  const transport = new Map<string, number>();
  const groups = new Map<string, Group>();
  const services = new Map<string, number>();
  let opaque = 0;

  for (const { meta, body } of caps) {
    const ct = meta.headers["content-type"] ?? "-";
    const ce = meta.headers["content-encoding"] ?? "-";
    const tk = `${meta.method} ${safeName(meta.path)} content-type=${safeName(ct.split(";")[0])} content-encoding=${safeName(ce)}`;
    transport.set(tk, (transport.get(tk) ?? 0) + 1);
    const json = tryParse(body);
    if (json === undefined) {
      opaque += 1;
      continue;
    }
    const otlp = /^\/v1\/(logs|traces|metrics)$/.exec(meta.path);
    if (otlp) {
      addOtlp(groups, services, otlp[1]!, json);
      continue;
    }
    const obj = asObj(json);
    const evName = safeName(obj?.["hook_event_name"] ?? obj?.["hookEventName"]);
    const g = group(groups, `hook:${safeName(meta.path.split("/").pop())}:${evName}`);
    g.count += 1;
    addShape(g.shape, json);
  }

  lines.push(`captures: ${caps.length} (non-JSON bodies, e.g. protobuf: ${opaque})`);
  lines.push("transport:");
  for (const [k, c] of transport) lines.push(`  ${k}: ${c}`);
  if (services.size > 0) {
    lines.push("service.name:");
    for (const [k, c] of services) lines.push(`  ${k}: ${c}`);
  }
  for (const [name, g] of [...groups.entries()].sort()) {
    lines.push(`== ${name} x${g.count}`);
    if (g.attrs.size > 0) {
      lines.push("  attributes (key: valueType):");
      for (const [k, types] of g.attrs) {
        lines.push(`    ${k}: ${[...types.entries()].map(([t, c]) => `${t}x${c}`).join(" | ")}`);
      }
    }
    lines.push(...fmtShape(g.shape, "  "));
  }
  return lines.join("\n");
}

/* -------------------------------------------------------------------- */
/* G5a: id equality between captures and the run's transcript / rollout */
/* -------------------------------------------------------------------- */

export interface IdPair {
  label: string;
  /** Property names holding the id on the capture side (hook body key or OTLP attribute key). */
  captureKeys: string[];
  /** Property names holding the id on the transcript side; `tool_use.id` = the `id` of a `tool_use` block. */
  transcriptKeys: string[];
}

export const CLAUDE_PAIRS: IdPair[] = [
  {
    label: "tool_use_id <-> tool_use.id",
    captureKeys: ["tool_use_id"],
    transcriptKeys: ["tool_use.id"],
  },
  {
    label: "prompt_id <-> promptId",
    captureKeys: ["prompt_id", "prompt.id"],
    transcriptKeys: ["promptId"],
  },
  { label: "request_id <-> requestId", captureKeys: ["request_id"], transcriptKeys: ["requestId"] },
  { label: "agent_id <-> agentId", captureKeys: ["agent_id"], transcriptKeys: ["agentId"] },
];

export const CODEX_PAIRS: IdPair[] = [
  {
    label: "tool_use_id/call_id <-> call_id",
    captureKeys: ["tool_use_id", "call_id"],
    transcriptKeys: ["call_id"],
  },
  { label: "turn_id <-> turn_id", captureKeys: ["turn_id"], transcriptKeys: ["turn_id"] },
  {
    label: "session_id <-> id (session_meta)",
    captureKeys: ["session_id"],
    transcriptKeys: ["id"],
  },
];

type IdSets = Map<string, Set<string>>;

function addId(sets: IdSets, key: string, value: string): void {
  const s = sets.get(key) ?? new Set<string>();
  s.add(value);
  sets.set(key, s);
}

/** Collects ids under any of `keys` from a parsed JSON value (plain properties, OTLP attributes, tool_use blocks). */
export function collectIds(v: Json, keys: Set<string>, into: IdSets): void {
  if (Array.isArray(v)) {
    for (const item of v) collectIds(item, keys, into);
    return;
  }
  if (v === null || typeof v !== "object") return;
  if (keys.has("tool_use.id") && v["type"] === "tool_use" && typeof v["id"] === "string") {
    addId(into, "tool_use.id", v["id"]);
  }
  if (typeof v["key"] === "string" && keys.has(v["key"])) {
    const val = asObj(v["value"]);
    const s = val?.["stringValue"];
    if (typeof s === "string") addId(into, v["key"], s);
  }
  for (const [k, child] of Object.entries(v)) {
    if (keys.has(k) && typeof child === "string") addId(into, k, child);
    collectIds(child, keys, into);
  }
}

function jsonlFiles(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  const out: string[] = [];
  for (const e of readdirSync(path, { withFileTypes: true })) {
    const p = join(path, e.name);
    if (e.isDirectory()) out.push(...jsonlFiles(p));
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

/** Counts of matching ids per pair; ids themselves are never returned. */
export function checkIds(captureDir: string, transcripts: string[], pairs: IdPair[]): string {
  const capKeys = new Set(pairs.flatMap((p) => p.captureKeys));
  const trKeys = new Set(pairs.flatMap((p) => p.transcriptKeys));
  const hook: IdSets = new Map();
  const otel: IdSets = new Map();
  for (const { meta, body } of readCaptures(captureDir)) {
    const json = tryParse(body);
    if (json === undefined) continue;
    collectIds(json, capKeys, /^\/v1\//.test(meta.path) ? otel : hook);
  }
  const tr: IdSets = new Map();
  let trLines = 0;
  for (const root of transcripts) {
    for (const f of jsonlFiles(root)) {
      for (const line of readFileSync(f, "utf8").split("\n")) {
        if (line.trim() === "") continue;
        const parsed = tryParse(Buffer.from(line));
        if (parsed === undefined) continue;
        trLines += 1;
        collectIds(parsed, trKeys, tr);
      }
    }
  }
  const union = (sets: IdSets, keys: string[]): Set<string> =>
    new Set(keys.flatMap((k) => [...(sets.get(k) ?? [])]));
  const lines = [`G5a id equality (transcript records parsed: ${trLines})`];
  for (const p of pairs) {
    const t = union(tr, p.transcriptKeys);
    for (const [lane, sets] of [
      ["hook", hook],
      ["otel", otel],
    ] as const) {
      const c = union(sets, p.captureKeys);
      let matched = 0;
      for (const id of c) if (t.has(id)) matched += 1;
      lines.push(
        `  ${p.label} [${lane}]: captured=${c.size} transcript=${t.size} matched=${matched}`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * Claude transcript latency: for every `tool_use` block, ms between its
 * assistant record and the matching `tool_result` (numbers only). The span
 * brackets tool execution including synchronous hooks and permission waits, so
 * compare runs of the same script against each other.
 */
export function toolLatency(transcripts: string[]): string {
  const started = new Map<string, number>();
  const deltas: number[] = [];
  for (const root of transcripts) {
    for (const f of jsonlFiles(root)) {
      for (const line of readFileSync(f, "utf8").split("\n")) {
        const rec = asObj(tryParse(Buffer.from(line)));
        const ts = typeof rec?.["timestamp"] === "string" ? Date.parse(rec["timestamp"]) : NaN;
        if (!rec || Number.isNaN(ts)) continue;
        for (const block of asArr(asObj(rec["message"])?.["content"])) {
          const b = asObj(block);
          if (b?.["type"] === "tool_use" && typeof b["id"] === "string") started.set(b["id"], ts);
          if (b?.["type"] === "tool_result" && typeof b["tool_use_id"] === "string") {
            const t0 = started.get(b["tool_use_id"]);
            if (t0 !== undefined) deltas.push(ts - t0);
          }
        }
      }
    }
  }
  deltas.sort((a, b) => a - b);
  const pct = (p: number): number | string =>
    deltas.length === 0
      ? "n/a"
      : deltas[Math.min(deltas.length - 1, Math.ceil(p * deltas.length) - 1)]!;
  return `tool latency ms (tool_use -> tool_result): n=${deltas.length} p50=${pct(0.5)} p95=${pct(0.95)}`;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const dir = argv[0];
  if (!dir || dir.startsWith("--")) {
    console.error(
      "usage: summarize-captures.ts <captureDir> [--transcript <path>]... [--engine claude|codex]",
    );
    process.exit(2);
  }
  const transcripts: string[] = [];
  let engine = "claude";
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === "--transcript" && argv[i + 1]) transcripts.push(argv[(i += 1)]!);
    else if (argv[i] === "--engine" && argv[i + 1]) engine = argv[(i += 1)]!;
  }
  console.log(summarizeCaptures(dir));
  if (transcripts.length > 0) {
    console.log("");
    if (engine === "claude") console.log(toolLatency(transcripts));
    console.log(checkIds(dir, transcripts, engine === "codex" ? CODEX_PAIRS : CLAUDE_PAIRS));
  }
}
