/**
 * Allowlist anonymizer for Claude Code and Codex hook payloads (B0.T1, design R8). Pure: takes one
 * parsed payload and returns the anonymized one; no I/O. Codex payloads are the same shape family
 * (`session_id`, `turn_id`, `transcript_path`, `tool_use_id`, …) and go through the same rules; the
 * engine is told apart by the `transcript_path` (a `rollout-<ts>-<id>.jsonl` file name).
 *
 * Rules, fail-closed:
 * - Ids (`session_id`, `turn_id`, `prompt_id`, `tool_use_id`, `agent_id`, `request_id`, `background_tasks[].id`)
 *   get a pseudonym from the shared {@link IdPseudonymizer}, so the same raw id keeps matching the
 *   OTLP and transcript lanes of the same session (G5a).
 * - `cwd` → `/tmp/crow-fixture/<repo>`; `transcript_path`/`agent_transcript_path` → a synthetic path
 *   built from the pseudonymized ids (`<claudeHome>/projects/<slug>/<sid>.jsonl`), or, for a Codex
 *   rollout, `<codexHome>/sessions/YYYY/MM/DD/rollout-<shifted ts>-<pseudonym>.jsonl` — the very
 *   relative path the rollout anonymizer gives that file. A Codex `tool_use_id` (`exec-<uuid>` for
 *   shell commands, the real `call_id` for collaboration tools) is pseudonymized as a whole, so it
 *   equals the rollout's `item_completed.payload.item.id` / `call_id` pseudonym.
 * - A small set of enumerated keys keeps its value, but only while the value still looks like a
 *   structural token ({@link ENUM_RE}); `hook_event_name` must be one of the known hook events;
 *   `StopFailure.error` is a category, and is kept only while it looks like one (`snake_case`).
 * - Inside `tool_input`/`tool_response` (user data), EVERY string is a marker, whatever its key.
 * - Any other string (`prompt`, `last_assistant_message`, `error` of other events, `file_path`,
 *   `description`, unknown keys…) → marker. Non-identifier-shaped object keys → key marker.
 * - Numbers, booleans and `null` are untouched.
 *
 * {@link verifyHookPayload} is the post-condition the CLI uses to refuse to write a body that did
 * not go through this allowlist.
 */
import { arr, isRec } from "@crow/core";
import type { Rec } from "@crow/core";
import { IDENTIFIER_KEY_RE } from "./claude";
import { shiftedRolloutRelPath } from "./codex";
import { ENUM_RE, MARKER_RE, PSEUDONYM_RE } from "./shared";
import type { FixtureContext } from "./shared";

/** The 15 hook events of design R8 (plus nothing else: an unknown event name is a marker). */
export const HOOK_EVENTS: ReadonlySet<string> = new Set([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "InstructionsLoaded",
  "Stop",
  "StopFailure",
]);

const ID_KEYS: ReadonlySet<string> = new Set([
  "session_id",
  "turn_id",
  "prompt_id",
  "tool_use_id",
  "agent_id",
  "request_id",
  "id", // background_tasks[].id (opaque containers never reach this rule)
]);
/** Enumerated keys whose value is a structural token (kept while it matches {@link ENUM_RE}). */
const ENUM_KEYS: ReadonlySet<string> = new Set([
  "model",
  "tool_name",
  "permission_mode",
  "source",
  "reason",
  "load_reason",
  "memory_type",
  "agent_type",
  "trigger",
  "level",
  "type",
  "status",
]);
/** Containers of user data: every string below is a marker. */
const OPAQUE_KEYS: ReadonlySet<string> = new Set(["tool_input", "tool_response"]);
const STOP_FAILURE_CATEGORY_RE = /^[a-z][a-z_]{0,39}$/;
const FIXTURE_PREFIX = "/tmp/crow-fixture/";
const CODEX_ROLLOUT_PATH_RE =
  /^\/tmp\/crow-fixture\/codex-home\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-id\d+\.jsonl$/;

function slugify(path: string): string {
  return path.split("/").join("-");
}

/** Codex rollout path → its anonymized twin under the fixture's `codexHome`; `null` if not a rollout path. */
function codexTranscriptPath(raw: string, ctx: FixtureContext): string | null {
  const rel = shiftedRolloutRelPath(raw.split("/").pop() ?? "", ctx.ids, ctx.tsOffsetMs);
  return rel === null ? null : `${ctx.codexHome}/sessions/${rel}`;
}

function transcriptPath(payload: Rec, ctx: FixtureContext, agent: boolean): string {
  const sid = payload.session_id;
  if (typeof sid !== "string") return ctx.marker();
  const base = `${ctx.claudeHome}/projects/${slugify(ctx.cwd)}/${ctx.ids.pseudonymize(sid)}`;
  if (!agent) return `${base}.jsonl`;
  const aid = payload.agent_id;
  if (typeof aid !== "string") return ctx.marker();
  return `${base}/subagents/agent-${ctx.ids.pseudonymize(aid)}.jsonl`;
}

function anonymizeValue(
  key: string,
  value: unknown,
  ctx: FixtureContext,
  event: string | null,
  opaque: boolean,
): unknown {
  if (typeof value === "string") {
    if (opaque) return ctx.marker();
    if (ID_KEYS.has(key)) return ctx.ids.pseudonymize(value);
    if (key === "cwd") return ctx.cwd;
    if (key === "hook_event_name") return HOOK_EVENTS.has(value) ? value : ctx.marker();
    if (key === "error" && event === "StopFailure") {
      return STOP_FAILURE_CATEGORY_RE.test(value) ? value : ctx.marker();
    }
    if (ENUM_KEYS.has(key)) return ENUM_RE.test(value) ? value : ctx.marker();
    return ctx.marker();
  }
  return anonymizeNode(value, ctx, event, opaque);
}

