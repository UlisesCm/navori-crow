# F2b Motor pi (pi.dev) — Tasks

Lotes de 1–3 tareas. Cada tarea declara los `R<n>` que cubre, sus archivos (anclados por símbolo) y sus tests; todo test lleva `// Covers: R<n>`. Orden y dependencias según design.md § Components y § Evidence gaps y lote B0. Ningún test lee homes reales ni necesita pi instalado, salvo el smoke opcional de B3.T3 (`CROW_PI_SMOKE=1`). Gate de cada tarea: `bun run lint && bun run typecheck` más sus tests; `bun run check` al cerrar cada lote.

Grafo: B0 → B2, B3 · B1 → B2, B3, B5 · B2 + B3 → B4 · B3 → B5 · B4 + B5 → Aceptación. B0 y B1 pueden ir en paralelo.

## B0 · evidencias, fixtures e higiene (sin dependencias; bloquea B2 y B3)

Correr pi ya es una decisión tomada (Q10): primero `faux`; llamadas reales solo si hace falta y nunca más de 10. Una corrida con tokens reales que no sea la del caso (a) de B0.T2 espera la confirmación explícita del usuario en ese momento. Todo corre con `PI_CODING_AGENT_DIR` y `--session-dir` en un scratch: no se toca `~/.pi/agent` (ni `auth.json` ni `sessions/`). La bitácora guarda formas y conteos, nunca contenido.

- [ ] **B0.T1** (R5, R6, R8, R9, R11) — Captura con el proveedor `faux` (sin tokens), según `scripts/b0-pi/protocol.md` (nuevo).
  - Archivos:
    - `scripts/b0-pi/faux-provider.ts`: extensión solo de B0. `pi.registerProvider("faux", { streamSimple })` con `createFauxCore` de `@earendil-works/pi-ai`, resuelto por el alias de jiti de pi (`getAliases`). Queda fuera de `tsc` con un `exclude` en `scripts/tsconfig.json`.
    - `scripts/b0-pi/capture-extension.ts`: reenvía al receptor los 11 eventos de R8 con el allowlist de D11, más la **lista de claves** de cada evento (nunca valores de contenido).
    - `scripts/b0-pi/count-session.ts`: conteos y relaciones de `timestamp` e ids sobre los JSONL del scratch, sin contenido.
    - `scripts/capture-receiver.ts` (existente), en sus modos `ok`, `hang`, `401` y `413`.
  - Guion:
    - RPC y `-p`: 2 `toolCall` paralelos, una tool que falla, `stopReason: "length"`, `set_model`, `clone` y `new_session`;
    - `pi --fork <archivo>` y `pi -p --no-session`;
    - TUI: `/tree` (rama desde un mensaje anterior), `/fork`, `/resume` y `/model`;
    - `/compact` con el contexto inflado (respuesta guionada larga, o `compaction.reserveTokens` bajo en el `settings.json` del scratch);
    - la parte de tools, repetida con el receptor abajo, colgado, 401 y 413.
  - Cierra: G1 (con el conteo de copias en el mismo ms del header), G2, G3, G4, G5, G6 y G10 (`session_start` doble en la TUI y con `resume`). G7 lo cierra B3.T3.
  - Evidencia: `specs/f2b-pi/b0-bitacora.md`.
  - Dependencias: ninguna.
- [ ] **B0.T2** (R4) — **Condicional**, con tokens reales: una sesión corta con el proveedor por defecto del usuario (≤ 10 llamadas: 2 tools, `/fork` y `/clone`).
  - Se corre **solo si**:
    - (a) B0.T1 no logra cablear `faux` (dentro de la autorización de Q10), o
    - (b) hace falta una fixture con `cost.total > 0` real e ids `call_…`/`fc_…`/`resp_…` reales para el anonimizador, **y el usuario lo confirma explícitamente en ese momento**. El orquestador puede proponerlo, no decidirlo.
  - `faux` no verifica el costo (da 0).
  - Sin B0.T2, el camino `cost.total > 0` queda cubierto por entradas sintéticas en `usage.test.ts`, y la unidad USD por la doc (design § Evidencia).
  - Evidencia: bitácora (conteos y magnitudes de `cost.total`, nunca contenido).
  - Dependencias: B0.T1 (mismo protocolo y scratch).
