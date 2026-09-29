/**
 * Pure core of `scripts/anonymize-fixture.ts` for `--engine codex`
 * (design.md § `fixtures/` y `scripts/`, § Evidencia: Codex CLI, R14, R16;
 * mitigates risk R2). Takes a run's rollout files in memory and returns
 * anonymized files in memory — no I/O, so it's unit-testable without
 * touching a real `~/.codex/sessions` tree.
 *
 * Rules (mirrors `scripts/anonymize/claude.ts`'s allowlist approach, adapted
 * to Codex's envelope `{timestamp, type, payload, ordinal?}`): every string
 * is markered by default. Ids the adapter (`packages/adapters/codex/src/
 * map-line.ts`) correlates on — `id` (thread id / assistant message id),
 * `session_id` (root thread), `parent_thread_id`, `forked_from_id`, `call_id` — get a
 * consistent pseudonym instead, shared across every file of one run, so
 * root↔fork↔thread links and tool call/output pairing survive
 * anonymization. The rollout filename's `<threadId>` gets the *same*
 * pseudonym as `session_meta.payload.id` for that file. `type`/subtype
 * strings (`session_meta`, `event_msg.token_count`, `response_item.message`,
 * content-block `type`, …), `model`, `cli_version`, `agent_role` and the
 * `other` literal (e.g. `"guardian"`) are the structural allowlist — kept
 * verbatim. `cwd` is rewritten to `/tmp/crow-fixture/<repo>`, and every
 * `timestamp` (including the one embedded in the rollout filename) is
 * shifted by one consistent offset so the earliest event lands at a fixed
 * epoch and relative ordering/deltas are preserved. Numbers, booleans and
 * `null` are always left untouched (usage numbers included). Object
 * **keys** are anonymized too: a key that isn't identifier-shaped gets a
 * deterministic key marker, mirroring the Claude anonymizer's lesson that
 * free text can hide in map keys.
 */
import type { Rec } from "@crow/core";
import { arr, isRec } from "@crow/core";

/** One rollout file to anonymize. `relPath` must already be in the canonical
 * `YYYY/MM/DD/rollout-<YYYY-MM-DDTHH-MM-SS>-<threadId>.jsonl` layout
 * (design.md § Evidencia: Codex CLI), relative to the sessions root. */
export interface AnonymizeSourceFile {
  relPath: string;
  content: string;
}

/** One anonymized file, ready to be written under the fixture's `--out` directory. */
export interface AnonymizeOutputFile {
  relPath: string;
  content: string;
}

export interface AnonymizeOptions {
  /** Folder name under `/tmp/crow-fixture/`, e.g. `navori-crow`. */
  repo: string;
  /** ISO instant the earliest event is shifted to. Default `2026-01-01T00:00:00.000Z`. */
  epochIso?: string;
  /** Keeps only the lines up to and including the Nth `event_msg.token_count` of each file (design.md
   * item 2: the 0.145.0 fixture is "recortado a sus primeros `token_count`"). No trimming when omitted. */
  maxTokenCounts?: number;
}

const DEFAULT_EPOCH_ISO = "2026-01-01T00:00:00.000Z";

/** Keys whose string values the adapter correlates identity by, across every file of one run. */
const ID_KEYS = new Set([
  "id", // session_meta.payload.id (thread id) and response_item.message.id
  "session_id", // session_meta.payload.session_id (root thread)
  "parent_thread_id", // thread_spawn.parent_thread_id
  "forked_from_id", // session_meta.payload.forked_from_id
  "call_id", // function_call/custom_tool_call/*_call_output.call_id
]);

/**
 * Keys whose string values `map-line.ts` branches on, or that are the same
 * kind of enum/version string — kept verbatim, globally. `type` covers the
 * envelope's own type, `payload.type` (event_msg subtype / response_item
 * subtype), and every content-block `type`. `agent_role` and `other` are
 * `source.subagent`'s two shapes (design.md § Evidencia: `thread_spawn` /
 * `other: "guardian"`).
 */
const ALLOWLISTED_STRING_KEYS = new Set([
  "type",
  "role",
  "model",
  "cli_version",
  "agent_role",
  "other",
]);

/** Same identifier-shaped test as `scripts/anonymize/claude.ts` (see its {@link IDENTIFIER_KEY_RE}
 * doc for the full rationale): a fixed JSON Schema field name never has spaces/punctuation. */
export const IDENTIFIER_KEY_RE = /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/;

