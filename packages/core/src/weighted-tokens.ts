import type { CrowEventUsage } from "./crow-event";

/**
 * Ported literal from navori-harness `packages/cli/src/lib/audit/report.ts`
 * (`weightedTokens`, `OUTPUT_MULTIPLIER`, `CACHE_WRITE_MULTIPLIER`,
 * `CACHE_READ_MULTIPLIER_DEFAULT`, `CACHE_READ_MULTIPLIER_OVERRIDES` and
 * `cacheReadMultiplier`, with their doc comments), commit `21f6c054`, the
 * last commit that touches the file, reachable from `origin/main`.
 * `git diff 21f6c054 origin/main -- packages/cli/src/lib/audit/report.ts`
 * is empty (verified 2026-09-24), so this is a byte-for-byte port of the
 * still-current implementation.
 *
 * The only change is the parameter type: navori-harness's `TokenTotals`
 * becomes `Pick<CrowEventUsage, "input" | "output" | "cacheRead" | "cacheCreation">`,
 * because crow's event carries the same four counters plus fields
 * `weightedTokens` never reads.
 */

/**
 * `output` tokens cost 5x an input token across the whole pricing table,
 * retired models included — verified 2026-09-22 against
 * https://platform.claude.com/docs/en/about-claude/pricing.
 */
const OUTPUT_MULTIPLIER = 5;

/**
 * Cache-write multiplier applied to `TokenTotals.cacheCreation`.
 *
 * Approximation, declared: the pricing table splits cache writes by TTL — 5
 * minutes at 1.25x, 1 hour at 2x — but `cache_creation_input_tokens` (and so
 * `TokenTotals.cacheCreation`) sums both without saying which TTL was used.
 * Using 1.25x UNDERSTATES any session that used 1h caching; there is no field
 * on the transcript's `usage` block to split them without re-parsing for a TTL
 * hint it does not carry today.
 */
const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * Cache-read multiplier, the standard rate the pricing docs state for "all
 * other models" — verified 2026-09-22.
 */
const CACHE_READ_MULTIPLIER_DEFAULT = 0.1;

/**
 * Per-model cache-read multiplier overrides (verified 2026-09-22): Claude
 * Fable 5.1 and Claude Mythos 5.1 bill cache hits at 0.025x, Claude Opus 5.5
 * at 0.05x. Matched by substring against the model id Claude Code stamps on
 * the transcript, because navori has no catalog mapping ids to the docs'
 * marketing names. An id that matches none of these falls back to the
 * default rather than guessing.
 */
const CACHE_READ_MULTIPLIER_OVERRIDES: Record<string, number> = {
  "fable-5-1": 0.025,
  "mythos-5-1": 0.025,
  "opus-5-5": 0.05,
};

function cacheReadMultiplier(model: string | null): number {
  if (!model) return CACHE_READ_MULTIPLIER_DEFAULT;
  const id = model.toLowerCase();
  for (const [needle, mult] of Object.entries(CACHE_READ_MULTIPLIER_OVERRIDES)) {
    if (id.includes(needle)) return mult;
  }
  return CACHE_READ_MULTIPLIER_DEFAULT;
}

/**
 * Tokens weighted into input-token equivalents. NOT a dollar figure and NOT a
 * price table — the multipliers are the pricing table's stable RATIOS, which
 * outlive an actual price change.
 *
 * The previous `billable()` excluded `cache_read` entirely: unweighted, it
 * reaches hundreds of millions on a long session and would drown every other
 * figure in the same table. That made the number wrong instead of merely
 * loud — `cache_read` is real, billed spend at (usually) 0.1x an input token,
 * never "not new spend". Weighting it down to its real proportion is what
 * lets it stay in the headline instead of being read separately with a caveat
 * that was not true.
 *
 * `thinking` stays excluded for the same reason it always was — it is already
 * IN `output`, not a fourth addend. Measured over the 1028 assistant messages
 * of transcript `4935c4d7` (CC 2.1.236): `output_tokens_details.thinking_tokens
 * <= output_tokens` in 100% of them.
 *
 * NOT modeled: `inference_geo: "us"` (1.1x on every counter) and fast mode
 * (doubles Opus 5's base rate) — neither is exposed on the transcript's usage
 * block today, so there is nothing to key an override on.
 */
export function weightedTokens(
  t: Pick<CrowEventUsage, "input" | "output" | "cacheRead" | "cacheCreation">,
  model: string | null,
): number {
  return (
    t.input +
    t.output * OUTPUT_MULTIPLIER +
    t.cacheCreation * CACHE_WRITE_MULTIPLIER +
    t.cacheRead * cacheReadMultiplier(model)
  );
}
