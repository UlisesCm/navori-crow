---
name: scoped-gate
description: Use when a repo-wide quality gate never turns green because of preexisting debt the diff never touches. Documents the diff-scoped gate pattern (baseline, file scope, four edge cases) — hygiene the agent runs mid-session, never a substitute for `qualityGate.full`.
metadata:
  type: reference
  # 750 and not the 500 default (#901): each of the four edge cases below
  # carries the bug it once caused, the way `security-invariants` (1200) and
  # `debug-failure` (850) already justify their own overrides — a compressed
  # version loses the "why", and a reimplementation without it re-pays the
  # bug.
  maxWords: 750
---

<!-- navori:managed id="scoped-gate-base" hash="45693abb" version="0.10.0" source="@navori/core" fmkeys="name,description,metadata" -->
# Scoped gate — diff-scoped quality gate as hygiene, not a seal

## The problem

A repo-wide `qualityGate.fast` judges the repo's **historical debt**, not the
agent's work. In a repo with preexisting failures, a blocking check never
turns green — not because it's slow, but because it's scoped wrong: it fails
on files the diff never touched. Measured across four repos: three are red on
`lint`/`format` from files outside any given diff.

## The pattern

Scope the fast check to the files actually in the diff instead of the whole
tree:

1. Resolve a baseline: `origin/<base>` first, the local ref only as fallback.
2. List files in scope: `git diff --name-only <base_sha>` **plus**
   `git ls-files --others --exclude-standard` for untracked files.
3. Run the linter/formatter against exactly that list.

```sh
base_sha=$(git rev-parse --verify --quiet "origin/main^{commit}" || git rev-parse main)
files=$( { git diff --name-only --diff-filter=ACMRT "$base_sha" -- '*.ts' '*.tsx'; \
           git ls-files --others --exclude-standard -- '*.ts' '*.tsx'; } | sort -u)
[ -n "$files" ] && eslint $files
```

Adapt the pathspec and linter invocation to the repo; the shape (baseline →
scope → run) is what matters.

## Four edge cases — each one cost a real bug to discover

- **Untracked files (#777).** Most of an agent's work is new files. When a
  single Bash call does `git add x && git commit`, the `PreToolUse` hook runs
  BEFORE the commit, so a scope built only from `git diff` reports `0 files to
  scan` — the gate goes green over a file nobody read. Always add
  `git ls-files --others --exclude-standard` to the scope.
- **A failed listing is not "nothing changed" (#511).** A `git` call that
  fails (unborn HEAD, a corrupt index, a base that vanished) produces empty
  output — indistinguishable from an empty diff unless you check its exit
  status. Without a sentinel, the gate reports `0 files to scan` and approves
  a tree it never read. Capture the exit code of every listing, not just the
  file list.
- **Baseline freshness.** Prefer `origin/<base>` over the local ref: an agent
  worktree is cut from whatever the base pointed at when it was created and
  never moves again, so the local ref has no freshness guarantee and can
  silently drift behind merged work.
- **Agent worktrees.** A hook fired by a commit inside a worktree still starts
  execution from the main repo's cwd. Resolving paths against the wrong root
  makes the scanner never run at all — silently, since an empty scope looks
  identical to a clean one without edge case #511's sentinel.

This repo's own `check-jscpd.sh` and `check-semgrep.sh` (under the Claude
engine's rendered scripts dir) implement exactly this pattern, sharing their
logic through a partial internal to navori's own source — read them for a
working reference, but a consumer repo does not have that partial and must
write its own script.

## Wiring: a `package.json` script, not a bare path

Claude Code pre-approves `<package-manager> run <script>` as
`Bash(<step>:*)`, but a bare script path (`bash path/to/script.sh`) earns
no rule and prompts on every run (`packages/cli/src/engines/claude/build-settings.ts:634-638`).
Define the scoped check as a `package.json` script invoked by the repo's
package manager (e.g. `pnpm run gate:fast`), never as a direct path to a
script file — pointing at the script directly reintroduces the friction that
led agents to wrap commands in `bash -c '…'` to dodge prompts.

## The honest limit: `typecheck` does not scope

`tsc` type-checks the whole project graph; there is no "these files only"
without losing correctness (a change in file A can break file B's types).
Two options, neither free: filter the reported errors by touched file
(misses errors your change caused elsewhere), or leave `typecheck` in the
repo-wide gate only. Default: leave it out of the scoped gate. A repo that is
already green on `typecheck` can afford to keep it repo-wide — the check is
typically sub-second there.

## Hygiene, never a seal

A scoped gate is **hygiene, never a seal**: it catches the agent's own
mistakes mid-session, cheaply, in a repo where the repo-wide check can't. It
never replaces `qualityGate.full`, which stays repo-wide and remains the
`reviewer`'s Pass 2. Treating a scoped-green result as approval is worse than
having no scoped gate at all — it launders preexisting debt as a pass.
<!-- /navori:managed id="scoped-gate-base" -->

## Your repo's scoped gate

<!-- user: document here the concrete wiring for this repo — the
     `package.json` script name, the pathspec/extensions it scopes to, and
     whether `typecheck` stays repo-wide or gets excluded. -->