/** `YYYY/MM/DD/rollout-<YYYY-MM-DDTHH-MM-SS>-<threadId>.jsonl`, anchored to the whole `relPath`
 * (mirrors `packages/adapters/codex/src/adapter.ts`'s `ROLLOUT_RE`). */
const ROLLOUT_RE =
  /^(\d{4})\/(\d{2})\/(\d{2})\/rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(.+)\.jsonl$/;

/** Mutable, run-scoped anonymization context: id pseudonyms, free-text markers, the timestamp offset. */
class AnonCtx {
  readonly newCwd: string;
  private readonly ids = new Map<string, string>();
  private idSeq = 0;
  private markerSeq = 0;
  private keySeq = 0;
  private tsOffsetMs = 0;

  constructor(repo: string) {
    this.newCwd = `/tmp/crow-fixture/${repo}`;
  }

  /** Same input value -> same pseudonym, for every call across the whole run (every file). */
  pseudonymize(value: string): string {
    const existing = this.ids.get(value);
    if (existing !== undefined) return existing;
    const pseudo = `id${this.idSeq}`;
    this.idSeq += 1;
    this.ids.set(value, pseudo);
    return pseudo;
  }

  /** A deterministic, sequential marker for a free-text string. */
  marker(): string {
    const m = `«str:${this.markerSeq}»`;
    this.markerSeq += 1;
    return m;
  }

  /** A deterministic, sequential marker for a non-identifier-shaped object key. */
  keyMarker(): string {
    const m = `«key:${this.keySeq}»`;
    this.keySeq += 1;
    return m;
  }

  setTimestampOffsetMs(offsetMs: number): void {
    this.tsOffsetMs = offsetMs;
  }

  /** Returns `null` when `iso` doesn't parse, so callers can fall back to a marker (fail-closed). */
  shiftTimestampMs(iso: string): number | null {
    const parsed = Date.parse(iso);
    return Number.isFinite(parsed) ? parsed + this.tsOffsetMs : null;
  }

  shiftTimestamp(iso: string): string {
    const shiftedMs = this.shiftTimestampMs(iso);
    return shiftedMs === null ? this.marker() : new Date(shiftedMs).toISOString();
  }
}

function anonymizeField(key: string, value: unknown, ctx: AnonCtx): unknown {
  if (typeof value === "string") {
    if (key === "cwd") return ctx.newCwd;
    if (key === "timestamp") return ctx.shiftTimestamp(value);
    if (ID_KEYS.has(key)) return ctx.pseudonymize(value);
    if (ALLOWLISTED_STRING_KEYS.has(key)) return value;
    return ctx.marker();
  }
  // number | boolean | null are untouched (usage numbers, ordinal, subagent_history_start_ordinal,
  // thread_spawn.depth all included); objects/arrays recurse.
  return anonymizeNode(value, ctx);
}

/**
 * Anonymizes a plain object node. Any key that isn't identifier-shaped is
 * replaced by a deterministic key marker and its value gets the default
 * (non-allowlisted, non-id) rule — checked *before* every other per-key
 * rule, same fail-closed order as the Claude anonymizer.
 *
 * `name` is allowlisted only when this record is itself a `function_call`/
 * `custom_tool_call` `response_item` payload (the tool's own name, e.g.
 * `"shell"`) — everywhere else `name` is ordinary free text, same precedent
 * as `scripts/anonymize/claude.ts`'s tool_use-only `name` allowlisting.
 */
function anonymizeRecord(node: Rec, ctx: AnonCtx): unknown {
  const isToolCall = node.type === "function_call" || node.type === "custom_tool_call";
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (!IDENTIFIER_KEY_RE.test(k)) {
      out[ctx.keyMarker()] = anonymizeNode(v, ctx);
    } else if (k === "name" && isToolCall && typeof v === "string") {
      out[k] = v;
    } else {
      out[k] = anonymizeField(k, v, ctx);
    }
  }
  return out;
}

/**
 * Anonymizes any JSON node. Fail-closed: a bare string (no enclosing key —
 * e.g. an array element) is *always* markered, never passed through.
 */
function anonymizeNode(node: unknown, ctx: AnonCtx): unknown {
  if (typeof node === "string") return ctx.marker();
  if (Array.isArray(node)) return arr(node).map((n) => anonymizeNode(n, ctx));
  if (isRec(node)) return anonymizeRecord(node, ctx);
  return node; // number | boolean | null
}

