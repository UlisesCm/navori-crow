/**
 * Allowlist anonymizer for Claude Code and Codex OTLP/JSON request bodies (logs, metrics, traces;
 * B0.T2, design D9/G3/G4). Pure: takes one parsed body and returns the anonymized one; no I/O.
 * The allowlists are the UNION of both engines (Claude `claude_code.*`, Codex `codex.*` from
 * `codex_exec` 0.158.0): a name or key only kept when one engine is known to emit it.
 *
 * Rules, fail-closed (a string survives only through one of the rules below, otherwise → marker):
 * - Names (log body `claude_code.<event>`, `event.name`, metric, span, span-event and scope names)
 *   are kept only when they belong to the known Claude Code name sets.
 * - Attribute KEYS are kept only when listed in {@link KNOWN_ATTR_KEYS}; an unknown key becomes a key
 *   marker and its value a marker.
 * - Attribute values: ids ({@link ID_ATTRS}) get the shared pseudonym; `event.timestamp` is shifted;
 *   enumerated attributes ({@link ENUM_ATTRS}) keep a structural token; numeric-as-string attributes
 *   ({@link NUMERIC_STRING_ATTRS}) keep digits; everything else (user/org/account identity, email,
 *   `terminal.type`, prompts, responses, argv, plugin names…) → marker. Numeric/bool value TYPES
 *   (`intValue`, `doubleValue`, `boolValue`) and their values are untouched.
 * - `traceId`/`spanId`/`parentSpanId` → consistent fake hex ids; all `*TimeUnixNano` shifted by the
 *   context's single offset (ordering and deltas survive).
 * - Metric `description`, unknown string fields and non-identifier object keys → marker / key marker.
 *
 * {@link verifyOtlpBody} is the post-condition the CLI uses to refuse to write a body that did not
 * go through this allowlist.
 */
import { arr, isRec } from "@crow/core";
import type { Rec } from "@crow/core";
import { IDENTIFIER_KEY_RE } from "./claude";
import { HOOK_EVENTS } from "./hooks";
import { ENUM_RE, MARKER_RE, PSEUDONYM_RE } from "./shared";
import type { FixtureContext } from "./shared";

/**
 * Log `event.name` values of Claude Code 2.1.285. All were seen in the raw B0 captures (runs 13/15/16/20/22),
 * but `api_error` and `compaction` are NOT in the committed `fixtures/otlp/claude` (captured once, not kept).
 */
export const LOG_EVENT_NAMES: ReadonlySet<string> = new Set([
  "user_prompt",
  "api_request",
  "api_error",
  "assistant_response",
  "tool_decision",
  "tool_result",
  "hook_registered",
  "hook_execution_start",
  "hook_execution_complete",
  "managed_settings_resolved",
  "mcp_server_connection",
  "plugin_loaded",
  "subagent_completed",
  "compaction",
]);
/** Log `event.name` values of Codex 0.158.0 (`codex_exec`); the sender puts them in `event.name` only (body is null). */
export const CODEX_LOG_EVENT_NAMES: ReadonlySet<string> = new Set([
  "codex.conversation_starts",
  "codex.startup_phase",
  "codex.user_prompt",
  "codex.api_request",
  "codex.websocket_connect",
  "codex.websocket_request",
  "codex.sse_event",
  "codex.turn_ttft",
  "codex.tool_decision",
  "codex.tool_result",
  "codex.agent_communication",
]);
const ALL_EVENT_NAMES: ReadonlySet<string> = new Set([
  ...LOG_EVENT_NAMES,
  ...CODEX_LOG_EVENT_NAMES,
]);
const LOG_BODIES = new Set([...LOG_EVENT_NAMES].map((e) => `claude_code.${e}`));

/**
 * Seen in the B0 captures: `session.count`, `cost.usage`, `token.usage`, `active_time.total`.
 * `lines_of_code.count` and `code_edit_tool.decision` were NOT seen: kept out of prudence (documented
 * Claude Code metrics) so a re-anonymized capture does not turn them into markers.
 */
