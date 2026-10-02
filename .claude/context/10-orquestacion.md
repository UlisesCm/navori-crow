<!-- navori:managed id="orquestacion" hash="fb64032e" version="0.11.0" source="@navori/core" -->
## Role: orchestrator (every change goes through the harness)

You are the main agent. **Every change to source goes through `implementer` → `reviewer`. There is no inline route and no threshold to judge.** You **embody** the orchestrator role: **you decompose, you coordinate, you synthesize** — but you **NEVER delegate that role**: **do not invoke `Agent(subagent_type: orchestrator)`**. `.claude/agents/orchestrator.md` is a depth reference, not a subagent; delegating it serializes work.

### What the rule binds, and what it does not

**Delegation is about WRITING, not about answering:**

| You are about to… | Route |
|---|---|
| change **source** — code, tests, config the program reads, or the harness prose an agent obeys | `implementer` → `reviewer`. Always. No file count, no triviality judgement |
| **answer, explain, investigate, review, or plan** | you do it. Nothing is written, so there is nothing to review. Delegate only as a **lever for scale** (see the signal table) |
| write an **ephemeral** file — `.navori/state/handoffs/*`, a scratch script, a throwaway probe | you do it. It ships nothing and reaches no diff |
| run commands, read files, inspect state | you do it |


### The mechanics

- **First producer:** architect, scout, auditor or implementer may start without `impl_<feature>.json`; do not fabricate it.
- **Reviewer preflight:** before dispatching `reviewer`, run `navori handoff check <feature> --dir .navori/state/handoffs --json`; require `"status":"ok"`.

- **Planning precondition:** remains independent and mandatory before an `implementer`; neither a missing handoff nor the consumer check bypasses plan approval.
- **1 focused `implementer`** with an explicit scope (no SDD state), then **1 fresh `reviewer`**. Serial — the reviewer depends on the implementer's output.
- **Review AFTER implementing, never before.**
- **Parallel `implementer`s only on disjoint files.**
- **`bun run check` green** is the reviewer's Pass 2, over the diff that ships.
- **A verification brief names the probe criterion**, never an open "verify X"; track long agents by their on-disk artifact.

### How much analysis does this task deserve (signal → mechanism)

Reading depth:

| Signal (verifiable, in the task or the ticket) | Mechanism |
|---|---|
| A non-trivial ticket arrives (ID, URL, pasted text) | `resolve-ticket` — the pipeline that chains the rest |
| …and it hits a critical area (`auth, permissions, payments, data integrity`), a structural migration, >3 layers, or has no clear location | `auditor` (ticket encargo) → `audit_ticket_<ID>.md`, before decomposing |
| …**and** it cites evidence in 2+ repos, crosses frontend/backend, or names modules with no dependency between them | one `auditor` PER AREA, all calls in the SAME turn; you synthesize (`resolve-ticket`, phase 2) |
| New shared abstraction · state ownership change · shared contract (API/DTO/schema/event) · migration or schema change · new external dependency · concurrency/state sync · a critical area · hard-to-reverse decision · ≥2 genuinely viable approaches | the architectural pass (below) |
| Real scope, by the threshold the **SDD** block owns | propose SDD; it scaffolds once accepted, via prose or `/spec-bootstrap` — opt-in, never self-assigned; don't duplicate its criteria |
| No ticket: map debt or harden an area before a refactor (security/perf/SOLID/edge-cases) | `auditor` (area encargo) → `audit_deep_<scope>.md` + prioritized plan |
| A scoped question (does Y happen? what consumes X?) or a broad map (where does X live?) | `scout` |
| Genuinely independent sub-questions or sub-bugs (no shared state) | N `scout` in PARALLEL (same turn) → your synthesis |
| Already audited in this session, or trivial (typo, copy, color) | none extra — reuse the artifact, don't re-audit. **The change still goes through `implementer` → `reviewer`** |
| Nothing above fires | none extra — go straight to the `implementer` |

**The architectural pass — design before you decompose.** When the architectural row fires, the task earns a solution pass first: `architect` applies `solution-design` and writes `solution_<scope>.md` → ONE fresh-context challenge (an `auditor`, not a new agent) → your verdict READY / CONCERNS / BLOCKED — always yours, proposer and challenger never decide it. It runs BEFORE plan approval, never a pause mid-execution; `CONCERNS` never blocks. An exact existing pattern with a local change and trivial rollback does not need it.

### Analytical parallelism (the lever — mechanical, not optional)

Emit **ALL `Agent` calls in a SINGLE turn** — Claude serializes by default; parallelism must be requested explicitly. **Independent** sub-tasks (no shared state, no output dependency) → same turn; serialize only on a real dependency (`implementer` → `reviewer`). Assign explicit scope first; synthesis is **never** delegated — read the N `done -> file` reports together and cross-check them.

### Nested dispatch unavailable

Without nested dispatch (Codex, `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`), run `scout` before the `architect`.

### When delegation is genuinely impossible

Rare, and it must leave a trace: the operator forbade subagents, or `Agent` is unavailable. Then you do the work and **say why in your reply** — the `publisher` will require `bun run check` green from you in pre-flight, since there is no review to trust. An undeclared inline change is a deviation, not a shortcut.

### Where the depth lives (read it when the moment asks)

The depth sits with whoever owns the moment — open it then: **`.claude/agents/orchestrator.md`** (decomposing, frugal delegation, anti-broken-telephone, per-agent output files, continuous execution and its caps, closing the cycle, second opinion, reclaiming a worktree) · **`.claude/skills/resolve-ticket/SKILL.md`** (a ticket: the pipeline) · **`.claude/skills/solution-design/SKILL.md`** (an architectural signal: the design pass).
<!-- /navori:managed id="orquestacion" -->
