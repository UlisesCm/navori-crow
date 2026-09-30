#!/usr/bin/env bun
/**
 * Test oracle for `@crow/otlp` (design.md D9): encodes the OTLP/JSON captures
 * in `fixtures/otlp/protobuf/<signal>.json` into `<signal>.bin` with
 * `protobufjs` and the vendored `scripts/otlp-proto/otlp-subset.proto`. The
 * decoder under test never sees `protobufjs`; it only reads the `.bin`.
 *
 *   bun scripts/encode-otlp-fixture.ts [<dir with <signal>.json>]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import protobuf from "protobufjs";

export const OTLP_SIGNALS = ["logs", "traces", "metrics"] as const;
export type OtlpFixtureSignal = (typeof OTLP_SIGNALS)[number];

const REQUEST_TYPE: Record<OtlpFixtureSignal, string> = {
  logs: "ExportLogsServiceRequest",
  traces: "ExportTraceServiceRequest",
  metrics: "ExportMetricsServiceRequest",
};

export const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "otlp", "protobuf");
const PROTO = join(import.meta.dir, "otlp-proto", "otlp-subset.proto");

/** Encodes `<signal>.json` with the oracle. Ids given as hex/base64 strings are converted to bytes first. */
export async function encodeFixture(
  signal: OtlpFixtureSignal,
  dir: string = FIXTURE_DIR,
): Promise<Uint8Array> {
  const root = await protobuf.load(PROTO);
  const type = root.lookupType(`crow.otlp.subset.${REQUEST_TYPE[signal]}`);
  const json: unknown = JSON.parse(readFileSync(join(dir, `${signal}.json`), "utf8"));
  const message = type.fromObject(hexIdsToBase64(json) as Record<string, unknown>);
  return type.encode(message).finish();
}

/** OTLP/JSON carries trace/span ids as hex; protobufjs `fromObject` expects base64 for `bytes`. */
function hexIdsToBase64(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(hexIdsToBase64);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] =
      (k === "traceId" || k === "spanId" || k === "parentSpanId") && typeof v === "string"
        ? Buffer.from(v, "hex").toString("base64")
        : hexIdsToBase64(v);
  }
  return out;
}

if (import.meta.main) {
  // Optional first argument: another fixture dir (e.g. `fixtures/otlp/claude`) holding `<signal>.json`.
  // A signal without a `.json` there is skipped (`fixtures/otlp/codex` only carries logs).
  const dir = process.argv[2] ?? FIXTURE_DIR;
  for (const signal of OTLP_SIGNALS) {
    if (!existsSync(join(dir, `${signal}.json`))) continue;
    const bytes = await encodeFixture(signal, dir);
    writeFileSync(join(dir, `${signal}.bin`), bytes);
    console.log(`${signal}.bin  ${bytes.length} bytes`);
  }
}