- [ ] **B0.T3** (R6, R9, R18) — Anonimizador, fixtures e higiene.
  - Archivos:
    - `scripts/anonymize/pi.ts`: allowlist de D16, con `name` calificado por tipo de registro (solo en bloques `toolCall`, como `anonymizeRecord` de `scripts/anonymize/codex.ts`). Un mismo id crudo recibe el mismo pseudónimo en el padre y en sus forks; `timestamp` intacto (D7 depende de `≤` y de los empates de ms); `cwd` y `parentSession` bajo `/tmp/crow-fixture/`.
    - `fixtures/pi/0.99.1/`: sesiones de B0.T1 (y de B0.T2, si corrió). `fixtures/pi/extension/*.json`: sobres capturados.
    - `fixtures/hygiene.test.ts`: `PII_PATTERNS` suma `\b(?:resp|call|fc)_[A-Za-z0-9]{6,}`; `anonymizedFixtureFiles` suma `fixtures/pi/**`.
  - Tests:
    - `scripts/anonymize/pi.test.ts` (`// Covers: R18`): centinelas en texto, `thinking`, argumentos y salida de tools, `details`, `system.sections`, `errorMessage`, **`session_info.name`, `label.label`, `custom.data` y `custom_message.content`** no sobreviven; el `name` de un bloque `toolCall` sí se conserva; el mismo id en padre y fork da el mismo pseudónimo; `timestamp` idéntico.
    - `fixtures/hygiene.test.ts` extendido (`// Covers: R18`).
    - `fixtures/b0-pi.test.ts` (nuevo), tripwires sobre las fixtures. (`// Covers: R6, R9`): en cada fork, toda copia tiene `ts ≤ header.ts` y forma el prefijo contiguo; cada `turn_end.messageEntryId` y cada `toolCallId` capturados existen en el JSONL de la misma corrida. (`// Covers: R18`): `session_info.name`, `label.label`, `custom.data`, `custom_message.content` y todo `name` fuera de un `toolCall` traen solo marcadores (la higiene estructural acepta strings cortos sin marcar).
  - Dependencias: B0.T1 (y B0.T2 si corrió).

## B1 · core (sin dependencia de B0; bloquea B2, B3 y B5)

- [x] **B1.T1** (R1, R3, R17) — Contratos, config y etiqueta web.
  - Archivos:
    - `packages/core/src/crow-event.ts`: `EngineId` gana `"pi"`; `EventKind` gana `"model.change"`; `CrowEventModel` y `CrowEvent.model?`; `IngestErrorReason` gana `"unsupported-version"`; el JSDoc del kind `usage` pasa a "usage outside an assistant message (OTel ledger or engine entries)".
    - `packages/core/src/adapter.ts`: `CrowConfig.piAgentDir` y `CrowConfig.piSessionDir`.
    - `packages/core/src/config.ts`: `loadConfig` resuelve `PI_CODING_AGENT_SESSION_DIR` > `PI_CODING_AGENT_DIR/sessions` > `~/.pi/agent/sessions`, con `~` expandido.
    - Literales de `CrowConfig`: `packages/cli/src/doctor.ts`, `packages/cli/src/doctor.test.ts`, `apps/server/src/app.test.ts`, `apps/server/src/otlp-server.test.ts`, `apps/server/src/api.test.ts` y `e2e/helpers.ts`.
    - `apps/web/src/lib/reduce/feed.ts`: `KIND_LABELS["model.change"]` = "Modelo"; `describeEvent` → `<provider>/<id>`.
  - Tests:
    - `packages/core/src/config.test.ts` (`// Covers: R1`): la precedencia y la expansión de `~`.
    - `apps/web/src/lib/reduce/feed.test.ts` (`// Covers: R3`): etiqueta y detalle de `model.change`.
  - Dependencias: ninguna.
