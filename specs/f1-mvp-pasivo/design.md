# F1 MVP pasivo — Design

> **Estado:** revisión 2. Atiende el challenge de `.claude/progress/challenge_f1-mvp-pasivo.md` (veredicto del orchestrator: CONCERNS) e incorpora las decisiones del usuario sobre R15, R16 y los precios, ya reflejadas en `requirements.md`.
> **Fecha:** 2026-09-24.
> **Base:** `origin/main` en `cba9b04` (F0). navori-harness en `origin/main` `d7f95d73`. Los archivos portados no cambian entre `6edc58b4`, `d7f95d73` y el HEAD local `a660123e` (`git diff` vacío). El último commit que toca `report.ts` es `21f6c054` (2026-09-22); `parse.ts` y el fixture, `b8dfe74c` (2026-09-18).
> **Señales:** contrato compartido nuevo (`EngineAdapter`, REST/SSE, DTOs); esquema y migraciones (SQLite v1); concurrencia (tailer, bus y relevo backfill→stream); área crítica de privacidad (prompts en disco); decisiones caras de revertir (qué significa el orden de los `id` y cuál es la identidad de dedupe).

## Resumen

- **Paquetes:**
  - `packages/core` queda como el núcleo agnóstico de motor que pide PLAN §6.3: tipos, contrato de adaptador, `projectKey`, pricing, ULID, store, bus y un **tailer genérico**.
  - `packages/adapters/{claude,codex}` son **parsers puros de línea**, sin I/O.
  - `apps/server` solo cablea HTTP, SSE, el guard y el sweeper.
- **Tailer:**
  - `fs.watch` recursivo (FSEvents) se usa como *pista*, no como fuente de verdad. Encima va un poll de 1 s sobre los archivos "calientes" y un rescan cada 30 s.
  - El offset en bytes y el estado del parser se persisten **en la misma transacción** que los eventos.
  - Una línea parcial se queda sin leer en disco, así que no hace falta buffer en memoria.
- **`id` = orden de ingesta (commit).**
  - Es un ULID monotónico generado dentro de la transacción. Se siembra con el mayor entre `max(id)` y el reloj.
  - Los eventos de backfill tienen `ts` viejo pero `id` nuevo, y eso es justo lo que hace correcto el replay por `Last-Event-ID`.
  - **Un cursor que no existe en la DB** (DB recreada, reloj atrás o un id ajeno) produce un `reset` explícito, nunca un silencio.
  - La UI ordena la vista por `(ts, id)` y usa el `id` solo como cursor.
- **Identidad de evento (R16, decidido):** `(source, sessionId, sha1 de los bytes de la línea, índice del evento en la línea)`. `seq` es el offset en bytes, solo informativo.
  - Una **clave semántica secundaria**, con alcance de archivo o agente, atrapa la misma línea lógica reescrita con bytes distintos. Cada descarte queda contado en `ingest_stats`.
  - El usage de Claude cuenta una vez por `message.id` **dentro de su agente** y gana el primero. Un usage discrepante no se descarta en silencio: genera `ingest.error usage-anomaly`.
  - En Codex, el **primer** `token_count` de cada archivo cuenta su `last_token_usage` y fija la línea base en el acumulado. Así el acumulado heredado de un fork no se cuenta nunca.
- **Proyecto pegajoso por sesión (R15, decidido):** la sesión toma el `projectKey` de su primer `cwd` y cada evento guarda su propio `cwd`.
- **Precios (decidido):** vienen de las páginas oficiales de cada proveedor, con fecha. Un modelo que no se pueda verificar queda sin precio.
- **Relevo sin huecos:** cada snapshot REST devuelve un `cursor` (el `max(id)` leído en la misma lectura síncrona) y el stream arranca desde ahí. La UI aplica una sola regla idempotente: `si e.id <= lastApplied, se ignora`.

---

## Evidencia de formatos reales (verificada 2026-09-24)

Solo se registran conteos y formas de campos, sin contenido. Los scripts de medición corrieron en scratchpad y no forman parte del repo.

### Claude Code (`~/.claude/projects`, versiones 2.1.231–2.1.281)

Muestra: 200 transcripts principales modificados en los últimos 30 días (202,225 líneas) y 1,109 transcripts de subagentes.

- **Layout.** Principal en `<root>/<slug>/<sessionId>.jsonl`. Subagente en `<root>/<slug>/<sessionId>/subagents/agent-<agentId>.jsonl`, más `agent-<agentId>.meta.json`. En el mismo árbol conviven `<sessionId>/tool-results/*.txt` y `memory/*.md`, que no son transcripts. Los archivos tienen permisos 0600.
- **Tipos de línea: 21 en principales y 1 más en subagentes.**
  - Mapeables: `assistant`, `user` y `system`.
  - De estado, sin evento: `attachment`, `last-prompt`, `mode`, `ai-title`, `permission-mode`, `bridge-session`, `atis-latch`, `pr-link`, `queue-operation`, `file-history-snapshot`, `file-history-delta`, `frame-link`, `agent-name`, `relocated`, `worktree-state`, `cost-state`, `artifact-comment-monitor` y `artifact-autoreact-ledger`.
  - En subagentes, además: `fork-context-ref`.
- **Primera línea.** Nunca es `user` ni `assistant`: `last-prompt` en 162 casos, `queue-operation` en 32 y `mode` en 6. El primer `cwd` aparece entre las líneas 2 y 5.
- **Identidad.**
  - `sessionId` coincide con el nombre del archivo en 200/200.
  - En subagentes, `agentId` coincide con el nombre del archivo, `sessionId` con el directorio y `isSidechain: true` se cumple en el 100 %.
  - `uuid` está presente en 140,631/140,631 líneas `user`, `assistant`, `system` y `attachment`.
  - **Agrupando principal y subagentes por `uuid` (237,352 grupos), no hay ningún `uuid` con más de una variante de bytes.** En Claude, identidad de contenido e identidad nativa coinciden.
- **`cwd`.**
  - 44 de 200 sesiones tienen más de un `cwd`, y 23 de 200 caen en más de un `projectKey`.
  - 29 `cwd` ya no existen en disco (worktrees borrados).
  - En subagentes, `cwd` está en 171,605/171,605 líneas.
- **Tiempo.** 3,321 líneas tienen un `timestamp` menor que la anterior, así que el `ts` no es monótono dentro de un archivo. Las 52,087 líneas sin `timestamp` son todas de tipos de estado; ninguna línea mapeable carece de él.
- **Usage.**
  - 32,798 líneas `assistant` repiten un `message.id`, y ninguna trae un usage distinto. El challenge lo reprodujo en 60 transcripts más: 8,796 grupos, 0 discrepancias.
  - `usage.cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}` está presente en el 100 %. **El 100 % de los tokens de escritura de caché son de TTL 1 h.**
  - Modelos vistos: `claude-opus-5-5`, `claude-opus-5`, `claude-fable-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001` y `<synthetic>` (mensajes de error de API).
- **Herramientas.** El bloque `tool_use` trae `{id, name, input, caller}`. `tool_result` trae `{tool_use_id, content, is_error?}` con 735 `is_error: true`.
- **Subagentes.**
  - Hay `meta.json` en 1109/1109, con `agentType`, `description`, `spawnDepth` y `toolUseId`, más opcionales.
  - `spawnDepth = 1` en 1109/1109.
  - 164 `meta.json` "nacieron" después de su `.jsonl` (mediana: unos 17 min después). **El sidecar se reescribe.**
- **Fin de un subagente.** Se ve en el transcript del padre.
  - `user.toolUseResult` trae `{agentId, status}`: `completed` en 26 casos (síncronos) y `async_launched` en 307.
  - Para los asíncronos, un `user` con `origin.kind: "task-notification"` lleva `<tool-use-id>` y `<status>` (completed 339, killed 16, failed 9).
- **Prompts.**
  - `promptSource` toma los valores `typed` (1587), `system` (417), `queued` (91), `sdk` (32) y `suggestion_accepted` (4).
  - `origin.kind` toma `human` (1682) y `task-notification` (388).
  - Además hay 76 líneas `user` con contenido string y sin ninguno de los dos campos.
- **Compactación.** `system` con `subtype: "compact_boundary"`.
- **Fin de sesión.** **No existe** un marcador.
- **Duplicados byte a byte (40,347).** Todos son tipos de estado sin evento; no hay ninguno en `user`, `assistant` ni `system`.
- **Tamaños** (1,541 archivos). La línea más grande mide 1.36 MB y el archivo más grande 53.8 MB; la mediana es de 494 KB.

### Codex CLI (resuelve el riesgo PLAN R7)

Muestra: 280 rollouts de las versiones 0.145.0, 0.146.0-alpha, 0.154.0, 0.155.1, 0.156.0 y 0.156.1. `CODEX_HOME` no está definido.

- **Layout confirmado:** `~/.codex/sessions/YYYY/MM/DD/rollout-<YYYY-MM-DDTHH-MM-SS>-<threadId>.jsonl`. `threadId` coincide con `session_meta.payload.id` en 280/280. Los timestamps son ISO en UTC con milisegundos en el 100 %.
- **Envoltorio de cada línea:** `{timestamp, type, payload, ordinal?}`. `ordinal` solo aparece en 30,394 de 75,708 líneas, así que no sirve como `seq`.
- **Tipos de primer nivel:** `response_item`, `event_msg`, `token_usage_record` (solo desde 0.154), `turn_context`, `world_state`, `inter_agent_communication_metadata`, `session_meta` y `compacted`.
- **`session_meta` (línea 0).** Trae `id`, `session_id`, `cwd`, `cli_version`, `source` y `git`. En 84 archivos hay más de un `session_meta`: los forks copian el del padre en la línea 1.
- **Subagentes: 185 de 280 archivos.**
  - `source.subagent` puede ser `thread_spawn` (111) u `other: "guardian"` (74).
  - `session_id` es la sesión raíz y es distinto de `id`. `parent_thread_id` coincide con `session_id` en 123 casos.
  - 90 son forks y 81 traen `subagent_history_start_ordinal`: 3,356 líneas con `ordinal` menor son historia heredada, y **ninguna** es un `token_count`.
- **Tokens.**
  - `event_msg.token_count` aparece en 280/280 archivos. `info.total_token_usage` es acumulado **por hilo** y monótono dentro de un archivo: 0 retrocesos en 7,588 líneas, con 136 totales repetidos.
  - En el **primer** `token_count` de cada archivo, `total_token_usage` es igual a `last_token_usage` en sus cuatro componentes en **93/93 principales** y **183/184 subagentes**. El contador arranca en el propio hilo, así que el primer valor es la primera llamada de API de ese hilo: gasto real, no heredado.
    - El ejemplo del challenge (`total_tokens = 24154`) es uno de estos casos: su `last` también es 24154.
  - **1 archivo** (0.145.0, fork sin `subagent_history_start_ordinal`) arrastra un acumulado: su primer `total_token_usage` supera a `last` por **2,218,759 tokens**. No coincide con el total del padre en el momento del spawn (5,314,371).
  - `cached_input_tokens` es menor o igual que `input_tokens` en 4001/4001: el input **incluye** lo cacheado. `cache_write_input_tokens` vale siempre 0.
  - El modelo va en `turn_context.payload.model`: `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-6-astra` y `codex-auto-review`.
