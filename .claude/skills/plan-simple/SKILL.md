---
name: plan-simple
description: Use when `navori plan classify` returns level 1 or the plan gate denies an implementer dispatch — writes the level-1 workplan JSON, renders and checks it, and keeps it current while the work runs. Not for level 2 (plan-advanced) or an accepted spec (spec-bootstrap).
metadata:
  type: reference
---

<!-- navori:managed id="plan-simple" hash="8fa4618d" version="0.10.0" source="@navori/core" fmkeys="name,description,metadata" -->
# plan-simple — level-1 workplan

## Steps

1. Draft `.claude/progress/workplan_<feature>.json`: a one-line observable goal; 1 to 5
   `A<n>` criteria, each with `command` and `expected`; at least one item out of scope;
   files measured against the repo (`"new": true` for new ones); declared signals.
2. Run `navori plan classify <feature>` → tell the user the level, score and breakdown in ≤ 4
   lines. If it comes back level 2 or higher, switch to `plan-advanced`.
3. Run `navori plan render <feature>` and `navori plan check <feature>` until both are green;
   show the rendered `.md` and wait for the user's approval.
4. "Open every implementer encargo with `workplan: <feature>` and list the `A<n>` that sub-task covers."
5. "When a sub-task closes, record it with `navori plan update`" (each `A<n>`'s status and
   decisions); `progress/current.md` points at the workplan, it doesn't copy it.
6. A change outside the approved files is a decision: record it and ask the user before
   dispatching it.
7. "Never write `workplan_<feature>.md` by hand — it is `navori plan render` output."

## Before declaring done

- [ ] Workplan drafted with a one-line goal, 1-5 `A<n>` with `command`/`expected`, ≥1 out-of-scope
      item, measured files, declared signals.
- [ ] `navori plan classify <feature>` ran and the level/score/breakdown went to the user in ≤ 4
      lines; a level ≥ 2 result switched to `plan-advanced`.
- [ ] `navori plan render` and `navori plan check` both green; the user approved the rendered `.md`.
- [ ] Every implementer encargo opened with `workplan: <feature>` and its `A<n>` list.
- [ ] Each closed sub-task recorded with `navori plan update`.
- [ ] A file outside the approved scope was either recorded as a decision with the user's
      go-ahead, or never dispatched.

If any item fails, fix it and re-run the whole list.
<!-- /navori:managed id="plan-simple" -->

## This repo's level-1 workplans

<!-- user: add here what's specific to your repo — where the `A<n>` commands
     typically live (test runner, lint target), and any local convention for
     naming out-of-scope items. -->
