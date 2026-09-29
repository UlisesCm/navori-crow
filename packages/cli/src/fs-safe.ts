import {
  accessSync,
  chmodSync,
  chownSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/** Backups kept per engine (D13). */
export const BACKUP_KEEP = 10;

/** Mode of a file crow creates from scratch (a config crow did not find). */
const NEW_FILE_MODE = 0o600;

/** Options of {@link safeWrite}. */
export interface SafeWriteOptions {
  /** `$CROW_HOME`; backups go to `<crowHome>/backups/<engine>/`. */
  crowHome: string;
  engine: string;
  /** Injectable clock for deterministic backup names. */
  now?: () => Date;
  /** Test seam: runs after the temp file is fully written and before the rename. */
  beforeRename?: (tmpPath: string) => void;
}

/** Result of {@link safeWrite}. */
export interface SafeWriteResult {
  /** Real path that was written (symlinks resolved). */
  target: string;
  /** Backup path, `null` when the target did not exist before. */
  backup: string | null;
}

/** Follows symlinks to the real file; a missing path resolves through its parent. */
export function resolveTarget(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return join(realpathSync(dirname(path)), basename(path));
  }
}

/** UTC stamp with milliseconds, sortable as text: `20260929T101530123Z`. */
function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(".", "");
}

/** Deletes all but the `keep` most recent `.bak` files of a backup directory. */
export function rotateBackups(dir: string, keep: number = BACKUP_KEEP): void {
  const baks = readdirSync(dir)
    .filter((f) => f.endsWith(".bak"))
    // The UTC stamp sits before ".bak"; sort by it, not by basename.
    .sort((a, b) => (a.slice(-24) < b.slice(-24) ? -1 : a.slice(-24) > b.slice(-24) ? 1 : 0));
  for (const old of baks.slice(0, Math.max(0, baks.length - keep))) unlinkSync(join(dir, old));
}

/**
 * Copies `target` to `<crowHome>/backups/<engine>/<basename>.<UTC>.bak` (0600 in a
 * 0700 directory) and rotates to the newest {@link BACKUP_KEEP}. Throws on failure:
 * callers abort rather than write without a backup (R22).
 */
export function backupFile(target: string, opts: SafeWriteOptions): string {
  const dir = join(opts.crowHome, "backups", opts.engine);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const dest = join(dir, `${basename(target)}.${stamp((opts.now ?? (() => new Date()))())}.bak`);
  copyFileSync(target, dest, constants.COPYFILE_EXCL);
  chmodSync(dest, 0o600);
  rotateBackups(dir);
  return dest;
}

/** Best-effort fsync of a directory so the rename is durable; some platforms reject it. */
function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Unsupported (no-op or EINVAL/EPERM): the rename already happened, never fail the write.
  }
}

/**
 * Atomic write: temp file in the target's directory, fsync, original mode (and
 * owner, best effort), then `rename` over the target. The target is either the
 * old or the new content, never truncated.
 */
export function atomicWrite(
  target: string,
  content: string,
  beforeRename?: (tmp: string) => void,
): void {
  const mode = existsSync(target) ? statSync(target).mode & 0o7777 : NEW_FILE_MODE;
  const tmp = join(dirname(target), `.${basename(target)}.crow-${process.pid}-${Date.now()}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, mode);
    if (existsSync(target)) {
      const { uid, gid } = statSync(target);
      try {
        chownSync(tmp, uid, gid);
      } catch {
        // Not permitted (not root, other owner): keep going, the mode is what matters.
      }
    }
    beforeRename?.(tmp);
    renameSync(tmp, target);
    fsyncDir(dirname(target));
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Temp already gone.
    }
    throw err;
  }
}

/**
 * Writes `content` to `path` through symlinks (MF8): the link is never replaced,
 * its real target is. Backs up an existing target first and aborts if it cannot
 * (R22); aborts before touching anything if the target is not writable.
 */
export function safeWrite(path: string, content: string, opts: SafeWriteOptions): SafeWriteResult {
  const target = resolveTarget(path);
  const exists = existsSync(target);
  accessSync(exists ? target : dirname(target), constants.W_OK);
  const backup = exists ? backupFile(target, opts) : null;
  atomicWrite(target, content, opts.beforeRename);
  return { target, backup };
}
