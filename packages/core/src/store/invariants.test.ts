import { describe, expect, test } from "bun:test";
import type { PartialCrowEvent } from "../adapter";
import { getOffset, ingestBatch, stats, getSessionDetail } from "./store";
import { factRows, freshDb, ingest, makeDeps, pending, T0 } from "./testing";

const USAGE = { input: 10, output: 5, cacheRead: 0, cacheCreation: 0, model: "claude-sonnet-5" };
const MATCH = { key: "tool-post:c1", mode: "exact" } as const;

function violations(): Array<[string, Partial<PartialCrowEvent>]> {
  return [
    ["usage", { kind: "assistant.message", ts: T0, text: "x", usage: USAGE, match: MATCH }],
    ["otelUsage", { kind: "api.request", ts: T0, otelUsage: USAGE, match: MATCH }],
    ["hook kind", { kind: "hook", ts: T0, hook: { name: "h", phase: "pre" }, match: MATCH }],
    ["revision kind", { kind: "revision", ts: T0, match: MATCH }],
    ["reported", { kind: "api.request", ts: T0, reported: { costUsd: 1 }, match: MATCH }],
  ];
}

describe("store invariants: no throw, no poison pill (D5, MF7)", () => {
  for (const [name, event] of violations()) {
    test(`a match on an event carrying ${name} becomes ingest.error invariant and is skipped`, () => {
      // Covers: R11, R13 — MF7
      const db = freshDb();
      const deps = makeDeps();
      const good = pending("transcript", { kind: "prompt", ts: T0 + 1, text: "ok" });
      let out: ReturnType<typeof ingest> = [];
      expect(() => {
        out = ingest(db, deps, pending("hook", event as PartialCrowEvent), good);
      }).not.toThrow();

      expect(out.map((e) => e.kind)).toEqual(["ingest.error", "prompt"]);
      expect(out[0]!.error?.reason).toBe("invariant");
      expect(stats(db).errorsByReason.invariant).toBe(1);
      expect(factRows(db).map((f) => f.kind)).toEqual(["ingest.error", "prompt"]);
      const row = db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE lkey IS NOT NULL")
        .get();
      expect(row!.n).toBe(0); // nothing was stored as a fact
      const session = getSessionDetail(db, "claude:s1")!.session;
      expect(session.totals.input).toBe(0); // the usage was NOT counted
    });
  }

  test("through ingestBatch the offset still advances: the tailer is not poisoned", () => {
    // Covers: R11 — MF7
    const db = freshDb();
    const deps = makeDeps();
    const [, bad] = violations()[0]!;
    ingestBatch(db, deps, {
      path: "/f",
      inode: "1",
      nextOffset: 42,
      state: null,
      events: [
        pending("transcript", bad as PartialCrowEvent & { kind: "prompt"; ts: number }),
        pending("transcript", { kind: "prompt", ts: T0 + 1, text: "after" }),
      ],
    });
    expect(getOffset(db, "/f")!.byteOffset).toBe(42);
    expect(factRows(db).map((f) => f.kind)).toEqual(["ingest.error", "prompt"]);
  });

  test("a revision row never carries usage and revisions are never matched", () => {
    // Covers: R11
    const db = freshDb();
    const deps = makeDeps();
    ingest(
      db,
      deps,
      pending("otel", {
        kind: "tool.post",
        ts: T0,
        tool: { name: "Bash", callId: "c1" },
        match: MATCH,
      }),
    );
    const [rev] = ingest(
      db,
      deps,
      pending("transcript", {
        kind: "tool.post",
        ts: T0,
        tool: { name: "Bash", callId: "c1", ok: true },
        match: MATCH,
      }),
    );
    expect(rev!.kind).toBe("revision");
    expect(rev!.usage).toBeUndefined();
    expect(rev!.revision!.fact.usage).toBeUndefined();
  });
});
