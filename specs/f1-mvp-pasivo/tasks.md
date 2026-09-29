# F1 MVP pasivo — Tasks

Cada lote es un PR a `main` con `bun run check` en verde. Cada test lleva `// Covers: R<n>`. El detalle de cada componente vive en `design.md` (secciones Components, Decisions, Contracts y Testing strategy); aquí solo se fija el alcance y la evidencia esperada.

## B1 · core: contrato y utilidades puras (sin dependencias)

- [x] **B1.T1** (R15, R20) — Extensiones aditivas de `CrowEvent`, contrato de adaptador de F1 (`packages/core/src/adapter.ts`, con `semanticKey` y `warnings`), tipos REST en `api-types.ts`, subpath de exportación `@crow/core/types` y utilidades de narrowing en `narrow.ts`, según `design.md` § Contracts. Además, agregar `"packages/adapters/*"` a `workspaces`. · test: `packages/core/src/narrow.test.ts` — el narrowing rechaza formas inválidas sin usar `any`.
- [x] **B1.T2** (R20, R21) — `ulid.ts` (ULID monotónico, semilla = el mayor entre `max(id)` y el reloj, `ulidTime`) según D9; `weighted-tokens.ts`, portado literal desde navori-harness `packages/cli/src/lib/audit/report.ts` `weightedTokens` después de verificar que no cambió frente a `21f6c054`, con cabecera de procedencia; `pricing.ts` con valores tomados de las páginas oficiales de precios, fechados, match exacto tras normalizar y caché de 1 h separada (D12). · tests: `ulid.test.ts` (monotonía y semilla con reloj atrás), `weighted-tokens.test.ts` (los 6 casos portados) y `pricing.test.ts` (caché de 1 h, sin substring y modelo desconocido sin `costUsd`), todos con `// Covers: R20` o `R21` según corresponda.
- [x] **B1.T3** (R15) — `projectKey` nunca lanza, incluso con un `cwd` borrado o sin git (D11). · test: `project-key.test.ts`, con casos agregados para el `cwd` inexistente y para un subdirectorio de un repo borrado.

## B2 · core: store SQLite (depende de B1)

- [x] **B2.T1** (R1, R2, R3) — `config.ts` (`CROW_HOME`, ventanas), `store/db.ts` (WAL; permisos 0700 en el directorio y 0600 en la DB, `-wal` y `-shm`) y `store/migrations.ts` (`PRAGMA user_version` en transacción; rechaza una versión futura; esquema v1 de `design.md` § Esquema v1, con `dedupe.fp` e `ingest_stats`). · tests: `migrations.test.ts` y `db.test.ts`.
- [x] **B2.T2** (R4, R13, R15, R16, R17, R19, R22) — `ingestBatch`: identidad de contenido y clave semántica (D7), `usageKey` con la guarda `usage-anomaly`, totales incrementales de sesión, agente y día en la misma transacción, proyecto pegajoso (D8), estado `live`/`ended` (D10) y offsets; `bus.ts`, que publica después del commit. · tests: `store.test.ts` (totales, rollback, usage discrepante, sesión pegajosa), `status.test.ts` (R17, R19) y `bus.test.ts`.
- [x] **B2.T3** (R18) — `sweepIdle` con reloj inyectado, `upsertAgentMeta`, `hasEvent`, `stats` y las lecturas que consume la API. · test: `status.test.ts` para la transición a `idle`.

## B3 · core: tailer genérico (depende de B2)

- [x] **B3.T1** (R6, R7, R8, R10, R16) — `line-reader.ts` por bytes (la línea parcial queda sin consumir), procesamiento por archivo con inode y offset, e `ingest.ts` (`ingest.error` con `path`, `offset` y `line`; contador `errors:<reason>`). · tests: `line-reader.test.ts` (incluye UTF-8 cortado y una línea mayor que el chunk), `ingest.test.ts` e `identity.test.ts` casos (a)–(g), con un adaptador de prueba.
- [x] **B3.T2** (R5, R9) — Discovery, backfill por ventana y por sesión (D6), watcher `fs.watch` como pista, poll de archivos calientes y rescan (D4), scheduler y sidecars. · tests: `watch.test.ts` (guardado por el probe), `poll.test.ts` y `backfill.test.ts`.

## B4 · adaptador Claude (depende de B3)

- [x] **B4.T1** (R11, R13, R15, R16) — `@crow/adapter-claude`: mapeo del transcript principal según `design.md` § Mapeo Claude, `semanticKey` y paridad con el fixture de navori copiado en `fixtures/claude/navori-audit/`. · test: `navori-parity.test.ts`, con los totales exactos de `design.md` § Testing strategy.
- [x] **B4.T2** (R12) — Subagentes: `subagents/agent-*.jsonl` más el sidecar `.meta.json` (incluido el sidecar tardío), `agent.start`/`agent.stop` y árbol con `depth = 2`. · test: `claude/subagents.test.ts`.
- [x] **B4.T3** (R11, R12) — `scripts/anonymize-fixture.ts` (allowlist de claves estructurales, `cwd` reescritos y usage intacto), fixture real `fixtures/claude/cc-2.1.281/` y snapshot de contrato. · tests: `claude/contract.test.ts` y `fixtures/hygiene.test.ts`.

