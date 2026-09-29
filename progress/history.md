# Historia de sesiones

<!--
Entradas más recientes arriba. Formato sugerido (no obligatorio):

## YYYY-MM-DD HH:MM — <agente> — <resumen breve>
- Cambios: <archivos / áreas tocadas>
- Quality gate: ✅ (quality gate sin configurar — corre 'navori configure quality-gate') verde | ❌ <razón>
- Notas: <decisiones no obvias, blockers, deuda>
- Commit / PR: <hash / URL>
-->

## 2026-09-29 15:10 — orchestrator — F1: lote B7.T2 (fixtures reales de Codex y contrato)
- Cambios: anonimizador `--engine codex` (`scripts/anonymize/codex.ts`, con `forked_from_id` correlacionado como id de hilo) y buscador `scripts/find-codex-fixtures.ts`. Fixtures reales anonimizados `fixtures/codex/0.145.0/` (dos principales, fork fresco y fork con acumulado arrastrado), `0.155.1/` (principal, fork con historia copiada y guardian) y `0.146.0-alpha.3.1/`. `codex/contract.test.ts` con snapshots, casos (a)–(d) de `codex/usage.test.ts` sobre los forks reales, y `store.test.ts`/`pricing.test.ts` con el total de la sesión sin el acumulado arrastrado. En `map-line.ts`: el salto por `subagent_history_start_ordinal` aplica solo si el archivo trae historia copiada (segundo `session_meta`); el guardian toma su padre de `payload.parent_thread_id`; `reasoning`, `agent_message` y `tool_search_*` pasan a conocidos sin evento. `design.md` corregido con la evidencia de los fixtures; `tasks.md` marca B7.T2 y agrega B7.T3. Cubre R14, R4, R20 y R21.
- Quality gate: ✅ `bun run check` verde (214 pass / 1 todo / 0 fail), Pass 2 del reviewer; receipt `f1-b7t2-contract` firmado.
- Notas: los forks sin historia copiada (id19, id32 y el guardian id70) traen start ordinal y sus `token_count` quedan por debajo, así que la regla anterior descartaba todo su usage; el diseño decía que los forks de 0.145.0 no tenían start ordinal. El acumulado arrastrado del fixture es exactamente 2,218,759, como en el diseño. Codex real no emite `user_message`: los prompts llegan como `response_item` `message` con role user, y hoy el adaptador genera 0 prompts de Codex (B7.T3, con el todo que queda). Los modelos de Codex no tienen precio, así que `costUsd` es 0.
- Commit / PR: feat/f1-b7t2-fixture-codex

## 2026-09-24 16:45 — orchestrator — F1: lote B7.T1 (adaptador Codex)
- Cambios: paquete nuevo `packages/adapters/codex` (`@crow/adapter-codex`: `adapter.ts`, `map-line.ts`, `index.ts`) según § Mapeo Codex: estado por archivo, línea base de tokens (el primer `token_count` cuenta `last_token_usage`, delta 0 sin evento, retroceso con `usage-anomaly`), historia heredada saltada por `subagent_history_start_ordinal`, `semanticKey` y raíz desde `CODEX_HOME`. Los hilos toman `parentAgentId` de `thread_spawn.parent_thread_id` cuando no es la sesión raíz y `depth` de `thread_spawn.depth`. `tasks.md` marca B7.T1. Cubre R14 y R16.
- Quality gate: ✅ `bun run check` verde (152 pass / 0 fail), Pass 2 del reviewer.
- Notas: la primera revisión rechazó aplanar todos los hilos a `depth = 1` sin padre: según la evidencia del diseño, un tercio de los subagentes cuelga de otro hilo. Codex nunca pone `usageKey` ni `spawnCallId`, así que no entra al conteo por máximo de Claude ni a la resolución de padre por `call_id`; el store enlaza por `parentAgentId` directo aunque el archivo del hijo llegue antes. Tests sintéticos: los fixtures reales son B7.T2, que además debe fijar la ruta exacta de `parent_thread_id` y `depth` (`FIXME(B7.T2)` en `map-line.ts`).
- Commit / PR: feat/f1-b7-adapter-codex

## 2026-09-24 16:41 — orchestrator — F1: lote B5.T1 (arranque del servidor y guard)
- Cambios: `apps/server/src/adapters.ts` (`ENGINE_ADAPTERS` con Claude), `app.ts` (`startApp` en el orden del diseño: DB y migración, semilla del ULID y `sweepIdle`, `Bun.serve` en loopback, tailer y sweeper; `stop()` apaga sweeper, tailer, servidor y DB en ese orden), `guard.ts` (Host y Origin según D14), `server.ts` (`isApiPath` como único predicado para el guard; `/healthz` y estáticos fuera), `index.ts` con `loadConfig`, y modo dev (Vite en 5173 con `strictPort`, `CROW_ALLOWED_ORIGINS`). En core, `TailerScheduler.stop()` pasa a async y espera el paso en curso sin relanzar su error. `tasks.md` marca B1.T1–B4.T2, que ya estaban mergeados, y B5.T1. Cubre R2 y R28.
- Quality gate: ✅ `bun run check` verde (155 pass / 0 fail), Pass 2 del reviewer.
- Notas: la primera revisión pidió un test que probara que `stop()` espera el paso en curso; al escribirlo apareció que un paso fallido hacía fallar `stop()`, y se corrigió. El error del paso sigue llegando a quien lo esperaba. Bun normaliza `//api/x` a `/api/x` antes de `fetch` (lo prueba un test contra el servidor real); `/API/x` cae a estáticos y da 404. Notas informativas del reviewer: los tests nuevos del scheduler llevan `// Covers: R6`, que no es el requisito que prueban, y el poll periódico sigue llamando `runPendingSteps()` sin esperar la promesa (previo a este lote).
- Commit / PR: feat/f1-b5-server

