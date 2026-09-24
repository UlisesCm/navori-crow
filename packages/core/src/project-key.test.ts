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
});