- **Mensajes y herramientas.**
  - Prompts: `event_msg.user_message`.
  - Respuestas del asistente: `response_item.message` con `role=assistant`, duplicadas en `event_msg.agent_message`.
  - Herramientas: `response_item.function_call` / `custom_tool_call` (`call_id`) más su `*_output`.
- **Duplicados byte a byte dentro de un archivo (841).** Son reemisiones con el mismo ms: `response_item.message` (412), `event_msg.agent_message` (416), `user_message` (3) y `token_count` (8).
- **Misma línea lógica con bytes distintos** (búsqueda dirigida que pidió el challenge):
  - **14** `event_msg.user_message` con el mismo texto que otro del mismo archivo, que difieren **solo en `timestamp`** (1–23 ms de diferencia, dentro de ráfagas de reescritura de historia con `task_started`).
  - **3** `response_item.message` con el mismo `payload.id` en dos archivos de la misma sesión, sin estar marcados como heredados (forks sin start ordinal). Otros 199 casos similares sí son historia heredada marcada.
  - 305 `token_count` con el mismo total y bytes distintos, que son inocuos porque el delta es 0.
- **Tamaños.** La línea más grande mide 4.46 MB y el archivo más grande 26.5 MB.

### Bun 1.4.2 en macOS

- **`fs.watch(root, { recursive: true })`.**
  - Reporta rutas anidadas relativas, incluidas las de directorios nuevos, con menos de 50 ms de latencia.
  - El tipo de evento es siempre `rename`, incluso para un append.
  - 5 appends rápidos llegan como 1 solo evento.
  - Aparece un evento viejo de antes de crear el watcher.
- **`Bun.serve`.** El `idleTimeout` por defecto es de 10 s (`bun-types` `serve.d.ts`). `Server.timeout(request, 0)` lo desactiva por request.

---

## Qué existe hoy

**En este repo (`origin/main`):**

- **`packages/core/src/crow-event.ts`, `CrowEvent`.** `id` está documentado como "ulid; global order" y `seq` como "position in the source (line/offset) for dedupe". No hay campos para `cwd`, agente ni error. `CrowEventUsage` no separa la caché de 1 h. Se extiende de forma aditiva.
- **`packages/core/src/project-key.ts`, `projectKey` / `resolveProjectRoot`.** Termina en `realpathSync(cwd)`, que **lanza una excepción** si el `cwd` no existe. Hay que endurecerlo (D11).
- **`apps/server/src/server.ts`.**
  - `startServer` hace bind a `127.0.0.1`. `handleRequest` sirve `/healthz` y los estáticos con `isInside`.
  - El handler no recibe `server`.
  - Se extiende.
- **`apps/web/vite.config.ts`.** Proxy de `/api` y `/healthz` hacia `127.0.0.1:CROW_PORT`, sin puerto fijo para Vite.
- **`package.json` raíz, `workspaces: ["apps/*", "packages/*"]`.** No incluye `packages/adapters/*`. `apps/server/tsconfig.json` resuelve `@crow/core` por `paths`; se sigue ese patrón.

**En navori-harness (solo lectura, `origin/main` `d7f95d73`):**

- **`packages/cli/src/lib/audit/parse.ts`.**
  - `readJsonl` lee archivos completos.
  - `sumTokens` deduplica por `message.id` **dentro de un transcript**.
  - `usageOf` mapea los contadores.
  - `parseAgentRun` lee `.meta.json` y tolera un sidecar corrupto.
  - `parseSession` descubre los subagentes y recupera `subagent_type`.
  - Helpers de narrowing: `isRec`, `str`, `num`, `arr` y `path`.
- **`packages/cli/src/lib/audit/report.ts`.** `weightedTokens`, junto con `OUTPUT_MULTIPLIER`, `CACHE_WRITE_MULTIPLIER`, `CACHE_READ_MULTIPLIER_DEFAULT`, `CACHE_READ_MULTIPLIER_OVERRIDES` y `cacheReadMultiplier`. **No hay tabla de precios en USD.**
- **Fixture `packages/cli/src/__tests__/fixtures/audit/-tmp-fixture-repo/`.** Es sintético. Tiene `msg_dup` duplicado, JSON inválido, un tipo desconocido, `permission-mode` dos veces y dos subagentes que **reusan `message.id: "sa_1"` con usages distintos**. Los oráculos están en `parse.test.ts` ("parse: token dedupe", "parse: subagents") y en `report.test.ts` ("weightedTokens: cache_read weighted per model (#927)").

### Qué se porta y cómo

| Origen (navori-harness) | Destino | Modo | Por qué |
|---|---|---|---|
| `report.ts` `weightedTokens` + las 4 constantes + `cacheReadMultiplier` (con sus doc comments) | `packages/core/src/weighted-tokens.ts` | **Copia literal**, con cabecera de procedencia: la ruta más `21f6c054`, el último commit que toca el archivo, alcanzable desde `origin/main`. Antes de copiar, B1 corre `git diff 21f6c054 origin/main -- <ruta>`, que debe salir vacío. El parámetro pasa a `Pick<CrowEventUsage, "input"\|"output"\|"cacheRead"\|"cacheCreation">` | R21 |
| `report.test.ts` "weightedTokens: cache_read weighted per model (#927)" (6 casos) | `packages/core/src/weighted-tokens.test.ts` | **Copia literal**, marcada `// Covers: R21` | Oráculo |
| `parse.ts` `isRec`, `str`, `num`, `arr`, `path` | `packages/core/src/narrow.ts` | **Copia literal** | Parseo defensivo |
| `parse.ts` `usageOf` | `adapters/claude` | **Reescritura**, con el mismo mapeo de los 4 contadores. Se suma `ephemeral_1h_input_tokens` y se quita `thinking` | Incremental |
| `parse.ts` `sumTokens` | store: dedupe de usage | **Reescritura**, con un conteo por `message.id` y transcript. Gana el primero y se agrega la guarda `usage-anomaly` | Sin releer el archivo |
| `parse.ts` `parseAgentRun` + fallback de `subagent_type` | `adapters/claude` `parseSidecar` + `openCalls` | **Reescritura** | El sidecar se reescribe |
| `parse.ts` regla de prompt | `adapters/claude` | **Reescritura extendida** | Prompts `queued`/`sdk` |
| Fixture `-tmp-fixture-repo/` | `fixtures/claude/navori-audit/-tmp-fixture-repo/` | **Copia byte a byte** (commit `b8dfe74c`) | Paridad |
| `readJsonl`, skills, MCP, artifact writes, permission modes, classifier, verdicts, overlaps, `attachHookEvents` | — | **No se porta** | F2/F3; `readJsonl` lo reemplaza el tailer |

## Drivers de decisión

1. **Agnóstico de motor** (PLAN §2.1). Toda la mecánica de archivos (R5–R10) vive una sola vez en el núcleo.
2. **Pasivo y de solo lectura** (PLAN §2.2 y §2.5).
3. **Local-first y privacidad** (PLAN §2.3 y §2.6, riesgo R2).
4. **Tolerancia a *format drift*, nunca en silencio** (riesgo R1). Toda anomalía termina en `ingest.error` o en un contador observable.
5. **Sin duplicados ni huecos** (aceptación 3 de F1, R16 y R24).
6. **Latencia < 2 s** (R29) y árboles grandes baratos (riesgo PLAN R9).
7. **Simple de leer en 6 meses** (PLAN §2.8 y CLAUDE.md). Sin dependencias nuevas y con `any` prohibido.
8. **Escalera de reutilización:** patrón existente, luego extensión pequeña, luego abstracción nueva, luego subsistema. Es un driver más, no el ganador por defecto.

## Approach

**Opciones exploradas para la ingesta:**

- **Peldaño 1, patrón existente (port de `parseSession`, re-parsear el archivo completo).** Se descarta porque viola R6 y R8 y relee archivos de hasta 53.8 MB en cada append.
- **Peldaño 2, un tailer por adaptador.** Se descarta porque duplica offsets, inode, truncado, líneas parciales y backfill en cada motor.
- **Peldaño 3, tailer genérico en core y adaptadores puros de línea. Elegido.** El adaptador es una función pura `(línea, estado) → (eventos, estado')`, y el tailer genérico se encarga de todo el I/O, del estado y de los errores.
- **Peldaño 4, un proceso o worker de ingesta aparte.** Se descarta porque trae dependencias nuevas y el orden entre procesos complica R24.

**Flujo elegido (un solo proceso y un solo hilo, que además es el único escritor):**

```
fs.watch (pista) ─┐
poll caliente 1s ─┼─► scheduler (cola hot > cola backfill) ─► readChunk(path, offset)
rescan 30s ───────┘        │ bytes → líneas completas (la parcial queda en disco)
                           ▼
            adapter.parseLine(línea, estado) → PartialCrowEvent[] (+ warnings) | error
                           ▼
            pipeline: engine/source/seq, lineKey=sha1(bytes), ingest.error
                           ▼
   store.ingestBatch  ── UNA transacción: dedupe (contenido + semántica) → sesión/proyecto
                         → usage/costo → totales (sesión, agente, día) → estado
                         → INSERT events (id ULID) → UPSERT ingest_offsets → ingest_stats
                           ▼ commit
                   bus.publish(eventos en orden de id)
                           ▼
         SSE /api/stream (replay por id, o reset)      REST /api/* (snapshot + cursor)
                           ▼
            UI Svelte 5: snapshot REST → stream desde cursor → reducers idempotentes
```

Como `bun:sqlite` es síncrono y JS tiene un solo hilo:

- el orden de commit es el orden de los `id` y es el orden de publicación;
- cualquier lectura síncrona ve un snapshot consistente con su `max(id)`.

Sobre esas dos propiedades se sostienen R4, R22, R24 y R33.

---

## Components

### `packages/core` (núcleo agnóstico; PLAN §6.3)