function anonymizeNode(
  node: unknown,
  ctx: FixtureContext,
  event: string | null,
  opaque: boolean,
): unknown {
  if (typeof node === "string") return ctx.marker(); // no key context: never passed through
  if (Array.isArray(node)) return arr(node).map((n) => anonymizeNode(n, ctx, event, opaque));
  if (!isRec(node)) return node; // number | boolean | null
  const out: Rec = {};
  for (const [k, v] of Object.entries(node)) {
    if (!IDENTIFIER_KEY_RE.test(k)) out[ctx.keyMarker()] = anonymizeNode(v, ctx, event, opaque);
    else out[k] = anonymizeValue(k, v, ctx, event, opaque || OPAQUE_KEYS.has(k));
  }
  return out;
}

/** Anonymizes one hook payload (the JSON body Claude Code POSTs/pipes to a hook). */
export function anonymizeHookPayload(payload: Rec, ctx: FixtureContext): Rec {
  const eventRaw = payload.hook_event_name;
  const event = typeof eventRaw === "string" ? eventRaw : null;
  const out: Rec = {};
  for (const [k, v] of Object.entries(payload)) {
    if (!IDENTIFIER_KEY_RE.test(k)) out[ctx.keyMarker()] = anonymizeNode(v, ctx, event, false);
    else if ((k === "transcript_path" || k === "agent_transcript_path") && typeof v === "string") {
      out[k] = codexTranscriptPath(v, ctx) ?? transcriptPath(payload, ctx, k !== "transcript_path");
    } else out[k] = anonymizeValue(k, v, ctx, event, OPAQUE_KEYS.has(k));
  }
  return out;
}

/** Keeps the first payload of each hook event, in input order (a "one example per event" set). */
export function firstPerHookEvent(payloads: Rec[]): Rec[] {
  const seen = new Set<string>();
  const out: Rec[] = [];
  for (const p of payloads) {
    const e = p.hook_event_name;
    if (typeof e !== "string" || seen.has(e)) continue;
    seen.add(e);
    out.push(p);
  }
  return out;
}

function verifyString(
  key: string,
  value: string,
  event: string | null,
  opaque: boolean,
): string | null {
  if (MARKER_RE.test(value)) return null;
  if (opaque) return "unmarked string in tool_input/tool_response";
  if (ID_KEYS.has(key)) return PSEUDONYM_RE.test(value) ? null : "id is not a pseudonym";
  if (key === "cwd") return value.startsWith(FIXTURE_PREFIX) ? null : "cwd outside fixture root";
  if (key === "transcript_path" || key === "agent_transcript_path") {
    return (value.startsWith(`${FIXTURE_PREFIX}claude-home/projects/`) && !/\s/.test(value)) ||
      CODEX_ROLLOUT_PATH_RE.test(value)
      ? null
      : "path outside fixture root";
  }
  if (key === "hook_event_name") return HOOK_EVENTS.has(value) ? null : "unknown hook event";
  if (key === "error" && event === "StopFailure") {
    return STOP_FAILURE_CATEGORY_RE.test(value) ? null : "error is not a category";
  }
  if (ENUM_KEYS.has(key)) return ENUM_RE.test(value) ? null : "enum value is not a token";
  return "string outside the allowlist";
}

function verifyNode(
  key: string,
  node: unknown,
  path: string,
  event: string | null,
  opaque: boolean,
  out: string[],
): void {
  if (typeof node === "string") {
    const problem = verifyString(key, node, event, opaque);
    if (problem !== null) out.push(`${path}: ${problem}`);
  } else if (Array.isArray(node)) {
    node.forEach((el, i) => verifyNode(key, el, `${path}[${i}]`, event, opaque, out));
  } else if (isRec(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (!IDENTIFIER_KEY_RE.test(k) && !/^«key:\d+»$/.test(k)) out.push(`${path}: raw key`);
      verifyNode(k, v, `${path}.${k}`, event, opaque || OPAQUE_KEYS.has(k), out);
    }
  }
}

/**
 * Post-condition of {@link anonymizeHookPayload}: returns the paths (never values) of every string
 * that would not have come out of the allowlist. Empty = safe to write.
 */
export function verifyHookPayload(anonymized: Rec): string[] {
  const out: string[] = [];
  const e = anonymized.hook_event_name;
  const event = typeof e === "string" ? e : null;
  if (event === null || !HOOK_EVENTS.has(event)) out.push("$.hook_event_name: not a known event");
  verifyNode("$", anonymized, "$", event, false, out);
  return out;
}

/**
 * Earliest instant (ms) embedded in the Codex rollout paths of RAW payloads (the file name holds a
 * local-time stamp read as UTC, like the rollout anonymizer does) — to derive an offset when there
 * is no other clock (hooks carry none). `null` for Claude payloads.
 */
export function minRolloutPathMs(payloads: Rec[]): number | null {
  let min: number | null = null;
  for (const p of payloads) {
    for (const k of ["transcript_path", "agent_transcript_path"]) {
      const v = p[k];
      const m =
        typeof v === "string"
          ? /rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-[^/]+\.jsonl$/.exec(v)
          : null;
      if (m === null) continue;
      const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.000Z`);
      if (Number.isFinite(ms) && (min === null || ms < min)) min = ms;
    }
  }
  return min;
}
