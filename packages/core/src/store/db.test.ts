import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbPathFor, openDatabase } from "./db";

/** File permission bits, masking out the file-type bits `stat` also reports. */
function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("openDatabase", () => {
  test("creates the CROW_HOME directory at 0700 and the DB file at 0600, even under a permissive umask", () => {
    // Covers: R1, R3
    const base = mkdtempSync(join(tmpdir(), "crow-db-"));
    const crowHome = join(base, "nested", ".crow");
    const originalUmask = process.umask(0o022);

    try {
      const db = openDatabase(crowHome);
      db.close();

      expect(mode(crowHome)).toBe(0o700);
      expect(mode(dbPathFor(crowHome))).toBe(0o600);
    } finally {
      process.umask(originalUmask);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("the -wal and -shm sidecars are also 0600 once WAL mode creates them", () => {
    // Covers: R1, R3
    const base = mkdtempSync(join(tmpdir(), "crow-db-"));
    const crowHome = join(base, ".crow");
    const originalUmask = process.umask(0o022);

    try {
      const db = openDatabase(crowHome);
      db.close();

      const dbPath = dbPathFor(crowHome);
      expect(existsSync(dbPath + "-wal")).toBe(true);
      expect(existsSync(dbPath + "-shm")).toBe(true);
      expect(mode(dbPath + "-wal")).toBe(0o600);
      expect(mode(dbPath + "-shm")).toBe(0o600);
    } finally {
      process.umask(originalUmask);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("opens in WAL mode", () => {
    // Covers: R1
    const base = mkdtempSync(join(tmpdir(), "crow-db-"));
    try {
      const db = openDatabase(join(base, ".crow"));
      const row = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode;").get();
      expect(row?.journal_mode).toBe("wal");
      db.close();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("reopening an existing CROW_HOME re-secures its permissions", () => {
    // Covers: R3
    const base = mkdtempSync(join(tmpdir(), "crow-db-"));
    const crowHome = join(base, ".crow");
    try {
      openDatabase(crowHome).close();
      const db = openDatabase(crowHome);
      db.close();

      expect(mode(crowHome)).toBe(0o700);
      expect(mode(dbPathFor(crowHome))).toBe(0o600);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