- **`src/crow-event.ts`.** `CrowEvent` con extensiones aditivas (§Contracts). Cubre R11, R12, R14, R15 y R20.
- **`src/adapter.ts`.** `EngineAdapter<S>`, `FileMatch`, `LinePos`, `LineResult<S>`, `AgentMetaPatch`, `JsonValue`, `PartialCrowEvent` y `bindAdapter`, que borra el genérico `S` sin `any`. Cubre R5, R10–R14 y R16.
- **`src/narrow.ts`.** Helpers portados. Cubre R10 y R11.
- **`src/types.ts`.** Barril solo de tipos, expuesto como `@crow/core/types` para la web. Cubre R25–R27 y R30–R33.
- **`src/api-types.ts`.** DTOs de REST y SSE. Cubre R23–R27.
- **`src/project-key.ts`.** Endurecido (D11). Cubre R15.
- **`src/ulid.ts`.** `createUlidFactory(seed)` monotónico, más `ulidTime(id)`. Cubre R23 y R24.
- **`src/weighted-tokens.ts`.** Port literal. Cubre R21.
- **`src/pricing.ts`.** Tabla por modelo, `priceFor` y `costUsd`. Cubre R20.
- **`src/config.ts`.** `loadConfig(env, homeDir)` es el **único** lugar que lee `env` u `homedir`. Cubre R1, R9, R14, R18 y R28.
- **`src/store/db.ts`.** `openDatabase(home)` con WAL y permisos 0700/0600. Cubre R1 y R3.
- **`src/store/migrations.ts`.** `MIGRATIONS` y `migrate(db, migrations)` sobre `PRAGMA user_version`. Cubre R2.
- **`src/store/store.ts`.** `ingestBatch` (una transacción), `upsertAgentMeta`, `sweepIdle`, `getOffset`, `hasEvent`, `stats` y las lecturas para la API. Cubre R4, R6, R13, R15–R19 y R24–R27.
- **`src/bus.ts`.** `EventBus`. Cubre R22.
- **`src/tailer/line-reader.ts`.** Lectura por bytes, línea parcial sin consumir y salto de líneas demasiado largas. Cubre R6–R8.
- **`src/tailer/tailer.ts`.** Discovery, backfill por grupo, scheduler, watcher, poll, rescan y sidecars. Cubre R5–R10.
- **`src/ingest.ts`.** `PartialCrowEvent` a `CrowEvent` (`engine`, `source`, `seq`, `lineKey`), errores y warnings a `ingest.error`, luego `store` y luego `bus`. Cubre R10, R16 y R22.

### `packages/adapters/claude` (`@crow/adapter-claude`, puro)

- **`src/adapter.ts`.** `watchRoots` (`${CLAUDE_CONFIG_DIR ?? ~/.claude}/projects`), `matches`, `groupKey = <slug>/<sessionId>`, `initialState`, `restoreState`, `parseLine` y `parseSidecar`. Cubre R11–R13.
- **`src/map-line.ts`.** §Mapeo Claude. Cubre R11–R13 y R16.
- **`src/sidecar.ts`.** `.meta.json`; tolera JSON corrupto. Cubre R12.

### `packages/adapters/codex` (`@crow/adapter-codex`, puro)

- **`src/adapter.ts`.** `watchRoots` (`${CODEX_HOME ?? ~/.codex}/sessions`), `matches` para `YYYY/MM/DD/rollout-*.jsonl`, `groupKey` = la ruta. Cubre R14.
- **`src/map-line.ts`.** §Mapeo Codex (línea base de tokens, historia heredada, claves semánticas). Cubre R14 y R16.

### `apps/server`

- **`src/adapters.ts`.** `ENGINE_ADAPTERS: readonly BoundAdapter[]`, el registro. B5 lo crea con Claude y B8 agrega Codex. Cubre R11 y R14.
- **`src/app.ts`.** `startApp(config, opts)` con este orden:
  1. abre la DB y migra;
  2. siembra el ULID y corre `sweepIdle` una vez;
  3. levanta `Bun.serve`;
  4. arranca el tailer con `ENGINE_ADAPTERS` y el sweeper.

  Cubre R2, R18 y R29.
- **`src/index.ts`.** `loadConfig(process.env, homedir())` y luego `startApp`. Loguea solo rutas y conteos.
- **`src/server.ts`.** `handleRequest(req, server)`: guard, luego API, luego estáticos. Cubre R28.
- **`src/guard.ts`.** `checkRequest(headers, port, allowedOrigins)`, puro. Cubre R28.
- **`src/api.ts`.** Handlers REST síncronos. Cubre R25–R27 y R33.
- **`src/sse.ts`.** Suscripción, validación del cursor (`reset`), replay paginado, buffer, heartbeat y `server.timeout(req, 0)`. Cubre R23 y R24.

### `apps/web` (Svelte 5 runes, sin librerías)

- **`src/lib/router.svelte.ts`.** `#/`, `#/split/<k1>,<k2>[,<k3>[,<k4>]]` y `#/session/<id>`. Cubre R30–R32.
- **`src/lib/api.ts` y `src/lib/stream.ts`.** Clientes tipados con `import type`. `openStream` maneja `reset` y resincroniza. Cubre R33.
- **`src/lib/reduce/*.ts`.** Reducers puros con la regla del cursor. Cubre R30–R33.
- **`src/lib/state/*.svelte.ts`.** Clases con `$state`. Cubre R30–R33.
- **`src/views/Home.svelte` + `ProjectCard.svelte`.** Cubre R30.
- **`src/views/Split.svelte` + `FeedColumn.svelte`.** Cubre R31.
- **`src/views/Session.svelte` + `Timeline.svelte` + `AgentTree.svelte` + `CostPanel.svelte`.** Cubre R32.

### `fixtures/` y `scripts/` (raíz, PLAN §6.3)

- **`fixtures/claude/navori-audit/…`.** Copia del fixture de navori. Cubre R13 y R21.
- **`fixtures/claude/cc-2.1.267/…`, `fixtures/codex/0.145.0/…` y `fixtures/codex/0.155.1/…`.** Reales y anonimizados. Cubre R11, R12, R14 y R16.
- **`scripts/anonymize-fixture.ts`.** Anonimizador por allowlist de claves. Cubre R11 y R14 y mitiga el riesgo R1.

---

## Decisions

Cada decisión trae lo que se elige, el porqué, lo que se descarta (una línea cada alternativa) y lo que cuesta revertirla.

### D1 — Layout de paquetes (R5–R16)

- Se sigue PLAN §6.3: `core` tiene store, bus, pricing, `projectKey`, tipos y el **tailer genérico** (agnóstico de motor, principio §2.1). `packages/adapters/{claude,codex}` son parsers puros. `apps/server` solo cablea.
- La web importa **solo tipos** por `@crow/core/types`.
- Se agrega `"packages/adapters/*"` a `workspaces`, y `@crow/core` gana `exports: {".": "./src/index.ts", "./types": "./src/types.ts"}`.
- `apps/server/src/adapters.ts` concentra el registro de motores, para que agregar uno toque un solo archivo.
- *Descartado:* paquetes `store` y `tailer` separados, que son boilerplate sin un consumidor aparte.
- *Descartado:* un tailer por adaptador.
- *Reversión:* barata.

### D2 — Migraciones con `PRAGMA user_version` (R2)

- `MIGRATIONS` es un arreglo ordenado de `{ version, sql }`.
- Los PRAGMA se aplican fuera de cualquier transacción. Si `user_version < latest`, las migraciones pendientes corren en orden dentro de una sola `BEGIN IMMEDIATE … COMMIT` junto con `PRAGMA user_version = N`.
- Si alguna falla, se hace rollback, `startApp` rechaza y el servidor no llega a escuchar. Con `user_version > latest`, también rechaza.
- F1 entrega solo la migración 1.
- *Descartado:* una tabla `schema_version`.
- *Reversión:* barata.

### D3 — Esquema v1 (R1, R4, R6, R13, R16, R25–R27)

Son las tablas de §7.2, con estos ajustes:

1. **Totales como columnas numéricas `t_*`**, que permiten un `UPDATE` atómico sin leer antes. *Descartado:* `totals_json`, que obliga a leer, modificar y escribir.
2. **`events` lleva `project_key`**, necesario para el índice `(project_key, ts)`. También lleva `call_id`, y el `cwd` va en el cuerpo, que es lo que exige R15.
3. **`project_daily`**, para "tokens y costo del día", mantenida en la misma transacción. *Descartado:* agregar `json_extract` en cada request.
4. **`dedupe.fp`**, la huella del usage contado, para detectar usages discrepantes (D7).
5. **`ingest_stats`**, contadores observables: descartes semánticos, anomalías de usage y errores por razón.

**Índices.** `events(session_id, id)`, `events(project_key, ts)`, `sessions(project_key, last_event_at)`, `sessions(status, last_event_at)` y `agents(session_id)`. `events(session_id, ts)` de §7.2 se difiere hasta la primera consulta por rango de `ts` dentro de una sesión (F3), porque en F1 no tendría lector.

**Reversión:** media para las columnas `t_*`, baja para el resto.

### D4 — Tailer híbrido sobre macOS (R5, R29; riesgo PLAN R9)

- **`fs.watch(root, {recursive: true})`, uno por raíz.** Da la pista; el tailer siempre hace `stat` y lee hasta el EOF.
- **Poll caliente cada 1 s** a los archivos modificados o ingeridos dentro de la ventana de idle.
- **Rescan cada 30 s:** `readdir` recursivo más `stat`, con reintento de las raíces que no existían.
- **Probe de capacidad al arrancar.** Si no hay watch recursivo, se pasa a "modo polling" con rescan de 5 s.
- *Descartado:* solo polling (descubrir un archivo nuevo tarda hasta el siguiente rescan).
- *Descartado:* solo `fs.watch` (FSEvents puede perder eventos).
- *Descartado:* chokidar (dependencia nueva).
- *Reversión:* barata.

### D5 — Offsets, inode, truncado y líneas parciales (R6–R8, R10)

- **Por archivo:** `stat({bigint: true})` contra `ingest_offsets`. Si cambió el inode o `size < byte_offset`, el archivo es nuevo: offset 0 y estado inicial (R7). Se leen hasta 8 MiB por paso y se corta en `0x0A` a nivel de bytes; `TextDecoder` se aplica por línea.
- **Línea parcial (R8).** El offset persistido es el inicio de la primera línea incompleta, así que no hay buffer en memoria.
- **Línea más larga que el chunk.** El chunk crece hasta 16 MiB (3.5 veces el máximo observado). Por encima se emite `ingest.error line-too-long` y se salta hasta el siguiente `\n`.
- **Estado del parser (`state_json`).** Se guarda con el offset en la misma transacción que los eventos (R6). Si `restoreState` falla, se reingiere desde 0 sin duplicados (D7).
- **Invariante.** La salida de una línea es función pura de `(línea, estado previo)`, así que ingerir de una pasada o en cortes con reinicios da los mismos eventos.
- **Symlinks.** Se usa `lstat` y se ignoran.
- *Reversión:* barata.

### D6 — Backfill por ventana y por sesión, perezoso (R9; riesgo PLAN R9)

- **Grupos con algún archivo cuyo mtime cae en la ventana** (24 h por defecto). Entra el grupo completo, con el principal antes que los agentes y los grupos ordenados por mtime descendente.
- **Archivos con offset persistido que crecieron o cambiaron de inode.** Se ponen al día siempre.
- **El resto no se lee.** Si un archivo viejo cambia, se lee desde 0.
- **Scheduler.** La cola hot pasa antes que la de backfill. Cada paso procesa como máximo 1,000 líneas u 8 MiB en una transacción, con `await` entre pasos. Un archivo en proceso se marca "dirty" y se reencola.
- **Codex.** `groupKey` es la propia ruta, porque la raíz de la sesión solo se conoce leyendo la línea 0.
- *Reversión:* barata.