- [ ] **B1.T2** (R4, R7) — Costo del motor y entradas desconocidas.
  - Archivos:
    - `packages/core/src/crow-event.ts`: `CrowEventUsage.engineCostUsd?`.
    - `packages/core/src/store/store.ts`: `applyUsage` usa `usage.engineCostUsd ?? computeCostUsd(usage)`; `ingestBatch` acepta `unknownEntries` y suma `unknown_entries` en la misma transacción; `stats()` lee `unknown_entries`.
    - `packages/core/src/adapter.ts`: `LineResult` (ok) gana `unknown?: true`.
    - `packages/core/src/tailer/ingest.ts`: `processFile` cuenta los `unknown` del paso y los pasa a `ingestBatch`.
    - `packages/core/src/api-types.ts`: `IngestStats.unknownEntries`.
  - Tests:
    - `packages/core/src/store/store.test.ts` (`// Covers: R4`): `engineCostUsd` gana a la tabla; ausente → tabla; sin modelo ni `engineCostUsd` → `t_unpriced`; el camino del delta de `usageKey` no lo lleva (residual fijado).
    - `packages/core/src/tailer/ingest.test.ts` (`// Covers: R7`): con un adaptador de prueba que marca N líneas `unknown`, `unknownEntries` = N y el offset avanzan en la misma transacción.
    - `apps/server/src/api.test.ts` (`// Covers: R7`): el `toEqual` exacto de `/api/stats` gana `unknownEntries: 0`.
    - Snapshots `contract.test.ts` de Claude y Codex sin cambios (`// Covers: R4`, regresión).
  - Dependencias: B1.T1 (comparten `crow-event.ts` y `adapter.ts`).

## B2 · adaptador pi, carril A (depende de B1 y de B0.T3)

- [ ] **B2.T1** (R1, R2, R7) — Paquete, descubrimiento, identidad y formato.
  - Archivos:
    - `packages/adapters/pi/` (`@crow/adapter-pi`: `package.json`, `tsconfig.json`, `src/index.ts`).
    - `src/adapter.ts`: `piAdapter` con `watchRoots` = `[config.piSessionDir]`, `matches` a profundidad 1 o 2, `initialState` y `restoreState` (rechaza otro `v`).
    - `src/map-line.ts`: header válido con `id` string y `timestamp` legible, sesión y `cwd` del header; versión ≠ 3 → `unsupported-version`; tipo o rol desconocido → `unknown: true` y un `unknown-type` por archivo y motivo (`PiState.warned`).
  - Tests:
    - `packages/adapters/pi/src/adapter.test.ts` (`// Covers: R1`): profundidad 1 y 2 aceptadas; profundidad 3, no-`.jsonl` y rutas fuera de la raíz rechazadas.
    - `src/map-line.test.ts` (`// Covers: R2`): sesión = `header.id` y proyecto = `header.cwd` aunque el nombre y el directorio digan otra cosa; header inválido → un `bad-shape` y nada más. (`// Covers: R7`): 3 entradas de un tipo nuevo, 1 rol nuevo y header v2 → un `ingest.error` por motivo y `unknown` en 4 líneas.
  - Dependencias: B1.T1, B1.T2.
- [ ] **B2.T2** (R3, R9) — Mapa del carril A y turno diferido.
  - Archivos: `src/map-line.ts` (`prompt`, `assistant.message`, `tool.pre`, `tool.post`/`tool.error`, `compact`, `model.change`; `semanticKey` y `match` de design § Mapa del carril A; `PiState.openTurn` de D4; copia de `trimInput` de `packages/adapters/claude/src/map-line.ts`; `text` ≤ 8 KiB y error ≤ 1 KiB).
  - Tests:
    - `src/map-line.test.ts` (`// Covers: R3`): centinelas en `thinking`, salida de tool, `details`, `system.sections` y `errorMessage` nunca salen. (`// Covers: R3, R9`): asistente con 2 `toolCall` → `turn.end` con el segundo `toolResult` y clave `turn-end:<entryId>`; sin tools → en la misma línea; turno abierto que cierra el asistente siguiente.
    - `src/contract.test.ts` (`// Covers: R3`): snapshot sobre `fixtures/pi/0.99.1/`, más entradas sintéticas de `compaction`, `model_change` y roles conocidos.
  - Dependencias: B2.T1; B0.T3 (fixtures).
