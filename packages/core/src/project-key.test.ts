import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectKey } from "./project-key";

/** Runs a git command synchronously in `cwd`, throwing on failure. */
function git(cwd: string, ...args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString("utf8")}`);
  }
}

describe("projectKey", () => {
  let base: string;
  let repoDir: string;
  let subDir: string;
  let worktreeDir: string;
  let nonGitDir: string;
  let symlinkDir: string;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "crow-project-key-"));

    repoDir = join(base, "repo");
    mkdirSync(repoDir);
    git(repoDir, "init", "-q", "-b", "main");
    git(repoDir, "config", "user.email", "test@example.com");
    git(repoDir, "config", "user.name", "Test");
    writeFileSync(join(repoDir, "README.md"), "hello\n");
    git(repoDir, "add", "README.md");
    git(repoDir, "commit", "-q", "-m", "init");

    subDir = join(repoDir, "sub");
    mkdirSync(subDir);

    worktreeDir = join(base, "worktree");
    git(repoDir, "worktree", "add", worktreeDir);

    nonGitDir = join(base, "nogit");
    mkdirSync(nonGitDir);

    symlinkDir = join(base, "symlink");
    symlinkSync(subDir, symlinkDir, "dir");
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("a subdirectory of a repo resolves to the same key as the root", () => {
    expect(projectKey(subDir).key).toBe(projectKey(repoDir).key);
  });

  test("a git worktree resolves to the same key as the main checkout", () => {
    expect(projectKey(worktreeDir).key).toBe(projectKey(repoDir).key);
  });

  test("a non-git directory falls back to a realpath-based key", () => {
    const result = projectKey(nonGitDir);
    const realPath = realpathSync(nonGitDir);
    expect(result.path).toBe(realPath);
    expect(result.key).toBe(createHash("sha1").update(realPath).digest("hex").slice(0, 12));
  });

  test("a symlinked directory resolves to the same key as its target", () => {
    expect(projectKey(symlinkDir).key).toBe(projectKey(subDir).key);
  });

  test("a cwd that doesn't exist never throws and falls back to a literal-path key (D11)", () => {
    // Covers: R15
    const deletedDir = join(base, "never-existed");
    expect(() => projectKey(deletedDir)).not.toThrow();
    const result = projectKey(deletedDir);
    expect(result.path).toBe(deletedDir);
    expect(result.key).toBe(createHash("sha1").update(deletedDir).digest("hex").slice(0, 12));
  });

  test("a subdirectory of a deleted repo never throws and resolves via the nearest ancestor (D11)", () => {
    // Covers: R15
    const deletedRepo = join(base, "deleted-repo");
    mkdirSync(deletedRepo);
    git(deletedRepo, "init", "-q", "-b", "main");
    git(deletedRepo, "config", "user.email", "test@example.com");
    git(deletedRepo, "config", "user.name", "Test");
    writeFileSync(join(deletedRepo, "README.md"), "hello\n");
    git(deletedRepo, "add", "README.md");
    git(deletedRepo, "commit", "-q", "-m", "init");
    const missingSub = join(deletedRepo, "gone", "deeper");

    rmSync(deletedRepo, { recursive: true, force: true });

    expect(() => projectKey(missingSub)).not.toThrow();
    const result = projectKey(missingSub);
    // No git repo survives at any existing ancestor, so it falls back to the
    // literal cwd rather than crashing.
    expect(result.path).toBe(missingSub);
    expect(result.key).toBe(createHash("sha1").update(missingSub).digest("hex").slice(0, 12));
  });
});
