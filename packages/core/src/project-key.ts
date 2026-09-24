import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

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
 * Algorithm (PLAN.md §7.3):
 * 1. Resolve `git rev-parse --path-format=absolute --git-common-dir` from `cwd`.
 * 2. Apply `realpath` and strip the trailing `/.git`.
 * 3. `key = sha1(path).slice(0, 12)`.
 * 4. If there's no git repo, use `realpath(cwd)` directly.
 * 5. Cache the result in memory per `cwd`.
 */
export function projectKey(cwd: string): ProjectKeyResult {
  const cached = cache.get(cwd);
  if (cached) return cached;

  const result = resolveProjectRoot(cwd);
  const key = createHash("sha1").update(result).digest("hex").slice(0, 12);
  const resolved: ProjectKeyResult = { key, path: result };

  cache.set(cwd, resolved);
  return resolved;
}

/** Resolves the real project root path for `cwd`, git-aware. */
function resolveProjectRoot(cwd: string): string {
  const gitCommonDir = readGitCommonDir(cwd);
  if (gitCommonDir === null) {
    return realpathSync(cwd);
  }

  const realGitDir = realpathSync(gitCommonDir);
  return realGitDir.endsWith("/.git") ? realGitDir.slice(0, -"/.git".length) : realGitDir;
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
