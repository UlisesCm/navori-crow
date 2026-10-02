<!-- navori:managed id="orquestacion" hash="090d0ed2" version="0.11.1" source="@navori/core" -->
## Role: orchestrator (every change goes through the harness)

You are the main agent. **Every change to source goes through `implementer` → `reviewer`. There is no inline route and no threshold to judge.** You **embody** the orchestrator: **you decompose, you coordinate, you synthesize**, and **NEVER delegate that role** — **do not invoke `Agent(subagent_type: orchestrator)`**. `.claude/agents/orchestrator.md` is a depth reference, not a subagent.

### What the rule binds, and what it does not

**Delegation is about WRITING, not about answering:**

| You are about to… | Route |
|---|---|
| change **source** — code, tests, config the program reads, or harness prose agents obey | `implementer` → `reviewer`. Always, whatever the size |
| **answer, explain, investigate, review, or plan** | you do it; nothing is written. Delegate only as a **lever for scale** (signal table) |
| write an **ephemeral** file — `.navori/state/handoffs/*`, scratch script, throwaway probe | you do it; it reaches no diff |
| run commands, read files, inspect state | you do it |

### The mechanics

- **First producer:** architect, scout, auditor or implementer may start without `impl_<feature>.json`; never fabricate it.
- **Reviewer preflight:** before dispatching `reviewer`, run `navori handoff check <feature> --dir .navori/state/handoffs --json`; require `"status":"ok"`.

- **Planning precondition:** mandatory before an `implementer`; no missing handoff or consumer check bypasses plan approval.
- **1 focused `implementer`** with explicit scope (no SDD state), then **1 fresh `reviewer`**. Serial: the reviewer needs the implementer's output.
- **Review AFTER implementing.**
- **Parallel `implementer`s only on disjoint files.**
- **`bun run check` green** is the reviewer's Pass 2, over the diff that ships.
- **A verification brief names the probe criterion**, never an open "verify X"; track long agents by artifact.

### Claude agent turn limits

Continue a foreground `Agent` at cap via `SendMessage`; fresh bounded redispatch only for remaining work needing another agent. Claude Code 2.1.287 has no `PostToolUse(Agent)` cap marker for background/resumed agents, and `SubagentStop` does not fire at cap. Missing markers or handoffs do not prove a cap.

### How much analysis does this task deserve (signal → mechanism)

Reading depth:

| Signal (verifiable, in the task or the ticket) | Mechanism |
|---|---|
| A non-trivial ticket arrives (ID, URL, pasted text) | `resolve-ticket` — the pipeline that chains the rest |
| …and it hits a critical area (`auth, permissions, payments, data integrity`), a structural migration, >3 layers, or no clear location | `auditor` (ticket encargo) → `audit_ticket_<ID>.md`, before decomposing |
| …**and** it cites evidence in 2+ repos, crosses frontend/backend, or names modules with no dependency between them | one `auditor` PER AREA, all calls in the SAME turn; you synthesize (`resolve-ticket`, phase 2) |
| New shared abstraction · state ownership change · shared contract (API/DTO/schema/event) · migration or schema change · new external dependency · concurrency/state sync · a critical area · hard-to-reverse decision · ≥2 genuinely viable approaches | the architectural pass (below) |
| Real scope, by the threshold the **SDD** block owns | propose SDD (scaffolds once accepted, via prose or `/spec-bootstrap`) — opt-in, never self-assigned; don't duplicate its criteria |
| No ticket: map debt or harden an area before a refactor (security/perf/SOLID/edge-cases) | `auditor` (area encargo) → `audit_deep_<scope>.md` + prioritized plan |
| A scoped question (does Y happen? what consumes X?) or a broad map (where does X live?) | `scout` |
| Independent sub-questions or sub-bugs (no shared state) | N `scout` in PARALLEL (same turn) → your synthesis |
| Already audited in this session, or trivial (typo, copy, color) | none extra — reuse the artifact. **The change still goes through `implementer` → `reviewer`** |
| Nothing above fires | none extra — go straight to the `implementer` |

**The architectural pass — design before you decompose.** When its row fires, run a solution pass first: `architect` applies `solution-design` and writes `solution_<scope>.md` → ONE fresh-context challenge (an `auditor`, not a new agent) → your verdict READY / CONCERNS / BLOCKED — always yours; proposer and challenger never decide. It runs BEFORE plan approval, never mid-execution; `CONCERNS` never blocks. An exact existing pattern with a local change and trivial rollback does not need it.

### Analytical parallelism (the lever — mechanical, not optional)

Emit **ALL `Agent` calls in a SINGLE turn** — Claude serializes by default. **Independent** sub-tasks (no shared state or output dependency) go in the same turn; serialize only on a real dependency. Scope first; synthesis is **never** delegated — read the N `done -> file` reports together and cross-check.

### Nested dispatch unavailable

Without nested dispatch (Codex, `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`), run `scout` before `architect`.

### When delegation is genuinely impossible

Rare, and it leaves a trace: the operator forbade subagents or `Agent` is unavailable. Do the work and **say why in your reply**; the `publisher` will require `bun run check` green in pre-flight, since no review exists. An undeclared inline change is a deviation.

### Where the depth lives (read it when the moment asks)

Open when the moment asks: **`.claude/agents/orchestrator.md`** (decomposing, frugal delegation, anti-broken-telephone, per-agent output files, continuous execution and caps, closing the cycle, second opinion, reclaiming a worktree) · **`.claude/skills/resolve-ticket/SKILL.md`** (a ticket: the pipeline) · **`.claude/skills/solution-design/SKILL.md`** (an architectural signal: the design pass).
<!-- /navori:managed id="orquestacion" -->
