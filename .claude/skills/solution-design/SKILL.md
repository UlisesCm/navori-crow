---
name: solution-design
description: Use when a task shows an architectural signal (new shared abstraction, ownership change, shared contract, migration, concurrency, critical area, hard-to-reverse decision) — decide WHAT to build and challenge it before decomposing into tasks.
metadata:
  type: reference
  # 1090 y no el default de 500 (spec 0003 §3.2.1): esta skill ya cargaba el
  # ciclo completo propose/challenge/verdict antes de spec 0029; el wiring
  # hacia `secure-by-design`/`quality-attributes` (R3/R4) que esa spec agrega
  # no cabía en los 3 palabras de margen que quedaban.
  maxWords: 1090
---

<!-- navori:managed id="solution-design" hash="d7ac2dec" version="0.10.0" source="@navori/core" fmkeys="name,description,metadata" -->
# solution-design — decide what to build, then try to break it

## When to use this skill

When a task shows any architectural signal (see the architectural pass in the
orchestration block), or a ticket audit came back `proceed-differently`. NOT for a
change following an exact existing pattern with local blast radius and trivial
rollback — no design pass needed, this skill is pure overhead.

This answers **what to build and why** — not the implementation plan (*what files,
in what order*), not code review (*did the code do what we agreed*). Design before
decomposing: a contract, a state owner or a migration path moves task boundaries,
so tasks written first get rewritten.

A security-sensitive signal also routes through `secure-by-design`; a
non-functional-requirement signal routes through `quality-attributes` for its
evidence matrix. Neither replaces this skill's verdict.

**Who does what (spec 0026 F; spec 0032 R23, R33).** Three roles, never collapsed: `architect`
**proposes** (applies this skill, writes the artifact) — always; there is no flag to turn it off.
`auditor` **challenges** in fresh context (or the orchestrator, with `auditor` off) — falsify, never
propose or polish. The orchestrator **decides**: READY / CONCERNS / BLOCKED, always its call
regardless of who proposed or challenged — synthesis is never delegated. With planning tiers on, at
level 2 the user picks among the surviving options before that verdict.

## The three failures this exists to prevent

1. **Inheriting the proposed solution.** A ticket naming a library, pattern or
   refactor already decided for you. Its diagnosis can be right, its remedy
   wrong. If step 0 is "install what the ticket named", you skipped the design.
2. **Listing costs without weighing them.** Naming drawbacks and proceeding anyway
   isn't analysis — a cost only counts against a concrete alternative.
3. **Filing scope-breaking findings as notes.** Discovering that part of the
   request is dead code, already fixed, or unsolved by what was proposed is a
   **verdict about scope**, not an open question.

## Process

1. **What already exists — first, with evidence.** Before proposing anything, find
   what in the repo already solves this fully or partially: `file:line`, the
   existing pattern, the layer that owns it today. Ask what the smallest change to
   THAT is. Before any option, derive the decision drivers from the project's own
   rules; the ladder `existing pattern > small extension > new abstraction > new
   subsystem` is one driver, not the default winner. Verify every 'already exists'
   claim against `origin/main`.
2. **State the real problem** — the behavior that changes and who consumes it, not
   the symptom the ticket describes.
3. **Approaches, only if ≥2 are genuine.** Never invent a straw alternative when
   one answer is obviously right. When the request proposes one, it is approach A
   and gets no privileges: give each option its tradeoffs and its cost of reversal.
4. **Choose**: what, why, and why not the others.
5. **Cover only the dimensions the signal raises** — boundaries and contracts,
   failure modes, migration and compatibility, testing strategy. An empty section
   is noise, not rigor. Every test you name answers a risk named above it.
6. **Challenge it in a fresh context** (below), then record the verdict.

## Ambiguity — three ways, never guess

- Answerable by reading the repo → investigate it.
- Product or human decision → ask it.
- Not blocking → assume the conservative option and **record the assumption**.

## The challenge (one round, fresh context)

Hand the artifact to a fresh-context `auditor` (challenge encargo) with a
falsification brief — break the design, don't polish it:

> What assumption is false? · What existing code contradicts it? · Which
> requirement isn't covered? · What contract breaks? · What happens on partial
> failure, timeout, duplicate delivery? · Who owns this state, and does the design
> respect it? · Are we duplicating an abstraction that already exists? · Can this
> be done with less machinery? · Would the tests catch the main risk?

It classifies findings `BLOCKER | CONCERN | NOTE` and writes
`solution_review_<scope>.md`. **It does not issue the verdict** — you do, when you
synthesize. One round only: once a scope decision is accepted or rejected, execute
it; do not re-argue it in later phases.

## Verdict

| | Meaning | Effect |
|---|---|---|
| `READY` | No known blockers. Notes may exist. | Implement |
| `CONCERNS` | Real risks, recorded, extra attention in review. | **Implement** — never blocks |
| `BLOCKED` | Implementing now means guessing a decision that could change the solution. | Ask and stop |

A `BLOCKED` must state four things: the blocking fact · why you cannot proceed
without guessing · who resolves it · the minimum information needed. **If you
cannot state all four, it is a CONCERN, not a blocker.**

**A product fork is not automatically a blocker.** Tickets arrive ambiguous;
blocking on every one turns this layer into the bottleneck it exists to remove.
On a real fork, ask: is one option defensible on the evidence, and cheap to
reverse? If both, it is `CONCERNS` — take that option, write the recommendation
and the discarded one explicitly ("going with B; if you meant A, say so"), and
let the work start. `BLOCKED` is for when no option is defensible without the
missing fact, or wrong picks are expensive to undo.

Never blockers: naming preference, a hypothetical future abstraction, a minor
optimization, an optional edge case, stylistic architecture taste.

## Artifact — `.claude/progress/solution_<scope>.md`

```markdown
# Solution — <scope>
**Verdict:** READY | CONCERNS | BLOCKED
**Signals:** <which ones triggered this pass>

## Problem
## What already exists          ← evidence, `file:line`; why extending it does/doesn't suffice
## Constraints
## Approaches                    ← only if ≥2 genuine; each with tradeoffs + cost of reversal
## Chosen solution               ← what · why · why not the others
## Boundaries & contracts        ← conditional
## Failure modes                 ← conditional
## Migration & compatibility     ← conditional
## Testing strategy              ← each test answers a risk named above
## NOT in scope                  ← deferred work + why; stops "improving things along the way"
## Open questions                ← [repo] investigate · [human] ask · [assumed] recorded
```

## Before declaring done

- "What already exists" cites real `file:line` and says why extending it is or
  isn't enough — not merely how the existing code fits the proposed solution.
- Any finding that changes what should be built is in the verdict, not a footnote.
- The challenge ran in a fresh context and its findings are classified.
- No empty conditional sections, and no invented alternatives.
<!-- /navori:managed id="solution-design" -->
