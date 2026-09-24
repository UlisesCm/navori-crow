---
name: quality-attributes
description: Use when a task carries a non-functional requirement or architecture signal.
metadata:
  type: behavior
  maxWords: 450
  maxWordsComposed: 500
---

<!-- navori:managed id="quality-attributes" hash="7ce878c3" version="0.10.0" source="@navori/core" fmkeys="name,description,metadata" -->
# Quality attributes

Use only when `solution-design` identifies architecture or a non-functional
requirement. This complements design; it does not create a dispatcher, replace
tests, or override `review-diff` and `verify-before-done`.

## Matrix

Select only relevant attributes (for example performance, reliability,
security, maintainability, accessibility, or compatibility) and write:

| Attribute | Measurable criterion | Evidence source | Test | Owner |
|---|---|---|---|---|
| <selected attribute> | <threshold or observable outcome> | <command/metric> | <named test> | <role> |

Use ISO/IEC 25010:2023 only as a reference model. Do not reproduce its text,
tables, or proprietary checklist; use project-specific criteria in your own
words. Put the matrix in the solution or spec artifact so it is reviewed with
the design.

## Rules

- Every selected row has a measurable criterion and an evidence source.
- A test belongs to the row when executable validation is feasible; otherwise
  state why and name the review evidence.
- Keep the matrix to the decision's active risks. Do not invent quality goals
  for a local, reversible change.
- Security rows route through `secure-by-design` and `security-invariants`.
<!-- /navori:managed id="quality-attributes" -->
