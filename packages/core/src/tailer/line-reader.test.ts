import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLines } from "./line-reader";

function withTempFile(content: Uint8Array | string, fn: (path: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "crow-line-reader-"));
  const path = join(dir, "f.jsonl");
  writeFileSync(path, content);
  return Promise.resolve(fn(path)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("readLines: partial trailing line (R8)", () => {
  test("a line without a trailing newline is never returned, and the offset points at its start", async () => {
    // Covers: R8
    await withTempFile("line-one\nline-two\npartial-no-newline", async (path) => {
      const { entries, nextOffset } = await readLines(path, 0);
      expect(
        entries.map((e) => (e.kind === "line" ? Buffer.from(e.bytes).toString() : e.kind)),
      ).toEqual(["line-one", "line-two"]);
      expect(nextOffset).toBe("line-one\nline-two\n".length);
    });
  });

  test("resuming from the persisted offset later sees the completed line plus whatever follows", async () => {
    // Covers: R8
    await withTempFile("line-one\npartial", async (path) => {
      const first = await readLines(path, 0);
      expect(first.entries).toHaveLength(1);
      expect(first.nextOffset).toBe("line-one\n".length);

      writeFileSync(path, "line-one\npartial-completed\nnext\n"); // simulate the source growing
      const second = await readLines(path, first.nextOffset);
      expect(
        second.entries.map((e) => (e.kind === "line" ? Buffer.from(e.bytes).toString() : e.kind)),
      ).toEqual(["partial-completed", "next"]);
    });
  });
});

describe("readLines: UTF-8 split across a chunk boundary", () => {
  test("a multibyte character split mid-sequence across chunks still decodes correctly once complete", async () => {
    // Covers: R8
    const text = "café\nnaïve résumé\n"; // both lines contain multibyte UTF-8 sequences
    await withTempFile(text, async (path) => {
      // A tiny chunk size forces the reader to straddle "é" and "ï"/"é" mid-byte across reads.
      const { entries } = await readLines(path, 0, { chunkBytes: 3 });
      const decoded = entries
        .filter((e): e is Extract<typeof e, { kind: "line" }> => e.kind === "line")
        .map((e) => new TextDecoder().decode(e.bytes));
      expect(decoded).toEqual(["café", "naïve résumé"]);
    });
  });
});

describe("readLines: a line larger than the chunk", () => {
  test("a line spanning many chunk reads, but under the cap, is returned whole", async () => {
    // Covers: R8
    const bigLine = "x".repeat(50);
    await withTempFile(`${bigLine}\nshort\n`, async (path) => {
      const { entries } = await readLines(path, 0, { chunkBytes: 4, maxLineBytes: 1000 });
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({ kind: "line" });
      if (entries[0]!.kind === "line") {
        expect(Buffer.from(entries[0]!.bytes).toString()).toBe(bigLine);
      }
      expect(entries[1]).toMatchObject({ kind: "line" });
    });
  });

  test("a line past maxLineBytes is reported too-long once its terminator is found, and reading resumes after it", async () => {
    // Covers: R8
    const overlong = "y".repeat(40);
    await withTempFile(`${overlong}\nshort\n`, async (path) => {
      const { entries, nextOffset } = await readLines(path, 0, { chunkBytes: 4, maxLineBytes: 10 });
      expect(entries[0]).toEqual({ kind: "too-long", startOffset: 0, length: overlong.length });
      expect(entries[1]).toMatchObject({ kind: "line" });
      if (entries[1]!.kind === "line") {
        expect(Buffer.from(entries[1]!.bytes).toString()).toBe("short");
      }
      expect(nextOffset).toBe(`${overlong}\nshort\n`.length);
    });
  });

  test("chunk-size invariance: the same content yields the same lines regardless of chunkBytes", async () => {
    // Covers: R8
    const content = "one\ntwo\nthree\nfour\n";
    await withTempFile(content, async (path) => {
      const bySmallChunks = await readLines(path, 0, { chunkBytes: 1 });
      const byOneRead = await readLines(path, 0, { chunkBytes: 1024 });
      const decode = (r: typeof bySmallChunks) =>
        r.entries.map((e) => (e.kind === "line" ? Buffer.from(e.bytes).toString() : e.kind));
      expect(decode(bySmallChunks)).toEqual(decode(byOneRead));
      expect(bySmallChunks.nextOffset).toBe(byOneRead.nextOffset);
    });
  });
});

describe("readLines: per-step byte budget (D5, D6)", () => {
  test("a call stops once it has read maxBytesPerStep bytes, leaving the rest for the next call", async () => {
    // Covers: R6, R9
    const content = "aaaa\nbbbb\ncccc\ndddd\neeee\n"; // 5 lines, 5 bytes each including \n
    await withTempFile(content, async (path) => {
      const first = await readLines(path, 0, { chunkBytes: 2, maxBytesPerStep: 12 });
      // The budget (12 bytes) only covers full lines "aaaa\n" (5) + "bbbb\n" (5) = 10 bytes;
      // the 2 remaining budgeted bytes aren't enough for a 3rd complete line.
      expect(
        first.entries.map((e) => (e.kind === "line" ? Buffer.from(e.bytes).toString() : e.kind)),
      ).toEqual(["aaaa", "bbbb"]);
      expect(first.nextOffset).toBe(10);

      const second = await readLines(path, first.nextOffset, {
        chunkBytes: 2,
        maxBytesPerStep: 12,
      });
      expect(
        second.entries.map((e) => (e.kind === "line" ? Buffer.from(e.bytes).toString() : e.kind)),
      ).toEqual(["cccc", "dddd"]);

      const third = await readLines(path, second.nextOffset, {
        chunkBytes: 2,
        maxBytesPerStep: 12,
      });
      expect(
        third.entries.map((e) => (e.kind === "line" ? Buffer.from(e.bytes).toString() : e.kind)),
      ).toEqual(["eeee"]);
    });
  });

  test("the byte budget doesn't cut off an in-flight too-long scan (D5's chunk-grows-to-16MiB exemption)", async () => {
    // Covers: R6, R9
    const overlong = "z".repeat(30);
    await withTempFile(`${overlong}\nshort\n`, async (path) => {
      // A tiny per-step budget would otherwise stop reading long before the
      // too-long line's terminator is ever found. `maxLineBytes` is small
      // enough that the overlong scan kicks in before the budget would.
      const { entries } = await readLines(path, 0, {
        chunkBytes: 3,
        maxLineBytes: 4,
        maxBytesPerStep: 6,
      });
      expect(entries[0]).toEqual({ kind: "too-long", startOffset: 0, length: overlong.length });
    });
  });

  test("defaults to the chunk size (8 MiB) when unset, so small files are unaffected", async () => {
    // Covers: R6
    await withTempFile("one\ntwo\n", async (path) => {
      const { entries } = await readLines(path, 0);
      expect(entries).toHaveLength(2);
    });
  });
});
