import { describe, expect, it } from "bun:test";
import { weightedTokens } from "./weighted-tokens";

/**
 * Ported literal from navori-harness
 * `packages/cli/src/lib/audit/__tests__/report.test.ts`, describe block
 * "weightedTokens: cache_read weighted per model (#927)", commit `21f6c054`.
 * The fixture object drops `thinking` (not part of `CrowEventUsage`).
 */
describe("weightedTokens: cache_read weighted per model (#927)", () => {
  it("applies the standard 0.1x default", () => {
    // Covers: R21
    const t = { input: 100, output: 0, cacheRead: 10_000, cacheCreation: 0 };
    // 100 input + 10_000 * 0.1 = 1100.
    expect(weightedTokens(t, "claude-sonnet-5")).toBe(1100);
  });

  it("falls back to the default for an unknown model instead of throwing", () => {
    // Covers: R21
    const t = { input: 0, output: 0, cacheRead: 10_000, cacheCreation: 0 };
    expect(weightedTokens(t, "some-future-model-nobody-declared")).toBe(1000);
  });

  it("falls back to the default when the run carries no model at all", () => {
    // Covers: R21
    const t = { input: 0, output: 0, cacheRead: 10_000, cacheCreation: 0 };
    expect(weightedTokens(t, null)).toBe(1000);
  });

  it("overrides to 0.025x for Claude Fable 5.1 and Claude Mythos 5.1", () => {
    // Covers: R21
    const t = { input: 0, output: 0, cacheRead: 10_000, cacheCreation: 0 };
    expect(weightedTokens(t, "claude-fable-5-1-20260101")).toBe(250);
    expect(weightedTokens(t, "claude-mythos-5-1-20260101")).toBe(250);
  });

  it("overrides to 0.05x for Claude Opus 5.5", () => {
    // Covers: R21
    const t = { input: 0, output: 0, cacheRead: 10_000, cacheCreation: 0 };
    expect(weightedTokens(t, "claude-opus-5-5-20260101")).toBe(500);
  });

  it("weights output at 5x and cache write at 1.25x, uniformly across models", () => {
    // Covers: R21
    const t = { input: 0, output: 100, cacheRead: 0, cacheCreation: 100 };
    // 100*5 + 100*1.25 = 625, same regardless of which model ran it.
    expect(weightedTokens(t, "claude-opus-5")).toBe(625);
    expect(weightedTokens(t, "claude-haiku-4-5")).toBe(625);
  });
});

/**
 * Crow addition (not from navori-harness): the same cache-read weighting as
 * above, exercised through the 0.1x default for two models the override
 * table doesn't touch.
 */
describe("weightedTokens: crow addition — 0.1x default for Opus 5 and Haiku 4.5", () => {
  it("applies the standard 0.1x default for Claude Opus 5 and Claude Haiku 4.5", () => {
    // Covers: R21
    const t = { input: 0, output: 0, cacheRead: 6_250, cacheCreation: 0 };
    expect(weightedTokens(t, "claude-opus-5")).toBe(625);
    expect(weightedTokens(t, "claude-haiku-4-5")).toBe(625);
  });
});
