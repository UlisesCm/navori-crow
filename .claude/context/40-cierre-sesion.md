<!-- navori:managed id="cierre-sesion" hash="f41ed3aa" version="0.11.0" source="@navori/core" -->
## Session closeout

Before closing the session:

1. **Quality gate**: run `navori receipt check --feature <feature> --include-consumed --json`. `"status":"ok"` and `"fresh":true` → cite the receipt as evidence, no re-run needed. Any other result → run bun run check again (or document debt in `progress/current.md`).
2. **History**: add an entry in `progress/history.md` with `## YYYY-MM-DD HH:MM <agent> — <summary>` + changes + gate status. **One redaction, every destination**: write that summary once and reuse the same text wherever else this closeout persists it (a memory store, for instance) — never write the same session up twice. If the session turned up a durable fact that outlives this repo (a data model, a business rule, a cross-service contract, a shared gotcha), promote it with the `dominio` skill instead of leaving it only in session memory.
3. **Clear current**: leave `progress/current.md` at `idle` or with the explicit next step.
4. **No temporaries**: delete scratch files; don't leave `console.log`, `debugger`, or commented-out code.
5. **Commit**: atomic, in the configured style (`conventional-es`), landing inside the work PR before it opens — never a `progress/`-only PR; `history.md` can't cite it. No work PR → commit `progress/` alone.
6. **Park on base**: once the cycle's work is committed and its branch pushed (PR opened when the flow calls for one), leave the repo standing on the base branch, synced: `git switch main` then `git pull --ff-only`. The point is where the NEXT session starts from — a repo parked on last week's feature branch breeds branches cut from stale bases. Rules that make it safe:
   - **Never delete the feature branch.** This is position hygiene, not history hygiene; the branch stays for its pending merge and for `follow-up-prs`.
   - Only with a **clean working tree** and the cycle's commits pushed. Anything unpushed or uncommitted → do NOT switch; say what was left and leave parking to the user.
   - `--ff-only`, always: the base must never receive a surprise merge from a parking step. If it doesn't fast-forward, report it instead of resolving it here.
   - If another session may be alive on this same working tree (a second terminal on this repo), switching yanks the branch out from under it — when in doubt, skip and say so.

**Lean close** — the conditions are verifiable, so this is not a judgment call: the session covered **one** user task and touched no critical area (`auth, permissions, payments, data integrity`). Both hold → skip step 2 when nothing was committed, and whatever ceremony another block exempts under this same name. It never exempts the quality gate, nor the `history.md` entry whenever there WAS a commit: a change that shipped leaves a trace, however trivial.
<!-- /navori:managed id="cierre-sesion" -->
