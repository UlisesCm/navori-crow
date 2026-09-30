import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { PendingEvent } from "./store";
import { getSessionDetail, listEventsAfter, listSessionEvents, stats } from "./store";
import type { CrowEvent } from "../crow-event";
import {
  factRows,
  freshDb,
  ingest,
  makeDeps,
  pending,
  permutations,
  revisionRows,
  T0,
  withoutId,
} from "./testing";

// ---------------------------------------------------------------------------
// Tool call: the 6 contributions of design D5 / D7 (BD2: OTel may come first)
// ---------------------------------------------------------------------------

const PRE = { key: "tool-pre:c1", mode: "exact" } as const;
const POST = { key: "tool-post:c1", mode: "exact" } as const;

function toolLanes(): Record<string, PendingEvent> {
  return {
    preTranscript: pending(
      "transcript",
      {
        kind: "tool.pre",
        ts: T0 + 1000,
        tool: { name: "Bash", callId: "c1", input: { command: "ls" } },
        match: PRE,
      },
      10,
    ),
    preHook: pending(
      "hook",
      {
        kind: "tool.pre",
        ts: T0 + 1010,
        tool: { name: "Bash", callId: "c1", input: { command: "ls -la" } },
        match: PRE,
      },
      20,
    ),
    otelDecision: pending(
      "otel",
      {
        kind: "tool.pre",
        ts: T0 + 1005,
        tool: {
          name: "Bash",
          callId: "c1",
          verdict: "allow",
          decisionSource: "user",
        },
        match: PRE,
      },
      30,
    ),
    postTranscript: pending(
      "transcript",
      {
        kind: "tool.post",
        ts: T0 + 1300,
        tool: {
          name: "Bash",
          callId: "c1",
          ok: true,
          ms: 300,
          msSource: "transcript",
        },
        match: POST,
      },
      40,
    ),
    postHook: pending(
      "hook",
      {
        kind: "tool.post",
        ts: T0 + 1310,
        tool: {
          name: "Bash",
          callId: "c1",
          ms: 40,
          msSource: "hook-receipt",
          verdict: "allow",
          decisionSource: "hook",
        },
        match: POST,
      },
      50,
    ),
    otelResult: pending(
      "otel",
      {
        kind: "tool.post",
        ts: T0 + 1320,
        tool: {
          name: "Bash",
          callId: "c1",
          ms: 250,
          msSource: "engine",
          verdict: "allow",
          decisionSource: "config",
        },
        match: POST,
      },
      60,
    ),
  };
}

/** The part of a fact a client paints: everything but the silent bookkeeping (ts/seq/sources/source). */
function visible(e: CrowEvent): Omit<CrowEvent, "id" | "ts" | "seq" | "sources" | "source"> {
  const { id: _id, ts: _ts, seq: _seq, sources: _sources, source: _source, ...rest } = e;
  return rest;
}

