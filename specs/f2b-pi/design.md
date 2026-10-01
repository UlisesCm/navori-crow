# F2b Motor pi (pi.dev) — Design

> **Estado:** revisión 2 del architect, con las correcciones del review de la spec (`.navori/state/handoffs/review_f2b-pi-spec.md`, § Correcciones del review). Aplica el veredicto CONCERNS del orquestador sobre la revisión 1 (challenge: `.navori/state/handoffs/challenge_f2b-pi.md`) y las decisiones Q1–Q10 que ya refleja `requirements.md`. Sin veredicto propio.
> **Fecha:** 2026-09-30.
> **Base:** `origin/main` en `d1bae2a` (verificado otra vez tras `git fetch origin main`; `HEAD` de `feat/f2b-pi-spec` = `origin/main`). Las citas `archivo:línea` del repo son de ese commit.
> **pi:** 0.99.1 instalado. Abreviaturas: `PI` = `~/.pi/agent/install/releases/0.99.1/node_modules/@earendil-works/pi-coding-agent/`, `PIAI` = `…/@earendil-works/pi-ai/`. La doc se leyó del paquete instalado el 2026-09-30. La doc web (`https://pi.dev/docs/latest`) no se consultó: sus equivalentes quedan **[SIN VERIFICAR]**.
> **Señales:**
> - contrato compartido: `EngineId`, `EventKind`, `CrowConfig`, `CrowEventUsage`, `LineResult`, `IngestStats` y un payload nuevo de carril B;
> - integridad de datos: doble conteo por fork, clone y ramas, y costo reportado por el motor;
> - código de crow que corre **dentro** de otro proceso (la extensión), con el riesgo de bloquear tools;
> - escritura en la configuración del usuario (`attach`);
> - privacidad.
>
> **Marcas:** **✓** = verificado en código o doc de pi, o en el repo. **✓ probe** = confirmado por los probes del challenge (proveedor `faux`, agent dir y sesiones en scratch). **⚠** = sin verificar; lo cierra B0.

## Resumen

- **Carril A** es un adaptador nuevo, `@crow/adapter-pi`, sobre el tailer de F1 sin cambios en el tailer.
  - La sesión y el proyecto salen del header (R2).
  - La historia que copian `/fork`, `/clone` y `--fork` es el **prefijo contiguo** del archivo cuyas entradas tienen `timestamp` **≤** al del header. No genera eventos ni uso, con el mismo criterio que la historia heredada de Codex en F1 (R6, D7). El `≤` absorbe el empate de milisegundo y el prefijo absorbe un reloj que retrocede después de la primera entrada propia.
  - Las ramas no necesitan nada: el archivo es solo de agregado (append) y cada entrada aparece una vez (R5).
  - El JSONL no tiene señal de fin: `ended` llega solo por el carril B. Sin él, la sesión pasa de `live` a `idle`, igual que Claude y Codex sin `attach` (D15).
- **Costo (R4).** Se cuenta todo el uso que pi suma a sus totales: el del asistente y también el de `compaction`, `branch_summary`, las entradas `usage` (entre ellas `cache_warm`, activo por defecto) y `toolResult`.
  - El uso que no es del asistente va en un evento `usage` propio (un kind que ya existe y la web no pinta), con `usageKey = entry:<id>:<tipo>` (D5).
  - Core gana `CrowEventUsage.engineCostUsd`, porque `applyUsage` hoy **siempre** recalcula el costo con la tabla.
- **Carril B** es un archivo TS generado, `~/.pi/agent/extensions/crow-ingest.ts`, sin imports salvo builtins `node:`.
  - Los handlers son síncronos, nunca lanzan y nunca devuelven valor. Un throw en `tool_call` bloquea la tool: `ExtensionRunner.emitToolCall` no atrapa (✓ probe).
  - Una cola interna acotada con un solo emisor manda lotes con `AbortSignal.timeout(2000)`.
  - Solo `session_shutdown(quit)` espera, como mucho 1 s.
  - `-ne` y los filtros de `settings.json` la desactivan. `doctor` avisa cuando puede saberlo (D14).
- **Reconciliación (R9)** con claves exactas por ids nativos: `tool-pre:`/`tool-post:<toolCallId>`, `turn-end:<assistantEntryId>`, `compact:<compactionEntryId>`, `session-start@main` y, para `resume`, `session-start@resume:<leafId>`. Así, el `session_start` que pi emite dos veces se funde en un solo hecho (D12).
  - El `turn.end` del carril A se emite **al cerrar el turno** (tras su último `toolResult`), no al ver la línea del asistente. Así queda después de sus tools en los dos carriles.
- **`attach pi`** escribe una sola unidad: el archivo de la extensión, con el puerto y la ruta del token grabados. Reusa `fs-safe`, el manifiesto, el diff y la confirmación de F2a. `settings.json` de pi solo se lee. Si después cambia `CROW_PORT` o `CROW_HOME`, `doctor` lo detecta y la salida es volver a correr `attach` (D9, D14).
- **Carga real de la extensión:** el test con Bun no prueba jiti. Un smoke con `pi -ne -e <extensión> -e <proveedor faux>` la prueba en B3 (e2e opcional) y deja el resultado en la bitácora (D10.8).

## Cambios de la revisión 2

| # | Ajuste pedido | Dónde queda |
|---|---|---|
| 1 | Regla de fork robusta ante empate de ms y reloj que retrocede | D7 (`≤` + prefijo contiguo); `fork.test.ts` con empate de ms |
| 2 | `session_start` de `resume`, `fork` y `new` sin duplicar | D12 (clave `session-start@resume:<leafId>`); § Contracts (`leafId`); `reconcile-pi.test.ts` |
| 3 | `session.end` del carril A | D15: no hay señal en el JSONL; `ended` depende del carril B; sin B, `idle` |
| 4 | `api.test.ts` y el `toEqual` exacto de `/api/stats` | § Components; `tasks.md` B1.T2 |
| 5 | `-ne` y filtros de settings | § Failure modes; D14 |
| 6 | Migración v1/v2 que reescribe el archivo y luego crece | D8: riesgo residual acotado. La huella de cabecera cuesta una migración de esquema |
| 7 | R4 ampliado: `entry:<id>:<tipo>` y `cacheWarming` | D5; § Mapa del carril A |
| 8 | Puerto de crow grabado en la extensión | D9; D14 (aviso de puerto o ruta del token distintos) |
| 9 | La carga con jiti no la prueba Bun | D10.8: smoke `pi -ne -e` con `faux` (B3.T3, e2e opcional) |

Además: Q1–Q10 quedan cerradas por el usuario (§ Decisiones del usuario), `model.change` deja de ser condicional (D17) y los hechos que confirmaron los probes pasan a **✓ probe**.

## Correcciones del review de la spec

| # | Hallazgo | Dónde queda |
|---|---|---|
| 1 | [ALTO] `name` sin calificar en el allowlist de fixtures dejaba salir `session_info.name` | D16: `name` solo en bloques `toolCall`; `session_info.name`, `label.label`, `custom.data` y `custom_message.content` van a marcador; centinelas en `scripts/anonymize/pi.test.ts` y chequeo por tipo en `fixtures/b0-pi.test.ts` |
| 2 | Allowlist exacto del sobre frente a R10 | § Contracts, "Allowlist exacto del sobre (R10)", con la categoría de R10 de cada clave; el test de B3.T1 compara contra esa lista |
| 3 | R5 frente a R6 en un fork con ramas | R5 ya exceptúa lo heredado bajo R6: D7 se apoya en ese texto y la lectura [assumed] desaparece |
| 4 | B0.T2 por decisión del orquestador | La corrida con tokens reales en el caso (b) exige la confirmación explícita del usuario en ese momento |
| 5 | `reconcile-pi.test.ts` y la dependencia core → adapter | Eventos `PendingEvent` sintéticos con las claves y roles de pi, como `reconcile.test.ts`; no importa `@crow/adapter-pi` |
| 6 | `reload` en R8 | Confirmado: R8 lo exime y D12, § Mapa del carril B y `hook.test.ts` lo mapean a `[]` |

---

## Evidencia verificada

### pi 0.99.1: sesiones (✓, código)

El binario `pi` ejecuta `PI/dist/bundle/cli.js`. Leí `PI/dist/core/*.js` y verifiqué en `PI/dist/bundle/chunks/chunk-GUORCHFS.js` que el bundle contiene la misma lógica de `createBranchedSession` y de `emitToolCall`.

- **Fork y clone copian con los mismos `id`.**
  - `SessionManager.createBranchedSession(leafId)` (`PI/dist/core/session-manager.js`) toma `getBranch(leafId)`, el camino raíz→hoja, y escribe cada entrada como `{ ...entry, parentId: pathParentId }`. Conserva `id`, `timestamp` y el `message` completo, incluidos `responseId` y `usage`. Solo cambia `parentId` al re-encadenar cuando quita entradas `label`, que se recrean con id nuevo.
  - El header es nuevo: `id` nuevo, `timestamp = new Date().toISOString()` del momento del fork y `parentSession` = ruta del archivo padre.
  - Si el camino ya tiene conversación, escribe todo de una vez con `_rewriteFile`, a un archivo **nuevo**.
- **`/clone` = `fork(leafId, { position: "at" })`**: `InteractiveMode.handleCloneCommand` en `PI/dist/modes/interactive/interactive-mode.js`. Copia la rama activa entera.
- **`/fork` = `fork(entryId, "before")`** sobre un mensaje `user`: `AgentSessionRuntime.fork` en `PI/dist/core/agent-session-runtime.js`. La hoja destino es el `parentId` de ese mensaje. Si ese `parentId` es `null` (fork desde el primer mensaje), usa `newSession({ parentSession })`, que crea un archivo nuevo **sin copias**.
- **`pi --fork <archivo>`** = `SessionManager.forkFrom` (vía `forkSessionOrExit` en `PI/dist/main.js`).
  - Copia **todas** las entradas no-header del origen, todas las ramas, con `appendFileSync` línea a línea y los mismos `id`.
  - El header lleva `parentSession` = ruta de origen, `cwd` = el cwd destino y `timestamp` de ahora.
- **Import:** `AgentSessionRuntime.importFromJsonl` copia el archivo con `copyFileSync` y conserva el **mismo** `id` de header, sin `parentSession`.
- **Ramas en el mismo archivo (`/tree`):**
  - `SessionManager.branch` solo mueve `leafId` en memoria;
  - `branchWithSummary` **agrega** una entrada `branch_summary` hija del punto de rama;
  - todo lo siguiente se agrega como hijo de esa hoja. El comentario de la clase dice "append-only trees".
  - **La hoja activa no se persiste.** Al cargar, `_buildIndex` toma como hoja la **última entrada del archivo**.
- **Escritura:**
  - el archivo nace con el primer mensaje `user` o `assistant` (`_persist` + `_hasConversation`, apertura `"wx"`), con todas las entradas acumuladas;
  - después, `appendFileSync(JSON.stringify(entry) + "\n")` por entrada (`_appendEntry` → `_persist`);
  - los mensajes `"pending"` nunca se persisten (`PI/docs/message-types.md`).
- **Reescritura en el lugar (el único riesgo para el tailer).** `_loadEntries` llama `_rewriteFile` (apertura `"w"`, trunca) cuando `migrateToCurrentVersion` migra un archivo v1 o v2 al abrirlo.
  - `migrateV1ToV2` genera **ids nuevos al azar**;
  - `migrateV2ToV3` conserva los ids y renombra el rol `hookMessage` a `custom`;
  - aparte, `loadEntriesFromFile` agrega un `"\n"` final si falta (solo agrega).
- **Raíz de sesiones.**
  - `sessionDir = --session-dir ?? PI_CODING_AGENT_SESSION_DIR ?? settings.sessionDir` (`PI/dist/main.js`).
  - Con `sessionDir` definido, `SessionManager.create(cwd, sessionDir)` escribe **plano** en ese directorio.
  - Sin él, usa `getDefaultSessionDirPath`, que da `<agentDir>/sessions/--<cwd codificado>--/`.
  - `getAgentDir()` = `PI_CODING_AGENT_DIR` (con `~` expandido) o `~/.pi/agent` (`PI/dist/config.js`).
  - El nombre de archivo es `<ISO con : y . → ->_<sessionId>.jsonl` (`newSession`).
- **Entradas automáticas al crear una sesión:** en una sesión nueva, pi agrega `model_change` y `thinking_level_change` justo después del header (`PI/dist/core/sdk.js`, rama `hasExistingSession`). Pueden caer en el mismo ms que el header. Al reabrir una sesión vieja sin `thinking_level_change`, lo agrega enseguida.
- **Sin entrada de cierre:** los tipos de `PI/docs/session-format.md` § Entry Types son `session`, `message`, `model_change`, `thinking_level_change`, `usage`, `compaction`, `context_edit`, `branch_summary`, `custom`, `custom_message`, `label` y `session_info`. Ninguno marca el fin de la sesión.
- **Censo local** (solo headers, sin contenido): 2 archivos, los dos `version: 3`, 0 con `parentSession`, profundidad 1 bajo `--cwd--`. No hay evidencia en disco de forks ni ramas: todo lo anterior sale del código, y B0 lo confirma.

### pi 0.99.1: extensiones (✓, código y doc)

- **Carga.**
  - `<agentDir>/extensions/*.ts|*.js` y `*/index.ts` (`PI/docs/configuration.md`, `PI/docs/extensions.md`);
  - las extensiones personales no pasan por la confianza de proyecto (`PI/docs/security.md` § "Resources protected by project trust");
  - se cargan en los modos interactivo, RPC, JSON y print (`PI/docs/extensions.md` § "Respect the runtime lifecycle");
  - jiti compila TS sin build;
  - `FILE_PATTERNS.extensions = /\.(ts|js)$/` (`PI/dist/core/package-manager.js`).
  - `settings.json` `extensions` admite patrones `!`, `+` y `-` que excluyen recursos descubiertos (ídem, `resourcePrecedenceRank` y los filtros de override).
- **Handlers:**
  - `ExtensionRunner.emit` hace `await handler(...)` en secuencia y atrapa: `emitError` reporta el error;
  - **`ExtensionRunner.emitToolCall` no tiene `try/catch`**: un throw se propaga y la doc dice que "a `tool_call` handler failure blocks the tool" (`PI/docs/extensions.md` § "Errors and cleanup");
  - `emitToolResult` y el `turn_end` (`BoundaryResult`) usan el valor devuelto para **modificar** el resultado;
  - no hay timeout en el runner.
- **`ctx` caduca.** Los getters de `ExtensionRunner.createContext` (`cwd`, `sessionManager`, `model`…) llaman `assertActive()`, que **lanza** tras un reemplazo de sesión o un reload (`invalidate`).
- **Guía de la doc:** no arrancar timers ni sockets en la factory. Los recursos se arrancan en `session_start` y se liberan de forma idempotente en `session_shutdown`.
- **Tipos** (`PI/dist/core/extensions/types.d.ts`):
  - `SessionStartEvent.reason ∈ {startup, reload, new, resume, fork}`;
  - `SessionShutdownEvent.reason ∈ {quit, reload, new, resume, fork}`;
  - `TurnEndEvent { turnIndex, message, toolResults, messageEntryId, toolResultEntryIds }`;
  - `ToolExecutionEndEvent { toolCallId, toolName, result, isError, parentToolCallId? }`;
  - `ToolCallEventBase.toolCallId`: para llamadas anidadas vale `<padre>/<n>`, y **"such ids never appear as tool calls or tool results in the transcript"**;
  - `SessionCompactEvent.compactionEntry` (con su `id`), `reason` y `willRetry`;
  - `ModelSelectEvent { model, previousModel, source }`;
  - `ExtensionContext.sessionManager: ReadonlySessionManager` (con `getSessionId`, `getSessionFile`, `getCwd`…).
