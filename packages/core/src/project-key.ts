import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname } from "node:path";

/** Result of resolving a working directory to a stable project identity. */
export interface ProjectKeyResult {
  /** Stable hash identifying the project (see PLAN.md §7.3). */
  key: string;
  /** Resolved real path of the project root, for display. */
  path: string;
}

const cache = new Map<string, ProjectKeyResult>();

/**
 * Resolves a `cwd` to a stable project identity that collapses subdirectories
 * and git worktrees into the same key as their main checkout.
 *
 * Algorithm (PLAN.md §7.3, hardened per design.md D11 — never throws):
 * 1. If `cwd` exists, resolve `git rev-parse --path-format=absolute
 *    --git-common-dir` from it, apply `realpath` and strip the trailing
 *    `/.git`. If there's no git repo, use `realpath(cwd)` directly.
 * 2. If `cwd` doesn't exist (a deleted worktree), walk up to the nearest
 *    existing ancestor and retry the git resolution from there.
 * 3. If neither yields a repo root (no git, or any `git`/`realpath` error
 *    along the way), fall back to `key = sha1(cwd literal)` and `path = cwd`
 *    — a worktree that no longer exists must never crash the ingest pipeline.
 * 4. `key = sha1(path).slice(0, 12)`.
 * 5. Cache the result in memory per `cwd`.
 */
export function projectKey(cwd: string): ProjectKeyResult {
  const cached = cache.get(cwd);
  if (cached) return cached;

  let result: string;
  try {
    result = resolveProjectRoot(cwd);
  } catch {
    result = cwd;
  }
  const key = createHash("sha1").update(result).digest("hex").slice(0, 12);
  const resolved: ProjectKeyResult = { key, path: result };

  cache.set(cwd, resolved);
  return resolved;
}

/**
 * Resolves the real project root path for `cwd`, git-aware.
 * Throws on any failure; {@link projectKey} catches it and falls back to
 * the literal `cwd` (D11).
 */
function resolveProjectRoot(cwd: string): string {
  const base = existsSync(cwd) ? cwd : nearestExistingAncestor(cwd);
  if (base === null) {
    throw new Error(`no existing ancestor of ${cwd}`);
  }

  const gitCommonDir = readGitCommonDir(base);
  if (gitCommonDir === null) {
    if (base === cwd) return realpathSync(cwd);
    throw new Error(`not a git repo: ${base}`);
  }

  const realGitDir = realpathSync(gitCommonDir);
  return realGitDir.endsWith("/.git") ? realGitDir.slice(0, -"/.git".length) : realGitDir;
}

/** Walks up from `path` to the nearest existing directory, or `null` if none exists. */
function nearestExistingAncestor(path: string): string | null {
  let dir = dirname(path);
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    dir = parent;
  }
  return dir;
}

/** Runs `git rev-parse --git-common-dir` from `cwd`; `null` if not a git repo. */
function readGitCommonDir(cwd: string): string | null {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return null;

    const output = proc.stdout.toString("utf8").trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}
