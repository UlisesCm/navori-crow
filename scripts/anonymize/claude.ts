/**
 * Pure core of `scripts/anonymize-fixture.ts` for `--engine claude`
 * (design.md § `fixtures/` y `scripts/`, R11, R12; mitigates risk R2). Takes
 * a session's files in memory and returns anonymized files in memory — no
 * I/O, so it's unit-testable without touching a real transcript.
 *
 * Rules (design.md, verbatim): a small allowlist of structural keys keeps
 * their string values (derived from what `packages/adapters/claude/src/
 * map-line.ts` and `sidecar.ts` actually branch on); every other string is
 * replaced by a deterministic, sequential marker. Ids the adapter
 * correlates on (`uuid`, `sessionId`, `agentId`, tool-call ids, …) get a
 * consistent pseudonym instead of a marker, so cross-file correlation,
 * `message.id` dedupe and subagent linkage keep working after
 * anonymization. `cwd` is rewritten to `/tmp/crow-fixture/<repo>`,
 * `gitBranch` to a fixed marker, and all `timestamp` values are shifted by
 * one consistent offset so the earliest event lands at a fixed epoch and
 * relative ordering/deltas across files are preserved. Usage numbers,
 * booleans and `null` are left untouched. Object **keys** are anonymized
 * too, not just values: a key that isn't identifier-shaped (a real map
 * keyed by free text, e.g. `AskUserQuestion`'s `answers` map or a
 * `modelUsage`-shaped map keyed by model id — confirmed on a real
 * transcript, review round 3) gets a deterministic key marker, and its
 * value falls back to the default rule regardless of what the key was.
 */
import type { FileMatch, Rec } from "@crow/core";
import { arr, isRec } from "@crow/core";
import type { IdPseudonymizer } from "./shared";
import { IdRegistry } from "./shared";

/** One file to anonymize, already classified by `claudeAdapter.matches`. */
export interface AnonymizeSourceFile {
  match: FileMatch;
  /** Original path relative to the watch root — only used to fix a deterministic traversal order. */
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
  /**
   * Shared id registry: pass the same one to `anonymizeHookPayload`/`anonymizeOtlp` so one raw id
   * maps to one pseudonym across the transcript, hook and OTLP lanes of a session. Default: private.
   */
  ids?: IdPseudonymizer;
  /** Explicit timestamp offset (ms), overriding the "earliest event lands on `epochIso`" default. */
  tsOffsetMs?: number;
}

const DEFAULT_EPOCH_ISO = "2026-01-01T00:00:00.000Z";
const FIXTURE_GIT_BRANCH = "fixture-branch";

/**
 * Keys whose string values the adapter correlates identity by — replaced by
 * a consistent pseudonym (same input value → same output value everywhere
 * in the fixture, including inside the task-notification's XML-ish text and
 * in file names).
 */
const ID_KEYS = new Set([
  "uuid",
  "parentUuid",
  "sessionId",
  "agentId",
  "id", // message.id, and a tool_use content block's own id (== a later tool_result's tool_use_id)
  "requestId",
  "tool_use_id",
  "toolUseId", // sidecar's spawn-call id (design.md: sidecar's `toolUseId` field)
  "promptId",
]);

/**
 * Keys whose string values the adapter branches on (design.md's structural
 * allowlist) — kept verbatim, GLOBALLY (any key with this name, wherever it
 * sits). Derived from `map-line.ts`/`sidecar.ts`: `parsed.type`/`subtype`
 * (event classification, including the `KNOWN_NO_EVENT_TYPES` set and
 * `compact_boundary`), `message.role`/`model`/`stop_reason`, content-block
 * `type`, `input.subagent_type`, `toolUseResult.status`/`resolvedModel`,
 * `origin.kind`, `promptSource`, sidecar's `agentType`.
 * `version`/`userType`/`entrypoint`/`permissionMode`/`level` aren't read by
 * this adapter but are the same kind of enum/version string (never free
 * text), so they're allowlisted too for a realistic, non-corrupting
 * fixture.
 *
 * `name` is deliberately **not** here: unlike every key above, a bare
 * `"name"` isn't unambiguous — a tool_use content block's `name` (e.g.
 * `"Bash"`) is structural, but nothing rules out an unrelated object
 * elsewhere in a real transcript using the same key for actual free text.
 * It's allowlisted with path context instead, in {@link anonymizeRecord}.
 */
