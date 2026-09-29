/**
 * Hand-written protobuf wire decoder for the OTLP export requests
 * (design.md D9). No runtime dependencies: `protobufjs` is a devDependency of
 * `@crow/scripts` only, used as a test oracle.
 *
 * Field numbers were verified against upstream opentelemetry-proto `main`
 * (common/v1/common.proto, resource/v1/resource.proto, logs/v1/logs.proto,
 * trace/v1/trace.proto, metrics/v1/metrics.proto) and are vendored, reduced to
 * the subset decoded here, in `scripts/otlp-proto/otlp-subset.proto`, which the
 * oracle loads with `protobufjs`. Upstream fields deliberately not decoded,
 * skipped as unknown: `AnyValue.string_value_strindex=8`,
 * `KeyValue.key_strindex=3`, `Resource.entity_refs=3`, `Span.events/links=11/13`,
 * `NumberDataPoint.exemplars=5`, `Metric.exponential_histogram/summary/metadata=10/11/12`.
 *
 * Only the fields the flattener reads are decoded; every other field, at any
 * level, is skipped by wire type. The output is the OTLP/JSON shape
 * (camelCase, int64 and fixed64 as decimal strings, ids as hex, bytes as
 * base64), so the JSON and protobuf transports converge on one flattener.
 *
 * Documented choices: a non-repeated message field seen twice keeps the last
 * occurrence (no merge), and so does the `AnyValue` oneof. A field whose wire
 * type does not match its schema is skipped like an unknown field.
 */
import type { OtlpJson, OtlpJsonValue, OtlpSignal } from "./types";

/** Malformed, truncated or over-limit protobuf. Maps to HTTP 400. */
export class ProtobufError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtobufError";
  }
}

/** Nesting limit for `AnyValue` (array/kvlist recursion). Depth 1 is the outermost value. */
export const MAX_ANY_VALUE_DEPTH = 32;
/**
 * Limit of `AnyValue`s decoded per request. A backstop only: the receiver's body-size cap (413,
 * D8) is the real bound on work per request.
 */
export const MAX_VALUES_PER_REQUEST = 1_000_000;

export interface DecodeLimits {
  maxDepth?: number;
  maxValues?: number;
}

interface Ctx {
  values: number;
  readonly maxDepth: number;
  readonly maxValues: number;
}

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;
const WIRE_FIXED32 = 5;

// ignoreBOM: a leading U+FEFF is content of the string, not an encoding mark to strip.
const utf8 = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

