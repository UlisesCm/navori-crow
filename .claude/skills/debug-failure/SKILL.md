---
name: debug-failure
description: Use when a command fails or the runtime misbehaves and you don't have a root cause yet. Before touching code, see the error unfiltered, reproduce it, and find the ROOT CAUSE with file:line — one fix at a time, and re-validate the hypothesis if it doesn't clear the symptom. Your stack's error patterns go in the user-section.
metadata:
  type: behavior
  # 850 y no el default de 200 (spec 0026 T14, R30): este asset fusiona tres
  # fuentes —las dos skills retiradas de diagnóstico que precedieron a esta
  # (600 y 1000 palabras respectivamente) y la `systematic-debug` personal—
  # en un solo ciclo de seis pasos, así que hereda el presupuesto combinado
  # de las dos primeras, ajustado a la baja porque el ciclo único elimina la
  # duplicación de "reproducir" y "root cause" que las dos skills retiradas
  # explicaban por separado.
  maxWords: 850
---

<!-- navori:managed id="debug-failure-base" hash="74e93458" version="0.10.0" source="@navori/core" fmkeys="name,description,metadata" -->
# Debug failure — the one cycle

A failure is not a mandate to change code. This skill forces diagnosis before any fix, and forces a hypothesis re-check when the fix doesn't clear the symptom.

The trigger is **"I don't know why it failed yet"**, not the size of the output. Measured across 57 audited sessions and 281 failed commands, the median failure is **7 lines long** — a three-line failure you can't explain earns the same protocol as a long one.

## The cycle (in order)

1. **See the error unfiltered.** The exit code is not evidence. Check the command you just ran: `2>/dev/null` **discards** the error stream, `| tail -5` may have cut the line that matters, and a wrapper can swallow a child's stderr. **Re-run it unfiltered before diagnosing.** Diagnosing from a truncated stream is how a fix gets aimed at the wrong error.
2. **Reproduce it.** No fix without a repro you can run again in this turn — "it probably is X" without a rerun is not a diagnosis. If it only reproduces in prod/staging and not locally, that itself is a fact about the cause (env var, cache, data, a different backend).
3. **Find the ROOT cause, `file:line`.** Separate error from chatter first (progress lines, warnings and logs with no stack are not the failure). Classify the type — types/compiler, lint, build, runtime, or blocked by a hook/permission rule (read the reason, never work around the guard) — each has a distinct cause shape. One root error usually cascades into the rest (a missing import breaks everything downstream): find that one, not each symptom. **When the failure crosses components** (request → service → data layer → response → render), instrument each border with what enters and what leaves, and compare stage to stage to see where the shape changes or data goes missing — that border is where the root cause lives.
4. **Apply a single fix** against the root cause found in step 3, then re-run and re-classify. Don't fire several fixes at once against the symptoms, and don't bundle an unrelated "improvement" into the same change.
5. **If the fix doesn't clear the symptom on the first post-fix repro, stop patching and re-validate the hypothesis** — don't escalate with a second patch on top of the first. Re-read the original symptom (literally, not from memory), state the diff you applied in one sentence ("changed X in file:line from Y to Z because W"), and check whether W logically implies the symptom should be gone. If it should and isn't, the model of the flow is incomplete — there's a step you're not seeing (caching, a different runtime side, a middleware, stale state). Pick ONE new hypothesis before touching code again.
6. **After two failed attempts on the same bug, stop and escalate — the channel depends on where you're running:**
   - **Inside a subagent** (no `AskUserQuestion`): report `BLOCKED` in your handoff file, with the original symptom, each hypothesis tried, its applied fix and its repro result, and the hypothesis you'd try next with the evidence behind it. The caller decides, you don't invent a fourth patch.
   - **In the main agent**: ask the user directly with the same four items — symptom, tried hypotheses + results, next hypothesis + evidence — and a concrete question ("do you know more context that supports or refutes this?").

Once step 4's repro is clean, apply `verify-before-done` before declaring the fix complete — this skill validates the SYMPTOM is gone, `verify-before-done` validates the rest of the gate still is.

## Rules

- **No fix without a root cause.** `file:line` plus why it fails, not "it probably is X".
- **One fix at a time.** Never mix a real fix with a "preventive" change — it hides which one worked and blocks a clean bisect.
- **Don't fix symptoms** that disappear on their own once the root is fixed.
- **Warning ≠ error** — a warning doesn't block; don't spend the turn on it unless asked.
- **Don't add logs/try-catch/fallbacks to "cover"** instead of understanding — that hides the bug, it doesn't fix it.
- **"It's flaky" needs evidence** of real flakiness, not a shrug after one failed rerun.

## Red flags (stop)

- About to make a second change on the same line without having re-run the repro.
- About to write "now it should work" without fresh evidence from this turn.
- Reverting and re-applying variations of the same change.
- The diff accumulates more than 3 attempts on the same file for the same symptom.
<!-- /navori:managed id="debug-failure-base" -->

## Your stack's error patterns

<!-- user: document here the recurring errors of YOUR toolchain and their fix, for instant triage. Suggestions:
     - Specific noise filters (build/runner lines that are NOT errors).
     - Typical errors with their cause + fix (e.g. codegen not run, server/client boundary, import path/alias, missing env).
     - Regeneration/validation commands (codegen, migrations) that resolve entire categories of errors.
     - Known race conditions or caches specific to this repo (CDN, redis, browser SW, build cache).
-->