const METRIC_NAMES: ReadonlySet<string> = new Set([
  "claude_code.session.count",
  "claude_code.cost.usage",
  "claude_code.token.usage",
  "claude_code.active_time.total",
  "claude_code.lines_of_code.count",
  "claude_code.code_edit_tool.decision",
]);
/** All seen in the B0 traces capture (run 20), including `gen_ai.request.attempt`. */
const SPAN_NAMES: ReadonlySet<string> = new Set([
  "claude_code.interaction",
  "claude_code.llm_request",
  "claude_code.tool",
  "claude_code.tool.blocked_on_user",
  "claude_code.tool.execution",
  "gen_ai.request.attempt",
]);
const SCOPE_NAMES: ReadonlySet<string> = new Set([
  "com.anthropic.claude_code",
  "com.anthropic.claude_code.events",
  "com.anthropic.claude_code.tracing",
  "codex_otel.log_only",
  "codex_otel.agent_communication",
  "codex_otel::metrics::client",
]);
const NAMES: ReadonlySet<string> = new Set([...METRIC_NAMES, ...SPAN_NAMES, ...SCOPE_NAMES]);

/** Attributes whose value is an id correlated with hook/transcript ids (or a per-request id). */
const ID_ATTRS: ReadonlySet<string> = new Set([
  "session.id",
  "prompt.id",
  "tool_use_id",
  "gen_ai.tool.call.id",
  "request_id",
  "client_request_id",
  "gen_ai.response.id",
  "message.uuid",
  "agent_id",
  // Codex: `conversation.id` = hook `session_id` = `session_meta.id`; `call_id` = rollout `call_id`
  "conversation.id",
  "call_id",
  "communication_id",
  "sender_thread_id",
  "receiver_thread_id",
]);
/** Attributes whose (string) value is an enumerated/structural token. */
const ENUM_ATTRS: ReadonlySet<string> = new Set([
  "service.name",
  "service.version",
  "event.name",
  "hook_event",
  "hook_name",
  "hook_type",
  "hook_source",
  "model",
  "final_model",
  "gen_ai.request.model",
  "gen_ai.system",
  "speed",
  "query_source",
  "query_source_safe",
  "agent.name",
  "agent_type",
  "agent.source",
  "decision",
  "source",
  "tool_name",
  "tool_name_safe",
  "tool_source",
  "status",
  "transport_type",
  "server_scope",
  "enabled_via",
  "start_type",
  "type",
  "success",
  "error_type",
  "stop_reason",
  "span.type",
  "llm_request.context",
  "parent.source",
  "language",
  "managed_settings.trigger",
  "managed_settings.source_behavior",
  "managed_settings.helper.state",
  "managed_settings.helper.applied",
  "plugin.scope",
  "safe_mode",
  "managed_only",
  "gen_ai.response.finish_reasons",
  // Codex (0.158.0)
  "provider_name",
  "reasoning_summary",
  "approval_policy",
  "sandbox_policy",
  "app.version",
  "auth_mode",
  "originator",
  "slug",
  "startup.phase",
  "startup.status",
  "event.kind",
  "model_reasoning_effort",
  "reasoning_effort",
  "tool_namespace",
  "auth.header_name",
  "auth.mode",
  "kind",
  "state",
  "env",
  "telemetry.sdk.language",
  "telemetry.sdk.name",
  "telemetry.sdk.version",
  "agent_name", // only `/root` survives, see enumValue
  "endpoint", // only `/path` survives, see enumValue
]);
/** Attributes Claude Code sends as a decimal STRING (`stringValue: "12"`). */
const NUMERIC_STRING_ATTRS: ReadonlySet<string> = new Set([
  "prompt_length",
  "duration_ms",
  "total_duration_ms",
  "num_hooks",
  "num_success",
  "num_blocking",
  "num_non_blocking_error",
  "num_cancelled",
  "stdout_chars",
  "additional_context_chars",
  "system_message_chars",
  "initial_user_message_chars",
  "num_outputs_persisted",
  "tool_input_size_bytes",
  "tool_result_size_bytes",
  "input_token_count",
  "output_token_count",
  "tool_token_count",
]);
/** Every attribute key below was seen in the raw B0 captures (Claude 2.1.285 and Codex 0.158.0, union of runs); any other key becomes a key marker. */
const KNOWN_ATTR_KEYS: ReadonlySet<string> = new Set([
  ...ID_ATTRS,
  ...ENUM_ATTRS,
  ...NUMERIC_STRING_ATTRS,
  "event.timestamp",
  "event.sequence",
  "user.id",
  "user.email",
  "user.account_uuid",
  "user.account_id",
  "organization.id",
  "terminal.type",
  "prompt",
  "response",
  "user_prompt",
  "response_length",
  "user_prompt_length",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "cost_usd",
  "cost_usd_micros",
  "ttft_ms",
  "first_content_ms",
  "attempt",
  "is_plugin",
  "is_built_in",
  "is_async",
  "model_swapped",
  "total_tokens",
  "total_tool_uses",
  "managed_settings.sources",
  "plugin.name",
  "marketplace.name",
  "plugin_id_hash",
  "has_hooks",
  "has_mcp",
  "host_owned_mcp",
  "skill_path_count",
  "command_path_count",
  "agent_path_count",
  "bash_command_class",
  "bash_argv0",
  "interaction.sequence",
  "interaction.duration_ms",
  "queued_sends",
  "host.arch",
  "os.type",
  "os.version",
  // Codex: identity/config/content (always markers) and typed numerics/bools
  "host.name",
  "mcp_servers",
  "mcp_server",
  "mcp_server_origin",
  "content",
  "arguments",
  "output",
  "http.response.status_code",
  "auth.header_attached",
  "auth.env_openai_api_key_present",
  "auth.env_codex_api_key_present",
  "auth.env_codex_api_key_enabled",
  "auth.env_refresh_token_url_override_present",
  "auth.retry_after_unauthorized",
  "auth.connection_reused",
  "cached_token_count",
  "cache_write_token_count",
  "reasoning_token_count",
  "tool_result_seq",
  "output_truncated",
]);
const TIME_KEYS: ReadonlySet<string> = new Set([
  "timeUnixNano",
  "observedTimeUnixNano",
  "startTimeUnixNano",
  "endTimeUnixNano",
]);
const HEX_ID_LEN: Readonly<Record<string, number>> = { traceId: 32, spanId: 16, parentSpanId: 16 };
const UNIT_RE = /^[A-Za-z0-9_.{}%/-]{0,32}$/;
const VERSION_RE = /^\d+(\.\d+){0,3}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const KEY_MARKER_RE = /^«key:\d+»$/;
const ENDPOINT_RE = /^\/[a-z_/]{1,40}$/;