/** Scans every envelope's `timestamp` field across every file to find the earliest instant. */
function findMinTimestampMs(sourceFiles: AnonymizeSourceFile[]): number | null {
  let min: number | null = null;
  for (const f of sourceFiles) {
    for (const rawLine of f.content.split("\n")) {
      if (rawLine.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawLine);
      } catch {
        continue;
      }
      if (!isRec(parsed) || typeof parsed.timestamp !== "string") continue;
      const ms = Date.parse(parsed.timestamp);
      if (Number.isFinite(ms) && (min === null || ms < min)) min = ms;
    }
  }
  return min;
}

function isTokenCountLine(parsed: unknown): boolean {
  return isRec(parsed) && isRec(parsed.payload) && parsed.payload.type === "token_count";
}

/** Keeps only the lines up to and including the Nth `event_msg.token_count` line; a file with fewer
 * than `max` such lines is kept whole. No-op when `max` is `undefined`. */
function trimToMaxTokenCounts(content: string, max: number | undefined): string {
  if (max === undefined) return content;
  let count = 0;
  const kept: string[] = [];
  for (const rawLine of content.split("\n")) {
    if (rawLine.trim() === "") continue;
    kept.push(rawLine);
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (isTokenCountLine(parsed)) {
      count += 1;
      if (count >= max) break;
    }
  }
  return kept.length > 0 ? `${kept.join("\n")}\n` : "";
}

/** Anonymized invalid-JSON or non-object lines are dropped: there's no safe way to anonymize a shape
 * we can't parse, mirroring the Claude anonymizer's documented decision. */
function anonymizeJsonlContent(content: string, ctx: AnonCtx): string {
  const out: string[] = [];
  for (const rawLine of content.split("\n")) {
    if (rawLine.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (!isRec(parsed)) continue;
    out.push(JSON.stringify(anonymizeNode(parsed, ctx)));
  }
  return out.length > 0 ? `${out.join("\n")}\n` : "";
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Rewrites `YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl` with the shifted timestamp (both the directory
 * and the filename's embedded date) and the thread id's pseudonym — the same one used everywhere else
 * this thread id occurs (`session_meta.payload.id`, `parent_thread_id`, …), since both go through
 * {@link AnonCtx.pseudonymize}. */
function anonymizeRelPath(f: AnonymizeSourceFile, ctx: AnonCtx): string {
  const m = ROLLOUT_RE.exec(f.relPath);
  if (m === null) {
    throw new Error(
      `not a codex rollout relPath (expected YYYY/MM/DD/rollout-...jsonl): ${f.relPath}`,
    );
  }
  const [, , , , fy, fm, fd, fh, fmin, fsec, threadId] = m;
  const originalIso = `${fy}-${fm}-${fd}T${fh}:${fmin}:${fsec}.000Z`;
  const shiftedMs = ctx.shiftTimestampMs(originalIso);
  const shifted = new Date(shiftedMs ?? Date.parse(originalIso));
  const yyyy = shifted.getUTCFullYear();
  const MM = pad2(shifted.getUTCMonth() + 1);
  const DD = pad2(shifted.getUTCDate());
  const HH = pad2(shifted.getUTCHours());
  const mm = pad2(shifted.getUTCMinutes());
  const ss = pad2(shifted.getUTCSeconds());
  const pseudoThreadId = ctx.pseudonymize(threadId!);
  return `${yyyy}/${MM}/${DD}/rollout-${yyyy}-${MM}-${DD}T${HH}-${mm}-${ss}-${pseudoThreadId}.jsonl`;
}

/**
 * Anonymizes one Codex run (a main rollout plus any fork/subagent rollouts
 * that belong with it). Deterministic: the same `sourceFiles` and `opts`
 * always produce the same output.
 */
export function anonymizeCodexFixture(
  sourceFiles: AnonymizeSourceFile[],
  opts: AnonymizeOptions,
): AnonymizeOutputFile[] {
  const ctx = new AnonCtx(opts.repo);
  const trimmed = sourceFiles.map((f) => ({
    ...f,
    content: trimToMaxTokenCounts(f.content, opts.maxTokenCounts),
  }));
  const epochMs = Date.parse(opts.epochIso ?? DEFAULT_EPOCH_ISO);
  const minMs = findMinTimestampMs(trimmed);
  ctx.setTimestampOffsetMs(minMs !== null ? epochMs - minMs : 0);

  const sorted = [...trimmed].sort((a, b) => a.relPath.localeCompare(b.relPath));
  return sorted.map((f) => ({
    relPath: anonymizeRelPath(f, ctx),
    content: anonymizeJsonlContent(f.content, ctx),
  }));
}
