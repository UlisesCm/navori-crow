---
name: dominio
description: Use when you discover — or need — a durable fact that spans multiple repos of a workspace (data model, business rule, migration, cross-service contract, shared gotcha). The Dominio is the workspace's canonical knowledge base; read it before assuming a model, and promote such facts into it instead of only saving to session memory.
metadata:
  type: reference
---

<!-- navori:managed id="dominio" hash="a2c1ab5c" version="0.10.0" source="@navori/core" fmkeys="name,description,metadata" -->
# dominio — the workspace knowledge base

Canonical, cross-repo facts for a workspace live as markdown under
`~/.navori/workspaces/<name>/dominio/`: one file per entry (`<id>.md`) plus a
derived index (`DOMINIO.md`) that is injected at session start. This is where a
fact like *"`coach`/`coachee` no longer exist — it's `user-profile.kind`"* lives
once for every repo, so it isn't relearned wrong in each one.

## Read first

The Dominio index is injected at the top of each session for repos that belong to
a workspace. **Before assuming a data model, business rule or cross-service
contract, check it.** Open the full entry (`navori dominio show <id>`, or read
`workspace://<name>/dominio/<id>.md`) when you need the detail behind an index
line.

## When to promote a fact (all THREE must hold)

1. **Durable** — it won't change next sprint; a structural fact, not a transient state.
2. **Transversal** — it applies to **≥2 repos** of the workspace. Test: *"would an agent in ANOTHER repo get this wrong without it?"*
3. **Canonical** — it's a fact/rule, not a task, a log, or an opinion.

If it passes, write it to the Dominio (below). If not, it belongs elsewhere.

### Do NOT put in the Dominio

Ticket status / progress / TODOs → `progress/`. Session scratch → engram.
Single-repo detail → that repo's `CLAUDE.md`. Personal preferences → engram.
Volatile values (versions, counts). **Secrets — never.**

## How to write an entry

Create `~/.navori/workspaces/<name>/dominio/<slug>.md` (`<slug>` is a stable
kebab-case id = the filename). Keep it to **one fact, short**:

```markdown
---
id: user-profile-model
title: Modelo user-profile
type: migration          # architecture | business-rule | migration | gotcha | glossary
applies-to: [nexus, webapp, dashboard, mobile]   # repos, or "all"
status: canonical        # canonical | deprecated | superseded
supersedes: []           # ids this entry replaces
updated: 2026-07-30
updated_by: <you>
---

<the fact>. **Por qué:** <reason>. **Cómo aplica:** <what to do differently>.
```

Then run `navori dominio reindex` to refresh the index.

## Curate — update, don't pile up

- **Update > duplicate.** Search existing entries first (`navori dominio list`);
  edit the matching one and bump `updated`, don't add a second.
- **Retire, don't delete.** When a fact is replaced, set the old entry
  `status: superseded` and point the new one's `supersedes:` at it — the history
  keeps an agent from rediscovering the old model.
- **`navori dominio doctor`** validates coherence (all warnings). Reindex after
  any change.
<!-- /navori:managed id="dominio" -->