## B5 · servidor: API y tiempo real (depende de B4)

- [x] **B5.T1** (R2, R28) — `apps/server/src/adapters.ts` (registro con Claude), `app.ts` (no escucha si la migración falla), `guard.ts` para Host y Origin, y modo dev (Vite en 5173 con `strictPort` y `CROW_ALLOWED_ORIGINS`) según D14. · test: `guard.test.ts` más integración.
- [x] **B5.T2** (R22, R23, R24, R25, R26, R27) — REST (`/api/projects`, `/api/sessions`, `/api/sessions/:id`, `/api/sessions/:id/events`, `/api/events`, `/api/stats`, y 409 `unknown-cursor`) y `sse.ts` (validación de cursor con `reset`, subscribe-buffer-replay-flush, heartbeat de 15 s, `server.timeout(req, 0)`) según D13. · tests: `api.test.ts`, `sse.test.ts` y `sse-replay.test.ts` casos (a)–(f).
- [x] **B5.T3** (R6, R16, R29) — e2e de latencia (el máximo de 5 appends es < 2000 ms), reinicio sin duplicados e hidratación de una sesión previa. · tests: `e2e/latency.test.ts`, `e2e/restart.test.ts` y `e2e/hydrate.test.ts`.

## B6 · UI (depende de B5)

- [ ] **B6.T1** (R30, R33) — Router por hash, `api.ts`, `stream.ts` (un solo `EventSource` y manejo de `reset`), reducers puros envueltos en runes (D16) y home con tarjetas por proyecto. · tests: `reduce/projects.test.ts` y `reduce/cursor.test.ts`.
- [ ] **B6.T2** (R31, R32) — Split de 2 a 4 proyectos y detalle de sesión (timeline filtrable, árbol de agentes y panel de costo; 500 eventos con opción de ver anteriores). · tests: `reduce/feed.test.ts` y `reduce/session.test.ts`.

## B7 · adaptador Codex (depende de B3; puede ir en paralelo a B4–B6, no toca `apps/server`)

- [x] **B7.T1** (R14, R16) — `@crow/adapter-codex`: estado por archivo, línea base de tokens (el primer `token_count` cuenta `last_token_usage`; un retroceso produce `usage-anomaly`), historia heredada que se salta con `subagent_history_start_ordinal`, hilos como agentes de la sesión raíz, `semanticKey` y raíz desde `CODEX_HOME`, según `design.md` § Mapeo Codex. · test: `codex/usage.test.ts` casos (a)–(d).
- [x] **B7.T2** (R14, R4, R20, R21) — Fixtures anonimizados `fixtures/codex/0.145.0/` (forks fresco y arrastrado) y `fixtures/codex/0.155.1/`, snapshots de contrato sobre el pipeline de B3, y `costUsd` y `weightedTokens` de la sesión que excluyen el acumulado arrastrado. · tests: `codex/contract.test.ts` y `codex/usage.test.ts`. `codex/contract.test.ts` también debe fijar la ruta JSON exacta de `parent_thread_id` y `depth` dentro de `session_meta.payload.source.subagent.thread_spawn` y revisar si los `guardian` también cargan un id de padre (123 hilos reportan padre contra 111 `thread_spawn`). Resuelto: la ruta quedó fijada en `codex/contract.test.ts` y el `guardian` lo trae en `payload.parent_thread_id`, que el adaptador ahora lee como respaldo.
- [x] **B7.T3** (R14, R16) — Prompts de Codex. Las capturas reales `fixtures/codex/0.146.0-alpha.3.1/` y `fixtures/codex/0.155.1/` no contienen ninguna línea `event_msg.user_message`: los prompts llegan como `response_item.message` con `role=user` y como `event_msg.item_completed` con `item.type = "UserMessage"`, y el adaptador hoy no emite ningún `prompt`. Mapear una de ellas (o ambas sin duplicar) a `prompt`, revisar la `semanticKey` y el dedupe de D7 y la lógica de `recentPrompts`, y volver a decidir el par real de `user_message` reemitido de `identity.test.ts` (e) con estas capturas. Nota: los modelos de Codex (`gpt-5.6-*`, `gpt-6-astra`, `codex-auto-review`) no tienen precio en `MODEL_PRICES`, así que su `costUsd` es 0. · tests: `codex/contract.test.ts` (el `test.todo` de `user_message` reemitido) y `identity.test.ts`.

## B8 · servidor: registro de Codex y e2e multi-motor (depende de B5 y B7)

- [x] **B8.T1** (R14, R15, R29) — Agregar Codex a `ENGINE_ADAPTERS` en `apps/server/src/adapters.ts`, más un e2e con dos repos de Claude y uno de Codex en la rejilla en vivo (aceptación 1 de F1). · test: `e2e/multi-engine.test.ts`.

## Cierre de F1

- [ ] Demo manual (PLAN.md §14 F1, criterios 1–4): dos repos con Claude y uno con Codex en vivo, split, reinicio sin duplicados e hidratación de una sesión previa.
