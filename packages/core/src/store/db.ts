import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Absolute path of the SQLite file inside a given `CROW_HOME` directory. */
export function dbPathFor(crowHome: string): string {
  return join(crowHome, "crow.db");
}

const SECURE_DIR_MODE = 0o700;
const SECURE_FILE_MODE = 0o600;

/** WAL/SHM sidecar suffixes SQLite creates once a write happens under WAL mode. */
const SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;

/** Applies 0600 to the DB file and its `-wal`/`-shm` sidecars, when they exist. */
function secureDbFiles(dbPath: string): void {
  chmodSync(dbPath, SECURE_FILE_MODE);
  for (const suffix of SIDECAR_SUFFIXES) {
    const sidecar = dbPath + suffix;
    if (existsSync(sidecar)) chmodSync(sidecar, SECURE_FILE_MODE);
  }
}

/**
 * Opens (creating if needed) the crow SQLite database under `crowHome`,
 * in WAL mode, with permissions `0700` on the directory and `0600` on the
 * database file plus its `-wal`/`-shm` sidecars (R1, R3).
 *
 * Does not run migrations — see `store/migrations.ts`.
 */
export function openDatabase(crowHome: string): Database {
  if (!existsSync(crowHome)) {
    mkdirSync(crowHome, { recursive: true, mode: SECURE_DIR_MODE });
  }
  chmodSync(crowHome, SECURE_DIR_MODE);

  const path = dbPathFor(crowHome);
  const db = new Database(path, { create: true });

  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");

  // Entering WAL mode alone doesn't create the `-wal`/`-shm` sidecars yet —
  // SQLite creates them lazily on the first write. A no-op write transaction
  // forces that now, so the permissions below cover every file that exists.
  db.exec("BEGIN IMMEDIATE;");
  db.exec("COMMIT;");

  secureDbFiles(path);
  return db;
}