- **`Model` trae `headers?` y `baseUrl`** (`PIAI/dist/types.d.ts` `BaseModel`). Nunca se reenvía el objeto `Model`.
- **Semántica** (`PI/docs/json.md`): "A turn is one assistant response plus any tool calls and tool results produced by that response". `agent_end` "closes one low-level agent run"; puede haber reintento después.
- **Runtime:** Node `>=22.19.0` (`PI/package.json` `engines`). `fetch` y `AbortSignal.timeout` están disponibles.
- **`settings.json` lo reescribe pi** con read-modify-write bajo su propio lock (`SettingsManager.persistScopedSettings`, `FileSettingsStorage.withLock`).
- **Proveedor falso (✓ probe):** `PIAI/dist/providers/faux.d.ts` exporta `createFauxCore`, `fauxToolCall` y `fauxAssistantMessage`. `pi -ne -e probe.ts --provider faux --model faux-1 -p` con `pi.registerProvider("faux", { streamSimple })` corre completo y escribe la sesión.
  - **No sirve para el costo:** con `cost {1,1,0,0}` sale `usage.cost.total = 0`, `cacheWrite` = `input` es un artefacto, y `fauxAssistantMessage` no acepta `usage` (challenge §7).
- **Imports de una extensión:** el loader de pi da alias de jiti a `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` y `typebox` (`PI/dist/core/extensions/loader.js`, `getAliases`). La extensión `faux` de B0 puede importar `@earendil-works/pi-ai` sin ruta absoluta; la plantilla de crow no importa nada de pi.

### pi 0.99.1: uso y costo (✓, doc y tipos)

- **`Usage`** (`PIAI/dist/types.d.ts`): `input, output, cacheRead, cacheWrite, cacheWrite1h?` (subconjunto de `cacheWrite`), `reasoning?` (subconjunto de `output`), `totalTokens` y `cost { input, output, cacheRead, cacheWrite, total }`.
- **Unidad del costo: USD (✓ doc).** `PI/docs/settings.md:21` expresa en dólares el umbral de `cacheWarming` ("at least $0.05 in avoided cache-miss cost"). El ejemplo de `UsageEntry` (`PI/docs/session-format.md` § UsageEntry: `cacheRead: 50000` → `cost.cacheRead: 0.015`) es coherente con un precio por millón de tokens. `types.d.ts` no declara la unidad.
- **Uso que suma a los totales de pi además del asistente:**
  - las entradas `usage` (`PI/docs/session-format.md` § UsageEntry: "contribute to session token and cost totals");
  - `compaction.usage` y `branch_summary.usage`;
  - `toolResult.usage` ("contributes to full-session statistics", `PI/docs/message-types.md`).
- **Precios por tramos:** `ModelCost.tiers` (`PIAI/dist/types.d.ts`). La tabla de crow no los modela.
- **Qué trae cada fuente de uso:**
  - `UsageEntry` trae `kind`, `provider`, `model` y `usage`; un `kind` desconocido "should be treated as normal usage" (`PI/docs/session-format.md` § UsageEntry);
  - `CompactionEntry.usage` y `BranchSummaryEntry.usage` son opcionales y no traen `provider` ni `model` (ídem);
  - `ToolResultMessage.usage` es opcional, sin modelo, y "contributes to full-session statistics" (`PI/docs/message-types.md` § ToolResultMessage);
  - ninguno de los cuatro trae `responseId`.
- **`cacheWarming`** vale `"streaming"` por defecto (`PI/docs/settings.md:19`): las entradas `usage` `cache_warm` aparecen sin configurar nada en proveedores elegibles. Con `"idle"`, también entre corridas.

### Probes del challenge (✓ probe, pi 0.99.1)

Del challenge de la revisión 1, con proveedor `faux`, `PI_CODING_AGENT_DIR` y `--session-dir` en scratch. Sin contenido de sesiones reales.

- **Fork y clone:** `pi --fork` y RPC `clone` copian con los mismos `id`, `timestamp`, `responseId` y `usage`. El header nuevo trae `parentSession` y un timestamp posterior, y el padre queda intacto (mismo inodo y tamaño).
  - Las entradas del mismo ms son comunes (system + user en el mismo ms; dos `toolResult` en el mismo ms). Un fork programático (`ctx.fork` en `agent_end`) puede caer en el mismo ms que su última copia.
- **`session_start` duplicado:** con `fork` y `new` en RPC llegan **dos** `session_start` por reemplazo y un solo `session_shutdown`. El modo interactivo no se probó.
- **`session_shutdown`** con `fork`/`new` llega con el `sessionId` del runtime **viejo**, legible (el `ctx` sigue activo).
- **Un `tool_call` que lanza** bloquea la tool sin aviso en `-p` (0 `tool_result`). `emit`, `emitBoundary` y `emitToolResult` sí atrapan.
- **Los handlers síncronos** que encolan y devuelven `undefined` no bloquean (11 eventos; `-p` terminó normal).
- **Orden:** `tool_execution_start` llega **antes** que `tool_call`. Los `tool_result` llegan en orden de fin, mientras el JSONL guarda los `toolResult` en orden de llamada.
- **Igualdades (G3):** `turn_end.messageEntryId` = `id` de la entrada `assistant`; `toolResultEntryIds` = ids de los `toolResult`; `toolCallId` del hook = `toolCall.id` = `toolResult.toolCallId`. También con `--no-session`. `compactionEntry.id` coincide por código, sin ejercitar.
- **Carga:** `<agentDir>/extensions/*.ts` carga sin `-e`, también en `-p`. `--no-extensions`/`-ne` la desactiva (los `-e` explícitos siguen cargando), y también un filtro `["!extensions/crow-ingest.ts"]` o `["-extensions/crow-ingest.ts"]` en `settings.json`.
- **Salida:** `print-mode` hace `process.exit(143)` en SIGTERM/SIGHUP, y `kill -9` no emite nada: no hay `session_shutdown`.
- **`model_select`** no se disparó con RPC `set_model`, aunque sí se escribió `model_change`.
- **`/compact`** con `faux` responde "Nothing to compact": el guion de B0 debe inflar el contexto.

### En el repo (`origin/main` `d1bae2a`, ✓)

- **`packages/core/src/store/store.ts`:**
  - `applyUsage` calcula `priced = computeCostUsd(usage)` **siempre**; un `costUsd` del adaptador se pisa;
  - `ingestInTx` hace dedupe `l:<lineHash>`, `s:<agent>:<semanticKey>` y `usageKey` (máximo por componente) con alcance **(source, sesión)**;
  - `ensureSession` deja la sesión en el proyecto `unresolved` hasta el primer evento con `cwd` y luego mueve sus eventos.
- **`packages/core/src/tailer/ingest.ts`:**
  - `resolveStartState` vuelve a 0 si cambió el inodo o el archivo encogió;
  - `lineHash` = sha1 de los bytes de la línea;
  - `DEFAULT_MAX_LINE_BYTES` = 16 MiB (`line-reader.ts`).
- **`packages/core/src/store/reconcile.ts`:**
  - `laneOf` reduce `hook:*` a `hook`;
  - `matchViolation` permite `match` en `turn.end` y lo prohíbe con `usage`;
  - precedencia transcript > hook > otel.
- **`packages/adapters/codex/src/map-line.ts`:** `historyStart` omite sin eventos las líneas heredadas (el precedente de R6).
- **`apps/server/src/adapters.ts`:** `ENGINE_ADAPTERS`. Registrar el adaptador con `fromHook` habilita `/ingest/hook/pi` (`ingest-route.ts`, la búsqueda del adaptador) y su carril en `LaneMonitor` (`app.ts`).
- **`apps/web`** no tiene literales de motor (`reduce/projects.ts` usa `e.engine`).
- **CLI:**
  - `packages/cli/src/attach-common.ts`: `Engine`, `buildContext`, `manifestPath`, `readManifest`, `writeConfig` (chequeo de carrera + `safeWrite`);
  - `fs-safe.ts`: `atomicWrite` usa el temporal `.<nombre>.crow-<pid>-<ts>.tmp` y `backupFile` va a `$CROW_HOME/backups/<engine>/`;
  - `hook-script.ts`: `generateHookScript` lee **solo** `$CROW_HOME/token`, en cada ejecución;
  - `doctor.ts`: `ENGINES`, `EngineReport` y `countJsonl`.
- **`packages/core/src/crow-event.ts`:** `EventKind` **no** tiene un kind de cambio de modelo.
- **`packages/core/src/api-types.ts`:** `IngestStats` = `semanticDuplicates`, `usageAnomalies`, `laneDuplicates`, `otelLateLinks` y `errorsByReason`. No hay contador de entradas desconocidas.
- **`fixtures/hygiene.test.ts`:** `PII_PATTERNS` (ids crudos `toolu_`/`msg_`/`req_`) y `anonymizedFixtureFiles` (solo `claude` y `codex`).
- **Estado de sesión:** `nextStatus` (`packages/core/src/store/store.ts:198`) pasa a `ended` solo con `session.end` (`store.ts:206`), y `sweepIdle` (`store.ts:1687`) solo lleva `live` → `idle`. Ningún carril de transcript emite `session.end` (`packages/adapters/claude/src/map-line.ts` y `packages/adapters/codex/src/map-line.ts`, sin coincidencias).
- **`matchViolation`** (`packages/core/src/store/reconcile.ts:328`) rechaza un evento con `usage` y `match`: el uso de una compactación o de un `toolResult` no puede ir en su `compact` ni en su `tool.post`.
- **El kind `usage` ya existe** (`crow-event.ts:32`). La web no lo pinta (`apps/web/src/lib/reduce/feed.ts:217`, `UNPAINTED`) y los reducers suman el `usage` de cualquier evento (`apps/web/src/lib/reduce/projects.ts:130`, `apps/web/src/lib/reduce/session.ts:57`). Hoy solo lo emiten los carriles OTel (`packages/adapters/claude/src/otel.ts:244`, `packages/adapters/codex/src/otel.ts:148`).
- **`applyUsage`** actualiza `sessions.model` solo si `usage.model` viene (`store.ts:519`) y guarda `{ ...usage, costUsd, weightedTokens }` (`store.ts:524`).
- **`stats()`** (`store.ts:1662`) arma `IngestStats` con un literal, y `apps/server/src/api.test.ts:172` compara `/api/stats` con un `toEqual` exacto.
- **`CrowConfig` literal** en `packages/cli/src/doctor.ts`, `packages/cli/src/doctor.test.ts`, `apps/server/src/app.test.ts`, `apps/server/src/otlp-server.test.ts`, `apps/server/src/api.test.ts` y `e2e/helpers.ts` (búsqueda de `codexHome:`).
- **Offsets:** `ingest_offsets` (`packages/core/src/store/migrations.ts:88`) guarda `inode`, `byte_offset` y `state_json`, sin huella de contenido.
  - `resolveStartState` (`packages/core/src/tailer/ingest.ts:140`) vuelve a 0 solo si cambió el inodo o el archivo es más corto que el offset.
  - `hasPersistedGrowth` (`packages/core/src/tailer/tailer.ts:129`) solo reprocesa al arrancar si el archivo creció.
  - Un paso lee a lo sumo `MAX_LINES_PER_STEP` = 1000 líneas (`ingest.ts:32`), y `restoreState` en `null` hace re-ingerir desde 0 (`packages/core/src/adapter.ts:142`).
- **Resume en F2a:** Claude y Codex mapean `SessionStart` `resume` a `session.start` **sin** clave (`packages/adapters/claude/src/hook.ts:124`, `packages/adapters/codex/src/hook.ts:117`).
- **Puerto grabado en F2a:** `generateHookScript` escribe `http://127.0.0.1:<port>` en el script (`packages/cli/src/hook-script.ts:33`) y `doctor` no compara ese puerto con `CROW_PORT` (`HooksConfigReport`, `packages/cli/src/doctor.ts:54`). `crowPort` sale de `CROW_PORT` o vale 7777 (`packages/core/src/config.ts:95`).
- **`trimInput`** exportado en `packages/adapters/claude/src/map-line.ts:124`; Codex tiene su copia privada (`packages/adapters/codex/src/hook.ts:29`).
- **`otherEngineHasOtlp`** (`packages/cli/src/attach-common.ts:453`) elige "el otro motor" con un ternario claude/codex.
- **Tests condicionales:** `test.skipIf` ya se usa en `packages/core/src/tailer/watch.test.ts:38`.
- **`scripts/tsconfig.json`** incluye `**/*.ts`: un script de B0 que importe paquetes de pi necesita un `exclude`.

---

## Qué existe hoy y qué se reusa

| Pieza existente | Uso en F2b | Por qué alcanza, o por qué no |
|---|---|---|
| Tailer F1 (`processFile`, offsets, líneas parciales, backfill) | Sin cambios | R1 pide las mismas reglas; pi escribe una línea por entrada con `"\n"` |
| `EngineAdapter` (`watchRoots`, `matches`, `parseLine`, `fromHook`) | Adaptador nuevo | Es el punto de extensión previsto |
| Dedupe `l:`, `s:` y `usageKey` | `semanticKey = entry:<id>:<n>`, `usageKey = resp:<id>` o `entry:<id>:<tipo>` | Protege relecturas, imports y la migración v2→v3 dentro de una sesión. **No** cruza sesiones: el fork lo resuelve D7 |
| Reconciliación D5 de F2a (`match`, roles, `revision`) | Sin cambios | Las claves exactas con ids nativos bastan |
| `applyUsage` y `pricing.ts` | **Cambio chico**: `engineCostUsd` | Hoy ignora el costo del motor (R4) |
| `LineResult` y `errorsByReason` | **Cambio chico**: `unknown` y `IngestStats.unknownEntries` | R7 pide un error por archivo y motivo más un conteo de todas las entradas |
| Cola de hooks y `/ingest/hook/:engine` (F2a D2, D3) | Sin cambios | Token, tope de 1 MiB, cuota por motor y 204 |
| `attach`/`detach` (unidades, manifiesto, `fs-safe`, diff, confirmación) | Se extienden a `pi` | Una sola unidad: el archivo |
| `hook-script.ts` (regla del token) | Se replica dentro de la extensión | La extensión hace el POST sin `curl` |
| `doctor` | Sección `pi` | `EngineReport` está modelado sobre hooks; pi reporta una extensión |
| `scripts/capture-receiver.ts` | Receptor de B0 | Ya graba peticiones con credenciales redactadas |
| Kind `usage` (hoy solo OTel) | Uso de `compaction`, `branch_summary`, `usage` y `toolResult` | No se pinta y se suma (`feed.ts:217`, `projects.ts:130`); `compact` y `tool.post` no pueden llevar uso (`reconcile.ts:328`) |
| `nextStatus` y `sweepIdle` | Sin cambios | `ended` solo con `session.end`, que da el carril B (D15) |
| `test.skipIf` (`watch.test.ts:38`) | Smoke opcional con pi real | CI no tiene pi (D10.8) |