const ALLOWLISTED_STRING_KEYS = new Set([
  "type",
  "subtype",
  "role",
  "model",
  "resolvedModel",
  "stop_reason",
  "version",
  "status",
  "userType",
  "entrypoint",
  "permissionMode",
  "level",
  "promptSource",
  "kind",
  "agentType",
  "subagent_type",
  // `attachment.commandMode` (cc-2.1.281): enum, e.g. "task-notification" — `mapAttachment` branches
  // on it exactly like `origin.kind`.
  "commandMode",
]);

/**
 * A key is "identifier-shaped" when it looks like a fixed JSON Schema field
 * name (`ASCII letter/`_`/`$`, then up to 63 more of letter/digit/`_`/`$`/
 * `-`) — every field name `map-line.ts`/`sidecar.ts` reads matches this
 * (`sessionId`, `tool_use_id`, `agentType`, …). Real Claude Code data can
 * put free text in *key position*, not just value position — confirmed
 * against a real transcript (review round 3): `AskUserQuestion`'s result
 * carries an `answers` map keyed by the full question sentence, and a
 * `modelUsage`-shaped map is keyed by a model id string like
 * `"claude-opus-5-5[1m]"`. Neither `map-line.ts` nor `sidecar.ts` reads any
 * map keyed this way (both only ever destructure fixed field names), so
 * there's nothing to preserve — every non-identifier key is replaced by a
 * deterministic {@link AnonCtx.keyMarker}, fail-closed, and its value is
 * anonymized with the default (non-allowlisted, non-id) rule regardless of
 * what the original key was, via {@link anonymizeNode}.
 */
export const IDENTIFIER_KEY_RE = /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/;

/**
 * A tool-call id used AS an object key (cc-2.1.285's `wireToolInputs` is a map keyed by `tool_use_id`).
 * It is identifier-shaped, so without this rule it would survive verbatim and break cross-lane id
 * equality; it gets the same pseudonym as the id in value position.
 */
const TOOL_USE_ID_KEY_RE = /^toolu_[A-Za-z0-9]{1,58}$/;

/** Extracts `<tag>value</tag>`, mirroring `map-line.ts`'s private helper of the same name. */
function extractXmlTag(text: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(text);
  return match !== null ? match[1]!.trim() : null;
}

/** Mutable, run-scoped anonymization context: id pseudonyms, free-text markers, the timestamp offset. */
class AnonCtx {
  readonly newCwd: string;
  private markerSeq = 0;
  private keySeq = 0;
  private tsOffsetMs = 0;

  constructor(
    repo: string,
    private readonly ids: IdPseudonymizer,
  ) {
    this.newCwd = `/tmp/crow-fixture/${repo}`;
  }

  /** Same input value → same pseudonym, for every call across the whole fixture. */
  pseudonymize(value: string): string {
    return this.ids.pseudonymize(value);
  }

  /** A deterministic, sequential marker for a free-text string — not deduped by value (YAGNI: no test needs it). */
  marker(): string {
    const m = `«str:${this.markerSeq}»`;
    this.markerSeq += 1;
    return m;
  }

  /** A deterministic, sequential marker for a non-identifier-shaped object key. Globally unique → always
   * collision-safe within any one object (a strictly stronger guarantee than the per-object minimum). */
  keyMarker(): string {
    const m = `«key:${this.keySeq}»`;
    this.keySeq += 1;
    return m;
  }

  setTimestampOffsetMs(offsetMs: number): void {
    this.tsOffsetMs = offsetMs;
  }