### D7 — Identidad de evento y dedupe (R13, R16; R16 decidido por el usuario)

**Identidad primaria (R16, literal).**

- `dedupe(source, session_id, key)`, con `key = "l:" + sha1(bytes de la línea) + ":" + índice del evento en la salida de la línea`. El sha1 va completo: 40 hex. Los errores y warnings usan el sufijo `":e<n>"`.
- `seq` es el offset en bytes del inicio de la línea y solo es informativo; se usa en `ingest.error` (R10) junto con `line`.
- **Por qué contenido y no posición.** El offset colisiona entre los archivos de una sesión y entre los eventos de una línea, y produce falsos dedupes después de un truncado con reescritura. El contenido resiste copias y rotaciones.

**Límite conocido, explícito.** El hash solo reconoce como duplicada una línea **idéntica byte a byte**. Una reemisión de la misma línea lógica con bytes distintos pasaría como un hecho nuevo. Medido:

- en Claude, 0 casos (237,352 `uuid`);
- en Codex, 14 `user_message` que solo cambian en `timestamp` y 3 `response_item.message` con el mismo `payload.id` repartidos en dos archivos.

Para cubrir el límite:

- **Clave semántica secundaria.** El adaptador puede adjuntar `semanticKey` a un `PartialCrowEvent`. El store la registra como `s:<agentId|main>:<semanticKey>` en `dedupe`. Si la clave de contenido es nueva pero la semántica ya existe, el evento **se descarta y se cuenta** en `ingest_stats.semantic_duplicates`: queda observable y nunca en silencio.
  - Claude: `uuid:<uuid>:<parte>`.
  - Codex, `response_item` con `payload.id`: `id:<payload.id>:<parte>`.
  - Codex, herramientas: `call:<call_id>` y `out:<call_id>`.
  - Codex, `user_message`: `um:<sha1(texto)>:<ts del primer ejemplar>`. El adaptador reusa el `ts` de un prompt idéntico visto en el mismo archivo hace ≤ 1000 ms; lleva en su estado las últimas 32 huellas.
- **Alcance limitado al archivo o agente**, de forma deliberada. Así los 14 casos quedan cubiertos y no se corre el riesgo de atribuir mal: si un fork se procesa antes que su padre, una clave con alcance de sesión le daría el evento al subagente. Las 3 copias entre archivos de forks sin start ordinal quedan como limitación documentada (solo 0.145.0; es texto sin usage).
- *Descartado:* reemplazar la identidad por una clave semántica. Viola la letra de R16 y no hay un id nativo en todas las líneas de Codex.
- *Descartado:* no hacer nada. El challenge lo marcó bien: los 14 casos existen.

**Usage de Claude (R13).**

- `usageKey = "u:" + (agentId ?? "main") + ":" + message.id`, con alcance de sesión y agente. El fixture de navori reusa `sa_1` en dos agentes con usages distintos.
- Gana el primero: el evento duplicado se guarda **sin `usage`**, de modo que "un evento trae `usage`" equivale a "ese usage se contó".
- **Guarda que no calla.** `dedupe.fp` guarda la huella del primer usage (`input`, `output`, `cacheRead`, `cacheCreation`, `cacheCreation1h`). Si un duplicado trae otra huella:
  - se mantiene el primero, como decidió el orchestrator;
  - se genera `ingest.error` con `reason: "usage-anomaly"` y `error.message` con el `message.id` y las dos huellas numéricas, sin contenido;
  - se incrementa `ingest_stats.usage_anomalies`.

  La evidencia es de 0/32,798 y 0/8,796 casos, así que no hay ruido esperado.

**Usage de Codex (corrige el BLOCKER 1).**

- **Regla:**
  - En el **primer** `token_count` con `info` que ve un estado sin línea base (archivo nuevo o reinicio por R7), el `usage` es `last_token_usage` y `state.lastTotal = total_token_usage`.
  - En los siguientes, el `usage` es el delta de `total_token_usage` contra `state.lastTotal`, componente por componente. Un delta de 0 no emite evento; con eso los 136 totales repetidos no cuentan dos veces.
  - Si algún componente del delta es negativo (el contador retrocede; 0 casos observados), el `usage` es `last_token_usage`, se fija una nueva línea base y el adaptador devuelve un warning que el pipeline convierte en `ingest.error usage-anomaly`.
- **Por qué.** En 93/93 principales y 183/184 subagentes el primer `total` es igual al `last`: el contador empieza en el hilo, y la regla anterior daba el mismo resultado. En el único archivo con acumulado arrastrado (2,218,759 tokens), la regla nueva cuenta solo su `last_token_usage` y deja fuera lo arrastrado.
- *Descartado (A):* no contar el primer `token_count`. Sub-contaría la primera llamada real de API en 183/184 subagentes, entre 15k y 35k tokens cada una.
- *Descartado (B):* sembrar con el total del padre en el momento del fork. Obliga a buscar en otro archivo, lo que rompe la pureza del adaptador, y además la evidencia muestra que el acumulado arrastrado (2,218,759) no es igual al total del padre (5,314,371): el modelo sería falso.
- **Costo de la regla elegida.** Si el primer `token_count` de un archivo cubriera varias respuestas (porque se perdió una línea anterior), se contaría solo la última. No se ha observado.

**Reversión:** cara una vez que haya datos, porque cambia la identidad. Por eso se decide ahora y queda fijada por R16.

### D8 — Proyecto pegajoso por sesión (R15; decidido por el usuario)

- **Regla (R15).** `sessions.project_key` se resuelve con `projectKey(cwd)` del **primer** evento de la sesión que trae `cwd`. La asignación se mantiene toda la sesión, y cada evento guarda su propio `cwd` (`CrowEvent.cwd`, dentro de `body_json`).
- **Evidencia.** 23 de 200 sesiones cruzan proyectos. Con claves por evento, la tarjeta de un proyecto mostraría eventos de sesiones que no aparecen en su lista.
- **Sesión sin `cwd` todavía** (solo pasa con `ingest.error` o con un subagente procesado antes que su principal, como en el fixture de navori). Queda en el proyecto reservado `unresolved`. El primer `cwd` real hace la asignación de R15: `UPDATE sessions` y `UPDATE events SET project_key` de esa sesión, en la misma transacción.
- *Reversión:* baja, porque el `cwd` de cada evento queda guardado.

### D9 — `id` = orden de ingesta, ULID monotónico y cursores robustos (R23, R24, R33; corrige el HIGH 2)

- **Generación.** `createUlidFactory(seed)` produce 48 bits de ms y 80 aleatorios en Crockford base32. Si el reloj no avanza o retrocede respecto del último `id`, incrementa el componente aleatorio del último. La asignación ocurre **dentro** de `ingestBatch`, en orden.
- **Semilla.** Al arrancar, la semilla es el mayor entre `SELECT max(id) FROM events` y un ULID de `Date.now()`. Si `ulidTime(max(id)) > Date.now() + 60 s` (el reloj retrocedió con la DB intacta), se emite un warning en el log y se sigue en modo monotónico: los `id` nuevos siguen siendo mayores que todo lo guardado.
- **Qué significa el orden.** Un evento de backfill con `ts` viejo recibe un `id` nuevo. Por eso el replay `id > cursor` lo incluye. La UI ordena por `(ts, id)`.
- **Cursor desconocido (el caso compuesto del challenge).** El servidor **no confía** en que un cursor sea menor que los `id` futuros. Todo cursor que llega (el header `Last-Event-ID` o el query `after` del stream, o el `after` de `/api/sessions/:id/events`) se valida con `store.hasEvent(id)`, una búsqueda por PK.
  - Si no existe (DB borrada o recreada, reloj atrás, o un `id` de otra instalación), en SSE se envía `event: reset` con `data: {"reason":"unknown-cursor"}` y se cierra el stream. En REST se responde 409 `{ error: "unknown-cursor" }`.
  - El cliente descarta su estado, vuelve a pedir el snapshot REST y abre el stream con el `cursor` nuevo.
  - Así, "DB nueva con reloj atrás" deja de ser una sesión colgada sin señal: se vuelve una resincronización explícita.
- **Cursor mayor que cualquier `id` actual pero existente:** no puede ocurrir, porque si existe es un `id` guardado.
- *Descartado:* `Bun.randomUUIDv7()`, que solo es monotónico dentro del proceso.
- *Descartado:* un contador `INTEGER`, que no sobrevive a una DB recreada.
- *Descartado:* confiar en el prefijo temporal. Es el supuesto que el challenge demostró falso.
- *Reversión:* cara, porque es un contrato de cliente. Se decide ahora.

### D10 — Estado de sesión derivado del `ts` del evento (R17–R19)

- **Por evento.** `last_event_at = max(last_event_at, ts)`; `ingest.error` no cuenta.
- **Estado.** `session.end` pasa a `ended`. Si no, un `ts >= now − idle` pasa a `live`, incluso desde `ended` (reanudación). Si no, queda `idle`, salvo que ya estuviera `ended`. Es una lectura [assumed] de R17: evita que el backfill marque como `live` sesiones viejas.
- **Sweeper (R18).** Cada 30 s y una vez al arrancar: `UPDATE sessions SET status='idle' WHERE status='live' AND last_event_at < now − idle`.
- **La UI** reevalúa `live → idle` con `lastEventAt` e `idleMs` cada 15 s. *Descartado:* eventos sintéticos de estado en el SSE.
- **Hallazgo.** Ningún adaptador de F1 emite `session.end`; R19 se prueba con un evento sintético y se activa en F2.
- *Reversión:* barata.

### D11 — `projectKey` nunca lanza (R15)

- Si el `cwd` existe, se usa el algoritmo actual.
- Si no existe, se busca el ancestro existente más cercano y se prueba `git --git-common-dir` desde ahí: si está en un repo, se usa la raíz del repo.
- Si no hay repo, `key = sha1(cwd literal)` y `path = cwd`.
- Cualquier error de `git` o `realpath` cae en el mismo fallback.
- *Descartado:* lanzar, que perdería sesiones de worktrees borrados.
- *Reversión:* barata.

### D12 — Pricing y `weightedTokens` (R20, R21; valores decididos por el usuario)

- **Fuente de los valores (decidido).**
  - Salen de las páginas oficiales de precios de cada proveedor (Anthropic y OpenAI).
  - Cada entrada lleva `verifiedAt` (fecha) y la URL de la fuente en un comentario.
  - Un modelo cuyo precio no se pueda verificar **no entra** en la tabla, así que su `costUsd` queda sin definir (R20).
  - Modelos a revisar: `claude-opus-5-5`, `claude-opus-5`, `claude-fable-5`, `claude-sonnet-5`, `claude-haiku-4-5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-6-astra` y `codex-auto-review`.