## Drivers de decisión

Derivados de PLAN §2, los drivers de F2a y `CLAUDE.md`:

1. **Integridad sin doble conteo.** Una respuesta del modelo se cuenta una vez, con cualquier orden de llegada y aunque haya fork, clone, ramas o dos carriles (R4–R6, R9).
2. **Nunca romper al motor.** La extensión corre **dentro** de pi: no puede bloquear una tool, mostrar errores ni colgar un handler (PLAN §2.4; R11).
3. **Privacidad.** No sale contenido de la extensión (R10), y el carril A guarda lo mismo que los otros motores (R3; F1 D15).
4. **Pasivo primero.** El carril A funciona sin `attach`. B es una mejora (PLAN §2.2).
5. **Solo lectura sobre proyectos.** Nivel usuario, nunca `.pi/` del repo (PLAN §2.5; R13).
6. **Agnóstico de motor.** Lo específico de pi vive en su adaptador. Core solo gana contratos que sirven a cualquier motor (`engineCostUsd`, `unknownEntries`).
7. **Contrato de F1 y F2a intacto.** Claude y Codex no cambian de comportamiento.
8. **Simple de leer en 6 meses.** Sin dependencias de runtime nuevas; `any` prohibido.
9. **Escalera de reutilización**, como un driver más: patrón existente > extensión > abstracción nueva.

## Approach y opciones

### Eje 1 — Historia copiada en fork, clone y `--fork` (R6)

- **Peldaño 1, patrón existente (elegido).** Omitir la historia heredada en el adaptador, como `historyStart` de Codex.
  - pi no marca el prefijo copiado, pero lo deja reconocible en el propio archivo. Las copias se escriben **juntas y primero**, justo después del header (`_rewriteFile` en `createBranchedSession`; bucle de `appendFileSync` en `forkFrom`), y conservan su `timestamp`, que es de antes del fork. Las entradas nuevas llegan después, con `new Date()`.
  - Regla (D7): con `parentSession` en el header, el **prefijo contiguo** de entradas con `ts ≤ header.ts` es heredado, y la primera entrada con `ts > header.ts` cierra el prefijo para siempre. Lo heredado no emite eventos ni uso.
  - Es puro, independiente del orden (el fork puede ingerirse antes que el padre) y no toca core.
  - *Descartado dentro del peldaño:* `ts < header.ts` estricto (revisión 1). Duplica uso cuando la última copia cae en el mismo ms que el header, algo común con un fork programático. Además, un reloj que retrocede después de la primera entrada propia la haría pasar por heredada (challenge §1).
  - Reversión: barata.
- **Peldaño 2, extensión (descartado).** Dedupe de `usageKey = resp:<responseId>` con alcance de motor, no de sesión.
  - Cambia el alcance del dedupe en core.
  - Atribuye el dinero al **primer** archivo ingerido: si el fork llega antes, le roba el costo al padre.
  - No cubre respuestas sin `responseId` (1 de 116 en la muestra del scout).
- **Peldaño 3, abstracción nueva (descartado).** Linaje de sesiones en el store: vínculo padre→hijo más un índice de ids de entrada, para restar lo copiado.
  - Necesita que el padre esté ingerido o una reconciliación diferida.
  - Suma una tabla sin otro consumidor que R6.

### Eje 2 — Cómo se instala la extensión (R8, R13)

- **A (elegido).** Un archivo generado en `<piAgentDir>/extensions/crow-ingest.ts`.
  - Es la ubicación documentada para extensiones personales, sin confianza de proyecto.
  - Una sola unidad y un solo archivo escrito. `settings.json` no se toca.
  - Reversión: borrar el archivo.
- **B (alternativa genuina, descartada).** Código en `$CROW_HOME/pi/crow-ingest.ts` más una entrada en `settings.json` `extensions`.
  - A favor: crow podría reescribir el código sin tocar la config de pi (como el script de hooks de F2a).
  - En contra:
    - edita un archivo que pi reescribe con read-modify-write bajo un lock que crow no puede tomar (`persistScopedSettings`): una edición concurrente de `pi config` sobre `extensions` perdería la entrada de crow;
    - R15 bloquearía la instalación por cualquier rotura ajena en `settings.json`;
    - son dos artefactos en lugar de uno.
  - Reversión: barata en ambos casos.
- **C (descartado).** `pi install <ruta>`: no hay diff, backup ni confirmación propios (R13), exige el binario `pi` y escribe `packages` en `settings.json`.

### Eje 3 — Cuándo emite el carril A el `turn.end` (R3, R9)

- **Al cerrar el turno (elegido).** El turno de pi es "una respuesta del asistente más sus tool results" (`PI/docs/json.md`), igual que `turn_end`, que llega **después** de los tools.
  - Si el carril A lo emitiera al ver la línea del asistente, y el tailer llega antes que el hook, el hecho tomaría un `id` anterior a sus `tool.post` y el timeline mostraría "Fin de turno" antes de que corran sus tools. Con B primero, al revés: el orden dependería del carril.
  - El adaptador guarda un turno abierto (el id de la entrada del asistente y sus `toolCallId` pendientes) y emite al llegar el último `toolResult`, o en la misma línea si el asistente no pidió tools. Es estado chico, persistido y puro.
- **En la línea del asistente (descartado):** es la lectura literal de "its end", pero el orden del timeline pasa a depender del carril que llega primero.

### Eje 4 — Costo reportado por el motor (R4)

Solo hay una opción viable: `CrowEventUsage.engineCostUsd`, que `applyUsage` respeta.

- *Descartado:* meter los modelos de pi en `pricing.ts`. Hay proveedores propios sin precio público, tramos (`ModelCost.tiers`), y R4 prefiere el número de pi.
- *Descartado:* guardar el costo de pi en `reported`. F2a D6 dice que `reported` nunca se suma, así que no cumple R4.

**Dónde va el uso que no es del asistente** (R4 ampliado, Q5):

- **Evento `usage` propio (elegido).** El kind `usage` ya existe (`crow-event.ts:32`), la web no lo pinta (`feed.ts:217`) y los reducers suman su `usage` (`projects.ts:130`). Es lo mismo que ya hace core con el uso de OTel promovido.
- *Descartado:* ponerlo en el `compact` o el `tool.post` de la misma entrada. Esos eventos llevan `match`, y `matchViolation` (`reconcile.ts:328`) rechaza `usage` junto con `match`.
- *Descartado:* un `assistant.message` sin texto. Se pintaría como una "Respuesta" vacía y no es una respuesta del asistente.
- *Descartado:* un kind nuevo. No tiene consumidor que el kind `usage` no cubra.

---

## Components

- **`packages/adapters/pi/` (`@crow/adapter-pi`, nuevo; workspace `packages/adapters/*`).**
  - `src/adapter.ts`: `piAdapter: EngineAdapter<PiState>` (`watchRoots`, `matches`, `initialState`, `restoreState`, `parseLine`, `fromHook`). Cubre R1, R2 y R17.
  - `src/map-line.ts`: mapa del carril A, turno diferido (D4), historia heredada (`inheritedEntry`, D7), versión y tipos desconocidos (D8), y una copia de `trimInput` (`packages/adapters/claude/src/map-line.ts:124`). Cubre R2, R3 y R5–R7.
  - `src/usage.ts`: `toCrowUsage` y `usageKeyFor`, para el asistente y para `compaction`, `branch_summary`, `usage` y `toolResult` (D5). Cubre R4.
  - `src/hook.ts`: `piFromHook`, que valida el sobre y mapea el carril B con las claves de inicio de sesión de D12. Cubre R8 y R9.
  - `extension/crow-ingest.ts`: **plantilla** de la extensión. Es TS plano, sin imports salvo `node:`; exporta `createCrowExtension(deps)` y, por defecto, la factory. Cubre R8 y R10–R12.
  - `src/render-extension.ts`: `renderPiExtension({ port, tokenFile })` reemplaza **solo** el bloque de configuración marcado, y `parseExtensionConfig(text)` lo lee de vuelta (D9, D13, D14). Cubre R13, R14 y R16.
  - `extension/testing/fake-pi.ts`: harness que simula `pi.on`, el `ctx` (incluido uno caducado que lanza) y `fetch`. Cubre R8 y R10–R12.
- **`packages/core`:**
  - `crow-event.ts`: `EngineId` gana `"pi"`; `CrowEventUsage.engineCostUsd?`; `IngestErrorReason` gana `"unsupported-version"`; `EventKind` gana `"model.change"` y `CrowEvent` gana `model?` (Q2); el JSDoc del kind `usage` pasa a cubrir el uso de entradas del motor. Cubre R3, R4, R7 y R17.
  - `adapter.ts`: `CrowConfig` gana `piAgentDir` y `piSessionDir`; `LineResult` (ok) gana `unknown?: true`. Cubre R1 y R7.
  - `config.ts`: resuelve las dos rutas (R1).
  - `store/store.ts`: `applyUsage` usa `engineCostUsd ?? computeCostUsd(usage)`; `ingestBatch` suma `unknown_entries` en la misma transacción; `stats()` lo expone (R4, R7).
  - `tailer/ingest.ts`: `processFile` acumula los `unknown` del paso y los pasa al batch (R7).
  - `api-types.ts`: `IngestStats.unknownEntries` (R7).
- **Tests existentes que cambian por contrato (sin cambio de comportamiento):**
  - `apps/server/src/api.test.ts:172`: el `toEqual` exacto de `/api/stats` gana `unknownEntries: 0` (challenge §5);
  - los literales de `CrowConfig` (§ Evidencia, "`CrowConfig` literal") ganan `piAgentDir` y `piSessionDir`.
- **`apps/server/src/adapters.ts`:** `bindAdapter(piAdapter)` (R17). No cambia nada más del servidor.
- **`apps/web`:** `KIND_LABELS` y `describeEvent` para `model.change` (`apps/web/src/lib/reduce/feed.ts`, R3). R17 no necesita más: la web ya es agnóstica y el kind `usage` ya se suma sin pintarse.
- **`packages/cli`:**
  - `attach-common.ts`: `Engine` gana `"pi"`; `buildContext` resuelve `configPath` = el archivo de la extensión; `Manifest.created.extensionsDir?`; `otherEngineHasOtlp` nunca elige a `pi`, que no tiene carril OTLP (R13–R15);
  - `pi-config.ts` (nuevo): `planPiAttach`, `planPiDetach` e `inspectPiInstall`, puros (R13–R16);
  - `attach.ts`/`detach.ts`: una rama para `pi` sin script de hooks ni OTLP (R13, R14);
  - `doctor.ts`: sección `pi` (R16).
- **`fixtures/pi/` y `scripts/anonymize/pi.ts`:** fixtures anonimizadas de B0 y extensión de `fixtures/hygiene.test.ts` (R18).
- **`scripts/b0-pi/`:** protocolo, extensión de captura y proveedor `faux` (§ B0). `faux-provider.ts` queda fuera de `tsc` con un `exclude` en `scripts/tsconfig.json`: sus imports los resuelve el alias de jiti de pi.
- **`e2e/pi-smoke.test.ts`:** carga real con pi, opcional (D10.8).
- **`scripts/pi-api-drift.ts`:** chequeo manual, fuera de CI, de los campos que la extensión lee contra el `types.d.ts` instalado (D10).

---

## Decisions

### D1 — Layout (R1–R18)

- La plantilla de la extensión vive en `@crow/adapter-pi`, no en la CLI. Es conocimiento del motor y es el **productor** del contrato que consume `piFromHook`, así que productor y consumidor se prueban juntos (PLAN §2.1; F2a D1).
- La CLI solo la renderiza e instala.
- La plantilla no importa nada del repo: corre dentro de pi. Un test lo impide (D10).
- *Reversión:* barata.

### D2 — Raíz, descubrimiento e identidad (R1, R2)

- **`config.ts`:**
  - `piAgentDir = PI_CODING_AGENT_DIR` (con `~` expandido) o `~/.pi/agent`;
  - `piSessionDir = PI_CODING_AGENT_SESSION_DIR` (con `~` expandido) o `<piAgentDir>/sessions`.

  Es la precedencia literal de R1, la misma que aplica pi entre sus variables de entorno (`PI/dist/main.js`, `PI/dist/config.js` `getAgentDir`).
- **`watchRoots`** = `[piSessionDir]`.
- **`matches(path, root)`** acepta un `*.jsonl` a profundidad 1 (plano: `sessionDir` propio) o 2 (`--<cwd>--/…`), y rechaza lo demás.
  - `FileMatch.sessionId` = el sufijo `_<id>` del nombre si existe. Es **provisional** y solo sirve para atribuir un error antes del header.
  - Un import puede renombrar con `-1` (`importFromJsonl`); para el resto manda el header.
- **Identidad (R2).** La primera línea debe ser `type: "session"` con `id` string, igual que en pi (`loadEntriesFromFile`), y con un `timestamp` legible, que pi siempre escribe (`newSession`) y D7 necesita.
  - La sesión = `header.id`. El proyecto = `header.cwd` por `projectKey` (F1 D8).
  - El directorio nunca se decodifica.
  - Si el header es inválido: **un** `ingest.error bad-shape` para el archivo y ninguna línea se ingiere. Sin `id`, pi tampoco lo considera sesión; sin `timestamp` legible es un caso que pi no produce.
- **Estado `PiState`** (§ Contracts), persistido en `state_json`. `restoreState` rechaza un `v` distinto: se re-ingiere desde 0 y el dedupe evita duplicados.
- *Reversión:* barata.

### D3 — Mapa del carril A (R3)

La tabla está en § Mapa del carril A. Reglas:

- **Lo que se guarda es lo mismo que en los otros motores (F1 D15):**
  - `text` ≤ 8 KiB (bloques `text` del `user` y del `assistant`);
  - `tool.input` recortado con una copia de `trimInput` (`packages/adapters/claude/src/map-line.ts:124`; Codex tiene la suya en `packages/adapters/codex/src/hook.ts:29`), porque no hay un helper compartido en core;
  - texto de `tool.error` ≤ 1 KiB (bloques `text` del `toolResult` con `isError`);
  - **nunca** `thinking`, la salida de tools, `details`, `system.sections`, `bashExecution.output`, `parentSession` (una ruta) ni `errorMessage` del asistente.
- **Agente:** siempre el principal (`agentId: null`). pi no persiste subagentes: el ejemplo `subagent` lanza procesos `pi --no-session` (NOT in scope).
- **`semanticKey`:** `header` para el header; `entry:<entryId>:<n>` para el evento n de una entrada; `turn:<assistantEntryId>` para el `turn.end` diferido.
- **Tipos y roles conocidos que no producen evento** (no son "desconocidos" para R7):
  - `thinking_level_change`, `session_info`, `label`, `custom`, `custom_message` y `context_edit`;
  - los roles `system`, `bashExecution`, `custom`, `branchSummary` y `compactionSummary`.
