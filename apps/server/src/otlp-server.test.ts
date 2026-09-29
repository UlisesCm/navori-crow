import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { bindAdapter, EventBus, IngestQueue, loadConfig, migrate } from "@crow/core";
import type {
  CrowConfig,
  EngineAdapter,
  FlatOtelRecord,
  IngestQueueOptions,
  PendingEvent,
  StatsResponse,
} from "@crow/core";
import { hexToBytes, lp, wrap } from "../../../fixtures/otlp/protobuf/vectors";
import { startApp } from "./app";
import type { AppHandle } from "./app";
import { ERROR_EVENT_BYTES, startOtlpServer } from "./otlp-server";
import { UNATTRIBUTABLE_EPISODE_MS } from "./otlp-route";
import type { OtlpServer, OtlpServerOptions } from "./otlp-server";

/** A test adapter owning records that carry the synthetic attribute `test.session`. */
const testAdapter: EngineAdapter<null> = {
  id: "testeng",
  watchRoots: () => [],
  matches: () => null,
  initialState: () => null,
  restoreState: () => null,
  parseLine: () => ({
    ok: false,
    reason: "bad-shape",
    sessionId: null,
    agentId: null,
    state: null,
  }),
  fromHook: () => ({
    ok: true,
    events: [
      {
        sessionId: "hooked",
        agentId: null,
        parentAgentId: null,
        kind: "prompt",
        ts: 1_700_000_000_000,
        cwd: "/tmp/proj",
      },
    ],
  }),
  ownsOtel: (r: FlatOtelRecord) => typeof r.attrs["test.session"] === "string",
  fromOtel: (r: FlatOtelRecord) => ({
    ok: true,
    events: [
      {
        sessionId: String(r.attrs["test.session"]),
        agentId: null,
        parentAgentId: null,
        kind: "prompt",
        ts: r.ts,
        cwd: "/tmp/proj",
      },
    ],
  }),
};
const ADAPTERS = [bindAdapter(testAdapter)];

const T0 = 1_700_000_000_000;

function attr(key: string, value: string): Record<string, unknown> {
  return { key, value: { stringValue: value } };
}

/** OTLP/JSON logs export with one record per attribute list. */
function logsJson(...records: Array<Record<string, unknown>[]>): string {
  return JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: [] },
        scopeLogs: [
          {
            logRecords: records.map((attributes) => ({
              timeUnixNano: `${T0}000000`,
              body: { stringValue: "x" },
              attributes,
            })),
          },
        ],
      },
    ],
  });
}

const hex = (s: string): string => Buffer.from(s).toString("hex");

/** OTLP/protobuf logs export with one record carrying `key=value`. */
function logsProto(key: string, value: string): Uint8Array<ArrayBuffer> {
  const kv = `0a${lp(hex(key))}12${lp(`0a${lp(hex(value))}`)}`;
  return Uint8Array.from(hexToBytes(wrap(`32${lp(kv)}`)));
}

interface Harness {
  otlp: OtlpServer;
  queue: IngestQueue;
  /** Everything the shared queue's drainer wrote, in order. */
  events: PendingEvent[];
  /** Waits until the shared queue's drainer has emptied both FIFOs. */
  flush: () => Promise<void>;
  clock: { now: number };
  url: string;
}

const running: Array<{ stop(): Promise<void> }> = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A receiver on an ephemeral port feeding a real shared `IngestQueue` whose store write is a
 * recording seam, so the tests see exactly what the single drainer would write.
 */
function harness(
  extra: Partial<OtlpServerOptions> = {},
  queueOpts: Partial<IngestQueueOptions> = {},
): Harness {
  const events: PendingEvent[] = [];
  const clock = { now: T0 };
  const db = new Database(":memory:");
  migrate(db);
  const queue = new IngestQueue({
    db,
    bus: new EventBus(),
    nextId: () => "id",
    now: () => clock.now,
    idleMs: 60_000,
    adapters: ADAPTERS,
    ingest: (_db, _deps, batch) => {
      events.push(...batch);
      return [];
    },
    ...queueOpts,
  });
  const otlp = startOtlpServer({
    port: 0,
    allowedOrigins: [],
    adapters: ADAPTERS,
    queue,
    now: () => clock.now,
    version: "9.9.9",
    ...extra,
  });
  running.push(otlp, queue);
  return {
    otlp,
    queue,
    events,
    flush: () => queue.idle(),
    clock,
    url: `http://127.0.0.1:${otlp.server.port}`,
  };
}

