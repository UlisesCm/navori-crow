import { describe, expect, test } from "bun:test";
import { localDay, msUntilNextDay } from "./time";

describe("time", () => {
  // Covers: R30
  test("localDay formats the local calendar day", () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59).getTime())).toBe("2026-01-05");
  });

  // Covers: R30
  test("msUntilNextDay lands exactly on local midnight", () => {
    const ts = new Date(2026, 8, 29, 23, 0, 0).getTime();
    const next = ts + msUntilNextDay(ts);
    expect(localDay(next)).toBe("2026-09-30");
    expect(new Date(next).getHours()).toBe(0);
  });
});
