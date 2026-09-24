import type { CrowEventUsage } from "./crow-event";

/**
 * Per-model USD price, per million tokens.
 *
 * `cacheWrite5m` / `cacheWrite1h` split the two cache-write TTLs Anthropic
 * bills separately; `cacheCreation1h` on {@link CrowEventUsage} tells
 * {@link costUsd} how much of a usage's `cacheCreation` used which rate.
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  /** ISO date the price was verified against the provider's page. */
  verifiedAt: string;
  /** Source page the price was verified against. */
  source: string;
}

const ANTHROPIC_PRICING_URL = "https://platform.claude.com/docs/en/about-claude/pricing";
const VERIFIED_AT = "2026-09-24";

/**
 * Prices verified 2026-09-24 by fetching {@link ANTHROPIC_PRICING_URL}
 * directly (D12). OpenAI's pricing pages (`openai.com/api/pricing`,
 * `platform.openai.com/pricing`) returned HTTP 403 to every fetch attempt
 * that day (no Wayback snapshot either), so the Codex-side models
 * (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-6-astra`,
 * `codex-auto-review`) could not be verified and are deliberately absent:
 * their `costUsd` stays undefined while their tokens still count (R20).
 *
 * Keys are normalized model ids (see {@link normalizeModelId}); match is
 * exact, never by substring, because e.g. `claude-opus-5` and
 * `claude-opus-5-5` coexist.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-fable-5": {
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite5m: 12.5,
    cacheWrite1h: 20,
    verifiedAt: VERIFIED_AT,
    source: ANTHROPIC_PRICING_URL,
  },
  "claude-opus-5-5": {
    input: 4,
    output: 20,
    cacheRead: 0.2,
    cacheWrite5m: 5,
    cacheWrite1h: 8,
    verifiedAt: VERIFIED_AT,
    source: ANTHROPIC_PRICING_URL,
  },
  "claude-opus-5": {
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite5m: 6.25,
    cacheWrite1h: 10,
    verifiedAt: VERIFIED_AT,
    source: ANTHROPIC_PRICING_URL,
  },
  "claude-sonnet-5": {
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite5m: 2.5,
    cacheWrite1h: 4,
    verifiedAt: VERIFIED_AT,
    source: ANTHROPIC_PRICING_URL,
  },
  "claude-haiku-4-5": {
    input: 1,
    output: 5,
    cacheRead: 0.1,
    cacheWrite5m: 1.25,
    cacheWrite1h: 2,
    verifiedAt: VERIFIED_AT,
    source: ANTHROPIC_PRICING_URL,
  },
};

/** Strips a trailing `-YYYYMMDD` date suffix, e.g. `claude-haiku-4-5-20251001`. */
const DATE_SUFFIX = /-\d{8}$/;

/** Normalizes a model id for an exact (never substring) pricing-table match. */
export function normalizeModelId(model: string): string {
  return model.toLowerCase().replace(DATE_SUFFIX, "");
}

/** Looks up the price for `model`, or `undefined` if it isn't in the table (R20). */
export function priceFor(model: string): ModelPrice | undefined {
  return MODEL_PRICES[normalizeModelId(model)];
}

/**
 * Computes the USD cost of a usage from the pricing table.
 *
 * `undefined` when the model isn't priced: the caller still counts the
 * tokens (R20), it just can't attach a dollar figure.
 */
export function costUsd(usage: CrowEventUsage): number | undefined {
  if (!usage.model) return undefined;
  const price = priceFor(usage.model);
  if (!price) return undefined;

  const cacheCreation1h = usage.cacheCreation1h ?? 0;
  const cacheCreation5m = usage.cacheCreation - cacheCreation1h;

  return (
    (usage.input * price.input +
      usage.output * price.output +
      usage.cacheRead * price.cacheRead +
      cacheCreation5m * price.cacheWrite5m +
      cacheCreation1h * price.cacheWrite1h) /
    1e6
  );
}
