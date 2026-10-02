---
name: resolve-ticket
description: Use when a ticket arrives (ID, URL or pasted text) and the task isn't trivial — the canonical 6-phase pipeline to process it with objective gates.
metadata:
  type: reference
  maxWords: 700
  # Compuesto (#683): ningún plugin extiende esta skill, así que los 50 sobre el
  # cap del asset son exactamente el margen de interpolación.
  maxWordsComposed: 750
---

<!-- navori:managed id="resolve-ticket" hash="8eaf782b" version="0.11.1" source="@navori/core" fmkeys="name,description,metadata" -->
# resolve-ticket — 6-phase pipeline

## Pipeline

Agents and skills chained by objective gates: what one phase pays for in tokens is written down for the next. Each phase writes to `.navori/state/handoffs/`; the gate is blocking. `scout` is used on demand inside any phase, not as a phase of its own.

| Phase | Who covers it | Artifact / Gate |
|---|---|---|
| 1 · Triage | you: `mem_search`, `cat progress/current.md`, `git status/log` | Trivial → skip the deeper phases; it still goes through `implementer`. If `progress/current.md` is not idle with ANOTHER ticket, ask; never two in parallel. |
| 2 · AUDIT | `auditor` (ticket encargo) — ONE, or one per area, only when the orchestration table's disparadores fire | `audit_ticket_<ID>.md`: **verdict** (proceed / proceed-differently / split / doesn't apply / blocked), verified problem + size, assessment of the ticket's proposed fix. **Gate: only `proceed` and `proceed-differently` wait for the user's approval.** Any other verdict opens no work → it closes the cycle here, unattended, with its evidence. No trigger fires → straight to 4, the ticket's own text is the audit. |
| 3 · Design | `solution-design` skill + ONE fresh-context `auditor` challenge | Only on an architectural signal (orchestration table), a `proceed-differently` verdict. Produces `solution_<scope>.md` + `solution_review_<scope>.md`. **Gate: your verdict READY / CONCERNS / BLOCKED** — `CONCERNS` records the risk and moves on, only `BLOCKED` stops. No signal → straight to 4. |
| 4 · Implementation | ONE `implementer` agent, `verify-before-done` inside it | Reads `audit_ticket_<ID>.md` (if 2 ran) → `solution_<scope>.md` (if 3 ran) → applicable skill. Produces `impl_<feature>.md` with fresh verification evidence at exit 0. **Gate: `bun run lint && bun run typecheck` green in the turn.** No evidence → back here. |
| 5 · Review | `reviewer` agent + `review-diff` skill | `review_<feature>.md`. Two-pass; Pass 1 fails → `CHANGES_REQUESTED`, back to 4. `APPROVED` → continue. |
| 6 · Publish | `publisher` agent | PR created and its URL to the user; a tracker comment only when the user asks for one — not a default step of the cycle. Then close the session per the closeout block. |

## Phase 2 fan-out

Only when the orchestration table's fan-out row fires, never on "it feels separable": three auditors on a one-file ticket cost more than the serial run they replace. Then one `auditor` per area, **all the `spawn_agent` calls in the SAME turn**, each writing `audit_ticket_<ID-area>.md` (e.g. `audit_ticket_BTBS-138-webapp.md`) so none overwrites another. **You synthesize** the N reports — contradictions and gaps included — into the single `audit_ticket_<ID>.md` every later phase reads. Never delegated.

## Hard rules

- **Phase 2 fires only on its disparadores** — never skipped because you "already understood the ticket" when it does fire, and never invented when it doesn't: the audit is for the implementer, and for you in 3 days.
- **No PR without `APPROVED`.**
- **A verdict that opens no work doesn't wait for approval:** report it with its evidence, leave `progress/current.md` at `idle`, stop — asking permission to do nothing turns a finished pipeline into a stalled one. Only `proceed` / `proceed-differently` hold for the user, right before code gets written.
- **A tracker comment is opt-in, per cycle, on request** — `publisher` drafts and posts it only when the user asks; the pipeline never assumes one is wanted.

## Before declaring done

- A cycle that proceeded ends with a PR via `publisher` and its URL to the user.
- A cycle closed at phase 2 ends with its verdict + evidence and no PR.
- Either way, `progress/current.md` at `idle`.
<!-- /navori:managed id="resolve-ticket" -->