/** Cursor over one message's bytes. */
class Reader {
  pos = 0;
  private readonly view: DataView;
  constructor(readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  /** Unsigned varint of at most 10 bytes. */
  varint(): bigint {
    let result = 0n;
    for (let i = 0; i < 10; i++) {
      const byte = this.buf[this.pos++];
      if (byte === undefined) throw new ProtobufError("truncated varint");
      result |= BigInt(byte & 0x7f) << BigInt(7 * i);
      if ((byte & 0x80) === 0) return result;
    }
    throw new ProtobufError("varint longer than 10 bytes");
  }

  private take(n: number): number {
    if (this.pos + n > this.buf.length) throw new ProtobufError("truncated field");
    const at = this.pos;
    this.pos += n;
    return at;
  }

  fixed64(): bigint {
    return this.view.getBigUint64(this.take(8), true);
  }

  sfixed64(): bigint {
    return this.view.getBigInt64(this.take(8), true);
  }

  double(): number {
    return this.view.getFloat64(this.take(8), true);
  }

  /** The bytes of one length-delimited field (a view, not a copy). */
  bytes(): Uint8Array {
    const len = this.varint();
    // Compare as bigint: never shift or `|` a length.
    if (len > BigInt(this.buf.length - this.pos)) throw new ProtobufError("length exceeds buffer");
    const n = Number(len);
    const at = this.take(n);
    return this.buf.subarray(at, at + n);
  }

  string(): string {
    return utf8.decode(this.bytes());
  }

  skip(wire: number): void {
    if (wire === WIRE_VARINT) this.varint();
    else if (wire === WIRE_FIXED64) this.take(8);
    else if (wire === WIRE_LEN) this.bytes();
    else if (wire === WIRE_FIXED32) this.take(4);
    else throw new ProtobufError(`unsupported wire type ${wire}`);
  }
}

/**
 * Walks the fields of one message. `on` returns true when it consumed the
 * field's payload; otherwise the field is skipped by its wire type.
 */
function fields(buf: Uint8Array, on: (field: number, wire: number, r: Reader) => boolean): void {
  const r = new Reader(buf);
  while (!r.done) {
    const key = r.varint();
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (field === 0) throw new ProtobufError("field number 0");
    if (!on(field, wire, r)) r.skip(wire);
  }
}

function hex(b: Uint8Array): string {
  let out = "";
  for (const byte of b) out += byte.toString(16).padStart(2, "0");
  return out;
}

function anyValue(buf: Uint8Array, depth: number, ctx: Ctx): OtlpJson {
  if (depth > ctx.maxDepth) throw new ProtobufError(`AnyValue nesting deeper than ${ctx.maxDepth}`);
  if (++ctx.values > ctx.maxValues) {
    throw new ProtobufError(`more than ${ctx.maxValues} values in one request`);
  }
  let out: OtlpJson = {};
  fields(buf, (f, w, r) => {
    if (f === 1 && w === WIRE_LEN) out = { stringValue: r.string() };
    else if (f === 2 && w === WIRE_VARINT) out = { boolValue: r.varint() !== 0n };
    else if (f === 3 && w === WIRE_VARINT)
      out = { intValue: BigInt.asIntN(64, r.varint()).toString() };
    else if (f === 4 && w === WIRE_FIXED64) out = { doubleValue: r.double() };
    else if (f === 5 && w === WIRE_LEN)
      out = { arrayValue: { values: valueList(r.bytes(), depth, ctx) } };
    else if (f === 6 && w === WIRE_LEN)
      out = { kvlistValue: { values: valueList(r.bytes(), depth, ctx, true) } };
    else if (f === 7 && w === WIRE_LEN)
      out = { bytesValue: Buffer.from(r.bytes()).toString("base64") };
    else return false;
    return true;
  });
  return out;
}

/** `ArrayValue.values` (AnyValue) or `KeyValueList.values` (KeyValue); both are field 1. */
function valueList(buf: Uint8Array, depth: number, ctx: Ctx, kv = false): OtlpJson[] {
  const out: OtlpJson[] = [];
  fields(buf, (f, w, r) => {
    if (f !== 1 || w !== WIRE_LEN) return false;
    out.push(kv ? keyValue(r.bytes(), depth + 1, ctx) : anyValue(r.bytes(), depth + 1, ctx));
    return true;
  });
  return out;
}

function keyValue(buf: Uint8Array, depth: number, ctx: Ctx): OtlpJson {
  const out: OtlpJson = { key: "" };
  fields(buf, (f, w, r) => {
    if (f === 1 && w === WIRE_LEN) out.key = r.string();
    else if (f === 2 && w === WIRE_LEN) out.value = anyValue(r.bytes(), depth, ctx);
    else return false;
    return true;
  });
  return out;
}

/** Collects a repeated `KeyValue` field into `into`. Top-level attributes start at depth 1. */
function attribute(r: Reader, into: OtlpJson[], ctx: Ctx): void {
  into.push(keyValue(r.bytes(), 1, ctx));
}

function resource(buf: Uint8Array, ctx: Ctx): OtlpJson {
  const attributes: OtlpJson[] = [];
  fields(buf, (f, w, r) => {
    if (f !== 1 || w !== WIRE_LEN) return false;
    attribute(r, attributes, ctx);
    return true;
  });
  return { attributes };
}

function scope(buf: Uint8Array, ctx: Ctx): OtlpJson {
  const out: OtlpJson = { attributes: [] as OtlpJson[] };
  fields(buf, (f, w, r) => {
    if (f === 1 && w === WIRE_LEN) out.name = r.string();
    else if (f === 2 && w === WIRE_LEN) out.version = r.string();
    else if (f === 3 && w === WIRE_LEN) attribute(r, out.attributes as OtlpJson[], ctx);
    else return false;
    return true;
  });
  return out;
}

function logRecord(buf: Uint8Array, ctx: Ctx): OtlpJson {
  const out: OtlpJson = { attributes: [] as OtlpJson[] };
  fields(buf, (f, w, r) => {
    if (f === 1 && w === WIRE_FIXED64) out.timeUnixNano = r.fixed64().toString();
    else if (f === 11 && w === WIRE_FIXED64) out.observedTimeUnixNano = r.fixed64().toString();
    else if (f === 3 && w === WIRE_LEN) out.severityText = r.string();
    else if (f === 5 && w === WIRE_LEN) out.body = anyValue(r.bytes(), 1, ctx);
    else if (f === 6 && w === WIRE_LEN) attribute(r, out.attributes as OtlpJson[], ctx);
    else if (f === 12 && w === WIRE_LEN) out.eventName = r.string();
    else return false;
    return true;
  });
  return out;
}

function status(buf: Uint8Array): OtlpJson {
  const out: OtlpJson = {};
  fields(buf, (f, w, r) => {
    if (f === 2 && w === WIRE_LEN) out.message = r.string();
    else if (f === 3 && w === WIRE_VARINT) out.code = Number(r.varint());
    else return false;
    return true;
  });
  return out;
}

function span(buf: Uint8Array, ctx: Ctx): OtlpJson {
  const out: OtlpJson = { attributes: [] as OtlpJson[] };
  fields(buf, (f, w, r) => {
    if (f === 1 && w === WIRE_LEN) out.traceId = hex(r.bytes());
    else if (f === 2 && w === WIRE_LEN) out.spanId = hex(r.bytes());
    else if (f === 4 && w === WIRE_LEN) out.parentSpanId = hex(r.bytes());
    else if (f === 5 && w === WIRE_LEN) out.name = r.string();
    else if (f === 6 && w === WIRE_VARINT) out.kind = Number(r.varint());
    else if (f === 7 && w === WIRE_FIXED64) out.startTimeUnixNano = r.fixed64().toString();
    else if (f === 8 && w === WIRE_FIXED64) out.endTimeUnixNano = r.fixed64().toString();
    else if (f === 9 && w === WIRE_LEN) attribute(r, out.attributes as OtlpJson[], ctx);
    else if (f === 15 && w === WIRE_LEN) out.status = status(r.bytes());
    else return false;
    return true;
  });
  return out;
}

function numberPoint(buf: Uint8Array, ctx: Ctx): OtlpJson {
  const out: OtlpJson = { attributes: [] as OtlpJson[] };
  fields(buf, (f, w, r) => {
    if (f === 2 && w === WIRE_FIXED64) out.startTimeUnixNano = r.fixed64().toString();
    else if (f === 3 && w === WIRE_FIXED64) out.timeUnixNano = r.fixed64().toString();
    else if (f === 4 && w === WIRE_FIXED64) out.asDouble = r.double();
    else if (f === 6 && w === WIRE_FIXED64) out.asInt = r.sfixed64().toString();
    else if (f === 7 && w === WIRE_LEN) attribute(r, out.attributes as OtlpJson[], ctx);
    else return false;
    return true;
  });
  return out;
}

/** `Gauge` (points only) and `Sum` (points, temporality, monotonic). */
function numberSeries(buf: Uint8Array, ctx: Ctx): OtlpJson {
  const dataPoints: OtlpJson[] = [];
  const out: OtlpJson = { dataPoints };
  fields(buf, (f, w, r) => {
    if (f === 1 && w === WIRE_LEN) dataPoints.push(numberPoint(r.bytes(), ctx));
    else if (f === 2 && w === WIRE_VARINT) out.aggregationTemporality = Number(r.varint());
    else if (f === 3 && w === WIRE_VARINT) out.isMonotonic = r.varint() !== 0n;
    else return false;
    return true;
  });
  return out;
}

/** Histograms, exponential histograms and summaries (fields 9-11) are skipped as unknown. */
function metric(buf: Uint8Array, ctx: Ctx): OtlpJson {
  const out: OtlpJson = {};
  fields(buf, (f, w, r) => {
    if (f === 1 && w === WIRE_LEN) out.name = r.string();
    else if (f === 3 && w === WIRE_LEN) out.unit = r.string();
    else if (f === 5 && w === WIRE_LEN) out.gauge = numberSeries(r.bytes(), ctx);
    else if (f === 7 && w === WIRE_LEN) out.sum = numberSeries(r.bytes(), ctx);
    else return false;
    return true;
  });
  return out;
}

/** `Resource*`/`Scope*` envelope shared by the three signals. */
function envelope(
  buf: Uint8Array,
  ctx: Ctx,
  scopesField: string,
  itemsField: string,
  item: (b: Uint8Array, ctx: Ctx) => OtlpJson,
): OtlpJson {
  const scopes: OtlpJson[] = [];
  const out: OtlpJson = { [scopesField]: scopes };
  fields(buf, (f, w, r) => {
    if (w !== WIRE_LEN) return false;
    if (f === 1) out.resource = resource(r.bytes(), ctx);
    else if (f === 2) {
      const items: OtlpJson[] = [];
      const sc: OtlpJson = { [itemsField]: items };
      fields(r.bytes(), (sf, sw, sr) => {
        if (sw !== WIRE_LEN) return false;
        if (sf === 1) sc.scope = scope(sr.bytes(), ctx);
        else if (sf === 2) items.push(item(sr.bytes(), ctx));
        else return false;
        return true;
      });
      scopes.push(sc);
    } else return false;
    return true;
  });
  return out;
}

const SIGNALS: Record<
  OtlpSignal,
  { root: string; scopes: string; items: string; item: (b: Uint8Array, ctx: Ctx) => OtlpJson }
> = {
  logs: { root: "resourceLogs", scopes: "scopeLogs", items: "logRecords", item: logRecord },
  traces: { root: "resourceSpans", scopes: "scopeSpans", items: "spans", item: span },
  metrics: { root: "resourceMetrics", scopes: "scopeMetrics", items: "metrics", item: metric },
};

/**
 * Decodes an `Export{Logs,Trace,Metrics}ServiceRequest` into its OTLP/JSON
 * shape. An empty body is a valid empty request. Throws `ProtobufError` on
 * malformed input or when a limit is exceeded — never `RangeError`.
 */
export function decodeOtlpProtobuf(
  signal: OtlpSignal,
  bytes: Uint8Array,
  limits: DecodeLimits = {},
): OtlpJson {
  const spec = SIGNALS[signal];
  const ctx: Ctx = {
    values: 0,
    maxDepth: limits.maxDepth ?? MAX_ANY_VALUE_DEPTH,
    maxValues: limits.maxValues ?? MAX_VALUES_PER_REQUEST,
  };
  const resources: OtlpJson[] = [];
  fields(bytes, (f, w, r) => {
    if (f !== 1 || w !== WIRE_LEN) return false;
    resources.push(envelope(r.bytes(), ctx, spec.scopes, spec.items, spec.item));
    return true;
  });
  return { [spec.root]: resources as OtlpJsonValue[] };
}

export const decodeLogsRequest = (b: Uint8Array, l?: DecodeLimits): OtlpJson =>
  decodeOtlpProtobuf("logs", b, l);
export const decodeTracesRequest = (b: Uint8Array, l?: DecodeLimits): OtlpJson =>
  decodeOtlpProtobuf("traces", b, l);
export const decodeMetricsRequest = (b: Uint8Array, l?: DecodeLimits): OtlpJson =>
  decodeOtlpProtobuf("metrics", b, l);
