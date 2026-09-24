/**
 * Claude subagent sidecar (`agent-<id>.meta.json`), design.md § Components
 * `packages/adapters/claude`. Tolerates corrupt/missing JSON by returning
 * `null` (R12): the caller then keeps whatever it already knew about the
 * agent instead of failing the whole file.
 */
import type { AgentMetaPatch, FileMatch } from "@crow/core";
import { isRec, str } from "@crow/core";

/** The subset of a `.meta.json` sidecar this adapter reads (design.md § Evidencia, Claude § Subagentes). */
export interface ParsedSidecar {
  type: string | null;
  description: string | null;
  spawnCallId: string | null;
  depth: number | null;
}

/** Parses a sidecar's text into its known fields, or `null` if the JSON is missing/corrupt/not an object. */
export function parseSidecarText(text: string): ParsedSidecar | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRec(json)) return null;
  return {
    type: str(json.agentType),
    description: str(json.description),
    spawnCallId: str(json.toolUseId),
    depth: typeof json.spawnDepth === "number" ? json.spawnDepth : null,
  };
}

/** Builds the `AgentMetaPatch` the store applies (`upsertAgentMeta`), or `null` if `match` has no agent identity. */
export function toAgentMetaPatch(parsed: ParsedSidecar, match: FileMatch): AgentMetaPatch | null {
  if (match.sessionId === null || match.agentId === null) return null;
  return {
    sessionId: match.sessionId,
    agentId: match.agentId,
    type: parsed.type ?? undefined,
    description: parsed.description ?? undefined,
    spawnCallId: parsed.spawnCallId ?? undefined,
    depth: parsed.depth ?? undefined,
  };
}
