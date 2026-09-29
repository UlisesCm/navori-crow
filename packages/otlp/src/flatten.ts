/**
 * Flattens OTLP export requests (logs, traces, metrics) into `FlatOtelRecord`s.
 *
 * Provenance: rewritten from navori-harness
 * `packages/cli/src/lib/audit/collect.ts` @ ba6322c1 (`attrScalar`,
 * `collectAttributes`, `msFromUnixNano`, `eventNameOf` and the
 * `flattenOtlp` walk). Differences: it also flattens spans and metric points;
 * it keeps the raw name (no `claude_code.` prefix stripping); it does not drop
 * records without a session (R17 is the router's job); attribute scalars keep
 * their type; `*UnixNano` goes through `BigInt` whether it arrives as a string
 * or a number.
 *
 * Input is the OTLP/JSON shape, which the protobuf decoder also produces, so
 * this file is transport-agnostic. Attribute precedence: resource < scope <
 * record.
 */
import { createHash } from "node:crypto";
import type { FlatOtelRecord, OtelScalar, OtlpSignal } from "./types";

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** int64 as the JSON spec sends it (decimal string, sometimes a number): number if safe, else the string. */
function intAttr(v: unknown): OtelScalar | null {
  if (typeof v === "number")
    return Number.isSafeInteger(v) ? v : Number.isFinite(v) ? String(v) : null;
  if (typeof v !== "string" || !/^-?\d+$/.test(v)) return null;
  const big = BigInt(v);
  return big <= MAX_SAFE && big >= -MAX_SAFE ? Number(big) : v;
}

/** The scalar shapes an exporter emits; arrays, kvlists and bytes carry content and are skipped. */
function attrScalar(v: unknown): OtelScalar | null {
  if (!isRec(v)) return null;
  if (typeof v.stringValue === "string") return v.stringValue;
  if (v.intValue !== undefined) return intAttr(v.intValue);
  if (typeof v.boolValue === "boolean") return v.boolValue;
  if (typeof v.doubleValue === "number") return v.doubleValue;
  return null;
}

/** Collects `attributes: [{key, value}]` from one OTLP node into `into`. */
function collectAttributes(node: unknown, into: Map<string, OtelScalar>): void {
  if (!isRec(node) || !Array.isArray(node.attributes)) return;
  for (const attr of node.attributes) {
    if (!isRec(attr) || typeof attr.key !== "string") continue;
    const value = attrScalar(attr.value);
    if (value !== null) into.set(attr.key, value);
  }
}

