/**
 * The OTLP/HTTP receiver: a separate `Bun.serve` on `127.0.0.1:CROW_OTLP_PORT`, opt-in (design.md
 * D8, R14, R15, R34).
 *
 * The request path never touches the DB: decode → flatten → `routeOtel` → enqueue → answer, so the
 * receiver (and the main server) never wait for storage (MF5).
 *
 * The decoded, routed events go to the shared `IngestQueue` (D2) via `enqueueOtel`; a full OTel FIFO
 * answers 503 with `Retry-After`. There is no drainer here: the queue's single drainer is the only
 * writer.
 */
import type { Server } from "bun";
import type {
  BoundAdapter,
  FlatOtelRecord,
  IngestQueue,
  OtlpLaneState,
  OtlpLaneStatus,
} from "@crow/core";
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
/** Retry-After (seconds) sent with the 503 of a full OTel FIFO (D8). */
const RETRY_AFTER_SECONDS = "5";

/**
 * Nominal bytes charged per `ingest.error` (its message cap), so episode errors count against the
 * OTel FIFO cap instead of bypassing it (D8, R17).
 */
export const ERROR_EVENT_BYTES = 1024;

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
    errorsDropped: 0,
  };
}

/** Knobs of {@link startOtlpServer}. Limits and the scheduler are injectable for tests. */
export interface OtlpServerOptions {
  port: number;
  allowedOrigins: readonly string[];
  adapters: readonly BoundAdapter[];
  /** The shared queue (D2): the receiver only ever calls `enqueueOtel`. */
  queue: Pick<IngestQueue, "enqueueOtel">;
  now: () => number;
  version: string;
  maxRawBytes?: number;
  maxDecodedBytes?: number;
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

/**
 * Starts the receiver. Throws (synchronously, `code: "EADDRINUSE"`) when the port is taken — the
 * caller turns that into the `port-in-use` lane state (R15).
 */
export function startOtlpServer(opts: OtlpServerOptions): OtlpServer {
  const maxRaw = opts.maxRawBytes ?? MAX_RAW_BYTES;
  const maxDecoded = opts.maxDecodedBytes ?? MAX_DECODED_BYTES;
  const limiter = new EpisodeLimiter();
  const stats = laneStatus("listening", null);

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
    // Mapped events are charged the body size; each `ingest.error` a nominal ERROR_EVENT_BYTES. A
    // refused error batch never fails the request: it is counted in `errorsDropped` (R17).
    const errors = routed.events.filter((e) => e.event.kind === "ingest.error");
    const mapped = routed.events.filter((e) => e.event.kind !== "ingest.error");
    if (!opts.queue.enqueueOtel(mapped, bytes.length)) {
      stats.rejectedFull++;
      return failure(wire, 503, "queue full, retry later", {
        "retry-after": RETRY_AFTER_SECONDS,
      });
    }
    if (!opts.queue.enqueueOtel(errors, errors.length * ERROR_EVENT_BYTES)) {
      stats.errorsDropped += errors.length;
    }

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
     * Stops accepting and closes the listener. Whatever is still in the shared queue is not
     * drained after `IngestQueue.stop` (design.md § Failure modes, shutdown); exporters retry.
     */
    async stop(): Promise<void> {
      await server.stop(true);
    },
  };
}
