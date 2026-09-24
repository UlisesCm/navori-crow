/**
 * Monotonic ULID generation (D9).
 *
 * `id` doubles as the global ingestion order (R23, R24, R33): every id
 * assigned within a process must sort strictly after every id assigned
 * before it, even across the same millisecond and even if the wall clock
 * doesn't advance or goes backwards.
 *
 * Encoding: 48 bits of ms epoch time + 80 random bits, Crockford base32
 * (26 characters total), per the ULID spec. Lexicographic order on the
 * encoded string matches numeric order on (time, randomness).
 */

/** Crockford base32 alphabet (excludes I, L, O, U to avoid transcription errors). */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10; // 48 bits / 5 bits-per-char
const RANDOM_LEN = 16; // 80 bits / 5 bits-per-char
const TIME_MAX = 2n ** 48n;
const RANDOM_MAX = 2n ** 80n;

/** Clock injected for tests; defaults to the wall clock. */
export type ClockFn = () => number;

function encodeBase32(value: bigint, length: number): string {
  let v = value;
  let out = "";
  for (let i = 0; i < length; i++) {
    out = ALPHABET[Number(v % 32n)] + out;
    v /= 32n;
  }
  return out;
}

function decodeBase32(chars: string): bigint {
  let v = 0n;
  for (const c of chars) {
    const digit = ALPHABET.indexOf(c);
    if (digit < 0) throw new Error(`invalid ULID character: ${c}`);
    v = v * 32n + BigInt(digit);
  }
  return v;
}

function randomBits(): bigint {
  const bytes = new Uint8Array(10); // 80 bits
  crypto.getRandomValues(bytes);
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

function encode(timeMs: number, random: bigint): string {
  const time = BigInt(Math.max(0, Math.floor(timeMs))) % TIME_MAX;
  return encodeBase32(time, TIME_LEN) + encodeBase32(random, RANDOM_LEN);
}

/** The ms epoch time encoded in a ULID's first 10 characters. */
export function ulidTime(id: string): number {
  return Number(decodeBase32(id.slice(0, TIME_LEN)));
}

/** The 80-bit randomness encoded in a ULID's last 16 characters. */
function ulidRandom(id: string): bigint {
  return decodeBase32(id.slice(TIME_LEN));
}

/**
 * Builds a generator of strictly increasing ULIDs, seeded with the last id
 * already assigned (by the caller: the greater of `max(id)` in the store and
 * a fresh ULID of `Date.now()` — see D9).
 *
 * On each call: if the clock has advanced past the seed/previous id's
 * timestamp, a fresh id is generated for `now`. Otherwise (clock stuck or
 * gone backwards) the previous id's random component is incremented by 1,
 * keeping its timestamp — which is what keeps the sequence monotonic
 * without ever depending on the clock moving forward.
 */
export function createUlidFactory(seed: string, clock: ClockFn = Date.now): () => string {
  let last = seed;

  return function next(): string {
    const now = clock();
    const lastTime = ulidTime(last);

    if (now > lastTime) {
      last = encode(now, randomBits());
      return last;
    }

    // Clock didn't advance (or went backwards): bump the random component of
    // the last id instead, wrapping modulo 2^80 in the astronomically
    // unlikely case it overflows — monotonicity within the process matters
    // more than a theoretical collision nobody will ever hit in practice.
    const bumped = (ulidRandom(last) + 1n) % RANDOM_MAX;
    last = encodeBase32(BigInt(lastTime), TIME_LEN) + encodeBase32(bumped, RANDOM_LEN);
    return last;
  };
}