/** Value of an enumerated attribute is kept only while it is a token; `hook_event` must be a known event. */
function enumValue(key: string, value: string, ctx: FixtureContext): string {
  if (key === "event.name") return ALL_EVENT_NAMES.has(value) ? value : ctx.marker();
  if (key === "agent_name") return value === "/root" ? value : ctx.marker(); // children are user-named
  if (key === "endpoint") return ENDPOINT_RE.test(value) ? value : ctx.marker();
  if (key === "hook_event") return HOOK_EVENTS.has(value) ? value : ctx.marker();
  if (key === "hook_name") {
    return /^[A-Za-z]+(:[A-Za-z0-9_.-]{1,40})?$/.test(value) ? value : ctx.marker();
  }
  return ENUM_RE.test(value) ? value : ctx.marker();
}

function stringAttrValue(key: string, value: string, ctx: FixtureContext): string {
  if (value === "") return ""; // carries nothing (Codex sends `mcp_server = ""` for built-in tools)
  if (ID_ATTRS.has(key)) return value === "" ? "" : ctx.ids.pseudonymize(value);
  if (key === "event.timestamp") return ctx.shiftIso(value);
  if (ENUM_ATTRS.has(key)) return enumValue(key, value, ctx);
  if (NUMERIC_STRING_ATTRS.has(key))
    return /^\d{1,15}(\.\d{1,9})?$/.test(value) ? value : ctx.marker();
  return ctx.marker();
}

