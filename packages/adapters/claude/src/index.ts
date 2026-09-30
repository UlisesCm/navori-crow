export { claudeAdapter } from "./adapter";
export { claudeFromHook } from "./hook";
export { claudeFromOtel, claudeOwnsOtel } from "./otel";
export { initialClaudeState, mapClaudeLine, restoreClaudeState } from "./map-line";
export type { ClaudeState } from "./map-line";
export { parseSidecarText, toAgentMetaPatch } from "./sidecar";
export type { ParsedSidecar } from "./sidecar";
