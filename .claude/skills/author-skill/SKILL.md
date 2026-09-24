---
name: author-skill
description: Use when creating or revising a skill (SKILL.md) — a project-local skill, a user-section, or a navori asset. Decides where the knowledge lives and writes portable frontmatter that Claude Code, Codex, and DeepSeek all parse, with facts checked against official docs. Not for agents (subagent definitions).
metadata:
  type: reference
---

<!-- navori:managed id="author-skill" hash="ea564e60" version="0.10.0" source="@navori/core" fmkeys="name,description,metadata" -->
# Authoring a skill

A skill loads by its `description` and costs tokens on every activation, so it carries only what the model can't know: this repo's rules, version traps, failure modes, exact commands.

## 1. Pick the cheapest home

First fit wins (`docs/EXTENDING.md`):

1. A repo rule on a topic a skill already covers → that skill's user-section.
2. Knowledge no installed skill covers → a local skill at `.claude/skills/<id>/SKILL.md`, listed in `project.localSkills`. That path is Claude Code's; Codex and DeepSeek read their own skill directories.
3. Stack knowledge reusable across repos → a local preset.
4. A tool or MCP wrapper → a navori plugin. Only universal rules reach core.

## 2. Frontmatter — portable across engines

```yaml
---
name: my-skill            # kebab-case, ≤64 chars, same as its directory
description: Use when <concrete triggers>. <What it does>. Not for <nearest neighbor>.
metadata:
  type: reference         # behavior ≤200 words · reference ≤500 · tool ≤300
---
```

- navori emits only `name`, `description`, `metadata`; host-specific keys don't travel.
- The description carries every "when to use"; the body loads only after it matches. Lead with the main trigger, stay under 500 characters (DeepSeek truncates there), third person.
- Over the cap on purpose → `metadata.maxWords` with the reason in a comment.

## 3. Body

- **No "When to use" section** — it's already in the description.
- **Facts from official docs, never memory or a third-party suggestion.** Version-bound facts name the version and tell the reader to check `package.json` first.
- One term per concept; a default with an escape hatch, not a menu.
- Give the reason instead of capitals: "never X" needs its why.
- Exact commands for fragile steps, heuristics for open ones.
- A dependency that may be missing declares its fallback; skipping silently is a bug.
- Local skills only: detail beyond the cap goes to `references/` (one level deep), deterministic steps to scripts beside it that run instead of being read.
- End with a copyable checklist and the loop: "If any item fails, fix it and re-run the whole list."
- Bundled assets end with navori's user-section sentinel and a `user:` template comment; `{{…}}` placeholders resolve only in bundled assets.

## 4. Evaluate

- **Trigger:** three prompts that should load it and one that shouldn't (a neighbor's job); adjust the description until all four behave.
- **Behavior:** run one real task with and without the skill. Cut what the model ignored; add what it got wrong.

## Before declaring done

Copy and check off:

- [ ] Home chosen by the ladder above.
- [ ] `name` matches the directory; description has triggers, a "Not for", and fits 500 characters.
- [ ] Body within its type's cap; no restated general knowledge.
- [ ] Every version-bound fact traced to an official source.
- [ ] Trigger and behavior checks pass; `navori doctor` shows no missing, triggerless, or flat local skill.

If any item fails, fix it and re-run the whole list.
<!-- /navori:managed id="author-skill" -->

## This repo's skills (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - Where this repo's local skills live and who reviews them.
     - Neighboring skills that are easy to confuse, and how to tell them apart.
-->
