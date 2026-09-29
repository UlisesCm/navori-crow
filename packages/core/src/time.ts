/**
 * Browser-safe time helpers, exposed as the `@crow/core/time` subpath. No
 * imports: unlike the package root, this module never reaches `bun:sqlite`.
 */

/**
 * Local calendar day (`YYYY-MM-DD`, runtime timezone) of an epoch-ms
 * timestamp — "today" is local, per design's open question 6. Used by the
 * store's `project_daily` rows, `GET /api/projects`' `day` field and the web
 * reducers' "today" totals.
 */
export function localDay(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Milliseconds from `ts` until the next local midnight (always > 0). */
export function msUntilNextDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - ts;
}
