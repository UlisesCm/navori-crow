/**
 * `EngineAdapter<ClaudeState>` for Claude Code (design.md § Components
 * `packages/adapters/claude`, R11–R13). Pure, no I/O: the core tailer reads
 * files and sidecars and hands their text here.
 */
import type { AgentMetaPatch, CrowConfig, EngineAdapter, FileMatch } from "@crow/core";
import { join, relative, sep } from "node:path";
import { initialClaudeState, mapClaudeLine, restoreClaudeState } from "./map-line";
import type { ClaudeState } from "./map-line";
import { parseSidecarText, toAgentMetaPatch } from "./sidecar";

const MAIN_RE = /^([^/]+)\/([^/]+)\.jsonl$/;
const AGENT_RE = /^([^/]+)\/([^/]+)\/subagents\/agent-([^/]+)\.jsonl$/;
const SIDECAR_RE = /^([^/]+)\/([^/]+)\/subagents\/agent-([^/]+)\.meta\.json$/;

/** `matches`: main transcript, subagent transcript, or its `.meta.json` sidecar; `null` for anything else
 * (e.g. `<sessionId>/tool-results/*.txt` or `<sessionId>/memory/*.md`, design.md § Evidencia). */
function matches(path: string, root: string): FileMatch | null {
  const rel = relative(root, path);
  if (rel === "" || rel.startsWith("..")) return null;
  const norm = rel.split(sep).join("/");

  const sidecarMatch = SIDECAR_RE.exec(norm);
  if (sidecarMatch) {
    const slug = sidecarMatch[1]!;
    const sessionId = sidecarMatch[2]!;
    const agentId = sidecarMatch[3]!;
    return {
      role: "sidecar",
      groupKey: `${slug}/${sessionId}`,
      sessionId,
      agentId,
      sidecarPath: path,
    };
  }

  const agentMatch = AGENT_RE.exec(norm);
  if (agentMatch) {
    const slug = agentMatch[1]!;
    const sessionId = agentMatch[2]!;
    const agentId = agentMatch[3]!;
    return {
      role: "agent",
      groupKey: `${slug}/${sessionId}`,
      sessionId,
      agentId,
      sidecarPath: path.replace(/\.jsonl$/, ".meta.json"),
    };
  }

  const mainMatch = MAIN_RE.exec(norm);
  if (mainMatch) {
    const slug = mainMatch[1]!;
    const sessionId = mainMatch[2]!;
    return {
      role: "main",
      groupKey: `${slug}/${sessionId}`,
      sessionId,
      agentId: null,
      sidecarPath: null,
    };
  }

  return null;
}

/** The Claude adapter (design.md § Mapeo Claude). */
export const claudeAdapter: EngineAdapter<ClaudeState> = {
  id: "claude",

  watchRoots(cfg: CrowConfig): string[] {
    return [join(cfg.claudeConfigDir, "projects")];
  },

  matches,

  initialState(_match: FileMatch, sidecarText: string | null): ClaudeState {
    const parsed = sidecarText !== null ? parseSidecarText(sidecarText) : null;
    const meta =
      parsed !== null
        ? {
            type: parsed.type,
            description: parsed.description,
            spawnCallId: parsed.spawnCallId,
            depth: parsed.depth,
          }
        : null;
    return initialClaudeState(meta);
  },

  restoreState(json: unknown, _match: FileMatch): ClaudeState | null {
    return restoreClaudeState(json);
  },

  parseLine: mapClaudeLine,

  parseSidecar(text: string, match: FileMatch): AgentMetaPatch | null {
    const parsed = parseSidecarText(text);
    if (parsed === null) return null;
    return toAgentMetaPatch(parsed, match);
  },
};