- **Formato.** `pricing.ts` es un módulo TS tipado: `Record<string, ModelPrice>` en USD por millón de tokens, con `{ input, output, cacheRead, cacheWrite5m, cacheWrite1h }`. *Descartado:* un JSON de usuario (override en F5).
- **Match exacto tras normalizar** (minúsculas y sin sufijo `-YYYYMMDD`), **nunca por substring**, porque `claude-opus-5` y `claude-opus-5-5` coexisten.
- **Costo:** `(input·pIn + output·pOut + cacheRead·pCR + (cacheCreation − cacheCreation1h)·pW5m + cacheCreation1h·pW1h) / 1e6`. La caché de 1 h es el 100 % de las escrituras reales.
- **Modelo desconocido.** `costUsd` queda sin definir, los tokens cuentan y el total incrementa `t_unpriced`.
- **`weightedTokens`.**
  - Es la función portada literal, aplicada por evento con su propio modelo y sellada en `usage.weightedTokens`.
  - En sesiones de un solo modelo coincide con el cálculo de navori sobre el total.
  - Conserva el 1.25x de escritura de caché de navori: manda la paridad (R21), y el costo en USD es el preciso.
- *Reversión:* barata.

### D13 — Bus y SSE (R22–R24)

- **Bus.** `EventBus.publish(events)` es síncrono y solo se llama **después del commit** (R22).
- **Cursor.** `/api/stream` acepta `project` (repetible), `session` y `after`. `Last-Event-ID` tiene precedencia sobre `after`. Todo cursor se valida primero (D9): si es desconocido, se envía `event: reset` y se cierra.
- **Relevo sin huecos (R24):**
  1. Se suscribe al bus en modo buffer.
  2. Se hace el replay paginado (500 por página) con `id > cursor` más el filtro, con `await` entre páginas.
  3. Se vacía el buffer con `id > lastSent`.
  4. Se pasa a modo live.
- **Frames.** Al inicio va `retry: 2000`. Cada evento viaja como `id: <ulid>` más `data: <CrowEvent JSON>`. `event: reset` es el único evento con nombre. El heartbeat es `: hb` cada 15 s con un único `setInterval` (R23).
- **Idle timeout de Bun.** `server.timeout(req, 0)`.
- **Consumidor lento.** Si `controller.desiredSize < −1000`, se cierra el stream y el cliente reconecta con `Last-Event-ID`.
- **Un `EventSource` por vista**, por el límite de 6 conexiones de HTTP/1.1.
- *Descartado:* replay síncrono antes de suscribirse (bloquea con replays grandes).
- *Reversión:* barata.

### D14 — Guard de Host y Origin y modo dev (R28)

- **Regla para `/api/*`.** 403 si el hostname de `Host` no está en `{127.0.0.1, localhost, ::1}`, o si hay un `Origin` que no está en `{http://127.0.0.1:<port>, http://localhost:<port>, http://[::1]:<port>} ∪ CROW_ALLOWED_ORIGINS`. `Origin: null` se rechaza. Sin `Origin` se permite.
- **Modo dev.** Vite fija `port: 5173` y `strictPort`, y deja `changeOrigin` en falso. El script `dev` del server exporta `CROW_ALLOWED_ORIGINS=http://localhost:5173`.
- *Descartado:* quitar el `Origin` en el proxy.
- `/healthz` y los estáticos quedan fuera del guard.
- *Reversión:* barata.

### D15 — Qué se guarda del contenido (riesgo PLAN R2)

- `text`: hasta 8 KiB.
- `tool.input`: recortado (strings de 1 KiB, profundidad 3, 30 claves).
- El texto de `tool.error`: hasta 1 KiB.
- **No se guardan** `raw`, el output de las herramientas, `thinking`, `encrypted_content` ni las instrucciones base.
- Los logs solo llevan ruta, offset y conteos.
- *Reversión:* barata hacia más contenido para lo que venga después, e imposible para lo ya ingerido.

### D16 — UI: estado, ruteo y relevo backfill→stream (R30–R33)

- **Router por hash** con `$state`.
- **Reducers puros envueltos en runes.**
- **Regla única del cursor.** `apply(e)` ignora los `e.id <= lastApplied`.
- **Home.** `GET /api/projects` (`{cursor, projects}`), luego `openStream({}, after: cursor)`. `applyToProjects` hace upsert de tarjeta y sesión con los datos del evento y suma el `usage` sellado al "día" si el `ts` cae en hoy.
- **Split.** `GET /api/events?project=k&limit=200` por proyecto, una conexión desde el cursor mínimo y un `lastApplied` por columna.
- **Detalle.** `GET /api/sessions/:id` y la paginación de eventos; los paginados con `id > cursor` suman al total. El stream arranca desde el último `id` paginado. Con `agent.*`, un refetch con debounce trae los metadatos de los agentes.
- **`reset` o 409 `unknown-cursor`.** `openStream` cierra el `EventSource`, la vista vuelve a pedir su snapshot y reabre desde el cursor nuevo (D9).
- **Sin virtualización en F1.** Tope de render de 500 con "mostrar anteriores". Tema claro y oscuro por CSS.
- *Reversión:* barata.

---

## Contracts

### `CrowEvent`: extensiones aditivas (`packages/core/src/crow-event.ts`)

```ts
export interface CrowEventUsage {
  input: number; output: number; cacheRead: number; cacheCreation: number;
  cacheCreation1h?: number;   // subset of cacheCreation billed at the 1h TTL rate
  model?: string;
  costUsd?: number;           // stamped by core; undefined = model not priced (R20)
  weightedTokens?: number;    // stamped by core with the ported function (R21)
}

export interface CrowEventAgent {
  type?: string; description?: string; spawnCallId?: string; depth?: number;
  outcome?: "completed" | "failed" | "killed";
}

export type IngestErrorReason =
  | "invalid-json" | "unknown-type" | "bad-shape" | "line-too-long" | "usage-anomaly";

export interface CrowEventError {
  message: string;            // short, ≤ 1 KiB, no source content
  reason?: IngestErrorReason; // ingest.error only
  path?: string; offset?: number; line?: number;
}

export interface CrowEvent {
  // …existing fields unchanged; `id` doc becomes "ULID; global ingestion order"
  cwd?: string;               // the event's own cwd (R15)
  agent?: CrowEventAgent;     // agent.start / agent.stop
  error?: CrowEventError;     // tool.error / ingest.error
}
```

### Contrato de adaptador en F1 (`packages/core/src/adapter.ts`)

```ts
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export type PartialCrowEvent =
  Omit<CrowEvent, "id" | "engine" | "source" | "projectKey" | "projectPath" | "seq">
  & {
    usageKey?: string;        // R13: usage counted once per key within session+agent
    semanticKey?: string;     // D7: secondary identity, scoped to the agent/file
  };

export interface FileMatch {
  role: "main" | "agent" | "sidecar";
  groupKey: string;
  sessionId: string | null;
  agentId: string | null;
  sidecarPath: string | null;
}

export interface LinePos { path: string; offset: number; line: number }

export interface LineWarning { reason: IngestErrorReason; detail: string }

export type LineResult<S extends JsonValue> =
  | { ok: true; events: PartialCrowEvent[]; warnings?: LineWarning[]; state: S }
  | { ok: false; reason: IngestErrorReason; detail?: string;
      sessionId: string; agentId: string | null; state: S };

export interface AgentMetaPatch {
  sessionId: string; agentId: string;
  type?: string; description?: string; spawnCallId?: string; depth?: number;
}

export interface EngineAdapter<S extends JsonValue> {
  readonly id: EngineId;
  watchRoots(cfg: CrowConfig): string[];
  matches(path: string, root: string): FileMatch | null;
  initialState(match: FileMatch, sidecarText: string | null): S;
  restoreState(json: unknown, match: FileMatch): S | null;   // null → re-ingest from 0
  parseLine(line: string, state: S, pos: LinePos): LineResult<S>;  // pure, never throws
  parseSidecar?(text: string, match: FileMatch): AgentMetaPatch | null;
}
```

- Lo que se difiere de §8: `fromHook`, `fromOtel`, `connect` y `attach` (F2).
- `matches` devuelve un `FileMatch` en lugar de un booleano.
- Los errores y warnings se devuelven en lugar de lanzarse, y el pipeline arma los `ingest.error`.

### Esquema v1 (`packages/core/src/store/migrations.ts`, migración 1)

PRAGMA al abrir, fuera de cualquier transacción: `journal_mode = WAL`, `synchronous = NORMAL`, `foreign_keys = ON`, `busy_timeout = 5000`.

```sql
-- totals column group, repeated as T below:
--   t_input INTEGER NOT NULL DEFAULT 0, t_output INTEGER NOT NULL DEFAULT 0,
--   t_cache_read INTEGER NOT NULL DEFAULT 0, t_cache_creation INTEGER NOT NULL DEFAULT 0,
--   t_cache_creation_1h INTEGER NOT NULL DEFAULT 0, t_weighted REAL NOT NULL DEFAULT 0,
--   t_cost_usd REAL NOT NULL DEFAULT 0, t_unpriced INTEGER NOT NULL DEFAULT 0

CREATE TABLE projects (
  key TEXT PRIMARY KEY,              -- projectKey | 'unresolved'
  path TEXT NOT NULL, name TEXT NOT NULL,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  last_error_json TEXT
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,               -- `${engine}:${nativeSessionId}`
  engine TEXT NOT NULL, native_id TEXT NOT NULL,
  project_key TEXT NOT NULL REFERENCES projects(key),
  started_at INTEGER NOT NULL, ended_at INTEGER, last_event_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('live','idle','ended')),
  model TEXT, last_prompt TEXT,
  T
);
CREATE INDEX sessions_by_project ON sessions(project_key, last_event_at);
CREATE INDEX sessions_by_status  ON sessions(status, last_event_at);
CREATE TABLE agents (
  id TEXT PRIMARY KEY,               -- `${session_id}/${agent_id ?? 'main'}`
  session_id TEXT NOT NULL REFERENCES sessions(id),
  agent_id TEXT, parent_id TEXT,
  type TEXT, description TEXT, spawn_call_id TEXT, depth INTEGER, model TEXT,
  started_at INTEGER, ended_at INTEGER, last_event_at INTEGER,
  T
);
CREATE INDEX agents_by_session ON agents(session_id);
CREATE TABLE events (
  id TEXT PRIMARY KEY,               -- ULID (ingestion order)
  session_id TEXT NOT NULL REFERENCES sessions(id),
  project_key TEXT NOT NULL, agent_id TEXT, kind TEXT NOT NULL,
  ts INTEGER NOT NULL, source TEXT NOT NULL, call_id TEXT,
  body_json TEXT NOT NULL            -- full CrowEvent, including its own cwd
);
CREATE INDEX events_by_session    ON events(session_id, id);
CREATE INDEX events_by_project_ts ON events(project_key, ts);
CREATE TABLE ingest_offsets (
  path TEXT PRIMARY KEY, inode TEXT NOT NULL,
  byte_offset INTEGER NOT NULL,      -- start of first unconsumed line
  state_json TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE dedupe (
  source TEXT NOT NULL, session_id TEXT NOT NULL,
  key TEXT NOT NULL,                 -- 'l:<sha1>:<i>' | 's:<agent>:<semanticKey>' | 'u:<agent>:<message.id>'
  fp TEXT,                           -- usage fingerprint, 'u:' keys only
  PRIMARY KEY (source, session_id, key)
) WITHOUT ROWID;
CREATE TABLE project_daily (
  project_key TEXT NOT NULL, day TEXT NOT NULL,      -- local YYYY-MM-DD of event ts
  T,
  PRIMARY KEY (project_key, day)
) WITHOUT ROWID;
CREATE TABLE ingest_stats (
  name TEXT PRIMARY KEY,             -- 'semantic_duplicates' | 'usage_anomalies' | 'errors:<reason>'
  value INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
```

