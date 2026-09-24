# Historia de sesiones

<!--
Entradas más recientes arriba. Formato sugerido (no obligatorio):

## YYYY-MM-DD HH:MM — <agente> — <resumen breve>
- Cambios: <archivos / áreas tocadas>
- Quality gate: ✅ (quality gate sin configurar — corre 'navori configure quality-gate') verde | ❌ <razón>
- Notas: <decisiones no obvias, blockers, deuda>
- Commit / PR: <hash / URL>
-->

## 2026-09-24 16:20 — orchestrator — F1: spec SDD y lote B1 (core puro)
- Cambios: spec `specs/f1-mvp-pasivo/` (requirements R1–R33, design con challenge del auditor, tasks en lotes B1–B8). B1 en `packages/core`: contrato de adaptador de F1, tipos REST y subpath `@crow/core/types`, narrowing, ULID monotónico, `weightedTokens` portado literal de navori-harness (`21f6c054`), tabla de precios de Claude con fuente oficial fechada, `projectKey` que nunca lanza. Workspaces incluye `packages/adapters/*`.
- Quality gate: ✅ `bun run check` verde (36 pass / 0 fail), Pass 2 del reviewer.
- Notas: decisiones del usuario: proyecto fijo por sesión (R15), dedupe por identidad de contenido (R16), precios de páginas oficiales. Los modelos de OpenAI/Codex quedan sin precio porque sus páginas devuelven 403; el costo de Codex sale vacío hasta que haya valores verificables. `CrowConfig` vive en `adapter.ts` y B2 debe importarlo.
- Commit / PR: feat/f1-b1-core-puro

## 2026-09-23 23:50 — orchestrator — F0 Bootstrap del monorepo
- Cambios: monorepo Bun workspaces (`packages/core`, `apps/server`, `apps/web`), TS strict, oxlint/oxfmt, CI en GitHub Actions, tipos `CrowEvent` y `projectKey()` con tests, `Bun.serve` en loopback con `/healthz` y estáticos (guard `isInside`), hello en Svelte 5 + Vite. Quality gate configurado en `navori.config.json` (`fast`: lint + typecheck, `full`: `bun run check`).
- Quality gate: ✅ `bun run check` verde (10 pass / 0 fail), Pass 2 del reviewer.
- Notas: deuda menor sin bloquear: la caché de `projectKey` usa el `cwd` crudo en vez de `realpath`.
- Commit / PR: feat/f0-bootstrap
