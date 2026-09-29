import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_DIR, OTLP_SIGNALS, encodeFixture } from "./encode-otlp-fixture";

describe("encode-otlp-fixture", () => {
  for (const signal of OTLP_SIGNALS) {
    // Covers: R14
    test(`${signal}.bin is up to date with ${signal}.json (rerun scripts/encode-otlp-fixture.ts)`, async () => {
      const committed = new Uint8Array(readFileSync(join(FIXTURE_DIR, `${signal}.bin`)));
      expect(await encodeFixture(signal)).toEqual(committed);
    });
  }
});