La columna es `byte_offset` y no `offset` porque `OFFSET` es palabra reservada de SQL.

**`ingestBatch({ path, inode, nextOffset, state, events })` corre en una sola transacción.** Por cada evento pendiente:

1. `INSERT OR IGNORE` de la clave `l:` en `dedupe`. Si no inserta nada, se salta (R16).
2. Si trae `semanticKey`: `INSERT OR IGNORE` de la clave `s:`. Si no inserta, se salta el evento y se hace `semantic_duplicates += 1` (D7).
3. Se resuelve la sesión y su proyecto (D8) y se asegura la fila del agente.
4. Si trae `usage` y `usageKey`: `INSERT OR IGNORE` de la clave `u:` con su `fp`.
   - Si no inserta, se quita el `usage`. Si además el `fp` guardado es distinto, se agrega un `ingest.error usage-anomaly` (clave `l:<sha1>:e<n>`) y se hace `usage_anomalies += 1`.
   - Si el `usage` sobrevive, se sellan `costUsd` y `weightedTokens` y se suma en sesión, agente y día.
5. Estado, `last_event_at`, `last_prompt`, `last_error_json` y los metadatos de `agent.*`, con la resolución del padre para `depth > 1`.
6. Se asigna el `id` ULID y se hace `INSERT` en `events`. Por cada `ingest.error`, `errors:<reason> += 1`.

Al final, `UPSERT` de `ingest_offsets`. Se devuelven los `CrowEvent` guardados.

### REST (`apps/server/src/api.ts`; tipos en `packages/core/src/api-types.ts`)

Las respuestas son JSON. Los errores tienen la forma `{ error: string }`:

- 400: parámetro inválido;
- 403: guard;
- 404: id desconocido;
- **409: `unknown-cursor`** (D9).

Validación: `id`/`after` contra el patrón ULID y `project` contra `^[0-9a-f]{12}$|^unresolved$`.

```ts
type SessionStatus = "live" | "idle" | "ended";
interface Totals { input: number; output: number; cacheRead: number; cacheCreation: number;
  cacheCreation1h: number; weightedTokens: number; costUsd: number; unpricedUsages: number }
interface SessionSummary { id: string; engine: EngineId; nativeId: string; projectKey: string;
  status: SessionStatus; startedAt: number; lastEventAt: number; endedAt: number | null;
  model: string | null; lastPrompt: string | null;
  activeAgent: { agentId: string; type: string | null } | null; totals: Totals }
interface ProjectSummary { key: string; path: string; name: string; engines: EngineId[];
  lastSeen: number; today: Totals;
  lastError: { kind: "tool.error" | "ingest.error"; ts: number; sessionId: string; message: string } | null;
  sessions: SessionSummary[] }
interface AgentNode { agentId: string | null; parentAgentId: string | null; type: string | null;
  description: string | null; model: string | null; status: "running" | "done" | "idle";
  startedAt: number | null; endedAt: number | null; lastEventAt: number | null; totals: Totals }
interface IngestStats { semanticDuplicates: number; usageAnomalies: number;
  errorsByReason: Partial<Record<IngestErrorReason, number>> }
```

| Ruta | Respuesta | R |
|---|---|---|
| `GET /api/projects?since=<ms>` | `{ cursor, idleMs, day, projects: ProjectSummary[] }`. Incluye proyectos con `last_seen >= since` y sus sesiones `live` más las `idle` con `last_event_at >= since`. `since` vale por defecto `now − ventana de backfill` | R25, R30 |
| `GET /api/sessions?project=&status=&since=&limit=` | `{ sessions: SessionSummary[] }` | R26 |
| `GET /api/sessions/:id` | `{ cursor, idleMs, session, agents: AgentNode[] }` | R26, R32 |
| `GET /api/sessions/:id/events?after=&limit=` | `{ events, nextAfter, hasMore }`. Si el `after` no existe, 409 | R27, R33 |
| `GET /api/events?project=&limit=` (**adición**) | `{ cursor, events }` con los últimos por `(ts desc, id desc)` | R31, R33 |
| `GET /api/stats` (**adición**) | `{ ingest: IngestStats }` | R10, R13, R16 (observabilidad) |

El `cursor` es el `max(events.id)` leído en la misma ejecución síncrona que el resto del snapshot.

### SSE (`apps/server/src/sse.ts`)

- **Petición:** `GET /api/stream?project=<key>[&project=<key>…][&session=<id>][&after=<ulid>]`, con el header opcional `Last-Event-ID` (precedencia).
- **Headers de respuesta:** `Content-Type: text/event-stream`, `Cache-Control: no-cache` y `X-Accel-Buffering: no`.
- **Frames:**
  - al inicio, `retry: 2000\n\n`;
  - por evento, `id: <CrowEvent.id>\ndata: <CrowEvent JSON>\n\n`;
  - cada 15 s, `: hb\n\n`;
  - ante un cursor desconocido, `event: reset\ndata: {"reason":"unknown-cursor"}\n\n` y el servidor cierra.
- **Semántica:**
  - con un cursor válido, se hace replay de los `id > cursor` que pasan el filtro y luego se pasa a live, sin huecos ni duplicados;
  - sin cursor, solo live;
  - con un cursor que no está en la DB, `reset`.

### Configuración (`packages/core/src/config.ts`)

| Variable | Default | R |
|---|---|---|
| `CROW_HOME` | `~/.crow` | R1, R3 |
| `CROW_PORT` | `7777` | — |
| `CROW_BACKFILL_HOURS` | `24` | R9 |
| `CROW_IDLE_MINUTES` | `5` | R18 |
| `CROW_ALLOWED_ORIGINS` | vacío | R28 |
| `CLAUDE_CONFIG_DIR` | `~/.claude` (raíz `/projects`) | R11 |
| `CODEX_HOME` | `~/.codex` (raíz `/sessions`) | R14 |

Los intervalos internos (heartbeat, poll, rescan, sweeper, idleTimeout) y el reloj son opciones de `startApp` que los tests inyectan.

---

## Mapeo Claude (`packages/adapters/claude/src/map-line.ts`) — R11–R13

Estado persistido: `{ v, started, cwd, lastTs, openCalls: {callId: {name, ts, subagentType?}}, spawned: {callId: agentId}, meta? }`, con `openCalls` limitado a 256 entradas. Todo evento lleva `cwd` (el de la línea o `state.cwd`) y `semanticKey = uuid:<uuid>:<parte>`.

| Línea | Eventos (en orden de parte) |
|---|---|
| Primera línea con `timestamp` de un **main** | `session.start`, seguido de los eventos de la línea |
| Primera línea con `timestamp` de un **agente** | `agent.start` con `agent` tomado del sidecar si existía. `parentAgentId = null` si `depth ≤ 1`; si `depth > 1`, lo resuelve el store por `call_id` |
| `assistant` | `assistant.message` si hay `text`/`thinking` o si es la primera línea de su `message.id` (lleva `usage`, `usageKey = u:<agentId\|main>:<message.id>` y `model`). Además, un `tool.pre` por cada `tool_use`, que se registra en `openCalls` |
| `user` con bloques `tool_result` | Por bloque, `tool.post` (si `is_error !== true`) o `tool.error` (con hasta 1 KiB). `name` y `ms` salen de `openCalls` |
| …y `toolUseResult` con `{agentId, status: "completed"}` | Además, `agent.stop` (`outcome` y `type` desde `openCalls`) |
| …y `toolUseResult` con `{agentId, status: "async_launched"}` | `spawned[tool_use_id] = agentId` |
| `user` con `origin.kind: "task-notification"` y `<tool-use-id>` + `<status>` | `agent.stop` vía `spawned` |
| `user` que es prompt | `prompt` (≤ 8 KiB). Es prompt si `origin.kind === "human"`, o si `promptSource` existe y no es `"system"`, o, sin ambos campos, si el contenido es string, no es `isMeta`/`isCompactSummary` y no trae `toolUseResult` |
| `system` con `subtype: "compact_boundary"` | `compact` |
| `attachment`, `system` con otro subtype, `user` restantes | Nada (sobre abierto) |
| Tipos de estado conocidos | Nada |
| `type` desconocido / JSON inválido / forma inválida | Error `unknown-type` / `invalid-json` / `bad-shape` (R10) |

`ts` es `Date.parse(timestamp)`, luego `state.lastTs` y, en último caso, la hora de ingesta. El sidecar se lee al abrir el archivo del agente y se relee cuando cambia (`upsertAgentMeta`, sin evento).

## Mapeo Codex (`packages/adapters/codex/src/map-line.ts`) — R14

Estado persistido: `{ v, sessionId, agentId, parentAgentId, cwd, model, historyStart, lastTotal: {input, cached, cacheWrite, output} | null, openCalls, recentPrompts: [{fp, ts}] (≤ 32) }`. Todo evento lleva `cwd = state.cwd`.

| Línea | Eventos |
|---|---|
| Primer `session_meta` | En un main: `session.start`. En un subagente: `agent.start` (`type = thread_spawn.agent_role ?? source.subagent.other`, `description = agent_nickname`, `depth`). Fija en el estado `sessionId`, `agentId`, `parentAgentId`, `cwd` y `historyStart` |
| `session_meta` posteriores | Nada |
| `ordinal < historyStart` | Nada (historia heredada) |
| `turn_context` | Nada; actualiza `model` y `cwd` |
| `event_msg` `user_message` | `prompt` (≤ 8 KiB) con `semanticKey = um:<sha1(texto)>:<ts>`, donde `ts` es el de un prompt idéntico visto en `recentPrompts` hace ≤ 1000 ms, o el propio |
| `response_item` `message` con `role=assistant` | `assistant.message` con `semanticKey = id:<payload.id>:<parte>` |
| `response_item` `function_call` / `custom_tool_call` | `tool.pre` con `semanticKey = call:<call_id>` |
| `response_item` `*_call_output` | `tool.post` con `semanticKey = out:<call_id>`; `name` y `ms` desde `openCalls` |
| `event_msg` `token_count` con `info` | Regla de D7: con `lastTotal = null`, `usage = last_token_usage` y línea base en el total. Después, delta por componente (con un delta de 0 no hay evento; con uno negativo, `last_token_usage`, nueva línea base y warning `usage-anomaly`). Se emite como `assistant.message` sin `text`, con `usage` { `input` = input − cached, `cacheRead` = cached, `cacheCreation` = cache_write, `output`, `model` } |
| `compacted` | `compact` |
| `response_item` conocidos sin evento, cualquier otro subtipo de `event_msg`, `token_usage_record`, `world_state`, `inter_agent_communication_metadata` | Nada |
| `type` desconocido o `response_item` con subtipo desconocido | `ingest.error` |