/** Nanoseconds since the epoch (decimal string or number) → ms, via `BigInt`. `null` when absent, zero or invalid. */
function msFromUnixNano(v: unknown): number | null {
  const raw = typeof v === "string" || typeof v === "number" ? String(v) : null;
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const ms = Number(BigInt(raw) / 1_000_000n);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** The event name from `event.name`, the record's `eventName`, or a string body — first non-empty wins. */
function logNameOf(record: Rec, attrs: Map<string, OtelScalar>): string {
  const fromAttr = attrs.get("event.name");
  const fromField = record.eventName;
  const fromBody =
    isRec(record.body) && typeof record.body.stringValue === "string"
      ? record.body.stringValue
      : "";
  const candidates = [
    typeof fromAttr === "string" ? fromAttr : "",
    typeof fromField === "string" ? fromField : "",
    fromBody,
  ];
  return candidates.map((c) => c.trim()).find((c) => c !== "") ?? "";
}

function enumIs(v: unknown, num: number, name: string): boolean {
  return v === num || v === name;
}

/** sha1 over a canonical form (sorted attrs) — the `l:` identity of a record. */
function hashOf(r: Omit<FlatOtelRecord, "hash">): string {
  const attrs = Object.entries(r.attrs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonical = JSON.stringify([
    r.signal,
    r.name,
    r.ts,
    r.endTs ?? null,
    attrs,
    r.service,
    r.scope,
    r.value ?? null,
    r.temporality ?? null,
    r.status ?? null,
  ]);
  return createHash("sha1").update(canonical).digest("hex");
}

export interface FlattenOptions {
  /** Fallback timestamp (epoch ms) for records that carry none. Defaults to `Date.now()`. */
  now?: number;
}

export interface FlattenResult {
  records: FlatOtelRecord[];
  /** Malformed entries dropped inside a well-formed envelope. */
  discarded: number;
}

interface Layout {
  root: string;
  scopes: string;
  items: string;
}

const LAYOUT: Record<OtlpSignal, Layout> = {
  logs: { root: "resourceLogs", scopes: "scopeLogs", items: "logRecords" },
  traces: { root: "resourceSpans", scopes: "scopeSpans", items: "spans" },
  metrics: { root: "resourceMetrics", scopes: "scopeMetrics", items: "metrics" },
};

interface Frame {
  attrs: Map<string, OtelScalar>;
  service: string | null;
  scope: string | null;
  now: number;
}

function logRecord(item: Rec, f: Frame): FlatOtelRecord {
  const attrs = new Map(f.attrs);
  collectAttributes(item, attrs);
  const declared = attrs.get("event.timestamp");
  const declaredMs = typeof declared === "string" ? Date.parse(declared) : Number.NaN;
  const ts = Number.isFinite(declaredMs)
    ? declaredMs
    : (msFromUnixNano(item.timeUnixNano) ?? msFromUnixNano(item.observedTimeUnixNano) ?? f.now);
  return finish({
    signal: "log",
    name: logNameOf(item, attrs),
    ts,
    attrs: Object.fromEntries(attrs),
    service: f.service,
    scope: f.scope,
  });
}

function spanRecord(item: Rec, f: Frame): FlatOtelRecord {
  const attrs = new Map(f.attrs);
  collectAttributes(item, attrs);
  const endTs = msFromUnixNano(item.endTimeUnixNano);
  const code = isRec(item.status) ? item.status.code : undefined;
  return finish({
    signal: "span",
    name: typeof item.name === "string" ? item.name : "",
    ts: msFromUnixNano(item.startTimeUnixNano) ?? f.now,
    ...(endTs !== null ? { endTs } : {}),
    attrs: Object.fromEntries(attrs),
    service: f.service,
    scope: f.scope,
    status: enumIs(code, 1, "STATUS_CODE_OK")
      ? "ok"
      : enumIs(code, 2, "STATUS_CODE_ERROR")
        ? "error"
        : "unset",
  });
}

/** One record per gauge/sum number point; histograms and summaries are not flattened. */
function metricRecords(item: Rec, f: Frame, out: FlatOtelRecord[]): number {
  const name = typeof item.name === "string" ? item.name : "";
  let discarded = 0;
  for (const series of [item.gauge, item.sum]) {
    if (!isRec(series) || !Array.isArray(series.dataPoints)) continue;
    const t = series.aggregationTemporality;
    const temporality = enumIs(t, 1, "AGGREGATION_TEMPORALITY_DELTA")
      ? "delta"
      : enumIs(t, 2, "AGGREGATION_TEMPORALITY_CUMULATIVE")
        ? "cumulative"
        : undefined;
    for (const point of series.dataPoints) {
      if (!isRec(point)) {
        discarded++;
        continue;
      }
      const value = point.asDouble !== undefined ? point.asDouble : intAttr(point.asInt);
      const num =
        typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
      if (!Number.isFinite(num)) {
        discarded++;
        continue;
      }
      const attrs = new Map(f.attrs);
      collectAttributes(point, attrs);
      out.push(
        finish({
          signal: "metric",
          name,
          ts:
            msFromUnixNano(point.timeUnixNano) ?? msFromUnixNano(point.startTimeUnixNano) ?? f.now,
          attrs: Object.fromEntries(attrs),
          service: f.service,
          scope: f.scope,
          value: num,
          ...(temporality ? { temporality } : {}),
        }),
      );
    }
  }
  return discarded;
}

function finish(r: Omit<FlatOtelRecord, "hash">): FlatOtelRecord {
  return { ...r, hash: hashOf(r) };
}

/**
 * Flattens one decoded export request. Returns `null` when `body` is not an
 * envelope of that signal (no `resourceLogs`/`resourceSpans`/`resourceMetrics`
 * array), so the caller can answer 400; `discarded` counts malformed entries
 * inside a well-formed envelope.
 */
export function flattenOtlp(
  signal: OtlpSignal,
  body: unknown,
  opts: FlattenOptions = {},
): FlattenResult | null {
  const layout = LAYOUT[signal];
  if (!isRec(body) || !Array.isArray(body[layout.root])) return null;
  const records: FlatOtelRecord[] = [];
  let discarded = 0;
  const now = opts.now ?? Date.now();

  for (const rs of body[layout.root] as unknown[]) {
    if (!isRec(rs)) continue;
    const resourceAttrs = new Map<string, OtelScalar>();
    collectAttributes(rs.resource, resourceAttrs);
    const svc = resourceAttrs.get("service.name");
    const scopes = Array.isArray(rs[layout.scopes]) ? (rs[layout.scopes] as unknown[]) : [];

    for (const sc of scopes) {
      if (!isRec(sc)) continue;
      const attrs = new Map(resourceAttrs);
      collectAttributes(sc.scope, attrs);
      const scopeName = isRec(sc.scope) && typeof sc.scope.name === "string" ? sc.scope.name : null;
      const frame: Frame = {
        attrs,
        service: typeof svc === "string" ? svc : null,
        scope: scopeName,
        now,
      };
      const items = Array.isArray(sc[layout.items]) ? (sc[layout.items] as unknown[]) : [];

      for (const item of items) {
        if (!isRec(item)) {
          discarded++;
          continue;
        }
        if (signal === "logs") records.push(logRecord(item, frame));
        else if (signal === "traces") records.push(spanRecord(item, frame));
        else discarded += metricRecords(item, frame, records);
      }
    }
  }
  return { records, discarded };
}