/** An OTLP `AnyValue` for attribute `key`: strings follow the key policy, other value types are preserved. */
function anonymizeAnyValue(key: string, value: unknown, ctx: FixtureContext): unknown {
  if (!isRec(value)) return value;
  const out: Rec = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "stringValue" && typeof v === "string") out[k] = stringAttrValue(key, v, ctx);
    else if (k === "arrayValue" && isRec(v)) {
      out[k] = {
        ...v,
        values: arr(v.values).map((el) => anonymizeAnyValue(key, el, ctx)),
      };
    } else if (k === "kvlistValue" && isRec(v)) {
      out[k] = { ...v, values: arr(v.values).map((kv) => anonymizeKeyValue(kv, ctx)) };
    } else if (k === "bytesValue") out[k] = "";
    else if (k === "intValue" || k === "doubleValue" || k === "boolValue") out[k] = v;
    else out[IDENTIFIER_KEY_RE.test(k) ? k : ctx.keyMarker()] = anonymizeGeneric(k, v, ctx);
  }
  return out;
}

function anonymizeKeyValue(kv: unknown, ctx: FixtureContext): unknown {
  if (!isRec(kv)) return anonymizeGeneric("", kv, ctx);
  const rawKey = kv.key;
  const known = typeof rawKey === "string" && KNOWN_ATTR_KEYS.has(rawKey);
  const key = known ? rawKey : "";
  const out: Rec = {};
  for (const [k, v] of Object.entries(kv)) {
    if (k === "key") out[k] = known ? rawKey : ctx.keyMarker();
    else if (k === "value") out[k] = anonymizeAnyValue(key, v, ctx);
    else out[IDENTIFIER_KEY_RE.test(k) ? k : ctx.keyMarker()] = anonymizeGeneric(k, v, ctx);
  }
  return out;
}

/** Anonymizes one string-valued field by its (structural) field name. */
function anonymizeField(key: string, value: string, ctx: FixtureContext): string {
  if (value === "") return "";
  if (Object.hasOwn(HEX_ID_LEN, key)) {
    return /^[0-9a-f]+$/i.test(value) ? ctx.hexId(value.toLowerCase(), HEX_ID_LEN[key]!) : "";
  }
  if (TIME_KEYS.has(key)) return ctx.shiftNanos(value);
  if (key === "name") return NAMES.has(value) || ALL_EVENT_NAMES.has(value) ? value : ctx.marker();
  if (key === "unit") return UNIT_RE.test(value) ? value : ctx.marker();
  if (key === "version") return VERSION_RE.test(value) ? value : ctx.marker();
  if (key === "stringValue") return LOG_BODIES.has(value) ? value : ctx.marker(); // log body
  if (key === "severityText") return ENUM_RE.test(value) ? value : ctx.marker();
  return ctx.marker();
}

function anonymizeGeneric(key: string, node: unknown, ctx: FixtureContext): unknown {
  if (typeof node === "string") return anonymizeField(key, node, ctx);
  if (Array.isArray(node)) {
    if (key === "attributes") return node.map((kv) => anonymizeKeyValue(kv, ctx));
    return node.map((n) => anonymizeGeneric(key, n, ctx));
  }
  if (!isRec(node)) return node;
  const out: Rec = {};
  for (const [k, v] of Object.entries(node)) {
    out[IDENTIFIER_KEY_RE.test(k) ? k : ctx.keyMarker()] = anonymizeGeneric(k, v, ctx);
  }
  return out;
}

