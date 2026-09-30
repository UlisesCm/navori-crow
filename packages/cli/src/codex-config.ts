/**
 * Codex side of attach/detach (design.md D13/D14): the unit is one `[[hooks.<Event>]]` group
 * with its nested `[[hooks.<Event>.hooks]]`, all inside one marked block at the end of
 * `config.toml`. Codex will not run them until the user trusts them (`/hooks`, MF2).
 */
import {
  AttachError,
  CODEX_EVENTS,
  DEFAULT_OTLP_PORT,
  HOOK_TIMEOUT_S,
  crowCommandRe,
  isRecord,
  sameData,
} from "./attach-common";
import type { AttachContext, Manifest, ManifestUnit, OtlpLane } from "./attach-common";

type Obj = Record<string, unknown>;

export const BLOCK_START = "# >>> crow v1 — crow attach codex; remove with: crow detach codex >>>";
export const BLOCK_END = "# <<< crow <<<";

/**
 * Text of the `[otel]` table crow writes (D14, R34): logs to crow's OTLP receiver over
 * HTTP/JSON. `log_user_prompt` is never written (R24).
 */
export function codexOtelText(ctx: AttachContext): string {
  return [
    "[otel]",
    `exporter = { otlp-http = { endpoint = "http://127.0.0.1:${ctx.otlpPort}/v1/logs", protocol = "json" } }`,
  ].join("\n");
}

/** Shape of the `[otel]` table crow wrote, whatever its port (when no manifest remembers it). */
const OTEL_UNIT_RE =
  /^\[otel\]\nexporter = \{ otlp-http = \{ endpoint = "http:\/\/127\.0\.0\.1:\d+\/v1\/logs", protocol = "json" \} \}$/;

/** Text of the group crow writes for one event. */
export function codexGroupText(event: string, ctx: AttachContext): string {
  return [
    `[[hooks.${event}]]`,
    `[[hooks.${event}.hooks]]`,
    `type = "command"`,
    `command = ${JSON.stringify(ctx.hookCommand)}`,
    `timeout = ${HOOK_TIMEOUT_S}`,
  ].join("\n");
}

/** Parses `config.toml` (R27). Uses Bun's parser, not Codex's own (D13 note). */
export function parseCodexConfig(text: string | null, path: string): Obj {
  if (text === null || text.trim() === "") return {};
  try {
    const parsed: unknown = Bun.TOML.parse(text);
    if (isRecord(parsed)) return parsed;
  } catch (err) {
    throw new AttachError(
      `cannot parse ${path}: ${err instanceof Error ? err.message : String(err)}; nothing written`,
    );
  }
  throw new AttachError(`cannot parse ${path}; nothing written`);
}

/** Whether a `[[hooks.X]]` group holds a crow handler (by command signature, D13). */
export function isCrowGroup(group: unknown): boolean {
  if (!isRecord(group) || !Array.isArray(group["hooks"])) return false;
  const re = crowCommandRe("codex");
  return group["hooks"].some(
    (h) => isRecord(h) && typeof h["command"] === "string" && re.test(h["command"]),
  );
}

function eventGroups(parsed: Obj, event: string): unknown[] {
  const hooks = parsed["hooks"];
  const groups = isRecord(hooks) ? hooks[event] : undefined;
  return Array.isArray(groups) ? groups : [];
}

/** Data with crow groups removed and emptied `hooks` containers pruned. */
function normalized(parsed: Obj, dropCrowIn: readonly string[]): unknown {
  const copy = JSON.parse(JSON.stringify(parsed)) as Obj;
  if (dropCrowIn.includes("otel")) delete copy["otel"];
  const hooks = copy["hooks"];
  if (isRecord(hooks)) {
    for (const [event, groups] of Object.entries(hooks)) {
      if (Array.isArray(groups)) {
        let list = groups as unknown[];
        if (dropCrowIn.includes(event)) {
          const i = list.findIndex(isCrowGroup);
          if (i >= 0) list = list.filter((_, j) => j !== i);
        }
        if (list.length > 0) hooks[event] = list;
        else delete hooks[event];
      }
    }
    if (Object.keys(hooks).length === 0) delete copy["hooks"];
  }
  return copy;
}

interface Block {
  /** Line index of the start marker and of the end marker. */
  start: number;
  end: number;
}

