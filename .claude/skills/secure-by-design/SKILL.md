---
name: secure-by-design
description: Use when a change is security-sensitive.
metadata:
  type: behavior
  maxWords: 600
  maxWordsComposed: 650
---

<!-- navori:managed id="secure-by-design-base" hash="5c3cf2db" version="0.10.0" source="@navori/core" fmkeys="name,description,metadata" -->
# Secure by design

This is a thin router, not a second security checklist. It composes with
`security-invariants` (business rules), `review-diff` (diff review), and
`verify-before-done` (fresh evidence); none of their gates are replaced.

## Trigger

Use only when the task changes authentication, authorization, a trust boundary,
sensitive data, web/API input, secrets, cryptography, uploads, an external
integration, or a dependency. For ordinary code, do not load this skill.

## Route

1. State the asset, actor, boundary, and unwanted outcome in 1–3 lines.
2. Load `security-invariants`; enumerate every mutating entry point when a
   guard or policy changes. Its server-side rules remain authoritative.
3. Select only applicable controls from the versioned reference record:
   OWASP ASVS 5.0.0, NIST SSDF 1.1, and SLSA. Link the selected control ids and
   explain the local implementation; never copy their checklists into a task.
4. Add an executable test or other reproducible evidence for each selected
   mitigation. Inputs and authorization need negative cases, not only happy
   paths.
5. Send the finished diff through `review-diff` and `verify-before-done`.

## Minimum handoff

```
Security scope: <asset / boundary / actor>
Threat: <unwanted outcome>
Controls: <versioned references and ids>
Evidence: <test or command and result>
Residual risk: <accepted risk or none>
```

## Guardrails

- Do not install a vendor skill, plugin, hook, or dependency from this router.
  Adoption follows the reversible pilot record in `docs/references/skills-security-quality.md`.
- Do not treat a static scan as authorization evidence; business invariants and
  tests remain required.
- Keep threat modeling proportional: one boundary and its concrete abuse cases,
  not a generic taxonomy dump.
<!-- /navori:managed id="secure-by-design-base" -->
