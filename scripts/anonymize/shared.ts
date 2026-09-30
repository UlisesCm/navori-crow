/**
 * Pieces shared by the Claude and Codex anonymizers (`claude.ts`/`codex.ts` transcripts and rollouts, `hooks.ts` hook payloads,
 * `otlp.ts` OTLP/JSON bodies) so one raw id maps to one pseudonym across all three lanes of the
 * same session (G5a id equality survives anonymization), and one raw instant shifts by one offset.
 * Pure: no I/O.
 */

/** Anything that maps a raw id to a stable pseudonym. */
export interface IdPseudonymizer {
  pseudonymize(value: string): string;
}

/** Same raw value → same `id<n>` pseudonym, for every call on the same registry. */
export class IdRegistry implements IdPseudonymizer {
  private readonly ids = new Map<string, string>();
  private seq = 0;

  pseudonymize(value: string): string {
    const existing = this.ids.get(value);
    if (existing !== undefined) return existing;
    const pseudo = `id${this.seq}`;
    this.seq += 1;
    this.ids.set(value, pseudo);
    return pseudo;
  }
}

/** Marker / key-marker / hex-id / time-shift state for one anonymization run over hooks + OTLP. */
export class FixtureContext {
  readonly cwd: string;
  /** Root that stands in for `~/.claude` in rewritten transcript paths. */
  readonly claudeHome = "/tmp/crow-fixture/claude-home";
  /** Root that stands in for `~/.codex` in rewritten rollout paths. */
  readonly codexHome = "/tmp/crow-fixture/codex-home";
  private markerSeq = 0;
  private keySeq = 0;
  private readonly hex = new Map<string, string>();
  private hexSeq = 0;

  constructor(
    repo: string,
    readonly ids: IdPseudonymizer = new IdRegistry(),
    /** Milliseconds added to every instant (see {@link offsetToEpoch}). */
    readonly tsOffsetMs = 0,
  ) {
    this.cwd = `/tmp/crow-fixture/${repo}`;
  }

  /** Deterministic, sequential marker for a free-text string. */
  marker(): string {
    const m = `«str:${this.markerSeq}»`;
    this.markerSeq += 1;
    return m;
  }

  /** Deterministic, sequential marker for a non-identifier-shaped object key. */
  keyMarker(): string {
    const m = `«key:${this.keySeq}»`;
    this.keySeq += 1;
    return m;
  }

  /** Same raw hex id → same fake, non-zero, lowercase hex id of `hexLen` chars (trace = 32, span = 16). */
  hexId(raw: string, hexLen: number): string {
    const k = `${hexLen}:${raw}`;
    const existing = this.hex.get(k);
    if (existing !== undefined) return existing;
    this.hexSeq += 1;
    const fake = this.hexSeq.toString(16).padStart(hexLen, "0");
    this.hex.set(k, fake);
    return fake;
  }

  shiftIso(iso: string): string {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? new Date(ms + this.tsOffsetMs).toISOString() : this.marker();
  }

  /** Shifts a unix-nanosecond instant (decimal string). Unparsable input becomes `"0"`. */
  shiftNanos(nanos: string): string {
    if (!/^\d+$/.test(nanos)) return "0";
    if (nanos === "0") return "0";
    return (BigInt(nanos) + BigInt(this.tsOffsetMs) * 1_000_000n).toString();
  }
}

/** Offset (ms) that moves `minMs` onto `epochIso`. */
export function offsetToEpoch(minMs: number | null, epochIso: string): number {
  return minMs === null ? 0 : Date.parse(epochIso) - minMs;
}

export const DEFAULT_EPOCH_ISO = "2026-01-01T00:00:00.000Z";

/**
 * Short structural token: what every allowlisted enum value looks like; free text essentially never does.
 * KNOWN LIMITATION: fields such as `tool_name`, `agent_type`, `agent.name`, `model` and `hook_name` are
 * validated by this SHAPE, not against a list. A custom MCP tool, agent or plugin name that looks like a
 * token passes as-is, so review those fields by hand when re-anonymizing captures from other environments
 * before committing.
 */
export const ENUM_RE = /^[A-Za-z0-9_.:\-[\]]{1,64}$/;
export const MARKER_RE = /^«str:\d+»$/;
export const PSEUDONYM_RE = /^id\d+$/;
