---
name: spec-bootstrap
description: Use when starting a real-scope feature before writing code — scaffolds a complete SDD spec (requirements/design/tasks) with EARS and R<n>↔test traceability.
metadata:
  type: reference
  # #892: model invocation re-enabled (dropped `disable-model-invocation`) so
  # accepting a proposal in prose can trigger scaffolding without asking the
  # user to also type `/spec-bootstrap`. The opt-in gate moves into the body
  # below as a blocking precondition instead — the host has no frontmatter
  # field for "invocable but must confirm first" (audited against the
  # official skills doc, ticket 892). That precondition costs ~50 words the
  # 650 cap didn't have room for (647/650 before this change), so the cap
  # goes up explicitly rather than shrinking unrelated prose to make space —
  # the override is loud, not silent (skill-meta.ts). 720 leaves a real
  # margin (697/720) instead of reproducing the same 3-word squeeze.
  maxWords: 720
  # Spec 0026 T16 (R35): the critical-areas challenge interpolates
  # auth, permissions, payments, data integrity INSIDE the managed zone, same defect as
  # review-diff (#683) — a verbose repo config pushes the composed file past
  # the asset's own cap with no plugin involved. Margin measured against the
  # skill-caps-composed.test.ts fixture.
  maxWordsComposed: 750
---

<!-- navori:managed id="spec-bootstrap" hash="a35d98fe" version="0.10.0" source="@navori/core" fmkeys="name,description,metadata" -->
# spec-bootstrap — kickoff of an SDD spec

## Before scaffolding — blocking precondition

Do not write anything under `specs` unless the user has explicitly accepted starting a spec in THIS thread — either by running `/spec-bootstrap` directly, or by accepting a proposal you made. No acceptance yet? Propose it and wait for the answer; never scaffold speculatively.

## When to use this skill

When SDD-scope work has been agreed with the user. The threshold and its opt-in gate live in ONE place — the **Spec Driven Development** block in `CLAUDE.md`; don't re-decide them here, and don't scaffold a spec nobody accepted.

Produces `specs/<feature>/{requirements.md, design.md, tasks.md}` ready to implement. Scaffolding is done by `orchestrator`, not a nested subagent.

**Challenge on critical areas.** WHEN the spec touches `auth, permissions, payments, data integrity`, a fresh-context `auditor` challenges it with `solution-design`'s falsification brief before handoff. One round, no verdict — `orchestrator` decides.

## Order

1. **requirements.md first.** No clear requirements, no design. Derive from the ticket/request; each requirement is EARS with id `R<n>`.
2. **design.md** — how to meet those `R<n>`: affected components, contracts, decisions and trade-offs. Reference the `R<n>` each decision satisfies. Design BEFORE decomposing: an architecture decision (e.g. a contract or a migration path) moves task boundaries, so tasks written first get rewritten. The `architect` writes `design.md`, applying `solution-design`.
3. **tasks.md** — batches of 1-3 tasks; each task lists the `R<n>` it covers and its test(s).
4. **`evals.md` — optional, rare.** Only when the feature ships a new **always-on layer** (context every session pays for), where prose can't prove behavior moved: `specs/<feature>/evals.md` tabulates RED (without the layer) / GREEN (with it) over ONE isolated variable — same ticket, same repo, same model — with named scenarios, each failure against its evidence, and inverted results kept exactly as they came out. The raw transcript dies with the session; the distilled table survives in git.

The reasoning that fills `design.md` is the `solution-design` skill — also the lighter home for an R2-architectural change that skips a full spec.

## Templates

`requirements.md`:
```md
# <Feature> — Requirements

## Context
<1-2 lines: what problem it solves and for whom.>

## Requirements (EARS)
- **R1** — The system SHALL <observable action>.
- **R2** — WHEN <event>, the system SHALL <action>.
- **R3** — IF <undesired condition> THEN the system SHALL <containment action>.
```

`design.md` — the first three sections always; the rest ONLY when the feature
raises them (an empty section is noise, not rigor):
```md
# <Feature> — Design

## Approach
<Chosen architecture and why. Discarded trade-offs.>

## Components
- <file/module> — <responsibility> — covers R<n>.

## Decisions
- <non-obvious decision> — <reason>.

## Contracts            ← if it touches an API/DTO/schema/event
## Failure modes        ← if it has partial failure, retries, concurrency
## Migration            ← if data or an existing contract changes shape
## Testing strategy     ← each test answers a risk named above, not a coverage quota
## NOT in scope         ← deferred work + why, so nobody "improves things along the way"
```

`tasks.md`:
```md
# <Feature> — Tasks

- [ ] **T1** (R1, R2) — <what gets implemented> · test: <file>::<case> with `// Covers: R1, R2`
- [ ] **T2** (R3) — <what gets implemented> · test: <file>::<case> with `// Covers: R3`
```

## Hard rules

- **Zero unresolved placeholders.** Don't leave `<...>`; an unknown value is a question for the user, not a hole. Same rule inside a task: "TBD", "implement later" or "similar to T<n>" describe nothing — name the observable behavior and the evidence expected. That is NOT a licence to dictate the code line by line; the implementer keeps its judgment.
- **Cite a stable anchor, not a line number:** `file` + symbol name, heading, or managed-block id — never `file:line`. Lines drift before implementation; a stale one skips real sites.
- **Every `R<n>` ends in ≥1 task and ≥1 test.** A requirement with no task or test isn't traceable → it doesn't enter the spec.
- **Tracking lives in `tasks.md`, not in `TaskCreate`.** See the SDD block.
- **Self-review before closing the scaffolding:** is each `R<n>` a single testable action? does each task point to real `R<n>`? does the design cover all the `R<n>`? If something fails, fix it before handing the spec off.
<!-- /navori:managed id="spec-bootstrap" -->