## 2026-09-24 15:55 — orchestrator — F1: lote B4.T3 (fixture real de Claude y regla de usage)
- Cambios: anonimizador `scripts/anonymize-fixture.ts` (workspace `scripts`), fixture real anonimizado `fixtures/claude/cc-2.1.281/` (sesión principal y 5 subagentes async), `fixtures/hygiene.test.ts` (sin PII y contrato estructural), `claude/contract.test.ts` con oráculo propio y snapshot. `map-line.ts` mapea el fin de subagente async de 2.1.281 (`attachment` `queued_command` con `commandMode: "task-notification"`) sin romper la forma anterior. Regla D7/R13 nueva: por `(agente, message.id)` el usage contado es el máximo por componente, una línea mayor suma solo el delta y `usage-anomaly` queda para cuando un componente decrece; migración v2 aditiva del store (`u_*` en `dedupe`). Cubre R11–R13.
- Quality gate: ✅ `bun run check` verde (134 pass / 0 fail), Pass 2 del reviewer.
- Notas: el fixture se nombra por la versión real (`cc-2.1.281`, no `cc-2.1.267`). Claude Code reemite el mismo `message.id` durante el streaming con `output_tokens` creciente; "primero gana" contaba 30,170 de 38,161 tokens de salida (−21%) y el adaptador descartaba 20 de las 22 continuaciones por ser solo `tool_use`. El anonimizador ahora anonimiza también claves de objeto (preguntas de AskUserQuestion, ids de modelo). El reviewer dejó dos notas informativas: la allowlist de claves del anonimizador no está acotada por ruta, y el crecimiento de usage por `message.id` solo lo prueba el fixture real, sin test sintético.
- Commit / PR: feat/f1-b4t3-fixture-claude

## 2026-09-24 13:30 — orchestrator — F1: lote B4.T1+T2 (adaptador Claude)
- Cambios: paquete nuevo `packages/adapters/claude` (`@crow/adapter-claude`: `adapter.ts`, `map-line.ts`, `sidecar.ts`) según § Mapeo Claude; fixture `fixtures/claude/navori-audit/` copiado literal de navori-harness; `store.ts` resuelve `parentAgentId` por `call_id` para `depth > 1` en ambos órdenes de procesamiento (cierra lo que B2 difirió). Cubre R11–R13, R15, R16.
- Quality gate: ✅ `bun run check` verde (108 pass / 0 fail), Pass 2 del reviewer.
- Notas: el implementer asumió `toolUseResult.toolUseId` y campos estructurados en la task-notification; contra transcripts reales no existen: el call id sale de `tool_result.tool_use_id` y la notificación es un string con tags `<tool-use-id>`/`<status>`. Corregido antes de revisar. B4.T3 (anonimizador y fixture real `cc-2.1.267`) queda pendiente: el modo auto bloquea derivar un fixture de `~/.claude` desde el agente; el script se escribe aquí y el usuario lo corre sobre la sesión que elija. El reviewer dejó una nota informativa: `toolResultBlocks[0]` asume un solo `tool_result` por línea de fin de agente (0 casos en contra en 1,258 líneas reales).
- Commit / PR: feat/f1-b4-adapter-claude

## 2026-09-24 12:40 — orchestrator — F1: lote B3 (tailer genérico)
- Cambios: `packages/core/src/tailer/` (`line-reader.ts` por bytes con tope de 1,000 líneas u 8 MiB por paso; `ingest.ts` con inode, offset, truncado y `ingest.error`; `tailer.ts` con discovery, backfill por ventana y por sesión, poll, `fs.watch` como pista, rescan y `Scheduler`/`TailerScheduler` con prioridad de archivos calientes, re-encolado de archivos sucios e intervalos inyectables). Adaptador de prueba en `tailer/testing/`. Cubre R5–R10, R16, R22.
- Quality gate: ✅ `bun run check` verde (101 pass / 0 fail) en macOS y `bun test` verde en Linux (docker `oven/bun:1.4.2`), Pass 2 del reviewer.
- Notas: la primera revisión pidió cambios (faltaban el scheduler y el tope de 8 MiB por paso). B5 solo arma `TailerScheduler` con los intervalos de `CrowConfig`; `stop()` no espera el paso en curso, a considerar en el apagado de B5. Los casos (e)/(f) de identidad comparten un test genérico; B4/B7 deben agregar los suyos con fixtures reales.
- Commit / PR: feat/f1-b3-tailer

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
