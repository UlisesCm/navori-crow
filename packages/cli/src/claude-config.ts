/**
 * Claude Code side of attach/detach (design.md D13/D14): the unit is one crow handler
 * (`command` + `async`, the transport B0 chose) inside `settings.json` `hooks.<Event>`.
 */
import { detectIndent } from "./diff";
import {
  AttachError,
  CLAUDE_EVENTS,
  HOOK_TIMEOUT_S,
  crowCommandRe,
  isRecord,
  sameData,
} from "./attach-common";
import type { AttachContext, Manifest, ManifestUnit } from "./attach-common";

type Obj = Record<string, unknown>;

/** Content-logging flags of Claude's `env` (R24); attach never writes them. */
const CONTENT_ENV = [
  "OTEL_LOG_USER_PROMPTS",
  "OTEL_LOG_ASSISTANT_RESPONSES",
  "OTEL_LOG_TOOL_DETAILS",
  "OTEL_LOG_TOOL_CONTENT",
] as const;

const HTTP_SIGNATURE = /^http:\/\/(127\.0\.0\.1|localhost):\d+\/ingest\/hook\/claude$/;
const HANDLER_KEYS = new Set(["type", "command", "async", "timeout"]);

/** The handler crow registers for every event. */
export function claudeHandler(ctx: AttachContext): Obj {
  return { type: "command", command: ctx.hookCommand, async: true, timeout: HOOK_TIMEOUT_S };
}

/** Whether a handler carries crow's signature (D13): command suffix or loopback ingest URL. */
export function isCrowClaudeHandler(h: unknown): boolean {
  if (!isRecord(h)) return false;
  if (h["type"] === "command" && typeof h["command"] === "string") {
    return crowCommandRe("claude").test(h["command"]);
  }
  return h["type"] === "http" && typeof h["url"] === "string" && HTTP_SIGNATURE.test(h["url"]);
}

/** Parses `settings.json` (R27): blank means `{}`; anything unparseable aborts. */
export function parseClaudeSettings(text: string | null, path: string): Obj {
  if (text === null || text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new AttachError(
      `cannot parse ${path}: ${err instanceof Error ? err.message : String(err)}; nothing written`,
    );
  }
  if (!isRecord(parsed))
    throw new AttachError(`cannot parse ${path}: not a JSON object; nothing written`);
  return parsed;
}

/** Handlers per event, validating the shape crow is about to edit. */
function groupsOf(settings: Obj, event: string, path: string): Obj[] | undefined {
  const hooks = settings["hooks"];
  if (hooks === undefined) return undefined;
  if (!isRecord(hooks))
    throw new AttachError(`cannot edit ${path}: "hooks" is not an object; nothing written`);
  const groups = hooks[event];
  if (groups === undefined) return undefined;
  const ok = Array.isArray(groups) && groups.every((g) => isRecord(g) && Array.isArray(g["hooks"]));
  if (!ok)
    throw new AttachError(
      `cannot edit ${path}: hooks.${event} has an unexpected shape; nothing written`,
    );
  return groups as Obj[];
}

function hasCrow(groups: Obj[] | undefined): boolean {
  return (groups ?? []).some((g) => (g["hooks"] as unknown[]).some(isCrowClaudeHandler));
}

/** Serializes with the file's own indentation (D13). */
export function serializeClaude(settings: Obj, before: string | null): string {
  const indent = before !== null && before.trim() !== "" ? detectIndent(before) : "  ";
  return `${JSON.stringify(settings, null, indent)}\n`;
}