describe("reconcile: a tool call across transcript, hook and OTel (R11)", () => {
  test("all 720 arrival orders of the 6 contributions yield the same 2 facts", () => {
    // Covers: R11
    const names = Object.keys(toolLanes());
    const orders = permutations(names);
    expect(orders).toHaveLength(720);

    // Migrate once; each permutation starts from a cheap deserialized copy of the empty schema.
    const template = freshDb().serialize();
    const problems: string[] = [];
    let expected: Omit<CrowEvent, "id">[] | null = null;
    for (const order of orders) {
      const db = Database.deserialize(template);
      const deps = makeDeps();
      const lanes = toolLanes();
      const published: CrowEvent[] = [];
      for (const name of order) published.push(...ingest(db, deps, lanes[name]!));

      // Row order follows arrival (ids); the facts are compared by kind.
      const facts = factRows(db).sort((a, b) => (a.kind < b.kind ? 1 : -1));
      if (facts.length !== 2) problems.push(`${order.join(",")}: ${facts.length} facts`); // BD2
      const normalized = facts.map(withoutId);
      const first = expected === null;
      if (expected === null) expected = normalized;
      else if (JSON.stringify(normalized) !== JSON.stringify(expected)) {
        problems.push(`${order.join(",")}: facts differ`);
      }

      // The ids are immutable and every revision points at one of them; a live client folding
      // the published stream converges to what REST serves.
      const ids = new Set(facts.map((f) => f.id));
      for (const r of revisionRows(db)) {
        if (!ids.has(r.revision!.of)) problems.push(`${order.join(",")}: dangling revision`);
      }
      const client = new Map<string, CrowEvent>();
      for (const e of published) {
        if (e.kind === "revision") client.set(e.revision!.of, e.revision!.fact);
        else client.set(e.id, e);
      }
      for (const f of facts) {
        if (JSON.stringify(visible(client.get(f.id)!)) !== JSON.stringify(visible(f))) {
          problems.push(`${order.join(",")}: client diverges`);
        }
      }
      if (!first) continue;

      // Per-field precedence (every other order is identical to this one, checked above).
      const [pre, post] = facts as [CrowEvent, CrowEvent];
      expect(pre.kind).toBe("tool.pre");
      expect(pre.tool?.input).toEqual({ command: "ls" }); // input from the transcript
      expect(pre.tool?.verdict).toBe("allow");
      expect(pre.tool?.decisionSource).toBe("user"); // the only lane that says it
      expect(pre.ts).toBe(T0 + 1000);
      expect(pre.seq).toBe(10);
      expect(pre.sources).toEqual(["transcript", "hook", "otel"]);
      expect(post.kind).toBe("tool.post");
      expect(post.tool?.ms).toBe(250); // ms from the engine ...
      expect(post.tool?.msSource).toBe("engine");
      expect(post.tool?.verdict).toBe("allow");
      expect(post.tool?.decisionSource).toBe("hook"); // ... verdict from the hook
      expect(post.tool?.ok).toBe(true);
      expect(post.ts).toBe(T0 + 1300);
    }
    expect(problems).toEqual([]);
  });

  test("with only the hook and the transcript, ms comes from the hook-receipt fallback ranking", () => {
    // Covers: R11 — `ms` from the hook lane when no engine measurement exists
    const db = freshDb();
    const lanes = toolLanes();
    ingest(db, makeDeps(), lanes.postTranscript!, lanes.postHook!);
    const [post] = factRows(db);
    expect(post!.tool?.ms).toBe(40);
    expect(post!.tool?.msSource).toBe("hook-receipt");
  });

  test("OTel first creates the row; the transcript then fills input and emits a revision (BD2)", () => {
    // Covers: R11
    const db = freshDb();
    const deps = makeDeps();
    const lanes = toolLanes();

    const [created] = ingest(db, deps, lanes.otelDecision!);
    expect(created!.kind).toBe("tool.pre");
    expect(created!.tool?.input).toBeUndefined();

    const out = ingest(db, deps, lanes.preTranscript!);
    expect(out).toHaveLength(1);
    const revision = out[0]!;
    expect(revision.kind).toBe("revision");
    expect(revision.revision!.of).toBe(created!.id);
    expect(revision.id > created!.id).toBe(true);
    expect(revision.revision!.fact.id).toBe(created!.id); // the fact keeps its id
    expect(revision.revision!.fact.tool?.input).toEqual({ command: "ls" });
    expect(revision.revision!.fact.usage).toBeUndefined();
    expect(factRows(db)).toHaveLength(1);
  });

  test("a fusion that changes nothing painted publishes nothing", () => {
    // Covers: R11 — silent fusion (same input and text in both lanes)
    const db = freshDb();
    const deps = makeDeps();
    const input = { command: "ls" };
    ingest(
      db,
      deps,
      pending("transcript", {
        kind: "tool.pre",
        ts: T0 + 10,
        tool: { name: "Bash", callId: "c9", input },
        match: { key: "tool-pre:c9", mode: "exact" },
      }),
    );
    const out = ingest(
      db,
      deps,
      pending("hook", {
        kind: "tool.pre",
        ts: T0 + 20,
        tool: { name: "Bash", callId: "c9", input: { command: "ls" } },
        match: { key: "tool-pre:c9", mode: "exact" },
      }),
    );
    expect(out).toEqual([]);
    expect(revisionRows(db)).toHaveLength(0);
    expect(factRows(db)[0]!.sources).toEqual(["transcript", "hook"]);
  });

  test("the same lane contributing twice to an exact key is a duplicate, counted and dropped", () => {
    // Covers: R11
    const db = freshDb();
    const deps = makeDeps();
    const make = (): PendingEvent =>
      pending("hook", {
        kind: "tool.pre",
        ts: T0 + 10,
        tool: { name: "Bash", callId: "c2" },
        match: { key: "tool-pre:c2", mode: "exact" },
      });
    ingest(db, deps, make());
    const out = ingest(db, deps, make());
    expect(out).toEqual([]);
    expect(factRows(db)).toHaveLength(1);
    expect(stats(db).laneDuplicates).toBe(1);
  });

  test("a tool.error from any lane makes the fused fact a tool.error", () => {
    // Covers: R11 — kind precedence (tool.post vs tool.error)
    for (const order of permutations(["ok", "err"])) {
      const db = freshDb();
      const deps = makeDeps();
      const lanes: Record<string, PendingEvent> = {
        ok: pending("transcript", {
          kind: "tool.post",
          ts: T0 + 5,
          tool: { name: "Bash", callId: "c3" },
          match: { key: "tool-post:c3", mode: "exact" },
        }),
        err: pending("hook", {
          kind: "tool.error",
          ts: T0 + 6,
          tool: { name: "Bash", callId: "c3" },
          error: { message: "boom" },
          match: { key: "tool-post:c3", mode: "exact" },
        }),
      };
      for (const name of order) ingest(db, deps, lanes[name]!);
      const [fact] = factRows(db);
      expect(fact!.kind).toBe("tool.error");
      expect(fact!.error?.message).toBe("boom");
    }
  });

  test("REST serves the fused fact at its original place; an older cursor also receives the revision", () => {
    // Covers: R11
    const db = freshDb();
    const deps = makeDeps();
    const lanes = toolLanes();
    const [first] = ingest(db, deps, lanes.otelResult!); // tool.post created by OTel
    const [other] = ingest(db, deps, pending("transcript", { kind: "prompt", ts: T0, text: "hi" }));
    const [rev] = ingest(db, deps, lanes.postTranscript!); // ok:true, ms transcript < engine

    const page = listSessionEvents(db, "claude:s1", null, 100)!;
    expect(page.events.map((e) => e.id)).toEqual([first!.id, other!.id, rev!.id]);
    expect(page.events[0]!.id).toBe(first!.id);
    expect(page.events[0]!.tool?.ok).toBe(true); // fused in place
    const replay = listEventsAfter(db, {
      after: first!.id,
      projects: [],
      sessionId: null,
      limit: 10,
    });
    expect(replay.map((e) => e.kind)).toEqual(["prompt", "revision"]);
  });
});

