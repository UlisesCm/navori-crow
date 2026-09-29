/**
 * Engine adapter registry (design.md § Components `apps/server`). B5 registers
 * Claude and Codex (roots from `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, via config).
 */
import type { BoundAdapter } from "@crow/core";
import { bindAdapter } from "@crow/core";
import { claudeAdapter } from "@crow/adapter-claude";
import { codexAdapter } from "@crow/adapter-codex";

export const ENGINE_ADAPTERS: readonly BoundAdapter[] = [
  bindAdapter(claudeAdapter),
  bindAdapter(codexAdapter),
];