function findBlock(lines: string[], path: string): Block | null {
  const start = lines.findIndex((l) => l.startsWith("# >>> crow v1"));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.trim() === BLOCK_END);
  if (end < 0) throw new AttachError(`crow block in ${path} has no end marker; nothing written`);
  return { start, end };
}

/** Result of {@link planCodexAttach}. */
export interface CodexAttachPlan {
  after: string;
  added: string[];
  /** The OTLP lane (R34): the `[otel]` table written, or omitted on conflict. */
  otlp: OtlpLane;
  manifest: Manifest;
  warnings: string[];
}

/** Computes the attach change; pure. Verifies that only crow groups and `[otel]` were added. */
export function planCodexAttach(
  before: string | null,
  prior: Manifest | null,
  ctx: AttachContext,
): CodexAttachPlan {
  const parsed = parseCodexConfig(before, ctx.configPath);
  const hooks = parsed["hooks"];
  if (hooks !== undefined && !isRecord(hooks)) {
    throw new AttachError(`cannot edit ${ctx.configPath}: "hooks" is not a table; nothing written`);
  }
  const missing = CODEX_EVENTS.filter((e) => !eventGroups(parsed, e).some(isCrowGroup)); // R25
  const units: ManifestUnit[] = [...(prior?.units ?? [])];
  const warnings: string[] = [];
  const otel = parsed["otel"];
  if (isRecord(otel) && otel["log_user_prompt"] === true) {
    warnings.push("[otel] log_user_prompt is enabled in your config; crow did not set it (R24)");
  }
  // The lane is present when crow's block holds an `[otel]` table; any other one is the user's.
  const existing = before === null ? [] : before.replace(/\n$/, "").split("\n");
  const existingBlock = findBlock(existing, ctx.configPath);
  const hasOtelUnit =
    existingBlock !== null &&
    existing.slice(existingBlock.start + 1, existingBlock.end).some((l) => /^\[otel\]\s*$/.test(l));
  const otelConflict = parsed["otel"] !== undefined && !hasOtelUnit;
  if (otelConflict) {
    warnings.push(
      "the OTLP lane was omitted for codex: your config already has an [otel] table (crow never overwrites yours)",
    );
  } else if (!hasOtelUnit && ctx.otlpPort !== DEFAULT_OTLP_PORT) {
    warnings.push(
      `OTLP port ${ctx.otlpPort} is not ${DEFAULT_OTLP_PORT}: Codex will export logs there`,
    );
  }
  const addOtel = !otelConflict && !hasOtelUnit;
  const otlp: OtlpLane = { active: !otelConflict, added: addOtel ? ["otel"] : [] };
  let after = before ?? "";
  if (missing.length > 0 || addOtel) {
    // `[otel]` goes first in the block: a table after a `[[hooks.X.hooks]]` would swallow its keys.
    const groups = missing.map((e) => codexGroupText(e, ctx)).join("\n\n");
    const lines = after === "" ? [] : after.replace(/\n$/, "").split("\n");
    const block = findBlock(lines, ctx.configPath);
    const otelLines = addOtel
      ? [...codexOtelText(ctx).split("\n"), ...(groups || block ? [""] : [])]
      : [];
    if (block) {
      lines.splice(block.start + 1, 0, ...otelLines);
      lines.splice(block.end + otelLines.length, 0, ...(groups ? groups.split("\n") : []));
    } else {
      if (lines.length > 0) lines.push("");
      lines.push(BLOCK_START, ...otelLines, ...(groups ? groups.split("\n") : []), BLOCK_END);
    }
    after = `${lines.join("\n")}\n`;
    if (addOtel) units.push({ event: "otel", value: codexOtelText(ctx) });
    for (const event of missing) units.push({ event, value: codexGroupText(event, ctx) });
    const reparsed = parseCodexConfig(after, ctx.configPath);
    const complete = CODEX_EVENTS.every((e) => eventGroups(reparsed, e).some(isCrowGroup));
    const dropped = [...CODEX_EVENTS, "otel"];
    if (
      !complete ||
      (otlp.active && !isRecord(reparsed["otel"])) ||
      !sameData(normalized(reparsed, dropped), normalized(parsed, dropped))
    ) {
      throw new AttachError("cannot verify the attach result; nothing written");
    }
  }
  return {
    after,
    added: [...missing],
    otlp,
    manifest: {
      version: 1,
      engine: "codex",
      configPath: ctx.configPath,
      units,
      created: { hooks: false, events: [] },
      ...(prior?.otlpConfig ? { otlpConfig: prior.otlpConfig } : {}),
    },
    warnings,
  };
}