- **Tipos que solo producen uso:** `usage` y `branch_summary` → un evento `usage` si traen uso (D5); si no, nada.
- **`model_change`** → `model.change` (Q2, D17).
- *Reversión:* barata hacia guardar más; imposible para lo ya ingerido.

### D4 — Turno diferido (R3, R9)

- **`PiState.openTurn`** = `{ entryId, ts, ok, category, pending: toolCallId[] } | null`.
- **Una línea `assistant`:**
  - si trae bloques `toolCall`, abre el turno con esos ids pendientes;
  - si no, emite `turn.end` en la misma línea.
- **Un `toolResult`** quita su `toolCallId` de `pending`. Si queda vacío, emite `turn.end` con `ts` del `toolResult` y `match turn-end:<entryId>`.
- **Una línea `assistant` con un turno todavía abierto** (pi se cayó antes de persistir los resultados) cierra el anterior con su `ts` conocido.
- **Un turno que queda abierto al final del archivo** no emite nada. Si el carril B lo entregó, el hecho existe igual.
- **`turn.ok`** = `stopReason ∉ {error, aborted, length}`. `category` = `stopReason` cuando no es ok. `toolUse`, `stop` y `deferred` son ok (`PIAI` `StopReason`).
- **Carril B:** `turn_end` → `turn.end` con la misma clave (`messageEntryId`) y el mismo cálculo de `ok` desde `message.stopReason`.
- *Reversión:* barata.

### D5 — Uso y costo (R4)

Se cuenta todo el uso que pi suma a sus totales (Q5), para que los tokens de una sesión coincidan con los de pi.

- **Qué entradas traen uso y a qué evento van:**

  | Entrada | Evento | `usageKey` | `model` |
  |---|---|---|---|
  | `message` `assistant` | `assistant.message` | `resp:<responseId>`; sin él, `entry:<id>:assistant` | `responseModel ?? model` |
  | `message` `toolResult` con `usage` | `usage` (además de su `tool.post`) | `entry:<id>:toolResult` | ninguno |
  | `compaction` con `usage` | `usage` (además de su `compact`) | `entry:<id>:compaction` | ninguno |
  | `branch_summary` con `usage` | `usage` | `entry:<id>:branch_summary` | ninguno |
  | `usage` (`cache_warm` u otro `kind`) | `usage` | `entry:<id>:usage` | `model` de la entrada |

  - El sufijo de tipo hace legible la clave y evita choques entre espacios de ids. El alcance (source, sesión) de F1 convierte `entry:<id>:<tipo>` en el "session id and entry id" de R4.
  - El `semanticKey` del evento `usage` es `entry:<id>:<n>`, como el de cualquier evento de una entrada (D3).
  - Un `kind` desconocido de `usage` se cuenta igual, como pide la doc de pi.
  - Un uso que no es del asistente con todos los componentes y `cost.total` en 0 no produce evento.
  - Las entradas heredadas de un fork no producen nada (D7): su uso no se cuenta dos veces.
- **Mapeo de `Usage`:**
  - `input`, `output`, `cacheRead`;
  - `cacheCreation = cacheWrite`;
  - `cacheCreation1h = cacheWrite1h` (los dos son subconjuntos: `PIAI` `Usage`, `CrowEventUsage`);
  - `reasoning` no se suma, porque ya está en `output`.
- **`model` solo cuando la entrada lo nombra.** `compaction`, `branch_summary` y `toolResult.usage` no traen modelo (§ Evidencia). Inferirlo del modelo de la sesión valoraría mal un resumen o una tool que usan otro modelo (`custom-compaction.ts`, el clasificador de `codemode` en `PI/docs/models.md`). Sin modelo, `applyUsage` tampoco pisa `sessions.model` (`store.ts:519`).
- **Costo:**
  - el adaptador pone `engineCostUsd = usage.cost.total` **solo si es > 0**;
  - `applyUsage` usa `usage.engineCostUsd ?? computeCostUsd(usage)`: con 0 o sin `cost`, cae a la tabla (`priceFor(model)`); sin modelo, el costo queda indefinido y suma `t_unpriced` (F1 R20);
  - la tabla de crow no tiene dimensión de proveedor: la búsqueda es por modelo ([assumed], Q6);
  - el camino del delta de `usageKey` (`deltaUsage = { ...delta, model }`) no lleva `engineCostUsd` y cae a la tabla. Solo afecta a respuestas que crecen bajo el mismo `responseId` (residual);
  - Claude y Codex nunca ponen `engineCostUsd`, así que no cambian (driver 7). `store.ts:524` guarda `engineCostUsd` dentro del JSON del evento de pi: es aditivo.
- **Coincidencia con pi:** los tokens coinciden siempre. El costo coincide en toda llamada que pi valora (`cost.total > 0`). Con `cost.total = 0` y un modelo que la tabla de crow sí valora, crow muestra más que pi, porque R4 lo pide así.
- **`cacheWarming`:** con el valor por defecto (`"streaming"`) las entradas `usage` `cache_warm` aparecen sin configurar nada, y se cuentan como las demás. Con `"idle"` hay calentamientos entre corridas: son eventos, así que la sesión vuelve a `live` sin actividad del usuario (§ Failure modes).
- **La unidad es USD** (✓ doc, § Evidencia).
- **`usageCallKey` no se usa.** pi no tiene carril OTel y el carril B nunca trae uso (R10). `reconcileTranscriptUsage` marca `tu_unkeyed` en la sesión, sin efecto: no hay filas `otel_usage` de pi.
- **Si una misma respuesta aparece en dos entradas** de la sesión (una respuesta `deferred` completada después con el mismo `responseId` ⚠), el máximo por componente de F1 cuenta solo el delta.
- *Reversión:* media. `engineCostUsd` es un campo nuevo de contrato; quitarlo cambia el costo de pi en adelante, no el ya contado.

### D6 — Ramas (R5)

- **No requiere lógica propia.** `/tree` solo agrega entradas (`branch`, `branchWithSummary`), y el tailer lee cada línea una vez, así que cada respuesta de cualquier rama se cuenta una vez por su `usageKey`.
- **La hoja activa no se necesita.** Si hiciera falta, es la última entrada del archivo, lo mismo que asume pi al cargar (`_buildIndex`).
- **Varios hijos de un mismo `parentId` y varias raíces** son normales (`getTree` los tolera). El adaptador no valida el árbol.
- *Reversión:* barata.

### D7 — Fork y clone (R6)

- **Señal.** Con `header.parentSession` presente (la ruta no se guarda, solo el booleano), las copias forman el **prefijo** del archivo. pi las escribe juntas justo después del header y antes de cualquier entrada nueva (`_rewriteFile` en `createBranchedSession`; bucle de `appendFileSync` en `forkFrom`), y conservan un `timestamp` anterior o igual al del header (✓ probe).
- **Regla.** `PiState.inheriting` arranca en `true` si el header trae `parentSession`. Para cada entrada, en orden de archivo:
  - si `inheriting` y `Date.parse(entry.timestamp) ≤ headerTs` → **heredada**: no produce eventos ni uso (precedente `historyStart` de Codex);
  - si no → `inheriting = false` para siempre, y la entrada se mapea normal;
  - una entrada sin `timestamp` legible mientras `inheriting` sigue siendo heredada y no cierra el prefijo (con un `bad-shape` por archivo). Ante la duda, nunca duplica dinero.
  - El `session.start` del header sí se emite. El archivo es su propia sesión (R6).
- **Por qué `≤` y el prefijo:**
  - *Empate de ms.* La última copia puede tener el mismo ms que el header, por ejemplo con un `ctx.fork` en `agent_end` (challenge §1). Con `≤` es heredada. Una entrada **nueva** con uso en el mismo ms que el header exigiría una respuesta del modelo en menos de 1 ms.
  - *Reloj que retrocede después de la primera entrada propia.* El prefijo ya está cerrado, así que la entrada se cuenta.
  - *Entradas automáticas del mismo ms.* `newSession({ parentSession })` (fork desde el primer mensaje, sin copias) agrega `model_change` y `thinking_level_change` enseguida (`PI/dist/core/sdk.js`). Si caen en el mismo ms del header, se toman por heredadas. Solo se pierde ese `model.change`, nunca uso.
- **Residuales, fijados por test** (`fork.test.ts`):
  - *Reloj que retrocede entre el fork y la primera entrada propia:* esas entradas pasan por heredadas hasta la primera con `ts > headerTs`. Sub-cuenta; nunca duplica.
  - *Copia con reloj adelantado en medio del prefijo* (el padre se escribió con un reloj adelantado respecto del fork): cierra el prefijo antes de tiempo y las copias siguientes se cuentan en el fork. Duplica solo si este crow también ingirió el padre.
- **Cubre** `/fork` (camino raíz→padre del mensaje elegido), `/clone` (rama activa entera), `--fork` (todas las ramas del origen), `ctx.fork` y `newSession({ parentSession })` (sin copias: el prefijo se cierra en la primera entrada propia).
- **Independiente del orden.** Da igual si el padre se ingiere antes, después o nunca (por ejemplo, fuera de la ventana de backfill): el dinero de lo heredado pertenece al padre. La regla es pura sobre el orden del archivo, así que una relectura desde 0 da el mismo resultado.
- **Timeline (Q8).** La historia heredada no se muestra en el fork: mostrarla duplicaría hechos entre sesiones.
- **R5 en un fork con ramas.** `--fork` copia todas las ramas del origen. R5 exceptúa "the entries inherited from a parent session under R6": las ramas heredadas no se cuentan ni se muestran, y las ramas propias del fork se cuentan una vez como en cualquier archivo (D6).
- *Descartado:* reconocer las copias por los ids del padre. `parentSession` es una ruta, y el método exige que el padre esté ingerido (peldaño 3 del Eje 1).
- **`importFromJsonl`** (mismo `id`, segundo archivo): las líneas idénticas se descartan por `l:` y, si difieren, por el `semanticKey` `entry:<id>:<n>`.
- *Reversión:* barata.

### D8 — Versiones, tipos desconocidos y reescrituras (R7)

- **Header con `version ≠ 3`:** se sigue ingiriendo y se emite un `ingest.error unsupported-version` (motivo nuevo, aditivo). Detalle: la versión.
  - Las entradas v2 se mapean igual: `hookMessage` es un rol conocido sin evento.
  - Las v1 no tienen `id` ni `parentId`: sin `semanticKey`, sin claves de reconciliación y con `usageKey` solo si hay `responseId` (mejor esfuerzo).
- **`type` o `message.role` desconocidos:**
  - la línea devuelve `ok: true`, `events: []`, `unknown: true`;
  - la **primera** vez por archivo y motivo agrega un `warnings: [{ reason: "unknown-type", detail: "<type o role>" }]`, y el pipeline lo convierte en `ingest.error`;
  - `PiState.warned` recuerda los motivos ya reportados;
  - el tailer suma los `unknown` del paso e `ingestBatch` incrementa `ingest_stats.unknown_entries` en la **misma** transacción; se expone como `IngestStats.unknownEntries`.
  - Una relectura desde 0 vuelve a contar: el contador mide líneas leídas, no entradas distintas (documentado).
- **Reescritura por migración** (`_loadEntries` → `_rewriteFile`, al reabrir en pi un archivo v1 o v2; `migrateToCurrentVersion` en `PI/dist/core/session-manager.js`):
  - **v2→v3** conserva los ids y el largo del header (`"version":2` → `3`). Solo encoge si hay roles `hookMessage` (pasan a `custom`: 5 bytes menos cada uno).
    - Mismo tamaño: el offset sigue alineado y lo nuevo se lee bien.
    - Más corto y sin crecer antes del siguiente paso del tailer: vuelve a 0 (`resolveStartState`, `ingest.ts:140`), y el dedupe `l:` o `entry:<id>:<n>` evita duplicados.
    - **Más corto y crecido por encima del offset viejo antes del siguiente paso** (crow apagado mientras pi reabre la sesión, o el `thinking_level_change` que pi agrega al reabrir una sesión vieja): el tailer lee desde la mitad del contenido. Resultado: a lo sumo un `invalid-json` y la pérdida de las entradas nuevas que caen en los primeros 5·k bytes. **Residual aceptado** (challenge §2).
  - **v1→v2** además cambia todos los ids (`migrateV1ToV2` los genera al azar). A lo anterior se suman eventos duplicados, y uso duplicado cuando no hay `responseId`. **Residual aceptado.**
  - **Por qué no se mitiga en F2b:** el censo tiene 0 archivos v1 o v2, y pi solo los reescribe al reabrir una sesión vieja.
    - Una huella de la primera línea junto al offset haría volver a 0 en los dos casos. Pero `ingest_offsets` (`migrations.ts:88`) no tiene dónde guardarla: sería una migración de esquema y un cambio del tailer para todos los motores. Queda como mejora si aparecen archivos v1/v2.
    - *Descartado:* que `restoreState` rechace el estado de un archivo v1/v2. Con más de `MAX_LINES_PER_STEP` líneas (`ingest.ts:32`), cada paso volvería a 0 y el tailer nunca pasaría del primer bloque.
- *Reversión:* barata.

### D9 — Extensión: distribución y generación (R8, R13)

- **Archivo** `<piAgentDir>/extensions/crow-ingest.ts`, modo 0600. El nombre sigue a `crow-ingest-hook` y evita choques con una extensión `crow.ts` del usuario.
- **Generación:** `renderPiExtension` toma la plantilla y reemplaza un único bloque marcado:

  ```ts
  // >>> crow config (generated by `crow attach pi`) >>>
  const CROW_PORT: number = 7777;
  const CROW_TOKEN_FILE: string = "/Users/u/.crow/token";
  // <<< crow config <<<
  ```

  El valor string se escribe con `JSON.stringify`. El puerto y la ruta del token quedan grabados, igual que en `generateHookScript` (`hook-script.ts:33`).
- **Si el usuario cambia `CROW_PORT` o `CROW_HOME` después de `attach`**, la extensión sigue mandando al puerto viejo o leyendo el token viejo. El carril B queda mudo (o recibe 401) sin error visible, por R11.
  - `doctor` lo detecta: lee el bloque con `parseExtensionConfig` y lo compara con `crowPort` y con `$CROW_HOME/token` actuales (D14).
  - La salida es volver a correr `crow attach pi`: el archivo lleva el marcador y difiere, así que `attach` muestra el diff, pide confirmación y hace backup (D13). Luego hay que reiniciar pi o usar `/reload`.
  - *Descartado:* que la extensión lea el puerto de la config de crow en cada lote. Acopla la extensión al formato de `config.json` de crow y al entorno de pi, que no es el de crow; F2a tampoco lo hace.
- **Marcador** en la primera línea: `// crow-ingest: generated by crow attach pi (crow-pi-extension/1). Remove with: crow detach pi`. Permite reconocer el archivo sin manifiesto (D13).
- **Carga:** pi no recarga en caliente. `attach` termina con "Reinicia pi o usa /reload en las sesiones abiertas".
- **Backups y temporales:**
  - los backups van a `$CROW_HOME/backups/pi/` (`backupFile`), nunca al directorio de extensiones, donde pi cargaría cualquier `.ts`;
  - el temporal de `atomicWrite` termina en `.tmp`, que `FILE_PATTERNS` no carga.