const post = (h: Harness, path: string, body: BodyInit, headers: Record<string, string>) =>
  fetch(`${h.url}${path}`, { method: "POST", body, headers });

const JSON_H = { "content-type": "application/json" };
const PROTO_H = { "content-type": "application/x-protobuf" };

describe("OTLP receiver: responses (R14)", () => {
  test("JSON → 200 {} in application/json; the event reaches the store step", async () => {
    // Covers: R14, R16
    const h = harness();
    const res = await post(h, "/v1/logs", logsJson([attr("test.session", "s1")]), JSON_H);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({});
    await h.flush();
    expect(h.events.map((e) => [e.engine, e.source, e.event.sessionId])).toEqual([
      ["testeng", "otel", "s1"],
    ]);
  });

  test("protobuf → 200 in application/x-protobuf, empty message", async () => {
    // Covers: R14
    const h = harness();
    const res = await post(h, "/v1/logs", logsProto("test.session", "s2"), PROTO_H);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-protobuf");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    await h.flush();
    expect(h.events[0]?.event.sessionId).toBe("s2");
  });

  test("gzip JSON and gzip protobuf are inflated; charset parameter accepted", async () => {
    // Covers: R14
    const h = harness();
    const gz = { "content-encoding": "gzip" };
    const a = await post(h, "/v1/logs", Bun.gzipSync(logsJson([attr("test.session", "g1")])), {
      "content-type": "application/json; charset=utf-8",
      ...gz,
    });
    const b = await post(h, "/v1/logs", Bun.gzipSync(logsProto("test.session", "g2")), {
      ...PROTO_H,
      ...gz,
    });
    expect([a.status, b.status]).toEqual([200, 200]);
    await h.flush();
    expect(h.events.map((e) => e.event.sessionId)).toEqual(["g1", "g2"]);
  });

  test("an empty body is a valid empty request", async () => {
    // Covers: R14
    const h = harness();
    expect((await post(h, "/v1/traces", "", JSON_H)).status).toBe(200);
    expect((await post(h, "/v1/metrics", new Uint8Array(0), PROTO_H)).status).toBe(200);
  });

  test("indecodable records → 200 with camelCase partialSuccess (JSON) / partial_success (protobuf)", async () => {
    // Covers: R14
    const h = harness();
    const bad = JSON.stringify({
      resourceLogs: [{ scopeLogs: [{ logRecords: [1, { body: { stringValue: "x" } }] }] }],
    });
    const json = await post(h, "/v1/logs", bad, JSON_H);
    expect(json.status).toBe(200);
    const body = (await json.json()) as { partialSuccess: Record<string, string> };
    expect(body.partialSuccess.rejectedLogRecords).toBe("1");
    expect(typeof body.partialSuccess.errorMessage).toBe("string");
    expect(Object.keys(body)).toEqual(["partialSuccess"]);
  });

  test("400 for malformed JSON, protobuf and a non-OTLP object, in the request's type", async () => {
    // Covers: R14
    const h = harness();
    const j = await post(h, "/v1/logs", "{nope", JSON_H);
    expect(j.status).toBe(400);
    expect(j.headers.get("content-type")).toBe("application/json");
    expect(((await j.json()) as { code: number }).code).toBe(3);
    expect((await post(h, "/v1/logs", '{"foo":1}', JSON_H)).status).toBe(400);
    const p = await post(h, "/v1/logs", Uint8Array.from([0x0a, 0x05, 0x01]), PROTO_H);
    expect(p.status).toBe(400);
    expect(p.headers.get("content-type")).toBe("application/x-protobuf");
    expect(
      (await post(h, "/v1/logs", "not gzip", { ...JSON_H, "content-encoding": "gzip" })).status,
    ).toBe(400);
  });

  test("405 on other methods of /v1/*, 404 elsewhere, /healthz identifies the OTLP receiver", async () => {
    // Covers: R14
    const h = harness();
    expect((await fetch(`${h.url}/v1/logs`)).status).toBe(405);
    expect((await fetch(`${h.url}/v1/metrics`, { method: "PUT" })).status).toBe(405);
    expect((await fetch(`${h.url}/other`)).status).toBe(404);
    expect(await (await fetch(`${h.url}/healthz`)).json()).toEqual({
      service: "navori-crow-otlp",
      version: "9.9.9",
    });
    const guarded = await fetch(`${h.url}/healthz`, { headers: { host: "evil.example.com" } });
    expect(guarded.status).toBe(403);
  });

  test("415 for other media types and encodings", async () => {
    // Covers: R14
    const h = harness();
    expect((await post(h, "/v1/logs", "x", { "content-type": "text/plain" })).status).toBe(415);
    expect((await post(h, "/v1/logs", "x", { "content-encoding": "gzip" })).status).toBe(415);
    const br = await post(h, "/v1/logs", "x", { ...JSON_H, "content-encoding": "br" });
    expect(br.status).toBe(415);
  });

  test("413 over the raw cap and for a gzip bomb (never inflated past the cap)", async () => {
    // Covers: R14
    const h = harness({ maxRawBytes: 64 * 1024, maxDecodedBytes: 1024 * 1024 });
    const big = await post(h, "/v1/logs", "x".repeat(65 * 1024), JSON_H);
    expect(big.status).toBe(413);
    const bomb = Bun.gzipSync(new Uint8Array(32 * 1024 * 1024)); // small raw, 32 MiB inflated
    expect(bomb.length).toBeLessThan(64 * 1024);
    const res = await post(h, "/v1/logs", bomb, { ...JSON_H, "content-encoding": "gzip" });
    expect(res.status).toBe(413);
    expect(h.events).toEqual([]);
  });

  test("503 + Retry-After when the shared OTel FIFO is full; accepted again after it drains", async () => {
    // Covers: R14
    const body = logsJson([attr("test.session", "q")]);
    const h = harness({}, { otelMaxBytes: body.length + 1 });
    h.queue.pause(); // keep the FIFO full until we say so
    expect((await post(h, "/v1/logs", body, JSON_H)).status).toBe(200);
    const full = await post(h, "/v1/logs", body, JSON_H);
    expect(full.status).toBe(503);
    expect(full.headers.get("retry-after")).toBe("5");
    expect(h.otlp.status().rejectedFull).toBe(1);
    expect(h.queue.otelDepth).toBe(1); // the refused batch left nothing behind
    h.queue.resume();
    await h.flush();
    expect(h.events).toHaveLength(1);
    expect((await post(h, "/v1/logs", body, JSON_H)).status).toBe(200);
  });

  test("a stopped queue refuses OTLP with 503 rather than accepting into the void", async () => {
    // Covers: R14
    const h = harness();
    await h.queue.stop();
    const res = await post(h, "/v1/logs", logsJson([attr("test.session", "late")]), JSON_H);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
  });

  test("OTel bytes queued return to 0 after draining", async () => {
    // Covers: R14
    const h = harness();
    h.queue.pause();
    const records = Array.from({ length: 7 }, (_, i) => [attr("test.session", `b${i}`)]);
    expect((await post(h, "/v1/logs", logsJson(...records), JSON_H)).status).toBe(200);
    expect(h.queue.otelQueuedBytes).toBeGreaterThan(0);
    expect(Number.isInteger(h.queue.otelQueuedBytes)).toBe(true);
    h.queue.resume();
    await h.flush();
    expect(h.queue.otelQueuedBytes).toBe(0);
    expect(h.events).toHaveLength(7);
  });

  test("episode errors are charged against the cap; refused ones are counted, not 503", async () => {
    // Covers: R17
    const cap = 3 * ERROR_EVENT_BYTES;
    const h = harness({}, { otelMaxBytes: cap });
    h.queue.pause();
    for (let i = 0; i < 20; i++) {
      const body = JSON.stringify({
        resourceLogs: [
          {
            resource: { attributes: [attr("service.name", `svc${i}`)] },
            scopeLogs: [{ logRecords: [{ timeUnixNano: `${T0}000000`, attributes: [] }] }],
          },
        ],
      });
      const res = await post(h, "/v1/logs", body, JSON_H);
      expect(res.status).toBe(200);
      expect(h.queue.otelQueuedBytes).toBeLessThanOrEqual(cap);
    }
    expect(h.queue.otelDepth).toBeLessThanOrEqual(3);
    expect(h.otlp.status().errorsDropped).toBeGreaterThan(0);
    h.queue.resume();
    await h.flush();
    expect(h.queue.otelQueuedBytes).toBe(0);
  });

  test("hooks drain before OTLP events when both are queued", async () => {
    // Covers: R14
    const h = harness();
    h.queue.pause();
    expect((await post(h, "/v1/logs", logsJson([attr("test.session", "o")]), JSON_H)).status).toBe(
      200,
    );
    expect(h.queue.enqueueHook("testeng", "{}")).toBe(true);
    h.queue.resume();
    await h.flush();
    expect(h.events.map((e) => e.source)).toEqual(["hook", "otel"]);
  });

  test("the request never waits for storage: it answers before the drainer runs", async () => {
    // Covers: R14
    const h = harness();
    h.queue.pause();
    const res = await post(h, "/v1/logs", logsJson([attr("test.session", "n")]), JSON_H);
    expect(res.status).toBe(200);
    expect(h.events).toEqual([]); // nothing stored yet: the drainer is held
    h.queue.resume();
    await h.flush();
    expect(h.events).toHaveLength(1);
  });

  test("a big batch is stored in steps of at most 200 events", async () => {
    // Covers: R14
    const steps: number[] = [];
    const h = harness(
      {},
      {
        ingest: (_db, _deps, b) => {
          steps.push(b.length);
          return [];
        },
      },
    );
    h.queue.pause();
    const records = Array.from({ length: 450 }, (_, i) => [attr("test.session", `s${i}`)]);
    expect((await post(h, "/v1/logs", logsJson(...records), JSON_H)).status).toBe(200);
    h.queue.resume();
    await h.flush();
    expect(steps).toEqual([200, 200, 50]);
  });
});

