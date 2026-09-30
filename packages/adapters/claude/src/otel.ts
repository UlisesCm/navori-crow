/**
 * Claude Code OTel record → `CrowEvent`s (design.md § Mapeo OTel, D5, D6, D10, R12, R18, R24).
 * Pure and allowlist-based: every attribute read here is named; anything else in the record
 * (prompt text, tool details, raw request/response, user/org identity) is never looked at, so it
 * can't leak into an event. Shapes follow the B0 captures (`fixtures/otlp/claude`): numeric
 * attributes may arrive as strings (`duration_ms`, `success`), so reads go through `nStr`/`bool`.
 */
import type {
  CrowEventReported,
  CrowEventUsage,
  FlatOtelRecord,
  MatchSpec,
  OtelResult,
  PartialCrowEvent,
} from "@crow/core";
import { usageCallKey } from "./map-line";

const PREFIX = "claude_code.";
const EVENTS_SCOPE = "com.anthropic.claude_code";
const LOG_EVENTS: ReadonlySet<string> = new Set([
  "user_prompt",
  "tool_result",
  "tool_decision",
  "api_request",
]);
const MAX_NAME = 128;

const exact = (key: string, role: string): MatchSpec => ({ key, mode: "exact", role });

/** `claude_code.foo` → `foo`; names without the prefix pass through. */
function unprefixed(name: string): string {
  return name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name;
}

/** The log event name: the `event.name` attribute wins over the record body name. */
function logName(r: FlatOtelRecord): string {
  const ev = r.attrs["event.name"];
  return unprefixed(typeof ev === "string" && ev !== "" ? ev : r.name);
}

function sessionOf(r: FlatOtelRecord): string | null {
  const s = r.attrs["session.id"];
  return typeof s === "string" && s !== "" ? s : null;
}

function s(r: FlatOtelRecord, key: string): string | null {
  const v = r.attrs[key];
  return typeof v === "string" && v !== "" ? v : null;
}

