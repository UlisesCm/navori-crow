# F2a Ingesta activa (Claude Code y Codex) — Tasks

Lotes de 1–3 tareas; cada tarea declara los `R<n>` que cubre y sus tests (todo test lleva `// Covers: R<n>`). Orden y dependencias según design.md § Batches propuestos. Ningún test lee homes reales.

## B0 · evidencias (sin dependencias; bloquea B1–B6)

- [ ] **B0.T1** (R8, R20, R33) — Experimento de transporte de Claude (gap G1, D14) con Claude Code real y `CLAUDE_CONFIG_DIR` temporal, siguiendo el protocolo `scripts/b0-transport-experiment.md`: para el hook `http` con timeout 2 y para el shim `command` con `async: true`, registrar error visible y latencia con crow abajo, colgado, 401 y 413. Capturar los payloads de los 15 eventos de R8 y cómo registra el transcript los hooks (`hook_*`), anonimizados en `fixtures/claude/hooks/`. El resultado fija el transporte de Claude (decisión del orquestador, criterio de D14) y, si aplica, el ajuste condicional de R5. · evidencia: bitácora del experimento; `fixtures/hygiene.test.ts` sobre las capturas.
- [ ] **B0.T2** (R9, R18, R19) — Capturas de hooks de Codex (G2: shell, `SubagentStart/Stop`, `session_id` raíz o hilo, `turn_id`, campo de error, paso de confianza) con `CODEX_HOME` temporal, y cuerpos OTLP reales de Claude y Codex (G3/G4: nombres y tipos de atributos, span de hook, `service.name`, `conversation.id`, id por llamada) en JSON y protobuf, con anonimizadores de allowlist en `scripts/anonymize/`. · tests: `scripts/anonymize/*.test.ts`, `fixtures/hygiene.test.ts`.
- [ ] **B0.T3** (R11, R12, R13) — Confirmación de ids entre carriles (G5a: `tool_use_id`, `prompt_id`/`promptId`, `request_id`/`requestId`, `agent_id`) sobre las capturas de B0.T1/T2 más el transcript de esa corrida, solo con conteos; `scripts/encode-otlp-fixture.ts` y los vectores protobuf de D9. · evidencia: tabla de igualdades en design.md § Evidencia verificada; `protobuf` vectores en `fixtures/otlp/`.

## B1 · core (depende de B0)

- [x] **B1.T1** (R3, R34) — Contratos y config: adiciones a `CrowEvent` (`turn.end`, `revision`, `hook`, `permission`, `usage` reportado), extensiones del contrato de adaptador (`fromHook`, `fromOtel`, `match`, `usageCallKey`), token por `CROW_TOKEN` o `$CROW_HOME/token`, y config de OTLP opt-in (flag, `CROW_OTLP`, `config.json`). · tests: `packages/core/src/config.test.ts`.
- [x] **B1.T2** (R10, R11, R13) — Migración 3 aditiva, `ingestEvents` con atribución (D4), reconciliación con hechos inmutables fundidos en el lugar y filas `revision` (D5), efectos no monótonos guardados por `ts` en el store y en los reducers de la web. · tests: `migrations.test.ts`, `store/agents.test.ts`, `store/reconcile.test.ts` (720 permutaciones), `status.test.ts`, `apps/web/src/lib/reduce/{projects,session,feed}.test.ts`, `sse-replay.test.ts` (revisión en el relevo), `store/invariants.test.ts`.
- [ ] **B1.T3** (R12, R30, R33) — Libro de uso OTel por llamada (D6: retención, descarte, promoción y corrección negativa), claves `match`/`usageCallKey` en los `map-line.ts` de F1, y mapeo de los registros de hook del transcript de Claude con allowlist y exclusión de los hooks de crow (D18). · tests: `store/usage-lanes.test.ts`, `claude/hook-records.test.ts`, `claude/contract.test.ts` (snapshot con `hook`).

## B2 · carril B y hooks de Claude (depende de B1)

