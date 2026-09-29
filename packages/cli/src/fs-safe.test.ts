import { afterAll, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUP_KEEP, safeWrite } from "./fs-safe";

const root = mkdtempSync(join(tmpdir(), "crow-fs-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function fresh(): { dir: string; crowHome: string } {
  const dir = mkdtempSync(join(root, "case-"));
  const crowHome = join(dir, "crow");
  mkdirSync(crowHome);
  return { dir, crowHome };
}

describe("safeWrite", () => {
  // Covers: R20
  test("writes through a symlink: the link stays and the real target changes", () => {
    const { dir, crowHome } = fresh();
    const real = join(dir, "dotfiles-settings.json");
    const link = join(dir, "settings.json");
    writeFileSync(real, "old");
    symlinkSync(real, link);
    const res = safeWrite(link, "new", { crowHome, engine: "claude" });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(real);
    expect(readFileSync(real, "utf8")).toBe("new");
    expect(statSync(res.target).isFile()).toBe(true);
    expect(lstatSync(res.target).isSymbolicLink()).toBe(false);
    expect(readFileSync(res.backup ?? "", "utf8")).toBe("old");
  });

  // Covers: R20
  test("backup: <basename>.<UTC>.bak, mode 0600 in a 0700 directory; target mode preserved", () => {
    const { dir, crowHome } = fresh();
    const file = join(dir, "config.toml");
    writeFileSync(file, "a");
    chmodSync(file, 0o640);
    const res = safeWrite(file, "b", {
      crowHome,
      engine: "codex",
      now: () => new Date("2026-09-29T10:15:30.123Z"),
    });
    expect(res.backup).toBe(
      join(crowHome, "backups", "codex", "config.toml.20260929T101530123Z.bak"),
    );
    expect(statSync(res.backup ?? "").mode & 0o777).toBe(0o600);
    expect(statSync(join(crowHome, "backups", "codex")).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o640);
  });

  // Covers: R20
  test("rotation keeps only the newest 10 backups", () => {
    const { dir, crowHome } = fresh();
    const file = join(dir, "s.json");
    writeFileSync(file, "0");
    for (let i = 1; i <= 13; i++) {
      safeWrite(file, String(i), {
        crowHome,
        engine: "claude",
        now: () => new Date(Date.UTC(2026, 8, 1, 0, 0, i)),
      });
    }
    const baks = readdirSync(join(crowHome, "backups", "claude")).sort();
    expect(baks).toHaveLength(BACKUP_KEEP);
    // Oldest three (contents 0,1,2) are gone; the newest backup holds "12".
    expect(
      readFileSync(join(crowHome, "backups", "claude", baks[baks.length - 1] ?? ""), "utf8"),
    ).toBe("12");
    expect(readFileSync(join(crowHome, "backups", "claude", baks[0] ?? ""), "utf8")).toBe("3");
  });

  // Covers: R20
  test("a crash mid-write leaves the target intact and no temp file behind", () => {
    const { dir, crowHome } = fresh();
    const file = join(dir, "s.json");
    writeFileSync(file, "original");
    expect(() =>
      safeWrite(file, "replacement", {
        crowHome,
        engine: "claude",
        beforeRename: () => {
          throw new Error("simulated crash");
        },
      }),
    ).toThrow("simulated crash");
    expect(readFileSync(file, "utf8")).toBe("original");
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  // Covers: R20
  test("creates a missing file without a backup", () => {
    const { dir, crowHome } = fresh();
    const file = join(dir, "new.json");
    const res = safeWrite(file, "x", { crowHome, engine: "claude" });
    expect(res.backup).toBeNull();
    expect(readFileSync(file, "utf8")).toBe("x");
  });
});