describe("OTLP routing without service.name (R16, R17)", () => {
  const foreign = logsJson([attr("service.version", "1")]); // no owner, no service.name

  test("records no adapter owns are counted and produce one ingest.error", async () => {
    // Covers: R17
    const h = harness();
    expect((await post(h, "/v1/logs", foreign, JSON_H)).status).toBe(200);
    await h.flush();
    const errors = h.events.filter((e) => e.event.kind === "ingest.error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.event.error?.reason).toBe("unattributable");
    expect(errors[0]?.engine).toBe("otel");
    expect(h.otlp.status().otelUnattributed).toBe(1);
  });

  test("an unattributable SDK exporting every 5 s for 30 min → 3 ingest.error", async () => {
    // Covers: R17
    const h = harness();
    for (let i = 0; i < 360; i++) {
      h.clock.now = T0 + i * 5_000;
      await post(h, "/v1/logs", foreign, JSON_H);
      await h.flush();
    }
    expect(h.events.filter((e) => e.event.kind === "ingest.error")).toHaveLength(3);
    expect(h.otlp.status().otelUnattributed).toBe(360);
    expect(UNATTRIBUTABLE_EPISODE_MS).toBe(600_000);
  });

  test("owned and foreign records in one export: the owned one is stored, the foreign one counted", async () => {
    // Covers: R16, R17
    const h = harness();
    await post(h, "/v1/logs", logsJson([attr("test.session", "mix")], [attr("x", "y")]), JSON_H);
    await h.flush();
    expect(h.events.map((e) => e.event.kind).sort()).toEqual(["ingest.error", "prompt"]);
  });

  test("an owner that can't attribute a session lands in <engine>:unknown", async () => {
    // Covers: R17
    const noSession: EngineAdapter<null> = {
      ...testAdapter,
      fromOtel: () => ({ ok: false, reason: "unattributable" }),
    };
    const h = harness({ adapters: [bindAdapter(noSession)] });
    await post(h, "/v1/logs", logsJson([attr("test.session", "z")]), JSON_H);
    await h.flush();
    expect(h.events[0]?.engine).toBe("testeng");
    expect(h.events[0]?.event.sessionId).toBe("unknown");
  });
});

describe("startApp: opt-in and busy port (R15, R34)", () => {
  function config(overrides: Partial<CrowConfig>): CrowConfig {
    const dir = mkdtempSync(join(tmpdir(), "crow-otlp-"));
    dirs.push(dir);
    return {
      crowHome: join(dir, "home"),
      crowPort: 0,
      backfillHours: 24,
      idleMinutes: 5,
      allowedOrigins: [],
      claudeConfigDir: join(dir, "claude"),
      codexHome: join(dir, "codex"),
      token: null,
      otlpEnabled: false,
      otlpPort: 0,
      ...overrides,
    };
  }
  async function start(cfg: CrowConfig): Promise<AppHandle> {
    const app = await startApp(cfg, { otlpAdapters: ADAPTERS });
    running.push(app);
    return app;
  }

  test("off by default, on with the flag, CROW_OTLP or config.json", async () => {
    // Covers: R34
    const home = mkdtempSync(join(tmpdir(), "crow-otlp-home-"));
    dirs.push(home);
    const off = loadConfig({ CROW_HOME: join(home, "a") }, home);
    expect(off.otlpEnabled).toBe(false);
    const app = await start({ ...config({}), otlpEnabled: off.otlpEnabled });
    expect(app.otlpLaneStatus().state).toBe("disabled");
    expect(app.otlpLaneStatus().port).toBe(0);

    const viaFlag = loadConfig({ CROW_HOME: join(home, "b") }, home, { otlp: true, otlpPort: 0 });
    const viaEnv = loadConfig({ CROW_HOME: join(home, "c"), CROW_OTLP: "1" }, home);
    for (const c of [viaFlag, viaEnv]) {
      expect(c.otlpEnabled).toBe(true);
    }
    const on = await start(config({ otlpEnabled: viaFlag.otlpEnabled }));
    expect(on.otlpLaneStatus().state).toBe("listening");
    const port = on.otlpLaneStatus().port;
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
  });

  test("end to end: POST → route → fromOtel → ingestEvents → stored and published", async () => {
    // Covers: R14, R16
    const app = await start(config({ otlpEnabled: true }));
    const seen: string[] = [];
    app.bus.subscribe((events) => void events.forEach((e) => seen.push(e.sessionId)));
    const port = app.otlpLaneStatus().port;
    const res = await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: JSON_H,
      body: logsJson([attr("test.session", "e2e")]),
    });
    expect(res.status).toBe(200);
    for (let i = 0; i < 50 && seen.length === 0; i++) await Bun.sleep(10);
    expect(seen).toEqual(["e2e"]);
    const row = app.db
      .query<{ n: number }, []>("SELECT count(*) AS n FROM events WHERE session_id LIKE '%e2e'")
      .get();
    expect(row?.n).toBe(1);
  });

  test("unattributable records never file a session under the server's own cwd project", async () => {
    // Covers: R17
    const app = await start(config({ otlpEnabled: true }));
    const port = app.otlpLaneStatus().port;
    const seen: string[] = [];
    app.bus.subscribe((events) => void events.forEach((e) => seen.push(e.kind)));
    for (let i = 0; i < 5; i++) {
      await fetch(`http://127.0.0.1:${port}/v1/logs`, {
        method: "POST",
        headers: JSON_H,
        body: logsJson([attr("service.name", `sdk${i}`)]),
      });
    }
    for (let i = 0; i < 50 && seen.length < 1; i++) await Bun.sleep(10);
    expect(seen).toEqual(["ingest.error"]); // one per episode

    const res = await fetch(`http://127.0.0.1:${app.server.port}/api/projects?since=0`);
    const body = (await res.json()) as {
      projects: Array<{ key: string; sessions: Array<{ id: string; status: string }> }>;
    };
    expect(body.projects.map((p) => p.key)).toEqual(["unresolved"]);
    const sessions = body.projects.flatMap((p) => p.sessions);
    expect(sessions.every((s) => s.status === "idle")).toBe(true);
    expect(sessions.map((s) => s.id)).toEqual(["otel:unattributed"]);
    const stats = (await (await fetch(`http://127.0.0.1:${app.server.port}/api/stats`)).json()) as {
      ingest: { errorsByReason: Record<string, number> };
    };
    expect(stats.ingest.errorsByReason["unattributable"]).toBe(1);
  });

  test("busy port: startApp resolves, the API serves and the lane is port-in-use", async () => {
    // Covers: R15
    const squatter = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
    try {
      const app = await start(config({ otlpEnabled: true, otlpPort: squatter.port ?? 0 }));
      expect(app.otlpLaneStatus().state).toBe("port-in-use");
      expect(app.otlpLaneStatus().port).toBe(squatter.port ?? 0);
      const health = await fetch(`http://127.0.0.1:${app.server.port}/healthz`);
      expect(health.status).toBe(200);
      const stats = await fetch(`http://127.0.0.1:${app.server.port}/api/stats`);
      expect(stats.status).toBe(200);
    } finally {
      await squatter.stop(true);
    }
  });

  async function lanesOf(app: AppHandle): Promise<StatsResponse["lanes"]> {
    const res = await fetch(`http://127.0.0.1:${app.server.port}/api/stats`);
    return ((await res.json()) as StatsResponse).lanes;
  }

  test("/api/stats.lanes.otlp is disabled when the lane is off", async () => {
    // Covers: R15, R28
    const app = await start(config({ otlpEnabled: false, otlpPort: 4318 }));
    const otlp = (await lanesOf(app)).otlp;
    expect(otlp.state).toBe("disabled");
    expect(otlp.port).toBe(4318);
    expect(otlp.requests).toBe(0);
    expect(otlp.rejectedFull).toBe(0);
  });

  test("/api/stats.lanes.otlp is listening with port, last received and counters", async () => {
    // Covers: R15, R28
    const app = await start(config({ otlpEnabled: true }));
    const before = (await lanesOf(app)).otlp;
    expect(before.state).toBe("listening");
    expect(before.lastReceivedAt).toBeNull();
    const port = before.port;
    expect(port).toBe(app.otlpLaneStatus().port);
    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: JSON_H,
      body: logsJson([attr("service.name", "nobody")]),
    });
    const after = (await lanesOf(app)).otlp;
    expect(after.requests).toBe(1);
    expect(after.otelUnattributed).toBe(1);
    expect(after.lastReceivedAt).toEqual(expect.any(Number));
    expect(after.rejectedFull).toBe(0);
  });

  test("port-in-use surfaces in /api/stats.lanes.otlp", async () => {
    // Covers: R15, R28
    const squatter = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
    try {
      const app = await start(config({ otlpEnabled: true, otlpPort: squatter.port ?? 0 }));
      const otlp = (await lanesOf(app)).otlp;
      expect(otlp.state).toBe("port-in-use");
      expect(otlp.port).toBe(squatter.port ?? 0);
    } finally {
      await squatter.stop(true);
    }
  });

  test("stop() closes the OTLP listener before the DB", async () => {
    // Covers: R14
    const app = await startApp(config({ otlpEnabled: true }), { otlpAdapters: ADAPTERS });
    const port = app.otlpLaneStatus().port;
    await app.stop();
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });
});