const ROOTS = ["resourceLogs", "resourceMetrics", "resourceSpans"] as const;

/** Anonymizes one OTLP/JSON export request. Throws on a body that is not an OTLP export request. */
export function anonymizeOtlp(body: unknown, ctx: FixtureContext): Rec {
  if (!isRec(body) || !ROOTS.some((r) => Array.isArray(body[r]))) {
    throw new Error(
      "not an OTLP/JSON export request (no resourceLogs/resourceMetrics/resourceSpans)",
    );
  }
  return anonymizeGeneric("", body, ctx) as Rec;
}

/** Signal name of an export request, from its root key. */
export function otlpSignal(body: Rec): "logs" | "metrics" | "traces" | null {
  if (Array.isArray(body.resourceLogs)) return "logs";
  if (Array.isArray(body.resourceMetrics)) return "metrics";
  if (Array.isArray(body.resourceSpans)) return "traces";
  return null;
}

/** Earliest instant (ms) found in a RAW body, over `*TimeUnixNano` and `event.timestamp` — to derive one offset. */
export function minOtlpTimeMs(body: unknown): number | null {
  let min: number | null = null;
  const seen = (ms: number): void => {
    if (Number.isFinite(ms) && (min === null || ms < min)) min = ms;
  };
  const walk = (node: unknown, key: string): void => {
    if (typeof node === "string") {
      if (TIME_KEYS.has(key) && /^[1-9]\d+$/.test(node)) seen(Number(BigInt(node) / 1_000_000n));
    } else if (Array.isArray(node)) node.forEach((n) => walk(n, key));
    else if (isRec(node)) {
      if (node.key === "event.timestamp" && isRec(node.value)) {
        const s = node.value.stringValue;
        if (typeof s === "string") seen(Date.parse(s));
      }
      for (const [k, v] of Object.entries(node)) walk(v, k);
    }
  };
  walk(body, "");
  return min;
}

/** Log event name of a (raw or anonymized) log record: the `event.name` attribute, if a string. */
function recordEventName(record: unknown): string | null {
  if (!isRec(record)) return null;
  for (const kv of arr(record.attributes)) {
    if (isRec(kv) && kv.key === "event.name" && isRec(kv.value)) {
      return typeof kv.value.stringValue === "string" ? kv.value.stringValue : null;
    }
  }
  return null;
}

/** Events that repeat with near-identical shape on every start-up/hook: capped by {@link trimNoisyLogs}. */
const NOISY_EVENTS = new Set([
  "hook_registered",
  "hook_execution_start",
  "hook_execution_complete",
  "mcp_server_connection",
  "plugin_loaded",
  "managed_settings_resolved",
]);

/** Codex logs that repeat with near-identical shape on every turn/request; `UNNAMED` = the metrics-client debug log. */
export const UNNAMED = "(unnamed)";
export const CODEX_NOISY_EVENTS: ReadonlySet<string> = new Set([
  "codex.conversation_starts",
  "codex.startup_phase",
  "codex.api_request",
  "codex.websocket_connect",
  "codex.websocket_request",
  "codex.sse_event",
  "codex.turn_ttft",
  UNNAMED,
]);

/**
 * Merges several RAW logs bodies into one and keeps at most `max` records per event name (only for
 * the `noisy` events when `onlyNoisy`, for every event otherwise). Records without an `event.name`
 * are counted only when `noisy` contains {@link UNNAMED}.
 */
