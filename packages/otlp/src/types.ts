/** A scalar attribute value as flattened from OTLP (`AnyValue` string/bool/int/double). */
export type OtelScalar = string | number | boolean;

export type OtelSignal = "log" | "span" | "metric";

/**
 * One OTLP record (log record, span or metric data point) with its resource
 * and record attributes flattened. The transport (JSON or protobuf) is already
 * erased. Structurally identical to the `FlatOtelRecord` contract of
 * `specs/f2a-ingesta-activa/design.md` § Contracts.
 */
export interface FlatOtelRecord {
  signal: OtelSignal;
  /** Raw name, `claude_code.` prefix kept. Empty string when a log carries none. */
  name: string;
  /** Epoch milliseconds (via `BigInt` from `*UnixNano`). */
  ts: number;
  /** Spans only: end, epoch milliseconds. */
  endTs?: number;
  /** Resource ∪ record attributes; the record wins. An int64 beyond 2^53 stays a string. */
  attrs: Readonly<Record<string, OtelScalar>>;
  service: string | null;
  scope: string | null;
  /** Metric number points. */
  value?: number;
  temporality?: "delta" | "cumulative";
  /** Spans. */
  status?: "unset" | "ok" | "error";
  /** sha1 of the canonical record — the `l:` identity. */
  hash: string;
}

/** OTLP/JSON shape: what both the JSON body and the protobuf decoder produce. */
export type OtlpJson = { [key: string]: OtlpJsonValue };
export type OtlpJsonValue = string | number | boolean | null | OtlpJsonValue[] | OtlpJson;

export type OtlpSignal = "logs" | "traces" | "metrics";