/** A finite number from a numeric or numeric-string attribute (OTLP int64 travels as string). */
function nStr(r: FlatOtelRecord, key: string): number | undefined {
  const v = r.attrs[key];
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function bool(r: FlatOtelRecord, key: string): boolean | undefined {
  const v = r.attrs[key];
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

/**
 * Signature-based ownership (D10): a `claude_code.*` metric or span, or a log whose event name is
 * one Claude emits (with or without the prefix) or that comes from Claude's events scope — the
 * scope keeps Claude's other logs (`assistant_response`, `hook_execution_*`…) from being reported
 * as unattributable noise; `fromOtel` ignores them. Spans and logs also need `session.id`.
 */
export function claudeOwnsOtel(r: FlatOtelRecord): boolean {
  switch (r.signal) {
    case "metric":
      return r.name.startsWith(PREFIX);
    case "span":
      return r.name.startsWith(PREFIX) && sessionOf(r) !== null;
    case "log":
      return (
        sessionOf(r) !== null &&
        (LOG_EVENTS.has(logName(r)) || (r.scope ?? "").startsWith(EVENTS_SCOPE))
      );
  }
}

const IGNORED: OtelResult = { ok: true, events: [] };

/** Maps one flattened Claude OTel record. Never throws; unknown records map to no events. */
export function claudeFromOtel(r: FlatOtelRecord): OtelResult {
  const sessionId = sessionOf(r);
  if (sessionId === null) {
    return { ok: false, reason: "unattributable", detail: "claude record without session.id" };
  }
  const base = { sessionId, agentId: null, parentAgentId: null, ts: r.ts } as const;

  if (r.signal === "metric") return { ok: true, events: mapMetric(r, base) };
  if (r.signal === "span") return { ok: true, events: mapSpan(r, base) };

  switch (logName(r)) {
    case "user_prompt": {
      const promptId = s(r, "prompt.id");
      return {
        ok: true,
        events: [
          {
            ...base,
            kind: "prompt",
            ...(promptId !== null ? { match: exact(`prompt@main:${promptId}`, "otel") } : {}),
          },
        ],
      };
    }
    case "tool_result": {
      const callId = s(r, "tool_use_id");
      // D5: a record without the id its key needs can't fuse; it's dropped, not stored keyless.
      if (callId === null) return IGNORED;
      const ok = bool(r, "success") !== false;
      const ms = nStr(r, "duration_ms");
      return {
        ok: true,
        events: [
          {
            ...base,
            kind: ok ? "tool.post" : "tool.error",
            tool: {
              name: (s(r, "tool_name") ?? "unknown").slice(0, MAX_NAME),
              callId,
              ok,
              ...(ms !== undefined ? { ms, msSource: "engine" as const } : {}),
            },
            ...(ok ? {} : { error: { message: "tool failed" } }),
            match: exact(`tool-post:${callId}`, "otel"),
          },
        ],
      };
    }
    case "tool_decision":
      return { ok: true, events: mapDecision(r, base) };
    case "api_request":
      return { ok: true, events: mapApiRequest(r, base) };
    default:
      return IGNORED;
  }
}

interface Base {
  sessionId: string;
  agentId: null;
  parentAgentId: null;
  ts: number;
}

/** `tool_decision` → the `tool.pre` fact plus the `permission` fact, both keyed by `tool_use_id`. */
function mapDecision(r: FlatOtelRecord, base: Base): PartialCrowEvent[] {
  const callId = s(r, "tool_use_id");
  if (callId === null) return [];
  const raw = s(r, "decision");
  const decision: "allow" | "deny" | undefined =
    raw === "accept" ? "allow" : raw === "reject" ? "deny" : undefined;
  const decisionSource = s(r, "source")?.slice(0, MAX_NAME);
  const tool = {
    name: (s(r, "tool_name") ?? "unknown").slice(0, MAX_NAME),
    callId,
    ...(decision !== undefined ? { verdict: decision } : {}),
    ...(decisionSource !== undefined ? { decisionSource } : {}),
  };
  return [
    { ...base, kind: "tool.pre", tool, match: exact(`tool-pre:${callId}`, "otel") },
    {
      ...base,
      kind: "permission",
      tool: { name: tool.name, callId },
      permission: {
        ...(decision !== undefined ? { decision } : {}),
        ...(decisionSource !== undefined ? { decisionSource } : {}),
      },
      match: exact(`permission:${callId}`, "otel"),
    },
  ];
}

/**
 * `api_request` → `api.request` fact with the engine's numbers in `reported` (never summed) and,
 * when the call has a `request_id`, the candidate `otelUsage` for the D6 ledger. Without a
 * `request_id` there is no per-call key, so no candidate: OTel never counts what it can't dedupe.
 * Carries no `match` (an event with usage/reported must not, D5).
 */
function mapApiRequest(r: FlatOtelRecord, base: Base): PartialCrowEvent[] {
  const model = s(r, "model")?.slice(0, MAX_NAME);
  const input = nStr(r, "input_tokens");
  const output = nStr(r, "output_tokens");
  const cacheRead = nStr(r, "cache_read_tokens");
  const cacheCreation = nStr(r, "cache_creation_tokens");
  const costUsd = nStr(r, "cost_usd");
  const ms = nStr(r, "duration_ms");
  const reported: CrowEventReported = {
    metric: "api_request",
    ...(model !== undefined ? { model } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(ms !== undefined ? { ms } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheCreation !== undefined ? { cacheCreation } : {}),
  };
  const key = usageCallKey(s(r, "request_id"));
  const otelUsage: CrowEventUsage | undefined =
    key !== undefined
      ? {
          input: input ?? 0,
          output: output ?? 0,
          cacheRead: cacheRead ?? 0,
          cacheCreation: cacheCreation ?? 0,
          ...(model !== undefined ? { model } : {}),
        }
      : undefined;
  return [
    {
      ...base,
      kind: "api.request",
      reported,
      ...(otelUsage !== undefined ? { usageCallKey: key, otelUsage } : {}),
    },
  ];
}

/**
 * `claude_code.token.usage` / `cost.usage` → one `usage` event with `reported` only (D6: metrics
 * aggregate the same calls `api_request` covers, so they never count). Zero points are dropped.
 * ⚠ D10 groups the points of one request into a single event; a pure per-record map can't, so each
 * point is its own event and the consumer groups by (session, model, ts) if it needs to.
 */
function mapMetric(r: FlatOtelRecord, base: Base): PartialCrowEvent[] {
  const name = unprefixed(r.name);
  const value = r.value;
  if (value === undefined || !Number.isFinite(value) || value === 0) return [];
  const model = s(r, "model")?.slice(0, MAX_NAME);
  const common = {
    metric: name,
    ...(r.temporality !== undefined ? { temporality: r.temporality } : {}),
    ...(model !== undefined ? { model } : {}),
  };
  if (name === "cost.usage") {
    return [{ ...base, kind: "usage", reported: { ...common, costUsd: value } }];
  }
  if (name === "token.usage") {
    const type = s(r, "type");
    if (type === null) return [];
    return [
      { ...base, kind: "usage", reported: { ...common, byType: { [type.slice(0, 32)]: value } } },
    ];
  }
  return [];
}

/** Beta `claude_code.hook` span → an aggregate `hook` event (one span covers all hooks of a call). */
function mapSpan(r: FlatOtelRecord, base: Base): PartialCrowEvent[] {
  if (unprefixed(r.name) !== "hook") return [];
  const name = s(r, "hook_name");
  const phase = s(r, "hook_event");
  if (name === null || phase === null) return [];
  const ms = nStr(r, "duration_ms") ?? (r.endTs !== undefined ? r.endTs - r.ts : undefined);
  const blocking = (nStr(r, "num_blocking") ?? 0) > 0;
  return [
    {
      ...base,
      kind: "hook",
      hook: {
        name: name.slice(0, MAX_NAME),
        phase: phase.slice(0, MAX_NAME),
        aggregate: true,
        blocking,
        ...(ms !== undefined ? { ms } : {}),
      },
    },
  ];
}