  shiftTimestamp(iso: string): string {
    const parsed = Date.parse(iso);
    if (!Number.isFinite(parsed)) return this.marker();
    return new Date(parsed + this.tsOffsetMs).toISOString();
  }
}

/** Claude's own project-directory slugification: every `/` becomes `-`. */
function slugifyCwd(cwd: string): string {
  return cwd.split("/").join("-");
}

/**
 * Rebuilds a task-notification's XML-ish payload, keeping only what `map-line.ts` reads
 * (`<tool-use-id>` pseudonymized, `<status>` verbatim) and dropping everything else (e.g.
 * `<task-id>`, `<summary>`). Shared by both real shapes: the older `user` line's
 * `message.content` and cc-2.1.281's `attachment.prompt` ({@link anonymizeRecord}).
 */
function anonymizeTaskNotificationContent(text: string, ctx: AnonCtx): string {
  const toolUseId = extractXmlTag(text, "tool-use-id");
  const status = extractXmlTag(text, "status");
  if (toolUseId === null || status === null) return ctx.marker();
  return `<task-notification><tool-use-id>${ctx.pseudonymize(toolUseId)}</tool-use-id><status>${status}</status></task-notification>`;
}

function anonymizeField(key: string, value: unknown, ctx: AnonCtx): unknown {
  if (typeof value === "string") {
    if (key === "cwd") return ctx.newCwd;
    if (key === "gitBranch") return FIXTURE_GIT_BRANCH;
    if (key === "timestamp") return ctx.shiftTimestamp(value);
    if (ID_KEYS.has(key)) return ctx.pseudonymize(value);
    if (ALLOWLISTED_STRING_KEYS.has(key)) return value;
    return ctx.marker();
  }
  // number | boolean | null are untouched (design.md); objects/arrays recurse.
  return anonymizeNode(value, ctx);
}

/** `message.content` needs the line's `origin.kind` (a sibling of `message`) to detect a task-notification. */
function anonymizeMessage(message: Rec, line: Rec, ctx: AnonCtx): unknown {
  const origin = line.origin;
  const isTaskNotification = isRec(origin) && origin.kind === "task-notification";
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(message)) {
    out[k] =
      k === "content" && typeof v === "string" && isTaskNotification
        ? anonymizeTaskNotificationContent(v, ctx)
        : anonymizeField(k, v, ctx);
  }
  return out;
}

/**
 * Anonymizes a plain object node. Any key that isn't identifier-shaped
 * ({@link IDENTIFIER_KEY_RE}) is replaced by a deterministic key marker and
 * its value gets the default (non-allowlisted, non-id) rule — this must run
 * *before* every other per-key rule below, since none of them are safe to
 * apply to a key that turned out to be free text instead of a field name.
 *
 * For identifier-shaped keys: `name` is allowlisted only when this record
 * is itself a tool_use content block (`type === "tool_use"`, the only shape
 * `map-line.ts` reads a `name` field from) — everywhere else a `name` key
 * is ordinary free text and falls through to the default marker, same as
 * any other unlisted key. `prompt` gets the same task-notification treatment
 * as `message.content` when this record is itself a `queued_command`/
 * `task-notification` attachment (cc-2.1.281's `mapAttachment` reads it):
 * checked against the RAW `type`/`commandMode` fields, so key order in the
 * source JSON doesn't matter.
 */
function anonymizeRecord(node: Rec, ctx: AnonCtx): unknown {
  const isToolUseBlock = node.type === "tool_use";
  const isTaskNotificationAttachment =
    node.type === "queued_command" && node.commandMode === "task-notification";
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (TOOL_USE_ID_KEY_RE.test(k)) {
      out[ctx.pseudonymize(k)] = anonymizeNode(v, ctx);
    } else if (!IDENTIFIER_KEY_RE.test(k)) {
      out[ctx.keyMarker()] = anonymizeNode(v, ctx);
    } else if (k === "message" && isRec(v)) {
      out[k] = anonymizeMessage(v, node, ctx);
    } else if (k === "name" && isToolUseBlock && typeof v === "string") {
      out[k] = v;
    } else if (k === "prompt" && isTaskNotificationAttachment && typeof v === "string") {
      out[k] = anonymizeTaskNotificationContent(v, ctx);
    } else {
      out[k] = anonymizeField(k, v, ctx);
    }
  }
  return out;
}

