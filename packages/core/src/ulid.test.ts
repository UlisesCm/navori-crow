import { describe, expect, test } from "bun:test";
import { createUlidFactory, ulidTime } from "./ulid";

/** A ULID seed at a fixed ms epoch time, with random tail zeroed out. */
function seedAt(ms: number): string {
  const next = createUlidFactory("0000000000" + "0".repeat(16), () => ms);
  return next();
}

describe("createUlidFactory", () => {
  test("produces strictly increasing ids as the clock advances", () => {
    // Covers: R23
    let now = 1_700_000_000_000;
    const next = createUlidFactory(seedAt(now), () => now);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      now += 10;
      ids.push(next());
    }
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! > ids[i - 1]!).toBe(true);
    }
  });

  test("stays monotonic when the clock doesn't advance (same ms)", () => {
    // Covers: R23
    const now = 1_700_000_000_000;
    const next = createUlidFactory(seedAt(now), () => now);
    const a = next();
    const b = next();
    const c = next();
    expect(b > a).toBe(true);
    expect(c > b).toBe(true);
    // Timestamp stays pinned to the seed's, only the random tail moves.
    expect(ulidTime(a)).toBe(now);
    expect(ulidTime(c)).toBe(now);
  });

  test("stays monotonic when the clock goes backwards", () => {
    // Covers: R23, R24
    const seedTime = 1_700_000_000_000;
    let now = seedTime;
    const next = createUlidFactory(seedAt(seedTime), () => now);
    const a = next();
    now = seedTime - 60_000; // clock jumped an hour into the past... a minute back
    const b = next();
    const c = next();
    expect(b > a).toBe(true);
    expect(c > b).toBe(true);
    // ids stay anchored to the last known-good time, never regress with the clock.
    expect(ulidTime(b)).toBe(seedTime);
    expect(ulidTime(c)).toBe(seedTime);
  });

  test("the seed can be the greater of max(id) and a fresh clock reading", () => {
    // Covers: R23
    const dbMaxId = seedAt(1_700_000_000_000);
    const clockSeed = seedAt(1_600_000_000_000); // an older wall-clock reading
    const seed = dbMaxId > clockSeed ? dbMaxId : clockSeed;
    expect(seed).toBe(dbMaxId);

    const next = createUlidFactory(seed, () => 1_600_000_000_000);
    const first = next();
    expect(first > seed).toBe(true);
    // Clock is behind the seed, so the generator keeps the seed's timestamp.
    expect(ulidTime(first)).toBe(ulidTime(dbMaxId));
  });
});

describe("ulidTime", () => {
  test("round-trips the ms epoch time encoded in a ulid", () => {
    // Covers: R23
    const ms = 1_726_000_000_123;
    const id = seedAt(ms);
    expect(ulidTime(id)).toBe(ms);
  });
});