Sin `session_meta` previo, `sessionId` sale del nombre del archivo y el proyecto queda `unresolved`.

Limitaciones de F1:

- Codex no emite `agent.stop` ni `tool.error`.
- Los 9 forks sin start ordinal (0.145.0) ingieren historia heredada, sin usage.
- Hay 3 copias de mensajes entre archivos (D7).

---

## Failure modes

| Falla | Qué pasa | Contención |
|---|---|---|
| Migración que falla o DB de una versión futura | Rollback; `startApp` rechaza antes de escuchar | R2 |
| Segunda instancia | El puerto está ocupado | Se sale con un mensaje; `busy_timeout` |
| `SQLITE_FULL` o error de I/O | Rollback: el offset no avanza y no se publica | Reintento con backoff; las fuentes siguen en disco |
| Crash entre el commit y el publish | Eventos guardados sin enviar | Replay por `Last-Event-ID` |
| **DB borrada o recreada, reloj atrás, o `Last-Event-ID` ajeno** | El cursor del cliente no existe; sin validación, el stream quedaría mudo | `hasEvent`: `event: reset` o 409, y el cliente resincroniza (D9) |
| **Reloj atrás con la DB intacta** | `Date.now()` menor que `max(id)` | Semilla = el mayor de los dos, modo monotónico y warning en el log (D9) |
| FSEvents pierde eventos | Queda una pista sin llegar | Poll de 1 s y rescan de 30 s |
| No hay watch recursivo | El probe falla | Modo polling |
| Raíz inexistente | No hay watcher | Se reintenta en cada rescan |
| Línea parcial | Se queda sin consumir | R8 |
| Truncado, rotación o inode nuevo | Reingesta desde 0 | R7; identidad de contenido (D7) |
| **Misma línea lógica con bytes distintos** | El hash no la reconoce | `semanticKey` con alcance de agente: descarte más contador. Límite documentado entre archivos (D7) |
| **Usage de `message.id` discrepante (Claude)** | Se mantiene el primero | `ingest.error usage-anomaly` más contador (D7) |
| **Fork de Codex con acumulado heredado** | Inflaría el primer delta | Primer `token_count` = `last_token_usage` y línea base (D7) |
| **Acumulado de Codex que retrocede** | Delta negativo | `last_token_usage`, nueva línea base y `usage-anomaly` |
| Línea de más de 16 MiB | `ingest.error line-too-long` | D5 |
| UTF-8 inválido | JSON inválido | `ingest.error invalid-json` |
| Tipo de línea nuevo y frecuente | Avalancha de `ingest.error` | Sobres abiertos, cuerpo mínimo y `errors:<reason>` en `/api/stats` |
| `state_json` incompatible | `restoreState` devuelve `null` | Reingesta desde 0 |
| `cwd` borrado o `git` ausente | Fallback | D11 |
| Subagente antes que su principal | Sesión en `unresolved` | Se asigna con el primer `cwd` (D8) |
| Sidecar ausente, corrupto o reescrito | Agente sin tipo | Fallback y upsert al cambiar |
| Consumidor SSE lento | La cola crece | Se cierra y hay replay |
| Timeout ocioso de Bun | Se cortaría el SSE | `server.timeout(req, 0)` |
| Seis conexiones HTTP/1.1 | Pestañas sin stream | Un `EventSource` por vista |
| Backfill grande | Loop ocupado | Pasos acotados; hot tiene prioridad |
| Symlink en una raíz | Leería fuera del árbol | `lstat` y se ignora |

## Migration (F0 → F1)

- No hay ninguna DB previa: la migración 1 crea todo.
- `CrowEvent` y `CrowEventUsage` solo ganan campos opcionales.
- `projectKey` pasa de lanzar a un fallback. Los tests de F0 siguen válidos.
- Cambios de configuración:
  - `workspaces` agrega `"packages/adapters/*"`;
  - `@crow/core` agrega `exports`;
  - `paths` en server y web;
  - `@crow/core` como devDependency de tipos en la web;
  - `vite.config.ts` con `port: 5173` y `strictPort`;
  - el script `dev` del server con `CROW_ALLOWED_ORIGINS`.
- `handleRequest(req, server)`; el test de `/healthz` se mantiene.

---

## Testing strategy

Ningún test lee `~/.claude`, `~/.codex` ni `~/.crow` reales: todo pasa por `loadConfig` con temporales. Todo test lleva `// Covers: R<n>`.

| Riesgo | Test | R |
|---|---|---|
| Esquema perdido o corrupto al arrancar | `migrations.test.ts`: migraciones inyectadas en orden; rollback ante una que falla, sin escuchar; downgrade rechazado | R1, R2 |
| DB legible por otros | `db.test.ts`: con umask 022, el directorio queda en 0700 y la DB, `-wal` y `-shm` en 0600 | R3 |
| Totales inconsistentes | `store.test.ts`: los totales de sesión, agente y día coinciden con la suma de `usage`; una transacción fallida no deja rastro | R4 |
| Doble conteo o falso dedupe de `message.id` | `navori-parity.test.ts`: principal {11, 22, 103, 54}, `withmeta1` {7, 8, 9, 1000}, `orphan2` {1, 1, 1, 500}, sesión {19, 31, 113, 1554}; 2 `ingest.error` (divergencia documentada frente a navori) | R13, R16 |
| **Usage discrepante tapado en silencio** | `store.test.ts`: un `message.id` duplicado con usage distinto (sintético) cuenta el primero, genera 1 `ingest.error usage-anomaly` y deja `usageAnomalies = 1` en `/api/stats` | R13 |
| Duplicados al reiniciar o falsos dedupes | `identity.test.ts`: (a) invariancia de cortes; (b) reingesta sin offsets sin eventos nuevos; (c) copia a un inode nuevo sin eventos nuevos; (d) truncado y reescritura con contenido distinto que sí guarda | R6, R7, R16 |
| **Misma línea lógica con bytes distintos** | `identity.test.ts`: (e) un par real anonimizado de `user_message` de Codex que solo difiere en `timestamp` se guarda una vez y deja `semanticDuplicates = 1`; (f) una línea de Claude con el mismo `uuid` y las claves reordenadas se guarda una vez; (g) el mismo `payload.id` en dos archivos de agentes distintos **no** se descarta (alcance de agente) | R16 |
| Media línea ingerida | `line-reader.test.ts`, incluido UTF-8 multibyte en el corte y una línea mayor que el chunk | R8 |
| Formato roto en silencio | `ingest.test.ts`: `ingest.error` con `path`, `offset` y `line`, y la siguiente línea se ingiere; `errors:<reason>` cuenta | R10 |
| Watcher ciego | `watch.test.ts`, guardado por el probe | R5 |
| Sin watcher | `poll.test.ts` | R5 |
| Hidratación parcial | `backfill.test.ts` | R9 |
| Deriva de formato en Claude | `claude/contract.test.ts`: snapshot del fixture real más aserciones por fila | R11, R12 |
| Árbol mal enlazado | `claude/subagents.test.ts` (sidecar tardío, `depth = 2` en ambos órdenes) | R12 |
| Deriva de formato en Codex | `codex/contract.test.ts`: snapshots de 0.145.0 y 0.155.1; hilo `thread_spawn` y `guardian` a `agentId`; historia heredada sin eventos; raíz desde `CODEX_HOME` | R14 |
| **Acumulado heredado de un fork inflando tokens (BLOCKER 1)** | `codex/usage.test.ts` sobre los forks **reales anonimizados** de `fixtures/codex/0.145.0/`: (a) fork "fresco" (primer `total = last`): el primer `usage` es igual a su `last_token_usage`; (b) fork con acumulado arrastrado: el primer `usage` es igual a `last_token_usage`, **no** a `total`, y el total de la sesión excluye lo arrastrado (se afirma el valor exacto del fixture); (c) los totales repetidos cuentan una vez; (d) un retroceso sintético del acumulado genera `usage-anomaly` y cuenta `last`. En `store.test.ts` y `pricing.test.ts`, el `costUsd` y el `weightedTokens` de la sesión del fixture no incluyen el acumulado arrastrado | R4, R14, R20, R21 |
| Repos fantasma o crash por `cwd` borrado | `project-key.test.ts` (agregados) | R15 |
| Sesión partida entre proyectos | `store.test.ts`: la sesión es pegajosa aunque un evento traiga el `cwd` de otro repo; ese evento conserva su propio `cwd`; `unresolved` se asigna con el primer `cwd` | R15 |
| Estado de sesión | `status.test.ts` con reloj inyectado | R17, R18, R19 |
| Costo mal calculado | `pricing.test.ts` (caché de 1 h, sin substring, modelo desconocido) | R20 |
| Aritmética distinta de navori | `weighted-tokens.test.ts`, los 6 casos portados más la paridad sobre el fixture | R21 |
| Publicar sin commit | `bus.test.ts` | R22 |
| Stream mal filtrado o cortado | `sse.test.ts`: filtros, `id`, heartbeat inyectado e `idleTimeout` de 1 s sobrevivido | R23 |
| Huecos o duplicados al reconectar | `sse-replay.test.ts`: (a) reconexión con `Last-Event-ID`; (b) la carrera de un evento ingerido durante el replay llega una vez; (c) el header gana sobre `after`; **(d) DB recreada** (otro `CROW_HOME` en el mismo puerto) más un `Last-Event-ID` de la DB anterior: `event: reset` y cierre; **(e) reloj inyectado atrás con la DB intacta**: los `id` nuevos siguen siendo mayores que `max(id)` y el replay los entrega; **(f)** un `after` inexistente en `/api/sessions/:id/events` da 409 | R24 |
| Contratos REST | `api.test.ts`, incluido `/api/stats` | R25, R26, R27 |
| DNS rebinding | `guard.test.ts` más integración | R28 |
| Latencia | `e2e/latency.test.ts`: el máximo de 5 appends es < 2000 ms | R29 |
| Reinicio que duplica | `e2e/restart.test.ts` | R6, R16 |
| Tarjeta, split y detalle | `reduce/projects.test.ts`, `reduce/feed.test.ts`, `reduce/session.test.ts` | R30, R31, R32 |
| Relevo y reset | `reduce/cursor.test.ts`: `id <= lastApplied` se ignora; los paginados con `id > cursor` suman una vez; **un `reset` descarta el estado y reaplica el snapshot nuevo sin doble conteo** | R33 |
| PII en fixtures | `fixtures/hygiene.test.ts` | Riesgo R2 |

