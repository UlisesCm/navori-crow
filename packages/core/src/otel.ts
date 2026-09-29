export type OtelScalar = string | number | boolean;

/**
 * One flattened OTLP record (design.md § Contracts). Declared in core so
 * adapters can consume it without depending on `@crow/otlp`.
 */
export interface FlatOtelRecord {
  signal: "log" | "span" | "metric";
  /** Raw name, prefix kept (D10). */
  name: string;
  /** Epoch ms. */
  ts: number;
  endTs?: number;
  /** Resource ∪ record attributes, record wins; unsafe int64 kept as string; transient. */
  attrs: Readonly<Record<string, OtelScalar>>;
  service: string | null;
  scope: string | null;
  value?: number;
  temporality?: "delta" | "cumulative";
  status?: "unset" | "ok" | "error";
  /** sha1 of the canonical record, the `l:` identity. */
  hash: string;
}