- [ ] **B2.T3** (R4, R5, R6, R7) — Uso, ramas, fork y migración.
  - Archivos:
    - `src/usage.ts`: `toCrowUsage` y `usageKeyFor` (`resp:<responseId>` o `entry:<id>:<tipo>`); `engineCostUsd` solo si `cost.total > 0`; `model` = `responseModel ?? model` del asistente o el `model` de la entrada `usage`, y ninguno en `compaction`, `branch_summary` y `toolResult`.
    - `src/map-line.ts`: evento `usage` para el uso que no es del asistente; `inheritedEntry` y `PiState.inheriting` (D7).
  - Tests:
    - `src/usage.test.ts` (`// Covers: R4`): `cost.total > 0` → `engineCostUsd`; `0` con modelo en la tabla → tabla; `0` sin modelo → sin precio; `cacheWrite1h` → `cacheCreation1h`; `reasoning` no se suma; mismo `responseId` en dos entradas → delta 0; una entrada de cada tipo (`usage` `cache_warm`, `usage` de `kind` desconocido, `compaction`, `branch_summary`, `toolResult`) → un `usage` con su clave, y la suma de `costUsd` = la suma de `cost.total` de pi; un uso en 0 → nada.
    - `src/branches.test.ts` (`// Covers: R5`): 2 ramas y `branch_summary` → cada respuesta una vez.
    - `src/fork.test.ts` (`// Covers: R6`): **empate de ms** (última copia con `ts == header.ts`) → heredada; primera propia con `ts > header` y luego una con el reloj atrás → contadas las dos; primera propia con `ts ≤ header` → heredada (residual fijado); copia con reloj adelantado en medio del prefijo → cierra el prefijo (residual fijado); `model_change` automático en el mismo ms del header de `newSession({ parentSession })` → sin evento; `timestamp` ilegible en el prefijo → heredada y un `bad-shape`; sin `parentSession` → nada heredado.
    - `e2e/pi-fork.test.ts` (`// Covers: R6`): padre más `/fork`, `/clone` y `--fork` sintéticos en los 24 órdenes → totales = padre + lo propio de cada fork; cada fork es su propia sesión y su timeline no muestra la historia copiada.
    - `src/migration.test.ts` (`// Covers: R5, R7`; tailer real): v2 ingerido, reescrito v3 del mismo tamaño y luego crecido → sin duplicados; más corto sin crecer → vuelve a 0 sin duplicados; con `hookMessage`, más corto y crecido antes del siguiente paso → a lo sumo un `invalid-json` (residual de D8 fijado).
  - Dependencias: B2.T2.

## B3 · extensión y carril B (depende de B1 y de B0.T1)

- [ ] **B3.T1** (R8, R10, R11, R12) — Plantilla de la extensión.
  - Archivos:
    - `packages/adapters/pi/extension/crow-ingest.ts`: `createCrowExtension(deps)` y la factory por defecto; handlers síncronos dentro de `try`; cola de 500, lotes de 50, `AbortSignal.timeout(2000)`, flush de 1 s solo en `quit`; `leafId` en `session_start`; token leído por lote; sin imports salvo `node:`.
    - `extension/testing/fake-pi.ts`: `pi.on`, `ctx` caducado que lanza y `fetch` inyectable.
  - Tests en `extension/crow-ingest.test.ts`:
    - `// Covers: R8`: registra exactamente los 11 eventos y cada uno produce su sobre; `session_start` lleva `leafId`.
    - `// Covers: R10`: centinelas en `input`, `args`, `content`, `result`, `message`, `messages`, `Model.headers`, `baseUrl` y `getSessionFile()` no salen; las claves del sobre ⊆ {`v`, `events`, `dropped`} y las de cada evento ⊆ el allowlist exacto del design (§ Contracts, "Allowlist exacto del sobre (R10)"), que nombra la categoría de R10 de cada clave.
    - `// Covers: R11`: con `ctx` caducado, `fetch` que lanza síncrono, rechazado o que nunca resuelve, respuesta no-`Response` y token ilegible → cada handler vuelve en < 20 ms con `undefined`, 0 `unhandledRejection`, `quit` ≤ 1.1 s, la cola ≤ 500 y `dropped`.
    - `// Covers: R12`: token → `Authorization: Bearer`; sin archivo → sin cabecera; token rotado entre lotes → el nuevo.
  - Dependencias: B0.T1 (formas de los eventos), B1.T1.