// ---------------------------------------------------------------------------
// R13: prompts, session start, agents, compaction: one fact whatever the lanes/orders
// ---------------------------------------------------------------------------

describe("reconcile: one logical fact across lanes (R13)", () => {
  test("a Claude prompt in the 3 lanes, in all 6 orders, is one fact with the transcript text", () => {
    // Covers: R13
    const match = { key: "prompt@main:p1", mode: "exact" } as const;
    for (const order of permutations(["transcript", "hook", "otel"] as const)) {
      const db = freshDb();
      const deps = makeDeps();
      const texts = {
        transcript: "fix the bug please",
        hook: "fix the bug",
        otel: "fix",
      };
      for (const lane of order) {
        ingest(
          db,
          deps,
          pending(lane, {
            kind: "prompt",
            ts: T0 + 10,
            text: texts[lane],
            match,
          }),
        );
      }
      const facts = factRows(db);
      expect(facts).toHaveLength(1);
      expect(facts[0]!.text).toBe("fix the bug please");
      expect(facts[0]!.sources).toEqual(["transcript", "hook", "otel"]);
      expect(getSessionDetail(db, "claude:s1")!.session.lastPrompt).toBe("fix the bug please");
    }
  });

  test("a Codex prompt (nearest, fingerprint) fuses across lanes; distinct prompts and repeats stay apart", () => {
    // Covers: R13
    const spec = (fingerprint: string) =>
      ({
        key: "prompt@main",
        mode: "nearest",
        windowMs: 10_000,
        fingerprint,
      }) as const;
    for (const order of permutations(["transcript", "hook"] as const)) {
      const db = freshDb();
      const deps = makeDeps();
      for (const lane of order) {
        ingest(
          db,
          deps,
          pending(lane, {
            kind: "prompt",
            ts: T0 + (lane === "hook" ? 800 : 0),
            text: "hello",
            match: spec("fp-hello"),
          }),
        );
      }
      expect(factRows(db)).toHaveLength(1);
    }

    // outside the window: its own fact, even with the same fingerprint
    const far = freshDb();
    ingest(
      far,
      makeDeps(),
      pending("transcript", {
        kind: "prompt",
        ts: T0,
        text: "a",
        match: spec("fp-a"),
      }),
    );
    ingest(
      far,
      makeDeps(),
      pending("hook", {
        kind: "prompt",
        ts: T0 + 60_000,
        text: "a",
        match: spec("fp-a"),
      }),
    );
    expect(factRows(far)).toHaveLength(2);

    // the same lane twice (an identical prompt typed again) never fuses with itself
    const twice = freshDb();
    ingest(
      twice,
      makeDeps(),
      pending("transcript", {
        kind: "prompt",
        ts: T0,
        text: "a",
        match: spec("fp-a"),
      }),
    );
    ingest(
      twice,
      makeDeps(),
      pending("transcript", {
        kind: "prompt",
        ts: T0 + 1000,
        text: "a",
        match: spec("fp-a"),
      }),
    );
    expect(factRows(twice)).toHaveLength(2);

    // two candidates in the window: the same fingerprint wins
    const two = freshDb();
    ingest(
      two,
      makeDeps(),
      pending("transcript", {
        kind: "prompt",
        ts: T0,
        text: "a",
        match: spec("fp-a"),
      }),
    );
    ingest(
      two,
      makeDeps(),
      pending("transcript", {
        kind: "prompt",
        ts: T0 + 500,
        text: "b",
        match: spec("fp-b"),
      }),
    );
    ingest(
      two,
      makeDeps(),
      pending("hook", {
        kind: "prompt",
        ts: T0 + 600,
        text: "b",
        match: spec("fp-b"),
      }),
    );
    const facts = factRows(two);
    expect(facts).toHaveLength(2);
    expect(facts.find((f) => f.text === "a")!.sources).toEqual(["transcript"]);
    expect(facts.find((f) => f.text === "b")!.sources).toEqual(["transcript", "hook"]);
  });

  test("a Codex prompt as the rollout and the hook emit it (trimmed-text sha1, seconds apart) is one fact per turn", () => {
    // Covers: R13
    // Same key shape as codex `map-line.ts` and `hook.ts`: fingerprint = sha1(text.trim()).
    const spec = (text: string) =>
      ({
        key: "prompt@main",
        mode: "nearest",
        windowMs: 10_000,
        fingerprint: createHash("sha1").update(text.trim()).digest("hex"),
      }) as const;
    const turn = (text: string, at: number) => ({
      transcript: pending("transcript", { kind: "prompt", ts: at, text, match: spec(text) }, 10),
      hook: pending(
        "hook",
        {
          kind: "prompt",
          ts: at + 3000,
          text: `${text}\n`,
          match: spec(`${text}\n`),
        },
        20,
      ),
    });
    const first = turn("run the tests", T0);
    const second = turn("now fix them", T0 + 60_000);
    const parts = {
      t1: first.transcript,
      h1: first.hook,
      t2: second.transcript,
      h2: second.hook,
    };
    const orders = permutations(Object.keys(parts));
    expect(orders).toHaveLength(24);
    for (const order of orders) {
      const db = freshDb();
      const deps = makeDeps();
      for (const name of order) ingest(db, deps, parts[name as keyof typeof parts]);
      const facts = factRows(db);
      expect(facts).toHaveLength(2);
      expect(facts.map((f) => f.sources).every((s) => s?.length === 2)).toBe(true);
    }
  });

  test("session start (transcript + hook) is one fact in both orders", () => {
    // Covers: R13
    const match = { key: "session-start@main", mode: "exact" } as const;
    for (const order of permutations(["transcript", "hook"] as const)) {
      const db = freshDb();
      const deps = makeDeps();
      for (const lane of order) {
        ingest(
          db,
          deps,
          pending(lane, {
            kind: "session.start",
            ts: T0 + (lane === "hook" ? 5 : 0),
            match,
          }),
        );
      }
      expect(factRows(db)).toHaveLength(1);
    }
  });

  test("subagent start and stop (transcript + hook) are one fact each and one agent row, in all orders", () => {
    // Covers: R13
    const parts = {
      startT: pending("transcript", {
        kind: "agent.start",
        agentId: "a1",
        ts: T0 + 100,
        agent: { type: "explorer", description: "look around", depth: 1 },
        match: { key: "agent-start:a1", mode: "exact" },
      }),
      startH: pending("hook", {
        kind: "agent.start",
        agentId: "a1",
        ts: T0 + 110,
        agent: { type: "explorer" },
        match: { key: "agent-start:a1", mode: "exact" },
      }),
      stopT: pending("transcript", {
        kind: "agent.stop",
        agentId: "a1",
        ts: T0 + 200,
        match: { key: "agent-stop:a1", mode: "exact" },
      }),
      stopH: pending("hook", {
        kind: "agent.stop",
        agentId: "a1",
        ts: T0 + 210,
        match: { key: "agent-stop:a1", mode: "exact" },
      }),
    };
    const orders = permutations(Object.keys(parts));
    expect(orders).toHaveLength(24);
    for (const order of orders) {
      const db = freshDb();
      const deps = makeDeps();
      for (const name of order) ingest(db, deps, parts[name as keyof typeof parts]);
      const facts = factRows(db);
      expect(facts.filter((f) => f.kind === "agent.start")).toHaveLength(1);
      expect(facts.filter((f) => f.kind === "agent.stop")).toHaveLength(1);
      const detail = getSessionDetail(db, "claude:s1")!;
      expect(detail.agents).toHaveLength(1);
      expect(detail.agents[0]!.status).toBe("done");
      expect(detail.agents[0]!.type).toBe("explorer");
      expect(detail.agents[0]!.description).toBe("look around");
      expect(detail.agents[0]!.endedAt).not.toBeNull();
    }
  });

  test("a compaction (hook:pre, hook:post, transcript) is one fact in all 6 orders; trigger from pre, endedAt from post", () => {
    // Covers: R13
    const match = {
      key: "compact@main",
      mode: "nearest",
      windowMs: 600_000,
    } as const;
    const parts = {
      pre: pending("hook", {
        kind: "compact",
        ts: T0 + 1000,
        compact: { trigger: "auto", startedAt: T0 + 1000 },
        match: { ...match, role: "hook:pre" },
      }),
      post: pending("hook", {
        kind: "compact",
        ts: T0 + 4000,
        compact: { endedAt: T0 + 4000 },
        match: { ...match, role: "hook:post" },
      }),
      transcript: pending("transcript", {
        kind: "compact",
        ts: T0 + 2000,
        compact: { trigger: "manual", startedAt: T0 + 2000 },
        match,
      }),
    };
    for (const order of permutations(Object.keys(parts))) {
      const db = freshDb();
      const deps = makeDeps();
      for (const name of order) ingest(db, deps, parts[name as keyof typeof parts]);
      const facts = factRows(db);
      expect(facts).toHaveLength(1);
      expect(facts[0]!.compact).toEqual({
        trigger: "auto", // hook:pre outranks the transcript
        startedAt: T0 + 1000,
        endedAt: T0 + 4000,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// BD1: effects guarded by ts, so a late fusion cannot regress state
// ---------------------------------------------------------------------------

describe("reconcile: non-monotone effects (BD1)", () => {
  test("(1) P1 by hook, then P2, then P1 fused from the transcript: last_prompt stays P2", () => {
    // Covers: R11, R13
    const db = freshDb();
    const deps = makeDeps();
    const p1 = { key: "prompt@main:p1", mode: "exact" } as const;
    const p2 = { key: "prompt@main:p2", mode: "exact" } as const;
    ingest(db, deps, pending("hook", { kind: "prompt", ts: T0 + 100, text: "P1", match: p1 }));
    ingest(db, deps, pending("hook", { kind: "prompt", ts: T0 + 200, text: "P2", match: p2 }));
    expect(getSessionDetail(db, "claude:s1")!.session.lastPrompt).toBe("P2");

    const out = ingest(
      db,
      deps,
      pending("transcript", {
        kind: "prompt",
        ts: T0 + 95,
        text: "P1 (full text)",
        match: p1,
      }),
    );
    expect(out.map((e) => e.kind)).toEqual(["revision"]); // the fact itself was fused
    const session = getSessionDetail(db, "claude:s1")!.session;
    expect(session.lastPrompt).toBe("P2");
    expect(session.lastPromptAt).toBe(T0 + 200);
  });

  test("(2) SubagentStop first, then the transcript's agent.start fused: the agent stays finished", () => {
    // Covers: R13
    const db = freshDb();
    const deps = makeDeps();
    ingest(
      db,
      deps,
      pending("hook", {
        kind: "agent.start",
        agentId: "a1",
        ts: T0 + 100,
        match: { key: "agent-start:a1", mode: "exact" },
      }),
    );
    ingest(
      db,
      deps,
      pending("hook", {
        kind: "agent.stop",
        agentId: "a1",
        ts: T0 + 300,
        match: { key: "agent-stop:a1", mode: "exact" },
      }),
    );
    const out = ingest(
      db,
      deps,
      pending("transcript", {
        kind: "agent.start",
        agentId: "a1",
        ts: T0 + 90,
        agent: { type: "explorer" },
        match: { key: "agent-start:a1", mode: "exact" },
      }),
    );
    expect(out.map((e) => e.kind)).toEqual(["revision"]);
    const detail = getSessionDetail(db, "claude:s1")!;
    expect(detail.agents[0]!.status).toBe("done");
    expect(detail.agents[0]!.endedAt).toBe(T0 + 300);
    expect(detail.agents[0]!.type).toBe("explorer"); // metadata still filled
    expect(detail.session.activeAgent).toBeNull();
  });

  test("(3) SessionEnd by hook, then a fused event with a smaller ts: the session stays ended", () => {
    // Covers: R11
    const db = freshDb();
    const deps = makeDeps(T0 + 1000);
    ingest(db, deps, pending("hook", { kind: "session.end", ts: T0 + 500 }));
    ingest(
      db,
      deps,
      pending("hook", {
        kind: "prompt",
        ts: T0 + 100,
        text: "old",
        match: { key: "prompt@main:old", mode: "exact" },
      }),
    );
    ingest(
      db,
      deps,
      pending("transcript", {
        kind: "prompt",
        ts: T0 + 90,
        text: "old, full",
        match: { key: "prompt@main:old", mode: "exact" },
      }),
    );
    expect(getSessionDetail(db, "claude:s1")!.session.status).toBe("ended");
  });
});

describe("nearest matching: the fingerprint is required when both sides carry one (R13)", () => {
  const spec = (fingerprint?: string) =>
    ({
      key: "prompt@main",
      mode: "nearest",
      windowMs: 10_000,
      fingerprint,
    }) as const;
  const prompt = (
    source: "transcript" | "hook",
    ts: number,
    text: string,
    fingerprint?: string,
  ): PendingEvent => pending(source, { kind: "prompt", ts, text, match: spec(fingerprint) });

  // Covers: R13
  test("distinct prompts inside the window never fuse; each later counterpart joins its own", () => {
    const db = freshDb();
    const deps = makeDeps();
    ingest(db, deps, prompt("transcript", T0, "a", "fp-a"));
    ingest(db, deps, prompt("hook", T0 + 3000, "b", "fp-b"));
    expect(factRows(db)).toHaveLength(2);

    ingest(db, deps, prompt("hook", T0 + 100, "a", "fp-a"));
    ingest(db, deps, prompt("transcript", T0 + 3100, "b", "fp-b"));
    const facts = factRows(db);
    expect(facts).toHaveLength(2);
    expect(facts.find((f) => f.text === "a")!.sources).toEqual(["transcript", "hook"]);
    expect(facts.find((f) => f.text === "b")!.sources).toEqual(["transcript", "hook"]);
  });

  // Covers: R13
  test("the same text within the window is one fact", () => {
    const db = freshDb();
    const deps = makeDeps();
    ingest(db, deps, prompt("transcript", T0, "a", "fp-a"));
    ingest(db, deps, prompt("hook", T0 + 3000, "a", "fp-a"));
    expect(factRows(db)).toHaveLength(1);
  });

  // Covers: R13
  test("a side without a fingerprint still fuses by window, in either direction", () => {
    for (const [first, second] of [
      [prompt("transcript", T0, "a", "fp-a"), prompt("hook", T0 + 500, "a")],
      [prompt("transcript", T0, "a"), prompt("hook", T0 + 500, "a", "fp-a")],
    ] as const) {
      const db = freshDb();
      const deps = makeDeps();
      ingest(db, deps, first);
      ingest(db, deps, second);
      expect(factRows(db)).toHaveLength(1);
    }
  });
});

describe("reconcile: a Codex child's start and stop across lanes (R13, R35)", () => {
  const startKey = { key: "agent-start:kid", mode: "exact" } as const;
  const stopKey = { key: "agent-stop:kid", mode: "exact" } as const;
  const codex = (p: PendingEvent): PendingEvent => ({ ...p, engine: "codex" });
  const lanes = (): Record<string, PendingEvent> => ({
    startTranscript: codex(
      pending("transcript", {
        sessionId: "root",
        agentId: "kid",
        kind: "agent.start",
        ts: T0 + 10,
        agent: { type: "worker" },
        match: startKey,
      }),
    ),
    startHook: codex(
      pending("hook", {
        sessionId: "root",
        agentId: "kid",
        kind: "agent.start",
        ts: T0 + 11,
        agent: { type: "worker" },
        match: startKey,
      }),
    ),
    startOtel: codex(
      pending("otel", {
        sessionId: "root",
        agentId: "kid",
        kind: "agent.start",
        ts: T0 + 9,
        match: startKey,
      }),
    ),
    // The Codex rollout emits no `agent.stop` today: a synthetic second stop lane.
    stopTranscript: codex(
      pending("transcript", {
        sessionId: "root",
        agentId: "kid",
        kind: "agent.stop",
        ts: T0 + 50,
        match: stopKey,
      }),
    ),
    stopHook: codex(
      pending("hook", {
        sessionId: "root",
        agentId: "kid",
        kind: "agent.stop",
        ts: T0 + 51,
        match: stopKey,
      }),
    ),
  });

  test("all 120 orders of 3 starts and 2 stops give one start fact, one stop fact and one agent row", () => {
    // Covers: R13, R35
    const names = Object.keys(lanes());
    const orders = permutations(names);
    expect(orders).toHaveLength(120);
    const template = freshDb().serialize();
    for (const order of orders) {
      const db = Database.deserialize(template);
      const deps = makeDeps();
      const all = lanes();
      for (const name of order) ingest(db, deps, all[name]!);
      const facts = factRows(db, "codex:root");
      const label = order.join(",");
      expect({ label, starts: facts.filter((f) => f.kind === "agent.start").length }).toEqual({
        label,
        starts: 1,
      });
      expect({ label, stops: facts.filter((f) => f.kind === "agent.stop").length }).toEqual({
        label,
        stops: 1,
      });
      const rows = db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM agents WHERE agent_id = 'kid'")
        .get();
      expect({ label, rows: rows?.n }).toEqual({ label, rows: 1 });
    }
  });

  test("a hook's null parent never overrides the parent an OTel spawn carried, in either order (D19)", () => {
    // Covers: R13, R35
    for (const order of permutations(["hook", "otel"] as const)) {
      const db = freshDb();
      const deps = makeDeps();
      const parented = (source: "hook" | "otel"): PendingEvent =>
        codex(
          pending(source, {
            sessionId: "root",
            agentId: "Y",
            parentAgentId: source === "otel" ? "K" : null,
            kind: "agent.start",
            ts: T0 + 1,
            match: { key: "agent-start:Y", mode: "exact" },
          }),
        );
      for (const source of order) ingest(db, deps, parented(source));
      const facts = factRows(db, "codex:root");
      expect(facts).toHaveLength(1);
      expect(facts[0]!.parentAgentId).toBe("K");
    }
  });
});

describe("reconcile: a null parentAgentId means absent, also for Claude (D19)", () => {
  const start = (source: "transcript" | "hook", parentAgentId: string | null): PendingEvent =>
    pending(source, {
      sessionId: "s1",
      agentId: "kid",
      parentAgentId,
      kind: "agent.start",
      ts: T0 + 1,
      match: { key: "agent-start:kid", mode: "exact" },
    });

  test("a transcript's null parent never overrides a hook's parent, in either order", () => {
    // Covers: R13
    for (const order of permutations(["transcript", "hook"] as const)) {
      const db = freshDb();
      const deps = makeDeps();
      for (const source of order)
        ingest(db, deps, start(source, source === "hook" ? "main-agent" : null));
      const facts = factRows(db).filter((f) => f.kind === "agent.start");
      expect({ order: order.join(","), n: facts.length }).toEqual({ order: order.join(","), n: 1 });
      expect({ order: order.join(","), parent: facts[0]!.parentAgentId }).toEqual({
        order: order.join(","),
        parent: "main-agent",
      });
    }
  });
});