export function mergeAndTrimLogs(
  bodies: Rec[],
  max: number,
  onlyNoisy: boolean,
  noisy: ReadonlySet<string> = NOISY_EVENTS,
): Rec {
  const counts = new Map<string, number>();
  const records: unknown[] = [];
  let first: Rec | null = null;
  for (const b of bodies) {
    for (const rl of arr(b.resourceLogs)) {
      if (!isRec(rl)) continue;
      for (const sl of arr(rl.scopeLogs)) {
        if (!isRec(sl)) continue;
        first ??= b;
        for (const rec of arr(sl.logRecords)) {
          const name = recordEventName(rec) ?? (noisy.has(UNNAMED) ? UNNAMED : null);
          if (name !== null && (!onlyNoisy || noisy.has(name))) {
            const n = counts.get(name) ?? 0;
            if (n >= max) continue;
            counts.set(name, n + 1);
          }
          records.push(rec);
        }
      }
    }
  }
  if (first === null) throw new Error("no log records to merge");
  const rl0 = arr(first.resourceLogs)[0] as Rec;
  const sl0 = arr(rl0.scopeLogs)[0] as Rec;
  return { resourceLogs: [{ ...rl0, scopeLogs: [{ ...sl0, logRecords: records }] }] };
}

/** Keeps the first `max` data points of a metric (any of `sum`/`gauge`/`histogram`). */
function capDataPoints(metric: unknown, max: number): unknown {
  if (!isRec(metric)) return metric;
  const out: Rec = { ...metric };
  for (const kind of ["sum", "gauge", "histogram"]) {
    const data = out[kind];
    if (isRec(data)) out[kind] = { ...data, dataPoints: arr(data.dataPoints).slice(0, max) };
  }
  return out;
}

/**
 * Merges several RAW metrics/traces bodies into one (same resource/scope as the first), keeping the
 * first metric per name / first span per name. Enough to show every name once.
 */
export function mergeFirstPerName(
  bodies: Rec[],
  signal: "metrics" | "traces",
  maxDataPoints = 4,
): Rec {
  const rootKey = signal === "metrics" ? "resourceMetrics" : "resourceSpans";
  const scopeKey = signal === "metrics" ? "scopeMetrics" : "scopeSpans";
  const itemKey = signal === "metrics" ? "metrics" : "spans";
  const seen = new Set<string>();
  const items: unknown[] = [];
  let first: Rec | null = null;
  for (const b of bodies) {
    for (const r of arr(b[rootKey])) {
      if (!isRec(r)) continue;
      for (const s of arr(r[scopeKey])) {
        if (!isRec(s)) continue;
        first ??= b;
        for (const item of arr(s[itemKey])) {
          const name = isRec(item) && typeof item.name === "string" ? item.name : "";
          if (seen.has(name)) continue;
          seen.add(name);
          items.push(signal === "metrics" ? capDataPoints(item, maxDataPoints) : item);
        }
      }
    }
  }
  if (first === null) throw new Error(`no ${signal} to merge`);
  const r0 = arr(first[rootKey])[0] as Rec;
  const s0 = arr(r0[scopeKey])[0] as Rec;
  return { [rootKey]: [{ ...r0, [scopeKey]: [{ ...s0, [itemKey]: items }] }] };
}

// --- post-condition -------------------------------------------------------------------------

function verifyAttrValue(key: string, value: unknown, path: string, out: string[]): void {
  if (!isRec(value)) return;
  for (const [k, v] of Object.entries(value)) {
    if (k === "stringValue" && typeof v === "string") {
      const problem = verifyAttrString(key, v);
      if (problem !== null) out.push(`${path}.stringValue(${key}): ${problem}`);
    } else if (k === "arrayValue" && isRec(v)) {
      arr(v.values).forEach((el, i) => verifyAttrValue(key, el, `${path}.arrayValue[${i}]`, out));
    } else if (k === "kvlistValue" && isRec(v)) {
      arr(v.values).forEach((kv, i) => verifyKeyValue(kv, `${path}.kvlist[${i}]`, out));
    } else if (k === "bytesValue") {
      if (v !== "") out.push(`${path}.bytesValue: not empty`);
    } else if (k !== "intValue" && k !== "doubleValue" && k !== "boolValue") {
      out.push(`${path}.${k}: unknown AnyValue member`);
    }
  }
}