/**
 * Anonymizes any JSON node. Fail-closed: a bare string (no enclosing key —
 * e.g. an array element) is *always* markered, never passed through,
 * regardless of nesting depth (arrays of arrays included).
 */
function anonymizeNode(node: unknown, ctx: AnonCtx): unknown {
  if (typeof node === "string") return ctx.marker(); // no key context: always markered, never passed through
  if (Array.isArray(node)) return arr(node).map((n) => anonymizeNode(n, ctx));
  if (isRec(node)) return anonymizeRecord(node, ctx);
  return node; // number | boolean | null
}

/** Scans every `timestamp` field across every jsonl file to find the earliest instant. */
export function findMinTimestampMs(sourceFiles: AnonymizeSourceFile[]): number | null {
  let min: number | null = null;
  for (const f of sourceFiles) {
    if (f.match.role === "sidecar") continue; // sidecars carry no `timestamp` field the adapter reads
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

/**
 * Anonymized invalid-JSON lines are dropped (design decision, documented in
 * the closing report): the `invalid-json` `ingest.error` path is already
 * exercised by the literal `fixtures/claude/navori-audit/` copy, so the
 * real anonymized fixture doesn't need to carry one too, and there's no
 * safe way to anonymize a line whose shape we can't parse.
 */
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

/** A sidecar `.meta.json` is a single JSON object, not JSON Lines. Corrupt/non-object content passes through
 * unchanged: `parseSidecarText` already tolerates that (returns `null`, keeps whatever was known). */
function anonymizeSidecarContent(content: string, ctx: AnonCtx): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  if (!isRec(parsed)) return content;
  return JSON.stringify(anonymizeNode(parsed, ctx));
}

function anonymizeRelPath(f: AnonymizeSourceFile, ctx: AnonCtx): string {
  const slug = slugifyCwd(ctx.newCwd);
  const sessionId = f.match.sessionId !== null ? ctx.pseudonymize(f.match.sessionId) : "unknown";
  if (f.match.role === "main") return `${slug}/${sessionId}.jsonl`;
  const agentId = f.match.agentId !== null ? ctx.pseudonymize(f.match.agentId) : "unknown";
  const ext = f.match.role === "agent" ? "jsonl" : "meta.json";
  return `${slug}/${sessionId}/subagents/agent-${agentId}.${ext}`;
}

/**
 * Anonymizes one Claude session (a main transcript plus its subagent
 * transcripts and sidecars). Deterministic: the same `sourceFiles` and
 * `opts` always produce the same output.
 */
export function anonymizeClaudeFixture(
  sourceFiles: AnonymizeSourceFile[],
  opts: AnonymizeOptions,
): AnonymizeOutputFile[] {
  const ctx = new AnonCtx(opts.repo, opts.ids ?? new IdRegistry());
  const epochMs = Date.parse(opts.epochIso ?? DEFAULT_EPOCH_ISO);
  const minMs = findMinTimestampMs(sourceFiles);
  ctx.setTimestampOffsetMs(opts.tsOffsetMs ?? (minMs !== null ? epochMs - minMs : 0));

  const sorted = [...sourceFiles].sort((a, b) => a.relPath.localeCompare(b.relPath));
  return sorted.map((f) => ({
    relPath: anonymizeRelPath(f, ctx),
    content:
      f.match.role === "sidecar"
        ? anonymizeSidecarContent(f.content, ctx)
        : anonymizeJsonlContent(f.content, ctx),
  }));
}
