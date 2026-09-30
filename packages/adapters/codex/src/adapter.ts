/**
 * `EngineAdapter<CodexState>` for Codex CLI (design.md § Components
 * `packages/adapters/codex`, R14). Pure, no I/O: the core tailer reads files
 * and hands their text here.
 */
import type { CrowConfig, EngineAdapter, FileMatch } from "@crow/core";
import { join, relative, sep } from "node:path";
import { codexFromHook } from "./hook";
import { codexFromOtel, codexOwnsOtel } from "./otel";
import { initialCodexState, mapCodexLine, restoreCodexState } from "./map-line";
import type { CodexState } from "./map-line";

// `YYYY/MM/DD/rollout-<YYYY-MM-DDTHH-MM-SS>-<threadId>.jsonl` (design.md § Evidencia, layout confirmado).
const ROLLOUT_RE = /^\d{4}\/\d{2}\/\d{2}\/rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/;

/** `matches`: a rollout file under `<root>/YYYY/MM/DD/`. Main vs. subagent thread isn't knowable from
 * the path alone (design.md § Evidencia: both share the same filename shape) — `map-line.ts` resolves
 * that from the file's own `session_meta` line and overrides `agentId` there. `groupKey` is the path
 * itself (design.md § Components: "`groupKey` = la ruta"). */
function matches(path: string, root: string): FileMatch | null {
  const rel = relative(root, path);
  if (rel === "" || rel.startsWith("..")) return null;
  const norm = rel.split(sep).join("/");

  const match = ROLLOUT_RE.exec(norm);
  if (match === null) return null;
  const threadId = match[1]!;
  return {
    role: "main",
    groupKey: norm,
    sessionId: threadId,
    agentId: null,
    sidecarPath: null,
  };
}

/** The Codex adapter (design.md § Mapeo Codex). */
export const codexAdapter: EngineAdapter<CodexState> = {
  id: "codex",

  watchRoots(cfg: CrowConfig): string[] {
    return [join(cfg.codexHome, "sessions")];
  },

  matches,

  initialState(match: FileMatch, _sidecarText: string | null): CodexState {
    return initialCodexState(match.sessionId ?? "unknown");
  },

  restoreState(json: unknown, _match: FileMatch): CodexState | null {
    return restoreCodexState(json);
  },

  parseLine: mapCodexLine,

  fromHook: codexFromHook,

  ownsOtel: codexOwnsOtel,

  fromOtel: codexFromOtel,
};
