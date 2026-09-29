/**
 * A minimal, engine-agnostic `EngineAdapter` used only by B3's tailer tests
 * (design.md tasks.md B3.T1: "un adaptador de prueba", no real Claude/Codex
 * adapter here — those are B4/B7). Each line is one JSON object mapped
 * almost verbatim to a `PartialCrowEvent`.
 *
 * Lives outside any `*.test.ts` file (so Bun's test runner doesn't try to
 * run it as a suite) but is not production surface: it's not exported from
 * `../../index.ts`.
 */
import type {
  EngineAdapter,
  FileMatch,
  JsonValue,
  LinePos,
  LineResult,
  PartialCrowEvent,
} from "../../adapter";
import type { EventKind } from "../../crow-event";
import { isRec, num, str } from "../../narrow";

/** The `[key: string]: JsonValue` index signature is what lets this satisfy `S extends JsonValue`. */
export interface TestAdapterState {
  [key: string]: JsonValue;
  count: number;
}

export interface TestLineShape {
  sessionId?: string;
  agentId?: string | null;
  parentAgentId?: string | null;
  kind?: EventKind;
  ts?: number;
  text?: string;
  cwd?: string;
  semanticKey?: string;
  usageKey?: string;
}

/** Serializes a {@link TestLineShape} to one JSONL line the test adapter understands. */
export function testLine(shape: TestLineShape): string {
  return JSON.stringify(shape);
}

function opt(v: unknown): string | undefined {
  return str(v) ?? undefined;
}

/** Builds a fresh test adapter; `id` lets a test run two "engines" over the same store. */
export function makeTestAdapter(id = "test"): EngineAdapter<TestAdapterState> {
  return {
    id,
    watchRoots: () => [],
    matches(path: string): FileMatch {
      return { role: "main", groupKey: path, sessionId: null, agentId: null, sidecarPath: null };
    },
    initialState: (): TestAdapterState => ({ count: 0 }),
    restoreState(json: unknown): TestAdapterState | null {
      if (!isRec(json) || typeof json.count !== "number") return null;
      return { count: json.count };
    },
    parseLine(line: string, state: TestAdapterState, _pos: LinePos): LineResult<TestAdapterState> {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return { ok: false, reason: "invalid-json", sessionId: null, agentId: null, state };
      }
      if (!isRec(parsed)) {
        return { ok: false, reason: "bad-shape", sessionId: null, agentId: null, state };
      }
      if (parsed.forceError === "bad-shape") {
        return {
          ok: false,
          reason: "bad-shape",
          sessionId: str(parsed.sessionId) ?? "unknown",
          agentId: typeof parsed.agentId === "string" ? parsed.agentId : null,
          state,
        };
      }

      const event: PartialCrowEvent = {
        sessionId: str(parsed.sessionId) ?? "s1",
        agentId: typeof parsed.agentId === "string" ? parsed.agentId : null,
        parentAgentId: typeof parsed.parentAgentId === "string" ? parsed.parentAgentId : null,
        kind: typeof parsed.kind === "string" ? (parsed.kind as EventKind) : "prompt",
        ts: typeof parsed.ts === "number" ? num(parsed.ts) : Date.now(),
        text: opt(parsed.text),
        cwd: opt(parsed.cwd),
        semanticKey: opt(parsed.semanticKey),
        usageKey: opt(parsed.usageKey),
      };
      return { ok: true, events: [event], state: { count: state.count + 1 } };
    },
  };
}