**Fixtures que hay que crear.** Todos anonimizados con `scripts/anonymize-fixture.ts`, que usa una allowlist de claves estructurales. Cualquier otra string se reemplaza por un marcador. Los `cwd` se reescriben a `/tmp/crow-fixture/<repo>`, los timestamps se desplazan de forma consistente y se eliminan los UUID de cuenta. **Los números de usage no se tocan.**

1. **`fixtures/claude/cc-2.1.267/`.** Principal más un subagente síncrono y otro asíncrono con sus `meta.json`: prompts `typed`/`queued`, duplicados de `message.id`, `is_error`, `compact_boundary`, `attachment` y tipos de estado.
2. **`fixtures/codex/0.145.0/`.** Un principal legacy (solo `token_count`, con totales repetidos), un fork "fresco" sin start ordinal y **el fork con acumulado arrastrado**, recortados a sus primeros `token_count`.
3. **`fixtures/codex/0.155.1/`.** Principal, un `thread_spawn` fork con `subagent_history_start_ordinal`, un `guardian` y un bloque con un `user_message` reemitido que solo difiere en `timestamp`.
4. **`fixtures/claude/navori-audit/`.** Copia literal.

**Verificación manual (demo de F1):** dos repos con Claude y uno con Codex en vivo, el split, reiniciar sin duplicados y una sesión previa hidratada.

---

## NOT in scope

- **Hooks, OTLP, SSE de opencode**, el resto del contrato de §8, la reconciliación por `tool_use_id`, `attach` y `doctor`. Son F2.
- **Redacción y retención.** Son F3. D15 limita lo que se guarda.
- **Señales, reportes y paridad de `crow report`.** Son F3.
- **Paneles de archivos y hooks, feed global y reportes** (§10.1). No están en R30–R32.
- **Virtualización y sesiones de más de 50k eventos.** Son F5.
- **`crow up`, daemon, npm y `~/.crow/config.json`.** Son F5.
- **`agent.stop` y `tool.error` en Codex, `session.end` pasivo, y dedupe semántico entre archivos.** No hay una señal inequívoca o el riesgo de atribuir mal es mayor que el beneficio (D7).
- **Soporte garantizado fuera de macOS.**
- **Normalizar la caché de `projectKey`.**

## Open questions

Las decisiones del usuario sobre R15, R16 y los precios ya son D8, D7 y D12. Quedan supuestos registrados, sin bloqueos:

1. **[assumed] Lectura de R17.** `live` solo si el `ts` del evento cae dentro de la ventana de idle (D10).
2. **[assumed] Acotar R25** a la ventana de backfill (`since` para ampliar).
3. **[assumed] Política de R10:** sobres abiertos y estrictos, y un error por línea. Si la avalancha aparece en la práctica, se podrá agregar por `(archivo, tipo)` después de F1; `errors:<reason>` ya lo hace visible.
4. **[assumed] R19** no es alcanzable pasivamente en F1.
5. **[assumed] Hilos de Codex como agentes** de la sesión raíz.
6. **[assumed] "Del día"** = día local del servidor según `ts`.
7. **[assumed] Endpoints adicionales** `GET /api/events?project=&limit=` (split) y `GET /api/stats` (observabilidad de D7 y R10).
8. **[assumed] Protocolo de reset.** `event: reset` más cierre en SSE, y 409 `unknown-cursor` en REST (D9). Un cliente que no sea crow e ignore `reset` reconecta cada 2 s sin daño.
9. **[assumed] Alcance de agente para las claves semánticas.** Las copias entre archivos de forks 0.145.0 sin start ordinal quedan como limitación (D7).

## Batches propuestos

Son PRs ordenados a `main`, cada uno con `bun run check` en verde.

| Batch | Contenido | R | Depende de |
|---|---|---|---|
| **B1 · `feat(core)` contrato y utilidades puras** | **T1:** extensiones de `CrowEvent`, `adapter.ts` (con `semanticKey` y `warnings`), `api-types.ts`, `@crow/core/types` y `narrow.ts`. **T2:** `ulid.ts` (semilla por el mayor entre DB y reloj, `ulidTime`), `weighted-tokens.ts` (port literal, verificando antes el diff contra `21f6c054`) y `pricing.ts` con valores oficiales fechados. **T3:** endurecer `projectKey` | R15, R20, R21 | — |
| **B2 · `feat(core)` store SQLite** | **T1:** `config.ts`, `db.ts` y `migrations.ts` (esquema v1 con `dedupe.fp` e `ingest_stats`). **T2:** `ingestBatch` (identidad, clave semántica, `usageKey` con guarda `usage-anomaly`, totales, proyecto pegajoso, estado, offsets) y `bus.ts`. **T3:** `sweepIdle`, `upsertAgentMeta`, `hasEvent`, `stats` y lecturas | R1–R4, R13, R15–R19, R22 | B1 |
| **B3 · `feat(core)` tailer genérico** | **T1:** `line-reader.ts`, procesamiento por archivo, `ingest.ts` (errores y warnings) y los tests de identidad (a)–(g) con un adaptador de prueba. **T2:** discovery, backfill, watcher, poll, rescan, scheduler y sidecars | R5–R10, R16 | B2 |
| **B4 · `feat(adapters)` Claude** | **T1:** el paquete, el mapeo del principal con `semanticKey` y la paridad con navori. **T2:** subagentes y sidecar. **T3:** anonimizador, fixture real, higiene y snapshot | R11–R13, R15, R16 | B3 |
| **B5 · `feat(server)` API y tiempo real** | **T1:** `adapters.ts` (registro con Claude), `app.ts`, `guard.ts` y el modo dev. **T2:** REST (con `/api/events`, `/api/stats` y el 409) y `sse.ts` (validación de cursor y `reset`, replay, heartbeat, `server.timeout`). **T3:** e2e de latencia, reinicio e hidratación | R2, R22–R29 | B4 |
| **B6 · `feat(web)` UI** | **T1:** router, `api.ts`, `stream.ts` (manejo de `reset`), reducers y home. **T2:** split y detalle | R30–R33 | B5 |
| **B7 · `feat(adapters)` Codex** | **T1:** `@crow/adapter-codex` (estado, línea base de tokens, historia heredada, hilos como agentes, `semanticKey`, `CODEX_HOME`). **T2:** fixtures anonimizados (0.145.0 con los forks fresco y arrastrado; 0.155.1), `codex/contract.test.ts` y `codex/usage.test.ts` sobre el pipeline de B3 | R14, R16 | B3 (en paralelo a B4–B6; no toca `apps/server`) |
| **B8 · `feat(server)` registro de Codex y e2e multi-motor** | **T1:** agregar Codex a `ENGINE_ADAPTERS` en `apps/server/src/adapters.ts` y un e2e con los dos motores en la rejilla (aceptación 1 de F1) | R14, R15, R29 | B5, B7 |

## Cobertura R1–R33

| R | Componente o decisión | Test (§Testing) | Batch |
|---|---|---|---|
| R1 | `store/db.ts`, esquema v1 (D3) | `migrations.test.ts` | B2 |
| R2 | `migrations.ts` (D2), `app.ts` | `migrations.test.ts` | B2, B5 |
| R3 | `store/db.ts` | `db.test.ts` | B2 |
| R4 | `ingestBatch` (D3) | `store.test.ts`, `codex/usage.test.ts` | B2, B7 |
| R5 | `tailer.ts` (D4) | `watch.test.ts`, `poll.test.ts` | B3 |
| R6 | `line-reader.ts`, `ingest_offsets` (D5) | `identity.test.ts`, `e2e/restart.test.ts` | B3, B5 |
| R7 | D5 | `identity.test.ts` (d) | B3 |
| R8 | D5 | `line-reader.test.ts` | B3 |
| R9 | D6 | `backfill.test.ts` | B3 |
| R10 | `ingest.ts`, `LineResult` | `ingest.test.ts` | B3 |
| R11 | adaptador Claude | `claude/contract.test.ts` | B4 |
| R12 | adaptador Claude, sidecar, `agents` | `claude/subagents.test.ts` | B4 |
| R13 | `usageKey`, `dedupe.fp` (D7) | `navori-parity.test.ts`, `store.test.ts` | B2, B4 |
| R14 | adaptador Codex, registro | `codex/contract.test.ts`, `codex/usage.test.ts`, e2e multi-motor | B7, B8 |
| R15 | `projectKey` (D11), proyecto pegajoso (D8) | `project-key.test.ts`, `store.test.ts` | B1, B2 |
| R16 | identidad de contenido y clave semántica (D7) | `identity.test.ts` (a)–(g), `navori-parity.test.ts` | B2, B3, B4, B7 |
| R17 | D10 | `status.test.ts` | B2 |
| R18 | `sweepIdle` (D10) | `status.test.ts` | B2, B5 |
| R19 | D10 | `status.test.ts` | B2 |
| R20 | `pricing.ts` (D12) | `pricing.test.ts`, `codex/usage.test.ts` | B1, B7 |
| R21 | `weighted-tokens.ts` (D12) | `weighted-tokens.test.ts`, `codex/usage.test.ts` | B1, B7 |
| R22 | `bus.ts` | `bus.test.ts` | B2 |
| R23 | `sse.ts` (D13) | `sse.test.ts` | B5 |
| R24 | `sse.ts` (D13), ULID y `hasEvent` (D9) | `sse-replay.test.ts` (a)–(f) | B5 |
| R25 | `/api/projects` | `api.test.ts` | B5 |
| R26 | `/api/sessions`, `/:id` | `api.test.ts` | B5 |
| R27 | `/:id/events` | `api.test.ts` | B5 |
| R28 | `guard.ts` (D14) | `guard.test.ts` | B5 |
| R29 | la cadena completa (D4, D13) | `e2e/latency.test.ts` | B5, B8 |
| R30 | `Home`, `applyToProjects` | `reduce/projects.test.ts` | B6 |
| R31 | `Split`, `/api/events` | `reduce/feed.test.ts` | B6 |
| R32 | `Session`, `Timeline`, `AgentTree`, `CostPanel` | `reduce/session.test.ts` | B6 |
| R33 | regla del cursor, `reset` (D16) | `reduce/cursor.test.ts` | B6 |

## Conocimiento durable (propuesta de destino; el architect no lo escribe)

- **Dominio:**
  - "proyecto pegajoso por sesión, con el `cwd` propio de cada evento";
  - "`id` = orden de ingesta; un cursor desconocido provoca un reset, nunca un silencio";
  - "identidad de línea = sha1 de los bytes más la parte; la clave semántica es secundaria y con alcance de agente";
  - "un evento con `usage` es un usage contado";
  - "en Codex, el primer `token_count` de cada archivo cuenta `last_token_usage`".
- **Sección de usuario de CLAUDE.md:**
  - los tests nunca leen los homes reales de los motores;
  - los fixtures se generan con `scripts/anonymize-fixture.ts`.
- **PLAN.md §15:**
  - marcar R7 como resuelto con el layout confirmado;
  - registrar que la escritura de caché es 100 % de TTL 1 h;
  - registrar que el acumulado de Codex es por hilo y que los forks sin start ordinal pueden arrastrarlo.
