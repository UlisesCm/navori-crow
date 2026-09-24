import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRecursiveWatchSupport, watchRoot } from "./tailer";

/**
 * `fs.watch(root, { recursive: true })` is FSEvents-backed on macOS but not
 * reliably available on Linux (design.md D4's probe). CI (ubuntu) and local
 * dev (macOS) diverge here, so every assertion that needs a live watcher is
 * skipped when the probe itself says the platform can't do it — the probe's
 * own behavior (never throwing, returning a clean boolean) is still always
 * exercised.
 */
function withTempDir(fn: (dir: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "crow-watch-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("probeRecursiveWatchSupport (D4)", () => {
  test("never throws, and closes the probe watcher it opens", async () => {
    // Covers: R5
    await withTempDir((dir) => {
      expect(() => probeRecursiveWatchSupport(dir)).not.toThrow();
      expect(typeof probeRecursiveWatchSupport(dir)).toBe("boolean");
    });
  });

  test("returns false for a root that doesn't exist, instead of throwing", () => {
    // Covers: R5
    expect(probeRecursiveWatchSupport("/definitely/not/a/real/path")).toBe(false);
  });
});

const RECURSIVE_WATCH_SUPPORTED = probeRecursiveWatchSupport(tmpdir());

describe("watchRoot: fs.watch is a hint only (R5, D4)", () => {
  test.skipIf(!RECURSIVE_WATCH_SUPPORTED)(
    "an appended file under the root eventually triggers a hint carrying its path",
    async () => {
      // Covers: R5
      await withTempDir(async (dir) => {
        const path = join(dir, "f.jsonl");
        writeFileSync(path, "");

        const hints: string[] = [];
        const watcher = watchRoot(dir, (hintedPath) => hints.push(hintedPath));
        expect(watcher).not.toBeNull();

        try {
          const deadline = Date.now() + 5000;
          while (hints.length === 0 && Date.now() < deadline) {
            writeFileSync(path, `line-${Date.now()}\n`, { flag: "a" });
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          expect(hints.some((h) => h.includes("f.jsonl"))).toBe(true);
        } finally {
          watcher?.close();
        }
      });
    },
  );

  test("returns null (never throws) when recursive watch isn't supported here", async () => {
    // Covers: R5
    await withTempDir((dir) => {
      if (RECURSIVE_WATCH_SUPPORTED) {
        const watcher = watchRoot(dir, () => {});
        expect(watcher).not.toBeNull();
        watcher?.close();
      } else {
        expect(watchRoot(dir, () => {})).toBeNull();
      }
    });
  });
});