- *Reversión:* barata: `crow detach pi`.

### D10 — Extensión: runtime a prueba de fallos (R11)

Reglas de la plantilla, cada una contra un riesgo de § Evidencia:

1. **Handlers síncronos, nunca lanzan y siempre devuelven `undefined`.**
   - Cada handler es `(event, ctx) => { try { enqueue(build(event, ctx)); } catch { /* swallow */ } }`.
   - `tool_call` nunca devuelve `{ block }`; `tool_result` y `turn_end` nunca devuelven modificaciones.
   - Así la extensión suma ~0 ms al handler. El único que espera es `session_shutdown` con `reason: "quit"`: `await Promise.race([drain(), sleep(1000)])` dentro del `try`, así que suma ≤ 1 s. R11 permite 2 s.
2. **`ctx` se lee síncrono y nunca se captura.** `build` extrae los campos del allowlist dentro del handler. Los getters de un `ctx` caducado lanzan (`assertActive`) y quedan dentro del `try`.
3. **Cola acotada con un solo emisor.**
   - Tope de 500 eventos: al llenarse, se descartan los nuevos y se cuenta `dropped`.
   - Un emisor perezoso arranca con el primer `enqueue`, no en la factory (guía de pi), y manda lotes de ≤ 50 eventos en orden con `fetch(url, { method: "POST", signal: AbortSignal.timeout(2000) })`.
   - Un fallo (conexión, timeout, 401, 413, 5xx) **descarta el lote sin reintento**, como los hooks de F2a.
   - Con crow colgado, cada lote tarda 2 s, la cola llega al tope y descarta. Memoria y sockets quedan acotados.
   - *Descartado:* un `fetch` por evento en paralelo, sin tope de sockets ni de memoria con crow colgado.
4. **Sin rechazos sin manejar.** Node termina el proceso ante un `unhandledRejection` por defecto. Toda promesa del emisor termina en `.catch(() => {})`: `fetch` que lanza síncrono, respuesta que no es `Response` y lectura del token que falla. El cuerpo de la respuesta se cancela (`res.body?.cancel()`).
5. **`sleep` del flush de salida con `unref()`,** para no retrasar la salida de pi.
6. **Registro defensivo.** Cada `pi.on(name, …)` va dentro de su propio `try`: si una versión futura rechaza un nombre, la factory no falla. Un error de carga de jiti sí sería visible; lo previenen la plantilla en TS plano (sin `enum`, `namespace`, decoradores ni imports de paquetes), `load.test.ts` y el smoke con pi real (D10.8).
7. **Si pi cambia la API:**
   - los campos se leen con `typeof` y un campo ausente se omite;
   - `piFromHook` **descarta** un evento de tool o de turno sin su id y agrega un `warning bad-shape`. Una API cambiada se ve como `ingest.error`, nunca como hechos duplicados sin clave;
   - `doctor` muestra el último evento recibido;
   - `scripts/pi-api-drift.ts` (manual) compara los campos leídos contra el `types.d.ts` instalado cuando pi se actualiza.
8. **Cómo se prueba la carga real.** `extension/load.test.ts` importa la plantilla con **Bun**, que no es jiti ni Node: prueba la sintaxis, los imports y el registro, no la carga dentro de pi.
   - La carga real la prueba `e2e/pi-smoke.test.ts`: `pi -ne -e <plantilla renderizada> -e scripts/b0-pi/faux-provider.ts --provider faux --model faux-1 -p <prompt> --session-dir <tmp>`, con `PI_CODING_AGENT_DIR=<tmp>` y un receptor local. `-ne` apaga el descubrimiento de extensiones y los `-e` explícitos siguen cargando (✓ probe), así que el test no depende de `~/.pi`.
   - Asserts: pi sale con 0, stderr sin rastro de la extensión y el receptor recibe `session_start` y `tool_call`. Con el receptor abajo, lo mismo pero sin sobres.
   - Es **opcional** (`test.skipIf` salvo `CROW_PI_SMOKE=1` y `pi` en el PATH; precedente en `watch.test.ts:38`), porque CI no tiene pi. Se corre a mano en B3.T3 y en cada actualización de pi, y el resultado va a la bitácora (G7).

*Reversión:* barata.

### D11 — Extensión: payload, allowlist y token (R10, R12)

- **Sobre** `{ v: 1, events: PiHookEvent[], dropped?: number }`. Cada evento lleva:
  - `e`: nombre del evento de pi;
  - `ts`: `Date.now()` de la extensión, o `turn_start.timestamp`;
  - `sessionId`: `ctx.sessionManager.getSessionId()`;
  - `cwd`: `ctx.cwd` (Q4);
  - `leafId`, solo en `session_start`: `ctx.sessionManager.getLeafId()`, un id de entrada (R10, D12). `getLeafId` está en `ReadonlySessionManager` (`PI/dist/core/session-manager.d.ts`);
  - los campos del allowlist exacto de § Contracts (alineado con R10), **y nada más**.
- **No se envían:**
  - `input`, `args`, `content`, `result`, `details`, `message` (salvo `message.stopReason`), `messages`, `toolResults`, `structuredContent`, `usage`;
  - el objeto `Model` (trae `headers` y `baseUrl`), `getSessionFile()` (una ruta) ni `previousSessionFile`/`targetSessionFile`.
- **Enums cerrados** (`reason`, `source`, `stopReason`) sí van: son calificadores del evento, no contenido. Es una lectura explícita de R10 (Q4).
- **Tiempos de tool (`ms`).** La extensión guarda `Map<toolCallId, ts>` en `tool_execution_start`, con tope de 1024 y limpieza en `end`. Envía `durationMs` en `tool_execution_end` → `tool.ms` con `msSource: "engine"`: es tiempo medido en el proceso de pi, más fiel que la recepción (F2a D7).
- **Token (R12), la misma regla que `generateHookScript`.**
  - Se lee `CROW_TOKEN_FILE` con `fs/promises.readFile` **en cada lote**, dentro del emisor, nunca en un handler.
  - Si hay contenido: `Authorization: Bearer <token>`. `CROW_TOKEN` del entorno de pi no se usa, igual que el script ([assumed], Q9).
- **Tamaño.** Un lote de 50 eventos ocupa unos 20 KB, muy por debajo del 1 MiB de F2a D3.
- *Reversión:* barata.

### D12 — Mapa del carril B y reconciliación (R8, R9)

Las tablas están en § Mapa del carril B y § Reconciliación.

- **Roles.** `tool_call`/`tool_result` usan `hook`; `tool_execution_start`/`tool_execution_end` usan `hook:exec`. Así las **dos** contribuciones de B se funden en el mismo hecho (D5 de F2a descarta un segundo aporte del mismo rol).
- **El inicio de sesión siempre lleva clave.** pi emite **dos** `session_start` por reemplazo con `fork` y `new` en RPC (✓ probe), y un segundo aporte sin clave sería otro hecho.
  - `startup`, `new` y `fork` → `session-start@main` (rol `hook`): se funden con el header y entre sí; el segundo cuenta en `laneDuplicates`.
  - `resume` → `session-start@resume:<leafId>`, donde `leafId` es la hoja de la sesión al reanudar. Dos `session_start` del mismo `resume` traen la misma hoja y se funden. Dos reanudaciones con actividad entre medio tienen hojas distintas y quedan como dos hechos. Dos reanudaciones sin ninguna entrada entre medio se funden, porque no pasó nada entre ellas. Sin `leafId`, la clave es `session-start@resume`.
  - Difiere de F2a, donde `resume` va sin clave (`claude/src/hook.ts:124`), porque pi sí duplica el evento.
  - El `startup` de una sesión que ya existía (`pi -c`, `--session`) se funde con el inicio original y no muestra un segundo inicio. La sesión vuelve a `live` por sus eventos.
  - *Descartado:* deduplicar en la extensión. Depende de si pi recrea la instancia de la extensión al reemplazar el runtime, y eso no está verificado.
- **`reload`** en `session_start` y `session_shutdown` se reenvía y da `[]` (R8): recarga el runtime de extensiones, no la sesión. Lo mismo `turn_start`, `agent_end` y `model_select` (Q3).
- **Llamadas anidadas** (`parentToolCallId` presente): nunca están en el transcript (`ToolCallEventBase`), así que dan `[]` sin error (NOT in scope).
- **Sin `sessionId`, o evento de tool o turno sin su id** → `warning bad-shape` y el evento se descarta (D10.7).
- **`dropped > 0`** → un `warning queue-overflow` ("la extensión descartó N eventos"), visible en la sesión y en `errorsByReason`.
- **`e` desconocido** → `warning unknown-type`. Solo pasa con desfase de versión entre la extensión instalada y el servidor.
- *Reversión:* barata.

### D13 — `crow attach | detach pi` (R13–R15)

- **Unidad:** el archivo `crow-ingest.ts` entero.
  - `AttachContext.configPath` = ese archivo, y es el único archivo de pi que se escribe (F2a R23).
  - Manifiesto `$CROW_HOME/attach/pi-<sha1(realpath)[:8]>.json` con `units: [{ event: "extension", value: { sha256, generator: "crow-pi-extension/1", port } }]` y `created.extensionsDir` (si crow creó `extensions/`).
- **Lectura de solo consulta:** `<piAgentDir>/settings.json` (sin BOM + `JSON.parse`, como pi). Para:
  1. patrones de `extensions` que excluyan `crow-ingest.ts` (`!`, `-`), que dan un aviso de "deshabilitada por settings";
  2. `sessionDir` definido, que da un aviso de "las sesiones pueden estar fuera de la raíz de crow" (Q1).

  **Si existe y no se puede parsear, `attach` y `detach` abortan sin escribir (R15).** Lo mismo con un manifiesto ilegible (`readManifest`, F2a).
- **`attach` (R13):**
  - archivo ausente → diff completo (vacío → plantilla renderizada), confirmación (TTY o `--yes`), `writeConfig` (chequeo de carrera + `safeWrite`, crea `extensions/` si falta) y manifiesto;
  - archivo igual byte a byte al renderizado → "pi ya está adjuntado; nada que hacer", sin escribir nada;
  - archivo con marcador y distinto (edición del usuario, otra versión u otro puerto) → diff, confirmación y **backup** en `$CROW_HOME/backups/pi/` antes de sobrescribir;
  - archivo **sin marcador** → abortar: "existe `crow-ingest.ts` que crow no creó; no se escribió nada". Nunca se pisa un archivo ajeno.
  - Si el destino es un symlink, se escribe a través de él (`resolveTarget`, F2a D13).
  - Nunca se escribe en `.pi/` de un proyecto.
- **`detach` (R14):**
  - el archivo **sin modificar** → backup, `unlink`, y `extensions/` se quita solo si crow lo creó y quedó vacío. "Sin modificar" = su sha256 coincide con el del manifiesto, **o** el archivo es igual a `renderPiExtension(parseExtensionConfig(archivo))`: la plantilla de esta versión de crow con el puerto y la ruta del token que trae el propio archivo. Así, un cambio de `CROW_PORT` sin manifiesto no hace pasar por editada una extensión intacta;
  - si difiere, se **conserva y se informa**;
  - archivo ausente → "no está adjuntado".
  - `settings.json` y cualquier otra extensión quedan intactos por construcción.
- *Reversión:* barata.

### D14 — `crow doctor` para pi (R16)

- **Carril A:** la raíz (`piAdapter.watchRoots`), si existe, y los `.jsonl` vistos (`countJsonl`).
- **Carril B, configuración** (`inspectPiInstall`): si el archivo existe, si lleva el marcador, si está sin modificar (regla de D13), el puerto y la ruta del token de su bloque (`parseExtensionConfig`), los patrones de `settings.json` que lo excluyen, si hay `sessionDir` definido y el error de parseo.
- **Carril B, servidor:** `lanes.engines.pi.hook` (último evento recibido, recibidos y rechazados por motivo) y las sesiones pi vivas con `fetchLiveCount`, como en Codex.
- **Avisos:**
  - raíz ausente;
  - falta `attach` → `crow attach pi`;
  - extensión modificada;
  - extensión deshabilitada por `settings.json` (`!` o `-`);
  - `sessionDir` definido (Q1): "las sesiones pueden quedar fuera de la raíz de crow";
  - **puerto o ruta del token distintos** de `crowPort` o de `$CROW_HOME/token` → "la extensión apunta a otro crow; corre `crow attach pi` y reinicia pi";
  - rechazos `unauthorized`;
  - **"instalada pero sin eventos mientras hay sesiones pi vivas"** → "reinicia pi o usa /reload; si corres pi con `-ne`/`--no-extensions`, el carril B está apagado en esas sesiones". Es el análogo de la "confianza pendiente" de Codex.
- **Lo que no puede saber:** `-ne` es por invocación y no deja rastro en `settings.json`. Solo lo delata el último aviso.
- **Forma:** `EngineReport.laneB.config` pasa a `HooksConfigReport | PiExtensionReport`, discriminados por `kind`, y `contentFlags` pasa a `ContentFlagsReport | null` (pi no tiene flags de contenido). Es aditivo para `--json`.
- *Reversión:* barata.

### D15 — Registro, integración y estado de sesión (R17)

- **`EngineId` gana `"pi"`** y `ENGINE_ADAPTERS` gana `bindAdapter(piAdapter)`. Con eso:
  - el tailer vigila la raíz;
  - `/ingest/hook/pi` deja de responder 404 (la búsqueda del adaptador con `fromHook` en `ingest-route.ts`);
  - `LaneMonitor` cuenta el carril;
  - las sesiones `pi:<uuid>` aparecen en la grilla, el split y el detalle con los estados de F1 D10/F2a D5 y totales de costo.
- **`session.end` solo por el carril B.** El JSONL de pi no tiene entrada de cierre (§ Evidencia), así que el carril A no emite `session.end`.
  - Con la extensión: `session_shutdown` (`quit`, `new`, `resume`, `fork`) → `session.end` → `ended` (`nextStatus`, `store.ts:206`).
  - Sin ella, o si el cierre no llega (`kill -9`, el `process.exit(143)` de `print-mode` en SIGTERM/SIGHUP, o el flush de salida vencido con crow colgado): `live` → `idle` por `sweepIdle` (`store.ts:1687`), y ahí se queda.
  - Es el mismo comportamiento que Claude y Codex sin `attach`: ningún carril de transcript emite `session.end` y F1 no tiene una regla `idle` → `ended`. R17 lo dice así de forma explícita.
- **Sesiones solo del carril B** (`pi --no-session`, o abrir y salir sin mensajes, porque pi no crea el archivo hasta el primer mensaje: `_persist`) aparecen con `session.start`/`session.end` y tools, sin costo. Es el mismo comportamiento que un hook de Claude sin transcript.
- *Reversión:* barata.

### D16 — Fixtures y anonimizador (R18)