/** Copy of `settings` with every crow handler removed and emptied containers pruned. */
function withoutCrow(settings: Obj): Obj {
  const copy = JSON.parse(JSON.stringify(settings)) as Obj;
  const hooks = copy["hooks"];
  if (!isRecord(hooks)) return copy;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = (groups as Obj[])
      .map((g) => ({
        ...g,
        hooks: (g["hooks"] as unknown[]).filter((h) => !isCrowClaudeHandler(h)),
      }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete copy["hooks"];
  return copy;
}

/** Result of {@link planClaudeAttach}. */
export interface ClaudeAttachPlan {
  after: string;
  /** Events that gained a crow handler; empty means already attached (R25). */
  added: string[];
  manifest: Manifest;
  warnings: string[];
}

/** Computes the attach change; pure. Verifies that only crow handlers were added. */
export function planClaudeAttach(
  before: string | null,
  prior: Manifest | null,
  ctx: AttachContext,
): ClaudeAttachPlan {
  const settings = parseClaudeSettings(before, ctx.configPath);
  const next = JSON.parse(JSON.stringify(settings)) as Obj;
  const created = {
    hooks: prior?.created.hooks ?? false,
    events: [...(prior?.created.events ?? [])],
  };
  const added: string[] = [];
  const units: ManifestUnit[] = [...(prior?.units ?? [])];
  const handler = claudeHandler(ctx);
  for (const event of CLAUDE_EVENTS) {
    if (hasCrow(groupsOf(next, event, ctx.configPath))) continue; // R25
    if (next["hooks"] === undefined) {
      next["hooks"] = {};
      created.hooks = true;
    }
    const hooks = next["hooks"] as Obj;
    if (hooks[event] === undefined) {
      hooks[event] = [];
      created.events.push(event);
    }
    (hooks[event] as Obj[]).push({ hooks: [{ ...handler }] });
    units.push({ event, value: { ...handler } });
    added.push(event);
  }
  if (added.length > 0 && !sameData(withoutCrow(next), withoutCrow(settings))) {
    throw new AttachError("cannot verify the attach result; nothing written");
  }
  const warnings: string[] = [];
  const env = settings["env"];
  if (isRecord(env)) {
    for (const flag of CONTENT_ENV) {
      const v = env[flag];
      if (v !== undefined && v !== "0" && v !== "false" && v !== false && v !== "") {
        warnings.push(`${flag} is enabled in your settings; crow did not set it (R24)`);
      }
    }
  }
  return {
    after: added.length > 0 ? serializeClaude(next, before) : (before ?? ""),
    added,
    manifest: { version: 1, engine: "claude", configPath: ctx.configPath, units, created },
    warnings,
  };
}

/** Result of {@link planClaudeDetach}. */
export interface ClaudeDetachPlan {
  after: string;
  removed: string[];
  /** Crow handlers the user edited; kept as they are. */
  kept: Array<{ event: string; reason: string }>;
  manifest: Manifest | null;
}

/** Whether a crow handler is exactly what crow wrote (manifest value, else a canonical shape). */
function isIntact(event: string, handler: unknown, prior: Manifest | null): boolean {
  if (!isRecord(handler)) return false;
  if (prior !== null) {
    return prior.units.some((u) => u.event === event && sameData(u.value, handler));
  }
  return handler["type"] === "command" && Object.keys(handler).every((k) => HANDLER_KEYS.has(k));
}

/**
 * Computes the detach change (R26). Intact crow handlers go, edited ones stay and are
 * reported, everything else is untouched. Aborts if the result is not exactly the
 * original minus the removed handlers.
 */
export function planClaudeDetach(
  before: string,
  prior: Manifest | null,
  ctx: AttachContext,
): ClaudeDetachPlan {
  const settings = parseClaudeSettings(before, ctx.configPath);
  const next = JSON.parse(JSON.stringify(settings)) as Obj;
  const removed: string[] = [];
  const removedHandlers: Array<{ event: string; handler: unknown }> = [];
  const kept: Array<{ event: string; reason: string }> = [];
  const hooks = next["hooks"];
  if (hooks !== undefined) {
    for (const event of Object.keys(isRecord(hooks) ? hooks : {})) {
      const groups = groupsOf(next, event, ctx.configPath) ?? [];
      const survivors: Obj[] = [];
      for (const group of groups) {
        const list = group["hooks"] as unknown[];
        const remaining = list.filter((h) => {
          if (!isCrowClaudeHandler(h)) return true;
          if (isIntact(event, h, prior)) {
            removed.push(event);
            removedHandlers.push({ event, handler: h });
            return false;
          }
          kept.push({ event, reason: "edited since attach" });
          return true;
        });
        if (remaining.length > 0 || remaining.length === list.length) {
          survivors.push({ ...group, hooks: remaining });
        }
      }
      const hooksObj = hooks as Obj;
      if (survivors.length > 0) hooksObj[event] = survivors;
      else if (groups.length > 0 && (prior === null || prior.created.events.includes(event))) {
        delete hooksObj[event];
      } else hooksObj[event] = survivors;
    }
    if (
      isRecord(hooks) &&
      Object.keys(hooks).length === 0 &&
      (prior === null || prior.created.hooks)
    ) {
      delete next["hooks"];
    }
  }
  if (removed.length === 0) return { after: before, removed, kept, manifest: prior };

  // Semantic check: same non-hook data, and the flattened handlers equal the original minus removed.
  const flat = (s: Obj): Array<{ event: string; matcher: unknown; handler: unknown }> => {
    const h = s["hooks"];
    if (!isRecord(h)) return [];
    return Object.entries(h).flatMap(([event, groups]) =>
      (groups as Obj[]).flatMap((g) =>
        (g["hooks"] as unknown[]).map((handler) => ({ event, matcher: g["matcher"], handler })),
      ),
    );
  };
  const expected = flat(settings);
  for (const r of removedHandlers) {
    const i = expected.findIndex((e) => e.event === r.event && sameData(e.handler, r.handler));
    if (i >= 0) expected.splice(i, 1);
  }
  const { hooks: _a, ...restBefore } = settings;
  const { hooks: _b, ...restAfter } = next;
  if (!sameData(restBefore, restAfter) || !sameData(expected, flat(next))) {
    throw new AttachError("cannot verify the detach result; nothing written");
  }
  const remainingUnits = (prior?.units ?? []).filter(
    (u) => !removedHandlers.some((r) => r.event === u.event && sameData(r.handler, u.value)),
  );
  return {
    after: serializeClaude(next, before),
    removed,
    kept,
    manifest: prior === null ? null : { ...prior, units: remainingUnits },
  };
}
