/**
 * Engine adapter registry (design.md § Components `apps/server`). B5 seeds it
 * with Claude only; B8 adds Codex once its adapter lands.
 */
import type { BoundAdapter } from "@crow/core";
import { bindAdapter } from "@crow/core";
import { claudeAdapter } from "@crow/adapter-claude";

export const ENGINE_ADAPTERS: readonly BoundAdapter[] = [bindAdapter(claudeAdapter)];