- **`scripts/anonymize/pi.ts`** con allowlist de claves estructurales:
  - claves estructurales en cualquier registro: `type`, `id`, `parentId`, `timestamp`, `version`, `role`, `api`, `provider`, `model`, `responseModel`, `stopReason`, `rawStopReason`, `usage.*`, `toolCallId`, `toolName`, `isError`, `thinkingLevel`, `modelId`, `firstKeptEntryId`, `tokensBefore`, `targetId`, `fromId` y `customType`;
  - **`name` solo dentro de un bloque `toolCall`** (el nombre de la tool, p. ej. `"bash"`), calificado por tipo de registro como hace `anonymizeRecord` en `scripts/anonymize/codex.ts:179`. En cualquier otro registro, `name` es texto libre y va a marcador;
  - **texto del usuario que nunca sale:** `session_info.name` (el nombre de sesión de `/name` o `--name`), `label.label`, `custom.data` y `custom_message.content`, además de los mensajes. Ninguno está en el allowlist;
  - la higiene estructural no basta para estos campos: `isAcceptableValue` (`fixtures/hygiene.test.ts`) acepta strings sin marcar de hasta 64 caracteres sin espacios, así que un nombre de sesión corto pasaría. Por eso los cubren centinelas en `scripts/anonymize/pi.test.ts` y un chequeo por tipo de registro en `fixtures/b0-pi.test.ts` (precedente: `fixtures/b0-claude.test.ts`);
  - el texto va a marcadores;
  - los ids crudos (`resp_`, `call_…|fc_…`, uuid) se pseudonimizan;
  - `cwd` se reescribe a `/tmp/crow-fixture/…`, y `parentSession` a una ruta bajo el mismo sandbox;
  - un mismo id crudo recibe el mismo pseudónimo en el padre y en sus forks, para que las fixtures conserven los "mismos ids" de D7;
  - los `timestamp` quedan intactos (el patrón ISO ya es estructural en `hygiene.test.ts`), porque la regla de D7 depende de `≤` y de los empates de ms.
- **`fixtures/hygiene.test.ts`:**
  - `PII_PATTERNS` suma `\b(?:resp|call|fc)_[A-Za-z0-9]{6,}`. Hoy ningún fixture coincide (verificado con `grep -rlE` sobre `fixtures/`);
  - `anonymizedFixtureFiles` suma `fixtures/pi/**`.
- **Sobres del carril B:** `fixtures/pi/extension/*.json`, capturas de B0 filtradas por el mismo allowlist de D11, más los generados por el harness.
- *Reversión:* barata.

### D17 — `model.change` (R3, Q2 aceptada)

- `EventKind` gana `"model.change"` y `CrowEvent` gana `model?: { provider?: string; id: string }`.
- Solo el carril A lo emite, desde `model_change` (`provider`, `modelId`), que trae id de entrada: `semanticKey` `entry:<id>:0`, sin `match` ni fusión (sin tocar `reconcile.ts`).
- La web gana la etiqueta "Modelo", con el detalle `<provider>/<id>`.
- `model_select` del carril B → `[]` (Q3): no trae id de entrada, y en el probe no se disparó con RPC `set_model` aunque sí se escribió `model_change`.
- El modelo sigue visible también por `usage.model` y `sessions.model`.
- *Reversión:* barata (kind aditivo).

---

## Contracts

### Core (aditivo)

```ts
// packages/core/src/crow-event.ts
export type EngineId = "claude" | "codex" | "gemini" | "opencode" | "aider" | "cursor" | "pi" | (string & {});
export type IngestErrorReason = /* F2a */ | "unsupported-version";          // D8
export interface CrowEventUsage {
  /* F1 */
  /** Engine-reported USD cost for this usage (pi `usage.cost.total` when > 0). Core prefers it to the price table (R4). */
  engineCostUsd?: number;
}
// D17 (Q2 accepted):
export type EventKind = /* F2a */ | "model.change";  // "usage" JSDoc widened: usage outside an assistant message (OTel ledger or engine entries, D5)
export interface CrowEventModel { provider?: string; id: string }
export interface CrowEvent { /* F2a */ model?: CrowEventModel }

// packages/core/src/adapter.ts
export interface CrowConfig { /* F2a */ piAgentDir: string; piSessionDir: string }  // R1
export type LineResult<S extends JsonValue> =
  | { ok: true; events: PartialCrowEvent[]; warnings?: LineWarning[]; state: S;
      /** R7: the line was an entry of an unknown type/role; counted in `IngestStats.unknownEntries`. */
      unknown?: true }
  | { /* F1 failure branch, unchanged */ ok: false; reason: IngestErrorReason; detail?: string;
      sessionId: string | null; agentId: string | null; cwd?: string; state: S };

// packages/core/src/api-types.ts
export interface IngestStats { /* F2a */ unknownEntries: number }  // R7
```

- `applyUsage`: `const priced = usage.engineCostUsd ?? computeCostUsd(usage);`. El resto no cambia (peso, `t_unpriced` y negación).
- `ingestBatch`: la entrada gana `unknownEntries?: number`, que incrementa `ingest_stats.unknown_entries` en la transacción. No hay migración de esquema: `ingest_stats` es clave-valor.
- `stats()` (`store.ts:1662`) lee la fila `unknown_entries` como `unknownEntries` (0 si no existe).

### Estado del adaptador

```ts
interface PiState {
  v: 1;
  sessionId: string | null;      // header.id (R2)
  cwd: string | null;            // header.cwd (R2)
  headerTs: number | null;       // Date.parse(header.timestamp) (D7)
  inheriting: boolean;           // header.parentSession present and the copied prefix still open (D7); the path is never stored
  version: number | null;        // header.version ?? 1 (D8)
  warned: IngestErrorReason[];   // one ingest.error per file and reason (R7)
  openTurn: { entryId: string; ts: number; ok: boolean; category: string | null; pending: string[] } | null; // D4
}
```

### Sobre del carril B (`POST /ingest/hook/pi`)

```ts
interface PiHookEnvelope { v: 1; events: PiHookEvent[]; dropped?: number }
interface PiHookBase { ts: number; sessionId: string; cwd?: string }
type PiHookEvent = PiHookBase & (
  | { e: "session_start"; reason: "startup" | "reload" | "new" | "resume" | "fork"; leafId?: string }  // leafId: D12
  | { e: "session_shutdown"; reason: "quit" | "reload" | "new" | "resume" | "fork" }
  | { e: "turn_start"; turnIndex: number }
  | { e: "turn_end"; turnIndex: number; messageEntryId: string; stopReason?: string }
  | { e: "tool_call" | "tool_execution_start"; toolCallId: string; toolName: string; parentToolCallId?: string }
  | { e: "tool_result"; toolCallId: string; toolName: string; isError: boolean; parentToolCallId?: string }
  | { e: "tool_execution_end"; toolCallId: string; toolName: string; isError: boolean; durationMs?: number; parentToolCallId?: string }
  | { e: "agent_end"; willRetry?: boolean }
  | { e: "session_compact"; compactionEntryId: string; reason: "manual" | "threshold" | "overflow"; willRetry: boolean }
  | { e: "model_select"; provider: string; model: string; source: "set" | "cycle" | "restore" }
);
```

- La plantilla declara su propia copia estructural de estos tipos (no puede importar).
- `piFromHook` valida con narrowing (`unknown` → tipos) y nunca lanza.
- **Allowlist exacto del sobre (R10).** Es la lista que compara `crow-ingest.test.ts`; ninguna otra clave sale.

  | Clave | Categoría de R10 |
  |---|---|
  | `v`, `dropped` (sobre); `turnIndex`, `willRetry` (evento) | envelope fields |
  | `e` | event name |
  | `sessionId`, `leafId`, `messageEntryId`, `compactionEntryId` | session and entry ids |
  | `toolCallId`, `parentToolCallId` | tool call ids |
  | `cwd` | `cwd` |
  | `toolName` | tool name |
  | `ts` | timestamps |
  | `durationMs` | durations |
  | `isError` | error flags |
  | `reason`, `source`, `stopReason` | closed enums |
  | `provider`, `model` | model identifiers |

  `events` es solo el arreglo que contiene los eventos; no lleva datos propios.
- La deriva entre los dos lados la atrapa el test dorado: los sobres del harness entran a `piFromHook`.

### Plantilla de la extensión

```ts
export interface CrowExtensionDeps {
  port: number;
  readToken: () => Promise<string | null>;  // reads CROW_TOKEN_FILE; never throws
  fetch: typeof fetch;
  now: () => number;
}
export function createCrowExtension(deps: CrowExtensionDeps): (pi: PiLike) => void;
export default createCrowExtension({ port: CROW_PORT, readToken: readTokenFile, fetch, now: Date.now });
// Constants: QUEUE_MAX = 500, BATCH_MAX = 50, SEND_TIMEOUT_MS = 2000, SHUTDOWN_FLUSH_MS = 1000, START_TIMES_MAX = 1024.
```

```ts
// packages/adapters/pi/src/render-extension.ts
export interface PiExtensionConfig { port: number; tokenFile: string }
export function renderPiExtension(config: PiExtensionConfig): string;
/** Reads the marked config block back; `null` when absent or malformed (D13, D14). */
export function parseExtensionConfig(text: string): PiExtensionConfig | null;
```

### CLI

```ts
// packages/cli/src/attach-common.ts
export type Engine = "claude" | "codex" | "pi";
export interface Manifest { /* F2a */ created: { hooks: boolean; events: string[]; env?: boolean; extensionsDir?: boolean } }

// packages/cli/src/pi-config.ts (pure)
export type PiAttachPlan =
  | { kind: "unchanged" }
  | { kind: "write"; after: string; overwrite: boolean; warnings: string[] }
  | { kind: "abort"; reason: string };                        // no marker, unreadable settings.json (R15)
export type PiDetachPlan =
  | { kind: "absent" } | { kind: "remove"; removeDir: boolean } | { kind: "keep"; reason: string } | { kind: "abort"; reason: string };
export interface PiExtensionReport {
  kind: "pi-extension"; file: string; exists: boolean; generatedByCrow: boolean;
  unmodified: boolean | null; disabledBy: string[]; sessionDirSetting: boolean; parseError: string | null;
  /** From the file's marked config block (`parseExtensionConfig`); `null` when absent or unreadable. */
  port: number | null; tokenFile: string | null;
  /** The block targets a port or token file other than crow's current ones (D9, D14). */
  portMismatch: boolean; tokenFileMismatch: boolean;
}
```

## Mapa del carril A (`map-line.ts`)

| Entrada | `CrowEvent` | `match` (exact) | Otros |
|---|---|---|---|
| Header `session` | `session.start` (`cwd`, `ts` del header) | `session-start@main` | `semanticKey: header`; versión ≠ 3 → `unsupported-version` (D8) |
| Entrada heredada de un fork (prefijo con `ts ≤ header.ts`) | nada | — | D7 |
| `message` `user` | `prompt` (`text` ≤ 8 KiB) | — | Un solo carril |
| `message` `assistant` | `assistant.message` (`text` ≤ 8 KiB, `usage`, `usageKey`) | — (lleva `usage`) | D5 |
| ídem, cada bloque `toolCall` | `tool.pre` (`name`, `callId`, `input` recortado) | `tool-pre:<toolCall.id>` | Abre el turno (D4) |
| ídem, sin `toolCall` | `turn.end` (`ok`, `category`) | `turn-end:<entry.id>` | D4 |
| `message` `toolResult` | `tool.post` o `tool.error` (`callId = toolCallId`, `name = toolName`, error ≤ 1 KiB) | `tool-post:<toolCallId>` | Puede cerrar el turno → `turn.end` `turn-end:<assistant entry id>` |
| ídem, con `usage` | `usage` | — | `usageKey entry:<id>:toolResult`, sin modelo (D5) |
| `compaction` | `compact` (`endedAt = ts`) | `compact:<entry.id>` | — |
| ídem, con `usage` | `usage` | — | `usageKey entry:<id>:compaction`, sin modelo (D5) |
| `branch_summary` con `usage` | `usage` | — | `usageKey entry:<id>:branch_summary`, sin modelo (D5) |
| `usage` (`cache_warm` u otro `kind`) | `usage` | — | `usageKey entry:<id>:usage`, `model` de la entrada (D5) |
| `model_change` | `model.change` (`model: { provider, id }`) | — | D17 |
| Tipos y roles conocidos sin evento | nada | — | D3 |
| `type` o `role` desconocidos | nada; `unknown: true`; un `ingest.error` por archivo y motivo | — | D8 |

## Mapa del carril B (`hook.ts`)

| Evento de pi (R8) | `CrowEvent` | `match` (role) | Notas |
|---|---|---|---|
| `session_start` `startup`/`new`/`fork` | `session.start` | `session-start@main` (`hook`) | Se funde con el header; el duplicado que emite pi cuenta en `laneDuplicates` (D12) |
| `session_start` `resume` | `session.start` | `session-start@resume:<leafId>` (`hook`) | Un hecho por reanudación, aunque pi emita el evento dos veces (D12) |
| `session_start` `reload` | nada | — | Recarga del runtime de extensiones, no de la sesión |
| `session_shutdown` `quit`/`new`/`resume`/`fork` | `session.end` | — | Un carril; `sessionId` del runtime que se cierra (✓ probe); con `quit`, flush acotado (D10) |
| `session_shutdown` `reload` | nada | — | ídem |
| `turn_start` | **nada** (Q3) | — | Sin kind: el transcript no lo registra y `turn.end` ya marca el turno |
| `turn_end` | `turn.end` | `turn-end:<messageEntryId>` (`hook`) | D4 |
| `tool_call` | `tool.pre` | `tool-pre:<id>` (`hook`) | Anidadas → nada |
| `tool_execution_start` | `tool.pre` | `tool-pre:<id>` (`hook:exec`) | |
| `tool_result` | `tool.post`/`tool.error` (`verdict` `allow`/`error`) | `tool-post:<id>` (`hook`) | |
| `tool_execution_end` | `tool.post`/`tool.error` (`ms`, `msSource: engine`) | `tool-post:<id>` (`hook:exec`) | |
| `agent_end` | **nada** (Q3) | — | Mapearlo a `turn.end` duplicaría el fin de turno |
| `session_compact` | `compact` (`trigger = reason`, `endedAt = ts`) | `compact:<compactionEntryId>` (`hook:post`) | Clave exacta, mejor que el `nearest` de F2a |
| `model_select` | **nada** (Q2, Q3) | — | Sin id de entrada; el carril A trae el cambio |

**Eventos de pi que quedan fuera** (no se suscriben):

- `context`, `context_with_system`, `before_provider_request`, `provider_stream_event`, `message_update`, `message_end`, `input`, `before_agent_start` y `user_bash`: traen contenido, algunos devuelven valores que cambian la ejecución y otros están en la ruta caliente del stream (`PI/docs/extensions.md`: "slow handlers delay stream consumption");
- `session_before_*`, porque pueden cancelar;
- `tool_execution_update`, por volumen;
- `agent_start`, `agent_settled`, `session_tree`, `thinking_level_select`, `ui_prompt_*`, `project_trust` y `resources_discover`: fuera de R8.

## Reconciliación — R9

