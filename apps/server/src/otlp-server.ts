/**
 * The OTLP/HTTP receiver: a separate `Bun.serve` on `127.0.0.1:CROW_OTLP_PORT`, opt-in (design.md
 * D8, R14, R15, R34).
 *
 * The request path never touches the DB: decode → flatten → `routeOtel` → answer → enqueue. A
 * drainer stores the queued events in steps of at most {@link DRAIN_STEP_EVENTS}, yielding the
 * thread between steps, so the receiver (and the main server) never wait for storage (MF5).
 *
 * TODO(queue): this FIFO is OTLP-local. D2 puts it inside the shared `IngestQueue` (B2); when
 * that lands, replace `queue`/`drain` here by the otel FIFO's `offer`, keeping the 503 contract.
 */
import type { Server } from "bun";
import type { BoundAdapter, FlatOtelRecord, PendingEvent } from "@crow/core";
import {
  decodeOtlpProtobuf,
  flattenOtlp,
  OtlpJsonError,
  parseOtlpJson,
  ProtobufError,
} from "@crow/otlp";
import type { OtlpSignal } from "@crow/otlp";
import { checkRequest } from "./guard";
import { EpisodeLimiter, routeOtel } from "./otlp-route";

/** Raw body cap (D8): 16 MiB. */
export const MAX_RAW_BYTES = 16 * 1024 * 1024;
/** Decompressed body cap (D8): 32 MiB. */
export const MAX_DECODED_BYTES = 32 * 1024 * 1024;
/** Estimated bytes the OTLP FIFO may hold before answering 503 (D2): 64 MiB. */
export const MAX_QUEUE_BYTES = 64 * 1024 * 1024;
/** Events stored per drain step (D2). */
export const DRAIN_STEP_EVENTS = 200;

/** State of the OTLP lane, as `crow doctor` and `/api/stats.lanes` report it (D15). */
export type OtlpLaneState = "listening" | "disabled" | "port-in-use" | "error";

/** Snapshot of the OTLP lane. Counts only, never content (D15). */
export interface OtlpLaneStatus {
  state: OtlpLaneState;
  /** The bound port while `listening`, else the configured one. */
  port: number | null;
  lastReceivedAt: number | null;
  /** Export requests accepted (200). */
  requests: number;
  /** Records nobody owns or that carry no session (R17, `stats.otelUnattributed`). */
  otelUnattributed: number;
  /** Known records with no mapping (`stats.otelIgnored`). */
  otelIgnored: number;
  /** Requests answered 503 because the queue was full. */
  rejectedFull: number;
}

/** A zeroed lane status in `state`. */
export function laneStatus(state: OtlpLaneState, port: number | null): OtlpLaneStatus {
  return {
    state,
    port,
    lastReceivedAt: null,
    requests: 0,
    otelUnattributed: 0,
    otelIgnored: 0,
    rejectedFull: 0,
  };
}

/** Knobs of {@link startOtlpServer}. Limits and the scheduler are injectable for tests. */
export interface OtlpServerOptions {
  port: number;
  allowedOrigins: readonly string[];
  adapters: readonly BoundAdapter[];
  /** Stores one step of events and publishes them; called from the drainer only. */
  ingest: (events: PendingEvent[]) => void;
  now: () => number;
  version: string;
  maxRawBytes?: number;
  maxDecodedBytes?: number;
  maxQueueBytes?: number;
  /** Runs `fn` on a later macrotask. Default `setTimeout(fn, 0)`. */
  scheduleDrain?: (fn: () => void) => void;
}

/** A running OTLP receiver. */
export interface OtlpServer {
  readonly server: Server<unknown>;
  status(): OtlpLaneStatus;
  stop(): Promise<void>;
}

const JSON_TYPE = "application/json";
const PROTO_TYPE = "application/x-protobuf";
const SIGNALS: Readonly<Record<string, OtlpSignal>> = {
  "/v1/logs": "logs",
  "/v1/traces": "traces",
  "/v1/metrics": "metrics",
};
const REJECTED_KEY: Readonly<Record<OtlpSignal, string>> = {
  logs: "rejectedLogRecords",
  traces: "rejectedSpans",
  metrics: "rejectedDataPoints",
};
/** google.rpc.Code.INVALID_ARGUMENT */
const INVALID_ARGUMENT = 3;