- [ ] **B3.T2** (R8, R9) — `piFromHook` y reconciliación.
  - Archivos:
    - `packages/adapters/pi/src/hook.ts`: `piFromHook`. `session_start` `resume` → `session-start@resume:<leafId>`; `startup`, `new` y `fork` → `session-start@main`; `reload` y los eventos de Q3 → `[]`; anidadas → `[]`; sin id → `bad-shape`; `dropped` → `queue-overflow`.
    - `src/adapter.ts`: `fromHook`.
  - Tests:
    - `src/hook.test.ts` (`// Covers: R8`): los sobres dorados del harness → eventos esperados; `turn_start`, `agent_end`, `model_select` y `reload` (de `session_start` y de `session_shutdown`) → `[]`.
    - `packages/core/src/store/reconcile-pi.test.ts` (`// Covers: R9`), con `PendingEvent` sintéticos que usan las claves y roles de pi, como `reconcile.test.ts`; no importa `@crow/adapter-pi`, así que core no depende del adaptador (la deriva con el adaptador la cubren `hook.test.ts`, `map-line.test.ts` y `e2e/pi-lanes.test.ts`): **720 permutaciones** de {A pre, B call, B exec_start, A post, B result, B exec_end} → 2 hechos; {A turn.end, B turn_end}, {A compact, B session_compact} y {header, `session_start` startup} en los dos órdenes → 1 cada uno; `session_start` `new` y `fork` **dos veces** → 1 hecho; `resume` dos veces con el mismo `leafId` → 1 hecho, y con `leafId` distinto → 2.
  - Dependencias: B3.T1 (sobres dorados).
- [ ] **B3.T3** (R8, R11, R13) — Render y carga real.
  - Archivos:
    - `packages/adapters/pi/src/render-extension.ts`: `renderPiExtension({ port, tokenFile })` y `parseExtensionConfig(text)`.
    - `e2e/pi-smoke.test.ts` (nuevo, opcional) y `scripts/pi-api-drift.ts` (manual, fuera de CI).
  - Tests:
    - `extension/load.test.ts` (`// Covers: R8, R13`): la plantilla renderizada se importa con Bun y registra los handlers en el `fake-pi`; solo importa `node:`; el render cambia solo el bloque marcado y `parseExtensionConfig` lo lee de vuelta.
    - `e2e/pi-smoke.test.ts` (`// Covers: R8, R11`; `test.skipIf` salvo `CROW_PI_SMOKE=1` y `pi` en el PATH): `pi -ne -e <renderizada> -e scripts/b0-pi/faux-provider.ts --provider faux --model faux-1 -p <prompt> --session-dir <tmp>` con `PI_CODING_AGENT_DIR=<tmp>` → el receptor del test recibe `session_start` y `tool_call`, pi sale con 0 y stderr no tiene rastro de la extensión; con el receptor abajo, lo mismo sin sobres. Se corre una vez a mano y el resultado va a la bitácora (G7).
  - Dependencias: B3.T1; B0.T1 (`faux-provider.ts`).

## B4 · integración (depende de B2 y B3)

