/**
 * Byte-based, offset-resuming line reader (design.md D5, R6-R8).
 *
 * Reads a file starting at `fromOffset`, splits it into complete lines on
 * raw `0x0A` bytes, and returns them **undecoded** (as bytes): decoding to a
 * string, and hashing for identity (D7), are the caller's job (`ingest.ts`),
 * applied once per fully-collected line — so a UTF-8 sequence split across
 * a chunk boundary is never an issue, and no persisted in-memory buffer is
 * needed across process restarts.
 *
 * A trailing line with no terminating `\n` is never returned as a line:
 * `nextOffset` points at its first byte, so the caller persists that as the
 * file's offset (R8). The next call (once the source has grown) starts from
 * the same place and sees the same bytes plus whatever was appended.
 *
 * A line that keeps growing past `maxLineBytes` without a terminator is
 * reported as `too-long` once its terminator is finally found. Memory stays
 * bounded: once a pending line crosses the cap, its bytes are dropped and
 * only its byte span is tracked while further chunks are scanned for `\n`.
 */

/** Default read step: "se leen hasta 8 MiB por paso" (D5). */
export const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

/** Default cap before a line is flagged `too-long`: "3.5 veces el máximo observado" (D5). */
export const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;

export interface ReadLinesOptions {
  /** Read-syscall granularity; also the fallback for `maxBytesPerStep`. */
  chunkBytes?: number;
  maxLineBytes?: number;
  /**
   * Total bytes one `readLines` call will fetch before stopping and leaving
   * the rest for the next call (D5 "se leen hasta 8 MiB por paso", D6 "cada
   * paso procesa como máximo 1,000 líneas u 8 MiB"). Exempt while resolving
   * an already-detected `too-long` line: that scan is bounded by
   * `maxLineBytes` instead, by design (D5's "el chunk crece hasta 16 MiB").
   */
  maxBytesPerStep?: number;
}

/**
 * `Uint8Array`'s buffer type param varies by how it was produced (`slice`,
 * `subarray`, `new Uint8Array(n)`…); this alias accepts any of them so chunk
 * reads, subarrays and concatenations stay interchangeable.
 */
type Bytes = Uint8Array<ArrayBufferLike>;

/** One complete line's raw bytes (no trailing `\n`) and where it starts in the file. */
export interface RawLine {
  kind: "line";
  bytes: Bytes;
  startOffset: number;
}

/** A line whose terminator was found only after it exceeded `maxLineBytes` (D5, R10). */
export interface TooLongLine {
  kind: "too-long";
  startOffset: number;
  length: number;
}

export type LineEntry = RawLine | TooLongLine;

export interface ReadLinesResult {
  /** Complete lines and too-long spans found, in file order. */
  entries: LineEntry[];
  /** Byte offset to persist: the start of the first still-unconsumed (partial) line. */
  nextOffset: number;
}

/** A minimal file-reading dependency, injectable so tests never touch the real disk clock/latency. */
export type ChunkReader = (path: string, start: number, length: number) => Promise<Bytes>;

/** Default {@link ChunkReader}: reads `[start, start+length)` of `path` with `Bun.file`. */
export const readChunk: ChunkReader = async (path, start, length) => {
  const slice = Bun.file(path).slice(start, start + length);
  return new Uint8Array(await slice.arrayBuffer());
};

function concatBytes(a: Bytes, b: Bytes): Bytes {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Reads complete lines from `path` starting at `fromOffset`. Never throws on
 * a missing/shrunk file mid-read: callers decide inode/size handling before
 * calling this (D5, R7) — an absent file simply yields no entries.
 */
export async function readLines(
  path: string,
  fromOffset: number,
  opts: ReadLinesOptions = {},
  read: ChunkReader = readChunk,
): Promise<ReadLinesResult> {
  const chunkBytes = opts.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const maxBytesPerStep = opts.maxBytesPerStep ?? DEFAULT_CHUNK_BYTES;

  const entries: LineEntry[] = [];
  let cursor = fromOffset;
  let pending: Bytes = new Uint8Array(0);
  let pendingStart = fromOffset;
  // Set once `pending` alone has already crossed maxLineBytes with no `\n`:
  // from then on we stop accumulating bytes and just scan new chunks for the terminator.
  let overlongStart: number | null = null;
  let bytesReadThisStep = 0;

  for (;;) {
    let readSize = chunkBytes;
    if (overlongStart === null) {
      const remaining = maxBytesPerStep - bytesReadThisStep;
      if (remaining <= 0) break; // step budget exhausted (D5, D6): the rest waits for the next call
      readSize = Math.min(chunkBytes, remaining);
    }
    const chunk = await read(path, cursor, readSize);
    if (chunk.length === 0) break; // real EOF: nothing more available right now
    const reachedEof = chunk.length < readSize;
    cursor += chunk.length;
    bytesReadThisStep += chunk.length;

    if (overlongStart !== null) {
      const nl = chunk.indexOf(0x0a);
      if (nl === -1) {
        if (reachedEof) break; // still pending; resume the overlong scan on the next call
        continue;
      }
      const absoluteNl = cursor - chunk.length + nl;
      entries.push({
        kind: "too-long",
        startOffset: overlongStart,
        length: absoluteNl - overlongStart,
      });
      overlongStart = null;
      pending = chunk.subarray(nl + 1);
      pendingStart = cursor - pending.length;
    } else {
      pending = concatBytes(pending, chunk);
    }

    let start = 0;
    for (;;) {
      const nl = pending.indexOf(0x0a, start);
      if (nl === -1) break;
      const bytes = pending.subarray(start, nl);
      if (bytes.length > maxLineBytes) {
        entries.push({ kind: "too-long", startOffset: pendingStart + start, length: bytes.length });
      } else {
        entries.push({ kind: "line", bytes, startOffset: pendingStart + start });
      }
      start = nl + 1;
    }
    pendingStart += start;
    pending = pending.subarray(start);

    if (pending.length > maxLineBytes) {
      overlongStart = pendingStart;
      pending = new Uint8Array(0);
    }

    if (reachedEof) break; // nothing more available this pass
  }

  return { entries, nextOffset: overlongStart ?? pendingStart };
}
