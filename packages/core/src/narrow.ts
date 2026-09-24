/**
 * Defensive narrowing helpers for parsing untrusted JSON lines.
 *
 * Ported from navori-harness `packages/cli/src/lib/audit/parse.ts`
 * (`isRec`, `str`, `num`, `arr`, `path`), commit `b8dfe74c`, the last commit
 * that touches the file, reachable from `origin/main`. Adapters use these to
 * read transcript/rollout lines without ever trusting a field's shape.
 */

/** A plain JSON object, narrowed from `unknown`. */
export type Rec = Record<string, unknown>;

/** True when `v` is a plain object (not an array, not null). */
export function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `v` as a string, or `null` if it isn't one. */
export function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** `v` as a finite number, or `0` if it isn't one. */
export function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** `v` as an array, or `[]` if it isn't one. */
export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Walks `rec` through a chain of keys, returning `undefined` off any non-object hop. */
export function path(rec: Rec, ...keys: string[]): unknown {
  let cur: unknown = rec;
  for (const k of keys) {
    if (!isRec(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}