type Wire = "json" | "protobuf";

/** Thrown while reading a body that passes a cap. */
class TooLarge extends Error {}

// --- minimal protobuf encoding for the two response messages ---------------------------------

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return out;
}

function lenField(field: number, bytes: Uint8Array): number[] {
  return [(field << 3) | 2, ...varint(bytes.length), ...bytes];
}

const enc = new TextEncoder();

/** `google.rpc.Status { code = 1; message = 2 }`. */
function statusBytes(code: number, message: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from([0x08, ...varint(code), ...lenField(2, enc.encode(message))]);
}

/** `Export*ServiceResponse { partial_success = 1 { rejected_* = 1; error_message = 2 } }`. */
function partialSuccessBytes(rejected: number, message: string): Uint8Array<ArrayBuffer> {
  const inner = Uint8Array.from([0x08, ...varint(rejected), ...lenField(2, enc.encode(message))]);
  return Uint8Array.from(lenField(1, inner));
}

function reply(
  wire: Wire,
  status: number,
  json: unknown,
  proto: Uint8Array<ArrayBuffer>,
  extra?: HeadersInit,
) {
  const headers = new Headers(extra);
  headers.set("content-type", wire === "json" ? JSON_TYPE : PROTO_TYPE);
  return new Response(wire === "json" ? JSON.stringify(json) : proto, { status, headers });
}

function failure(wire: Wire, status: number, message: string, extra?: HeadersInit): Response {
  return reply(
    wire,
    status,
    { code: INVALID_ARGUMENT, message },
    statusBytes(INVALID_ARGUMENT, message),
    extra,
  );
}

/** Media type without parameters, lowercased (`application/json; charset=utf-8` → `application/json`). */
function mediaType(header: string | null): string {
  return (header ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/**
 * Reads `req`'s body, counting bytes and cancelling the reader when a cap is passed — never
 * `arrayBuffer()`. `gzip` bodies are inflated through `DecompressionStream`, so a bomb is cut at
 * `maxDecoded` and never materialised.
 */
async function readBody(
  req: Request,
  gzip: boolean,
  maxRaw: number,
  maxDecoded: number,
): Promise<Uint8Array> {
  if (req.body === null) return new Uint8Array(0);
  let raw = 0;
  const counter = new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
    transform(chunk, controller) {
      raw += chunk.length;
      if (raw > maxRaw) controller.error(new TooLarge());
      else controller.enqueue(chunk);
    },
  });
  let stream: ReadableStream<Uint8Array<ArrayBuffer>> = req.body.pipeThrough(counter);
  if (gzip) stream = stream.pipeThrough(new DecompressionStream("gzip"));

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxDecoded) throw new TooLarge();
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    if (err instanceof TooLarge || raw > maxRaw) throw new TooLarge();
    throw err;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

interface QueueItem {
  events: PendingEvent[];
  /** Estimated bytes still held by `events`. */
  bytes: number;
}

/**
 * Starts the receiver. Throws (synchronously, `code: "EADDRINUSE"`) when the port is taken — the
 * caller turns that into the `port-in-use` lane state (R15).
 */