- [ ] **B4.T1** (R9, R17) — Registro del motor y e2e de carriles.
  - Archivos: `apps/server/src/adapters.ts` (`ENGINE_ADAPTERS` gana `bindAdapter(piAdapter)`).
  - Tests:
    - `apps/server/src/ingest-route.test.ts` (`// Covers: R17`): `/ingest/hook/pi` → 204.
    - `e2e/pi-lanes.test.ts` (`// Covers: R9, R17`): fixture de B0 por los dos carriles en orden aleatorio → sesión `pi:<id>` en `/api/projects` con totales y `live`, sin hechos duplicados; `session_shutdown` → `ended`; solo carril A → `live` y luego `idle` tras `sweepIdle`, nunca `ended`; solo carril B → sin costo.
  - Dependencias: B2.T3, B3.T2.

## B5 · CLI (depende de B1 y B3)

- [ ] **B5.T1** (R13, R15) — `crow attach pi`.
  - Archivos:
    - `packages/cli/src/attach-common.ts`: `Engine` gana `"pi"`; `buildContext` con `configPath` = `<piAgentDir>/extensions/crow-ingest.ts`; `Manifest.created.extensionsDir?`; `otherEngineHasOtlp` nunca elige a `pi`.
    - `packages/cli/src/pi-config.ts` (nuevo): `planPiAttach`; lectura de `settings.json` sin BOM para los avisos de `extensions` y `sessionDir`.
    - `packages/cli/src/attach.ts`: rama `pi` sin script de hooks ni OTLP, que termina con "reinicia pi o usa /reload".
  - Tests en `packages/cli/src/attach-pi.test.ts`:
    - `// Covers: R13`: diff, confirmación (TTY o `--yes`), escritura solo del archivo y de `$CROW_HOME`, backup en `$CROW_HOME/backups/pi/`, idempotencia, sin marcador → abortar, symlink escrito a través, `extensions/` creado y registrado, otro puerto → diff y backup.
    - `// Covers: R15`: `settings.json` o manifiesto ilegibles → abortar sin escribir.
  - Dependencias: B1.T1, B3.T3 (`renderPiExtension`).
- [ ] **B5.T2** (R14, R15) — `crow detach pi`.
  - Archivos:
    - `packages/cli/src/pi-config.ts`: `planPiDetach`. "Sin modificar" = sha256 del manifiesto **o** igual a `renderPiExtension(parseExtensionConfig(archivo))`.
    - `packages/cli/src/detach.ts`: rama `pi`.
  - Tests en `packages/cli/src/detach-pi.test.ts`:
    - `// Covers: R14`: intacta → se borra; intacta con otro puerto y sin manifiesto → se borra; editada → se conserva y se informa; `settings.json` y otra extensión intactos; `extensions/` se quita solo si crow lo creó y quedó vacío.
    - `// Covers: R15`: config ilegible → abortar.
  - Dependencias: B5.T1.
- [ ] **B5.T3** (R16) — `crow doctor` para pi.
  - Archivos: `packages/cli/src/doctor.ts` (`ENGINES` gana `pi`; `inspectPiInstall`; `PiExtensionReport` con `port`, `tokenFile`, `portMismatch`, `tokenFileMismatch`, `disabledBy` y `sessionDirSetting`; `laneB.config` discriminado por `kind`; `contentFlags` en `null` para pi; sesiones pi vivas con `fetchLiveCount`).
  - Tests en `packages/cli/src/doctor.test.ts` (`// Covers: R16`): raíz y archivos vistos; extensión ausente, instalada, modificada y deshabilitada por `!`/`-`; `sessionDir` definido; puerto distinto de `CROW_PORT` y token fuera de `$CROW_HOME` → aviso "corre `crow attach pi`"; último evento; "sin eventos con sesiones pi vivas" nombra el reinicio, `/reload` y `-ne`; `--json` con `kind: "pi-extension"`.
  - Dependencias: B5.T1 (`pi-config.ts`).

## Aceptación (F2b)

- [ ] Demo manual con pi real:
  - sin `attach`, una sesión de pi aparece en vivo en la rejilla (carril A) y pasa a `idle` al dejarla;
  - con `crow attach pi` y pi reiniciado, las tool calls aparecen al instante en el timeline y `session.end` llega al salir;
  - con crow apagado, pi funciona sin error visible y sin demora perceptible en las tools.