/** Result of {@link planCodexDetach}. */
export interface CodexDetachPlan {
  after: string;
  removed: string[];
  kept: Array<{ event: string; reason: string }>;
  manifest: Manifest | null;
}

/**
 * Computes the detach change (R26): intact groups of the marked block go, edited groups and
 * lines the user added inside the block stay, the markers go. Verifies the result by parsing.
 */
export function planCodexDetach(
  before: string,
  prior: Manifest | null,
  ctx: AttachContext,
): CodexDetachPlan {
  const parsed = parseCodexConfig(before, ctx.configPath);
  const lines = before.replace(/\n$/, "").split("\n");
  const block = findBlock(lines, ctx.configPath);
  if (block === null) {
    return { after: before, removed: [], kept: [], manifest: withoutStaleOtel(prior, false) };
  }

  const inner = lines.slice(block.start + 1, block.end);
  const segments: Array<{ event: string | null; lines: string[] }> = [{ event: null, lines: [] }];
  for (const line of inner) {
    const m = /^\[\[hooks\.([A-Za-z]+)\]\]\s*$/.exec(line);
    if (m) segments.push({ event: m[1] ?? null, lines: [line] });
    else if (/^\[otel\]\s*$/.test(line)) segments.push({ event: "otel", lines: [line] });
    else segments[segments.length - 1]!.lines.push(line);
  }
  const removed: string[] = [];
  const kept: Array<{ event: string; reason: string }> = [];
  const keptLines: string[] = [];
  for (const seg of segments) {
    if (seg.event === null) {
      keptLines.push(...seg.lines);
      continue;
    }
    const recorded = prior?.units.find((u) => u.event === seg.event)?.value;
    // Trailing comments and blank lines are the user's own additions, not part of the unit.
    let cut = seg.lines.length;
    while (cut > 0 && /^\s*(#.*)?$/.test(seg.lines[cut - 1]!)) cut--;
    const text = seg.lines.slice(0, cut).join("\n");
    const intact =
      recorded !== undefined
        ? text === String(recorded).trimEnd()
        : seg.event === "otel"
          ? OTEL_UNIT_RE.test(text)
          : text === codexGroupText(seg.event, ctx);
    if (intact) {
      removed.push(seg.event);
      keptLines.push(...seg.lines.slice(cut));
    } else {
      kept.push({ event: seg.event, reason: "edited since attach" });
      keptLines.push(...seg.lines);
    }
  }
  const hasOtelSegment = segments.some((seg) => seg.event === "otel");
  if (removed.length === 0) {
    return { after: before, removed, kept, manifest: withoutStaleOtel(prior, hasOtelSegment) };
  }

  const outLines = [
    ...lines.slice(0, block.start),
    ...trimEdges(keptLines),
    ...lines.slice(block.end + 1),
  ];
  if (keptLines.every((l) => l.trim() === "") && outLines[block.start - 1]?.trim() === "") {
    outLines.splice(block.start - 1, 1); // the blank separator attach added
  }
  const after = outLines.length === 0 ? "" : `${outLines.join("\n")}\n`;

  const reparsed = parseCodexConfig(after, ctx.configPath);
  if (!sameData(normalized(reparsed, []), normalized(parsed, removed))) {
    throw new AttachError(
      "cannot verify the detach result (a stray key inside the crow block?); nothing written",
    );
  }
  return {
    after,
    removed,
    kept,
    manifest:
      prior === null
        ? null
        : {
            ...prior,
            units: prior.units.filter(
              (u) => !removed.includes(u.event) && (u.event !== "otel" || hasOtelSegment),
            ),
          },
  };
}

/**
 * The manifest without the `otel` unit when the user deleted the `[otel]` table by hand
 * (`present` false), so a stale unit cannot keep the OTLP receiver on. Same object otherwise.
 */
function withoutStaleOtel(prior: Manifest | null, present: boolean): Manifest | null {
  if (prior === null || present || !prior.units.some((u) => u.event === "otel")) return prior;
  return { ...prior, units: prior.units.filter((u) => u.event !== "otel") };
}

function trimEdges(kept: string[]): string[] {
  let s = 0;
  let e = kept.length;
  while (s < e && kept[s]!.trim() === "") s++;
  while (e > s && kept[e - 1]!.trim() === "") e--;
  return kept.slice(s, e);
}