export function startOtlpServer(opts: OtlpServerOptions): OtlpServer {
  const maxRaw = opts.maxRawBytes ?? MAX_RAW_BYTES;
  const maxDecoded = opts.maxDecodedBytes ?? MAX_DECODED_BYTES;
  const maxQueue = opts.maxQueueBytes ?? MAX_QUEUE_BYTES;
  const schedule = opts.scheduleDrain ?? ((fn: () => void) => void setTimeout(fn, 0));
  const limiter = new EpisodeLimiter();

  const queue: QueueItem[] = [];
  let queuedBytes = 0;
  let draining = false;
  let stopped = false;
  const stats = laneStatus("listening", null);

  const step = (): void => {
    if (stopped) {
      draining = false;
      return;
    }
    const batch: PendingEvent[] = [];
    while (batch.length < DRAIN_STEP_EVENTS && queue.length > 0) {
      const head = queue[0] as QueueItem;
      const take = Math.min(DRAIN_STEP_EVENTS - batch.length, head.events.length);
      const per = head.bytes / head.events.length;
      batch.push(...head.events.splice(0, take));
      head.bytes -= per * take;
      queuedBytes -= per * take;
      if (head.events.length === 0) {
        queuedBytes -= head.bytes;
        queue.shift();
      }
    }
    try {
      opts.ingest(batch);
    } catch {
      // The store never throws on data (D2/MF7); an environmental failure drops this step
      // rather than wedging the drainer. Counts only, no content.
      console.warn(`crow: OTLP step of ${batch.length} events was not stored`);
    }
    if (queue.length > 0) schedule(step);
    else draining = false;
  };

  const enqueue = (events: PendingEvent[], bytes: number, force: boolean): boolean => {
    if (events.length === 0) return true;
    if (!force && queuedBytes + bytes > maxQueue) return false;
    queue.push({ events, bytes });
    queuedBytes += bytes;
    if (!draining) {
      draining = true;
      schedule(step);
    }
    return true;
  };

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const rejection = checkRequest(req.headers, server.port ?? 0, opts.allowedOrigins);
    if (rejection !== null) return rejection;

    if (url.pathname === "/healthz") {
      if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      return Response.json({ service: "navori-crow-otlp", version: opts.version });
    }
    const signal = SIGNALS[url.pathname];
    if (signal === undefined) return new Response("Not Found", { status: 404 });
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
    }

    const type = mediaType(req.headers.get("content-type"));
    if (type !== JSON_TYPE && type !== PROTO_TYPE) {
      return failure("json", 415, "unsupported media type");
    }
    const wire: Wire = type === JSON_TYPE ? "json" : "protobuf";
    const encoding = (req.headers.get("content-encoding") ?? "identity").trim().toLowerCase();
    if (encoding !== "gzip" && encoding !== "identity" && encoding !== "") {
      return failure(wire, 415, "unsupported content-encoding");
    }
    const declared = Number(req.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxRaw) return failure(wire, 413, "body too large");

    let bytes: Uint8Array;
    try {
      bytes = await readBody(req, encoding === "gzip", maxRaw, maxDecoded);
    } catch (err) {
      if (err instanceof TooLarge) return failure(wire, 413, "body too large");
      return failure(wire, 400, "body could not be read");
    }

    let records: FlatOtelRecord[] = [];
    let discarded = 0;
    if (bytes.length > 0) {
      try {
        const decoded =
          wire === "json"
            ? parseOtlpJson(new TextDecoder().decode(bytes))
            : decodeOtlpProtobuf(signal, bytes);
        const flat = flattenOtlp(signal, decoded, { now: opts.now() });
        if (flat === null) return failure(wire, 400, "not an OTLP export request");
        records = flat.records;
        discarded = flat.discarded;
      } catch (err) {
        if (err instanceof OtlpJsonError || err instanceof ProtobufError) {
          return failure(wire, 400, err.message);
        }
        return failure(wire, 400, "body could not be decoded");
      }
    }

    const routed = routeOtel(records, opts.adapters, limiter, opts.now());
    // Only the events of mapped records count against the cap; the tiny `ingest.error`s of an
    // episode always go in so the unattributable stream stays visible even under pressure (R17).
    const errors = routed.events.filter((e) => e.event.kind === "ingest.error");
    const mapped = routed.events.filter((e) => e.event.kind !== "ingest.error");
    if (!enqueue(mapped, bytes.length, false)) {
      stats.rejectedFull++;
      return failure(wire, 503, "queue full, retry later", { "retry-after": "5" });
    }
    enqueue(errors, 0, true);

    stats.requests++;
    stats.lastReceivedAt = opts.now();
    stats.otelUnattributed += routed.unattributed;
    stats.otelIgnored += routed.ignored;

    if (discarded > 0) {
      const message = "some records could not be decoded";
      return reply(
        wire,
        200,
        { partialSuccess: { [REJECTED_KEY[signal]]: String(discarded), errorMessage: message } },
        partialSuccessBytes(discarded, message),
      );
    }
    return reply(wire, 200, {}, new Uint8Array(0));
  };

  const server = Bun.serve({ hostname: "127.0.0.1", port: opts.port, fetch: handle });
  stats.port = server.port ?? opts.port;

  return {
    server,
    status: () => ({ ...stats }),
    /**
     * Stops accepting and closes the listener. Items still queued and not yet drained are
     * dropped, not stored (design.md § Failure modes, shutdown); exporters retry on their own.
     */
    async stop(): Promise<void> {
      stopped = true;
      await server.stop(true);
    },
  };
}
