---
name: verify-before-done
description: Use when about to declare a task done — the Iron Law of task closure: no success claim without fresh evidence from the command that backs it. Applies to implementer, reviewer, publisher and any response that declares "done".
metadata:
  type: behavior
  maxWords: 650
---

<!-- navori:managed id="verify-before-done-base" hash="70b147c4" version="0.10.0" source="@navori/core" fmkeys="name,description,metadata" -->
# Verify Before Done

## The Iron Law

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

If you didn't run the command THIS TURN, you can't make the claim. "Should work", "previous run was green" are inference, not evidence.

## Gate function

BEFORE claiming "done / ready / approved": IDENTIFY the command that proves it → RUN it this turn → READ output, exit code, failure count → VERIFY it confirms the claim (NO → declare the real state; YES → claim it WITH the evidence visible). Skipping a step is a lie, not verification.

## Table: claim → required output → not sufficient

| Claim | Required output | Not sufficient |
|---|---|---|
| `(quality gate sin configurar — corre 'navori configure quality-gate')` / `(quality gate sin configurar — corre 'navori configure quality-gate')` green | Full command run this turn, exit 0 | "ran it before", "should be green" |
| Zero new errors vs baseline | `git diff --name-only main` — a failure outside that list predates you | "lint said OK", no comparison |
| UI validated in the browser (only if asked) | Observed state via the repo's browser tool this turn | "looks fine in code" |
| Bug fixed | Reproduce the original symptom and see it NOT happen | "code changed, assumed fixed" |
| PR creatable | Pre-flight THIS TURN: not on the protected base branch, `gh auth status`, receipt `"status":"ok"` (prefer `navori receipt check …`; if the installed CLI lacks it, use the repository-built CLI); declared-inline change, your own run. No clean working tree required | "the branch has commits, we can create it" |
| Tests / type-check clean | Suite / `tsc --noEmit` run fresh, exit 0, this turn | "should still be green" |
| A shell edit landed (`sed -i`, a `>` redirect) | Re-read the changed span, this turn | The exit code — `sed -i` exits 0 on no match, a misdirected `>` truncates the file |
| Gate outlives Bash timeout, main session | `run_in_background`, wait on completion or `Monitor`; `TaskStop` unneeded tasks first | Polling (`pgrep`, `ps \| grep`) — matches other sessions' waits too |
| Gate outlives Bash timeout, subagent | Its `&&` steps one by one, foreground, under the timeout | Backgrounding — a subagent never gets re-woken, the run orphans |

## Baseline attribution (triage, not proof of age)

- Diff file → **introduced**. Outside the diff, no comparable baseline → **origin not determined**; only evidence over the same command/range calls it pre-existing. No location → not measured.
- Never `git stash` to measure it — empties the shared tree while another agent reads it. Never exempts a red gate or skips review.

## Red flags (STOP)

- About to write "done"/"ready"/"should work", or `git commit`/`APPROVED` without a fresh `(quality gate sin configurar — corre 'navori configure quality-gate')` run and a full diff read. "Just this once" — NO.
- Trusting a subagent's report without verifying its **load-bearing claims** (cited `file:line`s plus the diff it touched) — scope defined ONCE in `.claude/agents/orchestrator.md` § Anti-broken-telephone, never a full re-read of an already-validated diff.

## Rationalization prevention

| Excuse | Reality |
|---|---|
| "Confident" / "passed 10 min ago" | Confidence ≠ evidence. Re-run, fresh. |
| "If it compiles, it runs" | `strict: false` misses runtime undefined. |
| "Trivial" / "the subagent said done" | Doesn't exempt verification. |

## When invoked

`implementer` before `done -> impl_<feature>.md`; `reviewer` before `APPROVED`; `publisher` in pre-flight; any agent before "done".

## Closing

Always active, no explicit invocation. Include the claim, the fresh evidence, and any sub-claim that COULD NOT be verified — stated explicitly, never inferred.
<!-- /navori:managed id="verify-before-done-base" -->

## Project-specific checks

<!-- user: add here claims specific to your repo and their required evidence. Suggestions:
     - DB migrations: command to validate the state (e.g. your ORM's migration status).
     - Critical areas: auth, permissions, payments, data integrity → specific checks per area.
     - Repo scripts that count as "valid evidence" (e.g. `pnpm e2e:smoke`).
     - Commands forbidden as evidence (e.g. "the Vercel preview" if it's not a real repro).
     - Recurring bug patterns of the repo where inference has historically failed.
-->