| Hecho | Clave (exact) | Carril A | Carril B (roles) |
|---|---|---|---|
| Inicio de sesión | `session-start@main` | header | `session_start` `startup`/`new`/`fork` (`hook`) |
| Reanudación | `session-start@resume:<leafId>` | — | `session_start` `resume` (`hook`) |
| Tool, inicio | `tool-pre:<toolCallId>` | bloque `toolCall` | `tool_call` (`hook`), `tool_execution_start` (`hook:exec`) |
| Tool, fin | `tool-post:<toolCallId>` | entrada `toolResult` | `tool_result` (`hook`), `tool_execution_end` (`hook:exec`) |
| Fin de turno | `turn-end:<assistantEntryId>` | turno cerrado (D4) | `turn_end.messageEntryId` (`hook`) |
| Compactación | `compact:<compactionEntryId>` | entrada `compaction` | `session_compact` (`hook:post`) |

- **Precedencia:** la de F2a sin cambios. `ts`, `text`, `tool.name`, `tool.input` y `error` siguen transcript > hook; `tool.ms` sigue engine > transcript (D7 de F2a), y el `ms` del carril B gana; `kind` es `tool.error` si algún carril lo dice.
- **Un solo carril:** `prompt`, `assistant.message` y `usage` con uso, y `model.change` (A); `session.end` y la reanudación (B).
- **Igualdades (G3, ✓ probe):** `turn_end.messageEntryId` = `id` de la entrada `assistant`, y `toolCallId` del hook = `toolCall.id` = `toolResult.toolCallId`. `compactionEntry.id` = `id` de la entrada `compaction` por código (`agent-session.js` la busca con `newEntries.find` por `summary`): dos compactaciones con el mismo resumen resolverían la primera (residual). B0 lo ejercita.
- **Orden (✓ probe):** `tool_execution_start` llega antes que `tool_call`, y los `tool_result` en orden de fin. La reconciliación no depende del orden (720 permutaciones) y el turno diferido de D4 espera todos los `toolResult`.

---

## Failure modes

| Falla | Qué pasa | Contención |
|---|---|---|
| crow abajo, colgado, 401 o 413 | La extensión descarta lotes y no muestra nada. Handlers ~0 ms; salida de pi ≤ 1 s extra con crow colgado | D10; harness; B0 mide (G5, G6) |
| Handler que lanza en `tool_call` | pi bloquearía la tool sin aviso (✓ probe) | Todo handler envuelto; test con `ctx` caducado y `fetch` que lanza síncrono |
| `ctx` caducado tras fork, new, resume o reload | Sus getters lanzan | Lectura síncrona dentro del `try`; nunca se captura `ctx` |
| Promesa rechazada sin manejar | Node podría terminar pi | Todo termina en `.catch`; test con espía de `unhandledRejection` |
| Cola de la extensión llena | Se descartan eventos nuevos | `dropped` → `ingest.error queue-overflow` en la sesión |
| pi no reiniciado tras `attach` | Carril B mudo | Mensaje de `attach`; aviso de `doctor` (D14) |
| **pi corrido con `-ne`/`--no-extensions`** | Carril B apagado en esa sesión; A sigue | No se ve desde `settings.json`; `doctor` avisa "sin eventos con sesiones vivas" y nombra `-ne` (D14) |
| **Extensión excluida por `settings.json`** (`!extensions/crow-ingest.ts` o `-extensions/crow-ingest.ts`) | Carril B apagado en todas las sesiones | `doctor` y `attach` avisan (`disabledBy`; D13, D14) |
| **`CROW_PORT` o `CROW_HOME` cambian tras `attach`** | La extensión manda al puerto viejo o no encuentra el token (401): carril B mudo sin error | `doctor` compara el bloque con la config actual; `crow attach pi` de nuevo (D9, D14) |
| Error de carga de jiti | Error visible en pi (contra R11) | Plantilla en TS plano, `load.test.ts` con Bun y smoke con pi real (D10.8) |
| pi cambia un campo que crow lee | Eventos sin id | `bad-shape` visible, nunca duplicados; script de deriva; `doctor` |
| Carril B antes que A (lo normal) | La sesión nace con el `cwd` del carril B | `ensureSession` corrige al llegar el header |
| **`session_start` duplicado por pi** (`fork`/`new` en RPC) | Dos aportes del mismo inicio | Claves de D12; el segundo cuenta en `laneDuplicates` |
| **Sin cierre** (`kill -9`, `process.exit(143)` de `-p` en SIGTERM/SIGHUP, flush vencido, o sin carril B) | Sin `session.end`: la sesión queda en `idle`, nunca `ended` | Igual que Claude y Codex sin hooks (D15) |
| Fork, clone o `--fork` en cualquier orden | La historia copiada no cuenta | D7 |
| Última copia en el mismo ms que el header | Heredada | `≤` de D7; `fork.test.ts` |
| Reloj que retrocede entre el fork y la primera entrada propia | Esas entradas pasan por heredadas: sub-cuenta | Residual fijado por test (D7) |
| Copia con reloj adelantado en medio del prefijo | Las copias siguientes se cuentan en el fork; duplica si el padre también se ingirió | Residual fijado por test (D7) |
| Archivo v2 reabierto por pi, del mismo tamaño o encogido sin crecer | Reescritura; el tailer sigue alineado o vuelve a 0 | Dedupe `l:` o `entry:<id>:<n>` (D8) |
| Archivo v2 con `hookMessage` reescrito y crecido antes del siguiente paso | A lo sumo un `invalid-json` y las primeras entradas nuevas perdidas | Residual (D8); 0 archivos v1/v2 en el censo |
| Archivo v1 reabierto por pi | Ids nuevos: además, eventos duplicados y uso duplicado sin `responseId` | Residual (D8) |
| `importFromJsonl` (mismo id) | Segundo archivo de la misma sesión | Dedupe `l:` o `entry:<id>:<n>` (D7) |
| `sessionDir` en `settings.json` o `--session-dir` | Sesiones fuera de la raíz: invisibles | Aviso de `doctor` para el setting de usuario (Q1); la bandera no se ve |
| `cacheWarming: "idle"` | Calentamientos entre corridas: la sesión vuelve a `live` sin actividad del usuario | Aceptado: es gasto real (D5) |
| Uso de `compaction`, `branch_summary` o `toolResult` con `cost.total = 0` | Sin modelo: uso sin precio (`t_unpriced`) | D5; el panel lo muestra como "sin precio" |
| Dos compactaciones con el mismo resumen | El `session_compact` de la segunda se funde con la primera | Residual; el carril A trae la segunda igual |
| `pi --no-session` o subagentes del ejemplo | Sesiones solo del carril B, sin costo | Cuota de sesiones nuevas por motor (F2a D2) |
| Llamadas anidadas (codemode) | No están en el transcript | El carril B las ignora (NOT in scope) |
| Respuesta `deferred` que crece bajo el mismo `responseId` | Delta contado una vez | El delta se valora con la tabla (D5, residual) |
| Tipo nuevo en cada turno | Un error por archivo y motivo, más el contador | D8 |
| Línea `toolResult` > 16 MiB | `line-too-long` | El carril B aporta el `tool.post` |
| `crow-ingest.ts` ajeno (sin marcador) | `attach` aborta | D13 |
| Extensión editada por el usuario | `detach` la conserva; `attach` muestra el diff y hace backup | D13 |
| `settings.json` ilegible | `attach` y `detach` abortan | R15, D13 |
| Backup o temporal en `extensions/` | pi lo cargaría como extensión | Backups en `$CROW_HOME`; temporal `.tmp` (D9) |

## Migration & compatibility

- **Sin migración de esquema.** `ingest_stats` es clave-valor; `sessions.engine` ya es texto.
- **Contratos solo aditivos:** `EngineId`, `EventKind` (`model.change`), `CrowEvent.model`, `CrowEventUsage.engineCostUsd`, `IngestErrorReason`, `CrowConfig` (dos campos), `LineResult.unknown`, `IngestStats.unknownEntries` y `Manifest.created.extensionsDir`.
- **Tests que se actualizan por contrato:** `apps/server/src/api.test.ts:172` (`toEqual` exacto de `/api/stats`) y los que construyen `CrowConfig` literal (§ Components).
- **El kind `usage` pasa a venir también del transcript** (solo pi). La web ya no lo pinta y ya lo suma. Claude y Codex solo lo emiten desde OTel, así que no cambian.
- **Claude y Codex no cambian:** nunca ponen `engineCostUsd` ni `unknown`. Sus snapshots de contrato deben quedar idénticos (test de regresión).
- **`doctor --json`:** `laneB.config` y `contentFlags` ganan variantes (`kind` discriminado, `null`). Un consumidor que asuma la forma de hooks para cualquier motor debe leer `kind`.
- **Rollback:** `crow detach pi` más quitar el adaptador del registro. Los datos ya ingeridos de pi quedan como sesiones `pi:*`, inertes.

---

## Testing strategy

Ningún test lee homes reales ni necesita pi instalado, salvo el smoke opcional (D10.8). Todo test lleva `// Covers: R<n>`. Cada fila responde a un riesgo nombrado arriba. Las tareas que los escriben están en `tasks.md` y en § Cobertura.

| Riesgo | Test | R |
|---|---|---|
| Raíz mal resuelta | `packages/core/src/config.test.ts`: precedencia `PI_CODING_AGENT_SESSION_DIR` > `PI_CODING_AGENT_DIR/sessions` > `~/.pi/agent/sessions`, con `~` expandido | R1 |
| Archivos fuera de patrón | `packages/adapters/pi/src/adapter.test.ts`: `matches` acepta profundidad 1 y 2 y rechaza 3, no-`.jsonl` y rutas fuera de la raíz | R1 |
| Sesión o proyecto tomados del nombre | `map-line.test.ts`: nombre con otro uuid y directorio con `-` ambiguo → sesión = `header.id`, proyecto = `header.cwd`; header inválido (sin `id` o sin `timestamp` legible) → un `bad-shape` y nada más | R2 |
| Deriva del mapa | `contract.test.ts`: snapshot sobre `fixtures/pi/0.99.1/` (B0); entradas sintéticas de `compaction`, `model_change` y roles conocidos | R3 |
| Contenido guardado de más | `map-line.test.ts`: centinelas en `thinking`, salida de tool, `details`, `system.sections` y `errorMessage` nunca aparecen en los eventos; `text` ≤ 8 KiB; `input` recortado | R3 |
| `model.change` sin etiqueta | `apps/web/src/lib/reduce/feed.test.ts`: etiqueta y detalle | R3 |
| `turn.end` antes de sus tools | `map-line.test.ts`: asistente con 2 `toolCall` → el `turn.end` sale con el segundo `toolResult`; sin tools → en la misma línea; turno abierto que cierra el siguiente asistente | R3, R9 |
| Costo equivocado | `packages/core/src/store/store.test.ts` (caso nuevo): `engineCostUsd` gana a la tabla; ausente → tabla; modelo sin precio → `t_unpriced`. `pi/src/usage.test.ts`: `cost.total > 0` → `engineCostUsd`; `0` con modelo en la tabla → tabla; `0` sin modelo → sin precio; `cacheWrite1h` → `cacheCreation1h`; `reasoning` no se suma | R4 |
| Uso fuera del asistente sin contar | `usage.test.ts`: una entrada de cada tipo (`usage` `cache_warm`, `usage` de `kind` desconocido, `compaction`, `branch_summary`, `toolResult`) → un evento `usage` con `entry:<id>:<tipo>`; la suma de `costUsd` de la sesión = la suma de `cost.total` de pi; un uso en 0 → nada | R4 |
| Misma respuesta contada dos veces | `usage.test.ts`: dos entradas con el mismo `responseId` → un conteo (delta 0); sin `responseId` → `entry:<id>:assistant` | R4 |
| Regresión en Claude y Codex | Los snapshots `contract.test.ts` de Claude y Codex no cambian | R4 |
| Ramas contadas de más o de menos | `pi/src/branches.test.ts`: archivo con 2 ramas y `branch_summary` → cada respuesta una vez; total = suma de todas las ramas | R5 |
| Regla de fork frágil | `pi/src/fork.test.ts`: **empate de ms** entre la última copia y el header → heredada; reloj atrás después de la primera propia → contada; reloj atrás antes de la primera propia → heredada (residual); copia con reloj adelantado en medio del prefijo → cierra el prefijo (residual); `model_change` automático en el mismo ms → sin evento; `timestamp` ilegible en el prefijo → heredada y un `bad-shape`; sin `parentSession` → nada heredado | R6 |
| Fixtures que dejan de representar a pi | `fixtures/b0-pi.test.ts` (tripwires): en cada fork capturado, toda copia tiene `ts ≤ header.ts` y forma el prefijo contiguo; cada `turn_end.messageEntryId` y `toolCallId` capturados existen en el JSONL de la misma corrida | R6, R9 |
| Doble conteo por fork | `e2e/pi-fork.test.ts`: padre más `/fork`, `/clone` y `--fork` sintéticos (mismos ids y `responseId`, header posterior, última copia en el mismo ms del header), ingeridos en los 24 órdenes de los 4 archivos → totales = padre más lo propio de cada fork; cada fork es su propia sesión y su timeline no tiene la historia copiada | R6 |
| Reescritura por migración | `pi/src/migration.test.ts` (tailer real): v2 ingerido, reescrito v3 del mismo tamaño y luego crecido → sin duplicados; más corto sin crecer → vuelve a 0 sin duplicados; más corto y crecido antes del siguiente paso → a lo sumo un `invalid-json` (residual fijado) | R5, R7 |
| Formato desconocido en silencio | `map-line.test.ts` y `packages/core/src/tailer/ingest.test.ts`: 3 entradas de un tipo nuevo, 1 rol nuevo y header v2 → un `ingest.error` por motivo y archivo, y `unknownEntries = 4`. `apps/server/src/api.test.ts`: `/api/stats` con `unknownEntries` | R7 |
| La extensión no reenvía un evento | `extension/crow-ingest.test.ts` (harness): registra exactamente los 11 eventos de R8; cada uno produce su sobre; `session_start` lleva `leafId` | R8 |
| Deriva extensión ↔ adaptador | `pi/src/hook.test.ts`: los sobres que produce el harness (dorados) → eventos esperados; anidadas → `[]`; sin id → `bad-shape`; `dropped` → `queue-overflow`; `turn_start`, `agent_end`, `model_select` y `reload` (de `session_start` y de `session_shutdown`) → `[]` | R8 |
| Duplicados entre carriles | `packages/core/src/store/reconcile-pi.test.ts`, con `PendingEvent` sintéticos que usan las claves y roles de pi, como `reconcile.test.ts` (no importa `@crow/adapter-pi`; la deriva con el adaptador la cubren `hook.test.ts`, `map-line.test.ts` y `e2e/pi-lanes.test.ts`): **720 permutaciones** de {A pre, B call, B exec_start, A post, B result, B exec_end} → 2 hechos; {A turn.end, B turn_end}, {A compact, B session_compact} y {header, `session_start` startup} en ambos órdenes → 1 cada uno | R9 |
| `session_start` duplicado | `reconcile-pi.test.ts`: `new` y `fork` dos veces → 1 hecho; `resume` dos veces con el mismo `leafId` → 1; con `leafId` distinto → 2 | R9 |
| Fuga de contenido | harness: centinelas en `input`, `args`, `content`, `result`, `message`, `messages`, `Model.headers`, `baseUrl` y `getSessionFile()` → ninguno en el cuerpo enviado; claves del sobre ⊆ {`v`, `events`, `dropped`} y claves de cada evento ⊆ el allowlist exacto de § Contracts, alineado con R10 | R10 |
| Tool bloqueada o error visible | harness: cada handler devuelve `undefined` y nunca lanza (con `ctx` caducado, `fetch` que lanza síncrono, `fetch` rechazado, respuesta no-`Response` y token ilegible); cero `unhandledRejection` | R11 |
| Latencia | harness: con `fetch` que nunca resuelve, cada handler vuelve en < 20 ms; `session_shutdown(quit)` ≤ 1.1 s; la cola no pasa de 500 y reporta `dropped` | R11 |
| Token | harness: archivo con token → `Authorization: Bearer`; sin archivo → sin cabecera; token rotado entre lotes → el nuevo | R12 |
| Plantilla que no carga (Bun) | `extension/load.test.ts`: la plantilla renderizada se importa con Bun y la factory registra los handlers en el `fake-pi`; la plantilla solo importa `node:`; `renderPiExtension` cambia solo el bloque marcado y `parseExtensionConfig` lo lee de vuelta | R8, R13 |
| Plantilla que no carga (jiti) | `e2e/pi-smoke.test.ts` (opcional, D10.8): pi real con `-ne -e` y `faux`, con el receptor arriba y abajo | R8, R11 |
| Attach inseguro | `packages/cli/src/attach-pi.test.ts`: diff, confirmación (TTY o `--yes`), escritura solo del archivo y de `$CROW_HOME`, backup en `$CROW_HOME/backups/pi/`, idempotencia, archivo sin marcador → abortar, symlink escrito a través, `extensions/` creado y registrado, otro puerto → diff y backup | R13 |
| Detach destructivo | `detach-pi.test.ts`: intacta → se borra; intacta con otro puerto y sin manifiesto → se borra; editada → se conserva y se informa; `settings.json` y otra extensión intactos; `extensions/` se quita solo si crow lo creó y quedó vacío | R14 |
| Config ilegible | `attach-pi.test.ts` y `detach-pi.test.ts`: `settings.json` inválido → abortar sin escribir; manifiesto ilegible → abortar | R15 |
| Diagnóstico incompleto | `doctor.test.ts`: raíz, archivos vistos, extensión instalada/modificada/deshabilitada, `sessionDir`, puerto y ruta del token distintos, último evento, "sin eventos con sesiones vivas" (nombra `-ne`) | R16 |
| pi no aparece en la UI | `apps/server/src/ingest-route.test.ts`: `/ingest/hook/pi` → 204. `e2e/pi-lanes.test.ts`: fixture de B0 por los dos carriles → sesión `pi:<id>` en `/api/projects` con totales y `live`; `session_shutdown` → `ended`; solo carril A → `idle` tras `sweepIdle`, nunca `ended`; solo carril B → sin costo | R9, R17 |
| PII en fixtures | `fixtures/hygiene.test.ts` extendido (patrones `resp_`/`call_`/`fc_`, `fixtures/pi/**` en el contrato estructural); `scripts/anonymize/pi.test.ts` con centinelas en mensajes, `thinking`, tools, `session_info.name`, `label.label`, `custom.data` y `custom_message.content`, y `name` conservado solo en `toolCall`; `fixtures/b0-pi.test.ts`: esos campos solo traen marcadores | R18 |

