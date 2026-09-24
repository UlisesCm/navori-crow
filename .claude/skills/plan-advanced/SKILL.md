---
name: plan-advanced
description: Use when `navori plan classify` returns level 2 (score ≥ 8 or a floor) or the plan gate escalates a feature after two rejections — runs the architect design, the auditor challenge and the user's choice before the level-2 workplan. Not for level 1 (plan-simple) or an accepted spec (spec-bootstrap).
metadata:
  type: reference
---

<!-- navori:managed id="plan-advanced" hash="2270d046" version="0.10.0" source="@navori/core" fmkeys="name,description,metadata" -->
# plan-advanced — level-2 workplan

## Steps

1. Dispatch `architect` with the task, the signals and `classify`'s breakdown → it writes
   `solution_<feature>.md`.
2. Dispatch a fresh-context `auditor` (challenge encargo) → `solution_review_<feature>.md`.
3. "Present the surviving options to the user with the recommended one first and the challenge
   findings beside each; the user picks." If only one survives, say so and move on.
4. Your verdict, post-challenge: READY / CONCERNS / BLOCKED.
5. Write the level-2 workplan: everything `plan-simple` covers plus `solution {path, verdict}`,
   phases with their `A<n>`, and risks with their rollback; render, check and get the user's
   approval.
6. After two rejections, the gate requires `solution_<feature>.md` and
   `solution_review_<feature>.md`: the architect diagnoses why the previous design failed before
   redesigning.
7. "Knowledge destinations the architect proposes are proposals: write none without the user's
   approval, and a Dominio entry only on explicit approval."

## Before declaring done

- [ ] `architect` dispatched with task, signals and `classify`'s breakdown; `solution_<feature>.md`
      exists.
- [ ] Fresh-context `auditor` challenge ran; `solution_review_<feature>.md` exists.
- [ ] Surviving options presented to the user with the recommended one first and the challenge
      findings beside each (or the single survivor named); the user picked.
- [ ] Your verdict recorded: READY / CONCERNS / BLOCKED.
- [ ] Level-2 workplan written (solution reference, phases with `A<n>`, risks with rollback),
      rendered, checked green, and approved.
- [ ] After two rejections, both `solution_<feature>.md` and `solution_review_<feature>.md` cover
      the diagnosis before any redesign.
- [ ] No knowledge destination written without the user's explicit approval.

If any item fails, fix it and re-run the whole list.
<!-- /navori:managed id="plan-advanced" -->

## This repo's level-2 workplans

<!-- user: add here what's specific to your repo — who reviews `solution_<feature>.md`
     before the user sees it, and any local convention for phase boundaries or
     rollback evidence. -->