- [ ] **B2.T1** (R6, R7) — `IngestQueue` (D2): dos FIFO acotadas y un drenador, cuota por motor, bisección de poison pills y backoff ante `SQLITE_FULL`; `ingest.error` por episodio de desborde. · tests: `ingest-queue.test.ts`.
- [ ] **B2.T2** (R1, R2, R3, R4, R5, R28) — `POST /ingest/hook/:engine` (D3): 204 inmediato, 404 por motor sin hooks, 401 por token, guard compartido con `/api/*`, 413 por tope de 1 MiB con `Content-Length` o chunked; `LaneMonitor` y `/api/stats.lanes`. · tests: `ingest-route.test.ts`, `guard.test.ts`.
- [ ] **B2.T3** (R8, R10, R31, R32) — `fromHook` de Claude con los 15 eventos de R8 sobre las capturas de B0 (`Stop`/`StopFailure` → `turn.end`) y el presupuesto de latencia. · tests: `packages/adapters/claude/src/hook.test.ts`, `e2e/hook-latency.test.ts`.

## B3 · hooks de Codex (depende de B2)

- [ ] **B3.T1** (R9, R10, R13) — `fromHook` de Codex sobre las capturas de B0 y, solo si G2 lo pide, resolución de hilos por `transcript_path`; prompt de Codex a un solo hecho entre carriles. · tests: `packages/adapters/codex/src/hook.test.ts`, `store/reconcile.test.ts` (prompt de Codex).

## B4 · receptor OTLP (depende de B1)

- [x] **B4.T1** (R14, R16) — `packages/otlp`: decodificador protobuf propio con tope de profundidad 32, vectores a mano y oráculo `protobufjs` solo en `scripts`; aplanado portado de `collect.ts` (`timeUnixNano` como número y como string). · tests: `packages/otlp/src/protobuf.test.ts`, `packages/otlp/src/flatten.test.ts`.
- [ ] **B4.T2** (R14, R15, R16, R17, R34) — `otlp-server.ts` en `CROW_OTLP_PORT`, opt-in, JSON/protobuf/gzip con respuesta OTLP/HTTP en camelCase, 400/405/413/415/503, puerto ocupado sin tumbar el resto, ruteo sin `service.name` y `ingest.error` por episodio. · tests: `otlp-server.test.ts`, `config.test.ts`.

## B5 · mapas OTel (depende de B3 y B4)

- [ ] **B5.T1** (R18, R24) — `fromOtel` de Claude: eventos de log, las dos métricas de R18 y spans de hook (trazas beta, opt-in), sin atributos de contenido. · tests: `packages/adapters/claude/src/otel.test.ts`.
- [ ] **B5.T2** (R11, R12, R13, R19, R24) — `fromOtel` de Codex con los 4 eventos de R19, y el e2e de tres carriles sobre la sesión capturada en B0 (G5b) en orden aleatorio. · tests: `packages/adapters/codex/src/otel.test.ts`, `e2e/lanes.test.ts`.

## B6 · CLI (depende de B2 y B4)

- [x] **B6.T1** (R20, R34) — `packages/cli` con `crow up` mínimo (`--otlp`), escritura segura (`fs-safe`: a través de symlinks, backups 0600 con rotación), diff enmascarado y el script de hook de crow con fail-open. · tests: `packages/cli/src/hook-script.test.ts`, `config.test.ts`.
- [ ] **B6.T2** (R21, R22, R23, R24, R25, R26, R27) — `crow attach|detach <claude|codex>` por unidades (D13, D14): transporte de Claude elegido en B0, Codex anidado `[[hooks.X.hooks]]` con script confiable, sin flags de contenido, idempotente, aborta ante config ilegible, `detach` conserva e informa las entradas editadas. · tests: `attach.test.ts`, `attach-*.test.ts`, `detach-*.test.ts`.
- [ ] **B6.T3** (R15, R28) — `crow doctor`: carriles por motor, último hook y registro recibidos, confianza pendiente de Codex, `port-in-use`, collector ajeno, flags de contenido y conflicto con `OTEL_*` del shell. · tests: `doctor.test.ts`.

## B7 · UI (depende de B2)

- [ ] **B7.T1** (R11, R13, R29, R32) — Timeline con `hook`, `permission`, `turn.end`, `compact` y `api.request`; las filas `revision` actualizan el hecho y nunca se agregan al feed. · tests: `apps/web/src/lib/reduce/feed.test.ts`.
- [ ] **B7.T2** (R30) — Panel de hooks por sesión: ejecuciones, duración total y máxima, y veredictos bloqueantes, con estado vacío. · tests: `apps/web/src/lib/reduce/hooks.test.ts`, `apps/server/src/api.test.ts`.

## Aceptación (F2 criterios 1 y 2)

- [ ] Demo manual: con `crow attach claude`, los hooks, `SubagentStart` y los permisos aparecen en el timeline al instante; con crow apagado, Claude y Codex siguen funcionando sin error visible.