---

## Evidence gaps y lote B0

**Estado tras el challenge.** Los probes con `faux` cerraron parte de lo que la revisión 1 dejaba a B0: fork y clone con los mismos ids y `ts` (G1, salvo `/fork` por la TUI), las igualdades de ids (G3, salvo la compactación), la carga desde `-e` y desde `<agentDir>/extensions` (parte de G7) y `--no-session` (G8). La doc cerró la unidad USD (G9). Sigue sin haber en disco ningún fork, rama, compactación ni cambio de modelo reales, ni capturas del carril B en el repo.

| # | Qué falta | Estado | Cómo |
|---|---|---|---|
| **G1** | `/fork` por la TUI copia igual que `clone` y `--fork`; cuántas copias caen en el mismo ms del header | ✓ probe para `clone` y `--fork` | Captura en la TUI; conteo de empates |
| **G2** | `/tree` solo agrega (`branch_summary` más hijos del punto de rama) y nunca reescribe el archivo (D6) | ✓ código; sin probe (RPC no cubre `/tree`) | Rama desde un mensaje anterior en la TUI; comparar prefijo e inodo |
| **G3** | `compactionEntry.id` = `id` de la entrada `compaction` | ✓ código; sin probe | `/compact` con el contexto inflado |
| **G4** | `model_select` frente a `model_change` (¿`restore` escribe una entrada?) | Parcial: `set_model` escribió `model_change` sin `model_select` | `/model` y `/resume` en la TUI |
| **G5** | Salida con `quit`: el flush entrega `session.end`; tiempo de salida con crow arriba, abajo y colgado | Abierto | Cronometrar la salida en los 3 estados |
| **G6** | Latencia agregada por tool (p50 y p95 de 20 llamadas) con crow colgado frente a la base; ningún error visible con crow abajo, colgado, 401 y 413 | Abierto | `scripts/capture-receiver.ts` en sus modos `ok`, `hang`, `401` y `413` |
| **G7** | La plantilla de crow carga con jiti en la TUI y en `-p` | Parcial: una extensión TS con solo `node:` carga (probe) | Smoke de D10.8 con la plantilla real (B3.T3) |
| **G8** | `pi -p --no-session` carga la extensión | ✓ probe | — |
| **G9** | Unidad del costo y `cost.total > 0` en el camino real | Unidad ✓ doc; `faux` da 0 | B0.T2 solo si hace falta (Q10) |
| **G10** | `session_start` doble en modo interactivo y con `resume` | Abierto (el probe fue solo RPC) | `/new`, `/fork` y `/resume` en la TUI |

**Lote B0.** Decisión Q10: primero `faux`; hasta 10 llamadas reales solo si hace falta; `faux` no verifica el costo. El detalle y los archivos están en `tasks.md` § B0.

- **B0.T1 (sin tokens):** proveedor `faux` más una extensión de captura solo de B0, con `PI_CODING_AGENT_DIR` y `--session-dir` en scratch. Guion por RPC, `-p` y la TUI, con `/compact` sobre un contexto inflado. Cierra G1–G6 y G10; G7 lo cierra B3.T3.
- **B0.T2 (condicional, ≤ 10 llamadas reales):** (a) si B0.T1 no logra cablear `faux`, dentro de la autorización de Q10; o (b) para una fixture con `cost.total > 0` e ids reales, **solo con la confirmación explícita del usuario en ese momento**: el orquestador puede proponerla, no decidirla. Sin B0.T2, el camino `cost.total > 0` queda cubierto por entradas sintéticas.
- **B0.T3:** anonimizador, fixtures e higiene (D16).
- **Entregables:** `specs/f2b-pi/b0-bitacora.md` (formas y conteos, nunca contenido), `fixtures/pi/0.99.1/` y `fixtures/pi/extension/` anonimizados. Nada de `~/.pi/agent/sessions` ni de `auth.json` entra al repo.

---

## Decisiones del usuario (Q1–Q10) y lecturas

| Q | Decisión (ya en `requirements.md`) | Dónde |
|---|---|---|
| Q1 | No se sigue `sessionDir`; `doctor` avisa | R1, R16; D2, D14 |
| Q2 | Kind nuevo `model.change` | R3; D17 |
| Q3 | `turn_start`, `agent_end` y `model_select` se reenvían sin evento; también los `reload` | R8; D12; § Mapa del carril B |
| Q4 | La extensión envía `cwd` y los enums cerrados | R10; D11 |
| Q5 | Se cuenta el uso de `compaction`, `branch_summary`, `usage` y `toolResult` | R4; D5 |
| Q8 | La historia heredada de un fork se omite del timeline | R6; D7 |
| Q10 | B0 primero con `faux`; hasta 10 llamadas reales solo si hace falta; `faux` no verifica el costo | § B0; `tasks.md` § B0 |

**Lecturas que siguen como [assumed]:**

- R4 "provider and model": `pricing.ts` no tiene dimensión de proveedor, así que se busca por modelo (Q6).
- R7 "per file and reason": "reason" es el código `IngestErrorReason`; el detalle nombra el primer tipo visto y el contador cuenta todas las líneas.
- R12 "same rule": la extensión lee solo `$CROW_HOME/token`, igual que el script de hooks (Q9).

## Redacción de requisitos

El orquestador ya aplicó en `requirements.md` las propuestas de esta revisión (R3, R4, R9, R16 y R17) y las del review de la spec (R5 exceptúa lo heredado bajo R6; R8 exime el `reload`; R10 suma `v`, `turnIndex`, `willRetry` y `dropped`). El design las sigue al pie de la letra; no quedan propuestas abiertas.

## NOT in scope

- **Gemini CLI, OpenCode y carril D.** Los fija el contexto de `requirements.md`.
- **OTel de pi.** `@earendil-works/pi-telemetry` no exporta nada por sí solo (scout).
- **Llamadas anidadas** (`parentToolCallId`, codemode) y **subagentes de pi como agentes.** El ejemplo lanza procesos `--no-session` que crow ve como sesiones sueltas.
- **Vincular un fork con su sesión padre en la UI.**
- **Seguir `sessionDir` (de usuario o de proyecto) y `--session-dir`** (Q1).
- **Detectar `-ne` por invocación.** Solo lo delata el aviso de `doctor`.
- **`session.end` desde el carril A.** No hay señal en el archivo (D15).
- **Corregir la reescritura v1/v2** (D8, residual) y la huella de cabecera en el tailer.
- **Precio por proveedor y tramos en `pricing.ts`.**
- **Que la extensión siga un cambio de `CROW_PORT` sin volver a correr `attach`.**
- **Instalar vía `pi install` o como paquete npm, y la recarga en caliente.**
- **Nuevos kinds** `turn.start`/`agent.end`.
- **Validación automática contra los tipos de pi en CI.** Hay un script manual de deriva (D10) y el smoke opcional (D10.8).

## Open questions

- **[human]** Ninguna abierta: Q1–Q5, Q8 y Q10 las cerró el usuario, y la redacción de R3–R5, R8–R10, R16 y R17 ya está en `requirements.md`. Correr B0.T2 en el caso (b) espera la confirmación explícita del usuario en ese momento.
- **[assumed]** Precio por modelo sin proveedor (D5, Q6); token solo desde `$CROW_HOME/token` (D11, Q9); "reason" = código de `IngestErrorReason` (D8).
- **[assumed]** Tope de cola 500, lotes de 50, timeout de 2 s y flush de salida de 1 s (D10).
- **[repo]** Ninguna pendiente: todo lo del repo quedó verificado contra `origin/main` `d1bae2a`.

## Conocimiento durable (destino propuesto; no lo escribo)

- **Dominio:**
  - "En pi, `/fork`, `/clone` y `--fork` copian entradas con el mismo `id`, `timestamp` y `responseId`, como prefijo del archivo nuevo. La historia heredada es el prefijo contiguo con `timestamp ≤` al del header, y no genera eventos (mismo criterio que la historia heredada de Codex)."
  - "Un turno de pi es una respuesta del asistente más sus tool results. Su `turn.end` se emite al cerrar el turno y se reconcilia por el id de la entrada del asistente."
  - "Costo de pi: se cuenta todo uso que pi suma a sus totales (asistente, `compaction`, `branch_summary`, `usage` y `toolResult`). Manda `usage.cost.total` cuando es > 0 (`engineCostUsd`); si no, la tabla de crow para el modelo que nombra la entrada."
  - "El archivo de sesión de pi no tiene cierre: `ended` solo llega por la extensión."
- **CLAUDE.md (sección de usuario del proyecto):** "Una extensión de crow para un motor que corre en proceso (pi) nunca lanza, nunca devuelve valor y nunca espera en un handler, salvo el flush acotado de salida. Lee `ctx` de forma síncrona. Su carga real se prueba con el motor (`pi -ne -e`), no con Bun."
- **PLAN.md:** §6.1 (el carril B de pi es una extensión, no un hook) y §13 (cómo se engancha pi).

## Cobertura R1–R18

Cada R termina en al menos una tarea y un test obligatorio (el smoke opcional nunca es el único).

| R | Decisión | Tarea (`tasks.md`) | Test |
|---|---|---|---|
| R1 | D2 | B1.T1, B2.T1 | `core/config.test.ts`, `pi/adapter.test.ts` |
| R2 | D2 | B2.T1 | `pi/map-line.test.ts` |
| R3 | D3, D4, D17 | B1.T1, B2.T2 | `pi/map-line.test.ts`, `pi/contract.test.ts`, `web/reduce/feed.test.ts` |
| R4 | D5 | B1.T2, B2.T3 | `pi/usage.test.ts`, `core/store/store.test.ts`, contratos de Claude y Codex sin cambios |
| R5 | D6, D8 | B2.T3 | `pi/branches.test.ts`, `pi/migration.test.ts` |
| R6 | D7 | B0.T3, B2.T3 | `pi/fork.test.ts` (con empate de ms), `e2e/pi-fork.test.ts`, `fixtures/b0-pi.test.ts` |
| R7 | D8 | B1.T2, B2.T1, B2.T3 | `pi/map-line.test.ts`, `core/tailer/ingest.test.ts`, `server/api.test.ts`, `pi/migration.test.ts` |
| R8 | D9–D12 | B3.T1, B3.T2, B3.T3 | `extension/crow-ingest.test.ts`, `pi/hook.test.ts`, `extension/load.test.ts`; `e2e/pi-smoke.test.ts` (opcional) |
| R9 | D4, D12 | B0.T3, B2.T2, B3.T2, B4.T1 | `core/store/reconcile-pi.test.ts`, `pi/map-line.test.ts`, `e2e/pi-lanes.test.ts`, `fixtures/b0-pi.test.ts` |
| R10 | D11 | B3.T1 | `extension/crow-ingest.test.ts` (allowlist y centinelas) |
| R11 | D10 | B3.T1, B3.T3 | `extension/crow-ingest.test.ts`; `e2e/pi-smoke.test.ts` (opcional); B0 G5–G6 |
| R12 | D11 | B3.T1 | `extension/crow-ingest.test.ts` (token) |
| R13 | D9, D13 | B3.T3, B5.T1 | `extension/load.test.ts`, `cli/attach-pi.test.ts` |
| R14 | D13 | B5.T2 | `cli/detach-pi.test.ts` |
| R15 | D13 | B5.T1, B5.T2 | `cli/attach-pi.test.ts`, `cli/detach-pi.test.ts` |
| R16 | D14 | B5.T3 | `cli/doctor.test.ts` |
| R17 | D15 | B1.T1, B4.T1 | `server/ingest-route.test.ts`, `e2e/pi-lanes.test.ts` |
| R18 | D16 | B0.T3 | `fixtures/hygiene.test.ts`, `scripts/anonymize/pi.test.ts`, `fixtures/b0-pi.test.ts` |
