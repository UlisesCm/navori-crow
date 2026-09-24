import { describe, expect, test } from "bun:test";
import type { CrowEventUsage } from "./crow-event";
import { costUsd, MODEL_PRICES, normalizeModelId, priceFor } from "./pricing";

function usage(overrides: Partial<CrowEventUsage>): CrowEventUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, ...overrides };
}

describe("pricing", () => {
  test("splits cacheCreation between the 5m and 1h rates (D12)", () => {
    // Covers: R20
    // claude-sonnet-5: input 2, output 10, cacheRead 0.2, 5m 2.5, 1h 4 (USD/MTok).
    const cost = costUsd(
      usage({
        model: "claude-sonnet-5",
        cacheCreation: 1_000_000, // 400k at 5m rate + 600k at 1h rate
        cacheCreation1h: 600_000,
      }),
    );
    // (400_000 * 2.5 + 600_000 * 4) / 1e6 = (1_000_000 + 2_400_000) / 1e6 = 3.4
    expect(cost).toBeCloseTo(3.4, 10);
  });

  test("cacheCreation is billed at the 5m rate when cacheCreation1h is unset", () => {
    // Covers: R20
    // cacheCreation1h defaults to 0, so the whole amount falls in the 5m bucket
    // (the 1h split is stated evidence from adapters, not assumed by pricing).
    const cost = costUsd(usage({ model: "claude-sonnet-5", cacheCreation: 1_000_000 }));
    expect(cost).toBeCloseTo(2.5, 10);
  });

  test("matches exactly after normalizing, never by substring", () => {
    // Covers: R20
    // claude-opus-5 and claude-opus-5-5 have different prices and must not collide.
    expect(priceFor("claude-opus-5")?.input).toBe(5);
    expect(priceFor("claude-opus-5-5")?.input).toBe(4);
    expect(normalizeModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(priceFor("CLAUDE-SONNET-5")?.input).toBe(MODEL_PRICES["claude-sonnet-5"]?.input);
  });

  test("an unknown model leaves costUsd unset while tokens still count", () => {
    // Covers: R20
    const u = usage({ model: "some-future-model-nobody-declared", input: 100, output: 50 });
    expect(costUsd(u)).toBeUndefined();
    expect(u.input).toBe(100);
    expect(u.output).toBe(50);
  });

  test("a usage without a model leaves costUsd unset", () => {
    // Covers: R20
    expect(costUsd(usage({ input: 100 }))).toBeUndefined();
  });
});