function verifyAttrString(key: string, v: string): string | null {
  if (v === "" || MARKER_RE.test(v)) return null;
  if (ID_ATTRS.has(key)) return v === "" || PSEUDONYM_RE.test(v) ? null : "id is not a pseudonym";
  if (key === "event.timestamp") return ISO_RE.test(v) ? null : "not an ISO instant";
  if (key === "event.name") return ALL_EVENT_NAMES.has(v) ? null : "unknown event name";
  if (key === "agent_name") return v === "/root" ? null : "agent name outside the allowlist";
  if (key === "endpoint") return ENDPOINT_RE.test(v) ? null : "endpoint is not a path";
  if (key === "hook_event") return HOOK_EVENTS.has(v) ? null : "unknown hook event";
  if (ENUM_ATTRS.has(key)) return ENUM_RE.test(v) ? null : "enum value is not a token";
  if (NUMERIC_STRING_ATTRS.has(key)) return /^\d{1,15}(\.\d{1,9})?$/.test(v) ? null : "not numeric";
  return "string outside the allowlist";
}

function verifyKeyValue(kv: unknown, path: string, out: string[]): void {
  if (!isRec(kv)) {
    out.push(`${path}: attribute is not an object`);
    return;
  }
  const key = kv.key;
  const known = typeof key === "string" && KNOWN_ATTR_KEYS.has(key);
  if (!known && !(typeof key === "string" && KEY_MARKER_RE.test(key))) {
    out.push(`${path}.key: unknown attribute key`);
  }
  verifyAttrValue(known ? key : "", kv.value, `${path}.value`, out);
}

function verifyField(key: string, v: string, path: string, out: string[]): void {
  if (v === "" || MARKER_RE.test(v)) return;
  const bad = (why: string): void => void out.push(`${path}: ${why}`);
  if (Object.hasOwn(HEX_ID_LEN, key)) {
    if (!new RegExp(`^[0-9a-f]{${HEX_ID_LEN[key]}}$`).test(v)) bad("id is not a fake hex id");
  } else if (TIME_KEYS.has(key)) {
    if (!/^\d+$/.test(v)) bad("time is not digits");
  } else if (key === "name") {
    if (!NAMES.has(v) && !ALL_EVENT_NAMES.has(v)) bad("name outside the allowlist");
  } else if (key === "unit") {
    if (!UNIT_RE.test(v)) bad("unit is not a token");
  } else if (key === "version") {
    if (!VERSION_RE.test(v)) bad("version is not numeric");
  } else if (key === "stringValue") {
    if (!LOG_BODIES.has(v)) bad("log body outside the allowlist");
  } else if (key === "severityText") {
    if (!ENUM_RE.test(v)) bad("severity is not a token");
  } else bad("string outside the allowlist");
}

function verifyGeneric(key: string, node: unknown, path: string, out: string[]): void {
  if (typeof node === "string") verifyField(key, node, path, out);
  else if (Array.isArray(node)) {
    if (key === "attributes") node.forEach((kv, i) => verifyKeyValue(kv, `${path}[${i}]`, out));
    else node.forEach((n, i) => verifyGeneric(key, n, `${path}[${i}]`, out));
  } else if (isRec(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (!IDENTIFIER_KEY_RE.test(k) && !KEY_MARKER_RE.test(k)) out.push(`${path}: raw key`);
      verifyGeneric(k, v, `${path}.${k}`, out);
    }
  }
}

/**
 * Post-condition of {@link anonymizeOtlp}: returns the paths (never values) of every string that
 * would not have come out of the allowlist. Empty = safe to write.
 */
export function verifyOtlpBody(anonymized: Rec): string[] {
  const out: string[] = [];
  if (otlpSignal(anonymized) === null) out.push("$: not an OTLP export request");
  verifyGeneric("", anonymized, "$", out);
  return out;
}
