# Historia de sesiones

<!--
Entradas más recientes arriba. Formato sugerido (no obligatorio):

## YYYY-MM-DD HH:MM — <agente> — <resumen breve>
- Cambios: <archivos / áreas tocadas>
- Quality gate: ✅ (quality gate sin configurar — corre 'navori configure quality-gate') verde | ❌ <razón>
- Notas: <decisiones no obvias, blockers, deuda>
- Commit / PR: <hash / URL>
-->

## 2026-09-24 11:10 — orchestrator — F1: lote B2 (store SQLite)
- Cambios: `packages/core/src/config.ts`, `bus.ts` y `store/` (`db.ts` con WAL y permisos 0700/0600 incluidos `-wal`/`-shm`; `migrations.ts` con `PRAGMA user_version` transaccional y esquema v1; `store.ts` con `ingestBatch`, `upsertAgentMeta`, `sweepIdle`, `hasEvent`, `stats` y lecturas para la API). Cubre R1–R4, R13, R15–R19, R22.
- Quality gate: ✅ `bun run check` verde (64 pass / 0 fail), Pass 2 del reviewer.
- Notas: el store confía en `parentAgentId` tal como llega; la resolución por `call_id` (design, paso 5 de `ingestBatch`) queda para B4 y hay que reconciliarla ahí. `upsertAgentMeta` recibe `engine` aparte de `AgentMetaPatch`. Las lecturas de R25–R27 se prueban en B5. Deuda menor: `// Covers: R4` mal etiquetado en el test de `hasEvent`, JSDoc desactualizado en `IngestBatchDeps.now`, y `mkdirSync` recursivo no asegura directorios intermedios si `CROW_HOME` se anida más de un nivel nuevo.
- Commit / PR: feat/f1-b2-store

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
