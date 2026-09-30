# F2a Ingesta activa (Claude Code y Codex) — Design

> **Estado:** revisión 2. Atiende el challenge `.claude/progress/challenge_f2a.md` (veredicto del orchestrator: CONCERNS), las decisiones del usuario (R12 con clave por llamada, OTLP opt-in, `turn.end` y R33 aceptados, transporte de Claude decidido en B0, `protobufjs` solo como oráculo, trazas beta opt-in) y `requirements.md` con R1–R34.
> **Fecha:** 2026-09-29.
> **Base:** `origin/main` en `06037d2` (F1 completo). navori-harness en `origin/main` `5ee6c984`: `collect.ts` y `_partials/audit-log.sh` en `ba6322c1`, `parse.ts` en `b8dfe74c`.
> **Señales:** contrato compartido (`EngineAdapter`, `CrowEvent`, REST/SSE, endpoint de escritura nuevo); esquema v3; concurrencia (una cola para dos carriles, un solo escritor); integridad de datos (reconciliación y conteo de tokens, riesgo PLAN R8); privacidad (riesgo R2); dependencia de desarrollo (`protobufjs`); escritura en la configuración del usuario.
> **Marcas:** **doc** = afirmado por la documentación oficial citada en el challenge (no la volví a leer; B0 la confirma con capturas). **✓** = verificado por mí en el repo o con una prueba en el scratchpad. **⚠** = sin verificar; lo cierra B0.

## Resumen

- **Hechos inmutables más revisiones anexas (BD1).** Cada hecho lógico es una fila de `events` cuyo `id` no cambia nunca.
  - Cuando otro carril aporta algo, el store funde el cuerpo **en el lugar**, como F1 ya hace con `project_key` (D8).
  - Si cambió algo que se pinta, **agrega una fila `revision`** con `id` nuevo que lleva el hecho fundido. El SSE, el `Last-Event-ID`, el cursor `after`, el 409 y la regla `id <= lastApplied` de F1 quedan intactos.
  - Todos los efectos no monótonos (estado de sesión, `lastPrompt`, agente activo, agente terminado) pasan a estar **guardados por `ts`**. Así, insertar, fundir o repetir un hecho en cualquier orden converge.
- **Independencia del orden (BD2).** Desaparece `enrichOnly`: OTel crea la fila si llega primero y la precedencia por campo decide.
  - Los prompts de Claude usan clave exacta `prompt_id` / `promptId` / `prompt.id`.
  - `nearest` queda solo para la compactación y, hasta que G2 dé un id, para los prompts de Codex.
- **R12: libro de uso OTel.**
  - El transcript cuenta como en F1 y marca cada `requestId`.
  - El uso por llamada que llega por OTel (`api_request.request_id` en Claude; en Codex, por sesión) queda **retenido** 30 s. Se descarta si el transcript trae esa llamada y **cuenta** si no.
  - Si el transcript llega después de contado, lo **reemplaza** con un evento de corrección negativa.
  - No hay doble conteo en ningún orden.
- **Carril B.**
  - Cola con dos FIFO y un drenador: hooks primero y OTLP detrás.
  - El store nunca lanza por datos.
  - El transporte de Claude (hook `http` sync con `timeout: 2`, o shim `command` con `async: true`) se decide con **el experimento de B0**. El adaptador no depende de esa elección.
  - Codex usa la forma anidada `[[hooks.X.hooks]]`, con un script propio de crow como comando confiable.
- **Carril C.** Apagado por defecto (R34): se enciende con `crow up --otlp` o con `$CROW_HOME/config.json`, que `attach` escribe.
  - Decodifica y rutea en la petición, sin DB, y guarda por la cola.
  - Respuestas en camelCase.
  - Decodificador protobuf propio con vectores de prueba y tope de profundidad; `protobufjs` solo como oráculo en `scripts`.
  - Ruteo sin `service.name` para Claude.
- **R33.** Los registros `hook_success` (y los demás resultados de hook) del transcript de Claude pasan a eventos `hook` con allowlist, y los hooks de crow se excluyen. El panel de hooks cuenta esos registros; los spans beta son agregados y no entran al panel.
- **CLI.**
  - `crow up` solo arranca el servidor con banderas.
  - `attach` escribe a través de symlinks y no pisa `OTEL_*` del shell.
  - `detach` quita por **unidades**: las entradas de crow sin tocar salen; las que el usuario editó se conservan y se informan (requiere el ajuste de R26, § Requisitos que necesito cambiar).

## Cambios respecto a la revisión 1

| Hallazgo | Dónde se resuelve |
|---|---|
| BD1 re-sello re-aplica efectos | D5 (hechos inmutables + `revision`), D16 (folds guardados por `ts`), § Esquema v3 (`last_prompt_at`) |
| BD2 `enrichOnly` depende del orden | D5 (OTel crea filas), prueba de 720 permutaciones |
| MF1 fail-open de `http` | D14 (dos transportes, experimento B0) |
| MF2 forma de Codex y confianza | D14 (`[[hooks.X.hooks]]`, script propio, `/hooks`), D15 (`doctor`) |
| MF3 agentes fantasma | D4 (orden de pasos y regla de `SubagentStop`) |
| MF4 R12 | D6 (libro de uso), requisito R12 reformulado por el usuario |
| MF5 OTLP síncrono | D2/D8 (decodificar y rutear en la petición, guardar por la cola) |
| MF6 estimador de `ms` | D7 (motor > OTel > recepción del hook > transcript, con `msSource`) |
| MF7 poison pills | D2 (bisección y clasificación de errores), D5 (invariantes → `ingest.error invariant`) |
| MF8 symlinks | D13 (escritura a través del destino) |
| MF9 fuga de `OTEL_*` | D14 (endpoint genérico igual al default, detección del shell, nota en el diff) |
| MF10 sin `service.name` | D10 (ruteo por nombres y atributos; episodios de 10 min) |
| SF1 prompts exactos | D5 |
| SF2 cronología | Resuelto por BD1: el `id` no cambia |
| SF3 seguridad de ingesta | D2 (tope en vuelo, cuota por motor), D3 (token por defecto con el script) |
| SF4 decodificador | D9 |
| SF5 respuestas OTLP | D8 |
| SF6 flags de contenido | D14, D15 |
| SF7 `turn.end` | D11 (R32) |
| SF8 panel de hooks | D18 (R33), D16 |
| SF9 attach/detach | D13 |
| SF10 alcance | D12 (`crow up` mínimo), D10 (métricas agrupadas), D4 (alias solo si G2 lo pide) |
| SF11 y G1–G7 | § Evidence gaps (reencuadrado) |

---

## Evidencia verificada

### Por mí (✓)

- **Fixtures reales de F1 (`fixtures/claude/cc-2.1.281/`, principal y 5 subagentes):**
  - `promptId` en 290/290 líneas `user`;
  - `requestId` en 482/482 líneas `assistant`;
  - 8 líneas `attachment` `hook_success` con `hookName`, `hookEvent`, `toolUseID`, `exitCode`, `command` y `durationMs` (numérico 8/8), más 4 `hook_additional_context`;
  - 9 líneas `system` `turn_duration`.
- **navori-harness:**
  - campos de hook que se leen en producción: `session_id`, `cwd`, `agent_id`/`subagent_id` (el primer no vacío), `tool_use_id`, `tool_name`, `tool_input`, `prompt`, `source`, `reason`, `agent_type`, `transcript_path`;
  - `agent_id` es estable en las fases de tool y **no** en `SubagentStop` (#560: 112 ids en 117 disparos; 102 no resuelven);
  - `PARENT_ONLY_PHASES`;
  - unión OTel ↔ sesión por `session.id`.
- **Bun 1.4.2:**
  - `Bun.serve` lanza `EADDRINUSE` de forma síncrona;
  - `maxRequestBodySize` responde 413 solo, con `Content-Length` y con chunked;
  - `Bun.TOML.parse` rechaza redefinir una tabla y acepta `[[a.b]]` repartido;
  - `DecompressionStream("gzip")` funciona.
- **curl:**
  - manda `Host` loopback y ningún `Origin`;
  - `curl -s -m 2 … >/dev/null 2>&1 || true` con el puerto cerrado da código 0, stdout vacío y 10 ms.

### Por B0 (✓, 2026-09-29)

Claude Code 2.1.285 y Codex 0.158.0; formas y conteos en [`b0-bitacora.md`](b0-bitacora.md). Lo que contradice al documento (⚠) y lo que confirma (=):

- ⚠ **`service.name` de Claude = `claude-code`** (la sección "doc" decía que no lo fija). Codex en `exec`: `codex_exec`.
- ⚠ **MF9: el `env` de settings no llegó a los subprocesos de Bash** (`OTEL_*` = 0 en dos celdas), al revés de la suposición de D14. Caveat: modo `-p` y variables vía `--settings`; falta el TUI con `settings.json`. Las mitigaciones de D14 siguen valiendo, pero el riesgo de fuga es menor de lo supuesto.
- ⚠ **El hook `http` de Claude no entrega `SessionStart`** (44 requests contra 45 con `command`).
- ⚠ **Las líneas `hook_*` del transcript aparecen solo cuando el hook falla** (http abajo, colgado, 401 o 413: 42 líneas; con éxito o `command` async: 0). R33 no puede contar con ellas en el camino feliz.
- ⚠ **`http` es visible en todos los fallos** (abajo, colgado, 401, 413) y con crow colgado suma ~4 s por tool call (p50 4046 ms contra 52 de base). Con `command`+`async` no hay error visible en `-p` ni latencia medible.
- ⚠ **`request_id` no viaja en los hooks de Claude** (0 de 7): solo el carril OTel lo trae (7 de 7 contra `requestId` del transcript). `agent_id` no viaja en OTel.
- ⚠ **Codex: `tool_use_id` de los comandos `Bash` en el hook es `exec-<uuid>`**, igual al `item.id` del rollout y **distinto** del `call_id` (`call_<…>`) de la `function_call`; para las herramientas de colaboración sí es el `call_id`. En OTel de Codex el atributo `call_id` contiene los 6 `tool_use_id` de hook, incluidos los `exec-<id>` de `Bash` (6/6): la unión hook ↔ OTel de Codex por id de llamada **sí está confirmada** (bitácora § G5a; fixtures `fixtures/codex/0.158.0`). Lo que difiere es el `call_id` de la `function_call` del rollout, que no coincide con el `exec-<id>` en shell (el rollout se une por `item.id`).
- ⚠ **Codex `exec` no ejecuta hooks no confiados y no avisa**; el TUI muestra "Hooks need review" y la confianza solo cambia `config.toml` (`[hooks.state."…"] trusted_hash`).
- = **`prompt_id` = `promptId`** (2 de 2, hook y OTel); **`tool_use_id` = `tool_use.id`** (7 de 7 en Claude, incluido el subagente, con el directorio del proyecto en `--transcript`; 20 de 20 en las celdas de 20 llamadas); **`agent_id` = `agentId`** (1 de 1 por hook).
- = **Claves desconocidas en silencio:** Claude (`crowProbe`, http y command) y Codex (`crow_probe`, sin invalidar el hash de confianza).
- = **Sin reintentos** de hooks; `PostToolUse` trae `duration_ms`; `SubagentStop` trae `agent_transcript_path`; `SubagentStart/Stop` existen en Codex.
- **Sin reproducir (deuda):** `PermissionDenied` de Claude; `PermissionRequest`, `PreCompact` y `PostCompact` de Codex.

### Según la documentación que citó el challenge (doc)

- **Hooks de Claude:**
  - POST con JSON;
  - fallo de conexión, respuesta no 2xx o cuerpo 2xx no JSON = "non-blocking error";
  - **`async` solo existe en hooks `command`**;
  - `prompt_id` es un campo común (v2.1.196+) que "coincide con `prompt.id` de OpenTelemetry";
  - existen `headers`, `allowedEnvVars` y la allowlist administrada `allowedHttpHookUrls`;
  - `SessionStart.source` ∈ {`startup`, `resume`, `clear`, `compact`, `fork`};
  - `SessionEnd.reason` ∈ {`clear`, `resume`, `logout`, `prompt_input_exit`, `other`}, y `SessionEnd` tiene un presupuesto de 1.5 s;
  - `StopFailure` tiene un conjunto cerrado de categorías (`rate_limit`, `overloaded`, `authentication_failed`, `billing_error`, `server_error`, `max_output_tokens`, …).
- **OTel de Claude:**
  - **no fija `service.name`**;
  - `session.id` activo por defecto;
  - `prompt.id`, `request_id` y `event.sequence` en los eventos;
  - `tool_use_id` en `tool_result`/`tool_decision` "coincide con los payloads de hook";
  - `type` de tokens ∈ {`input`, `output`, `cacheRead`, `cacheCreation`};
  - temporalidad por defecto delta; intervalo de logs 5 s y de métricas 60 s;
  - flags de contenido: `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT`;
  - las variables de telemetría se ignoran en settings de proyecto o locales, y la configuración administrada quita las que chocan;
  - spans de hook beta con `hook_event`, `hook_name` (p. ej. `PreToolUse:Write`), `num_hooks`, `duration_ms`, `num_success`, `num_blocking`, `num_non_blocking_error` y `num_cancelled`: **un span agrega todos los hooks de una invocación**.
- **Hooks de Codex:**
  - grupo con handlers anidados `[[hooks.X]]` / `[[hooks.X.hooks]]` (`type`, `command`, `timeout`); `timeout` por defecto 600 s (1 s en `SessionEnd`);
  - stdin con `session_id`, `hook_event_name`, `cwd`, `transcript_path` (puede ser nulo), `model`, `turn_id` y `tool_use_id`;
  - **cada hook no administrado exige que el usuario revise y confíe en la definición exacta**, y un cambio en ella vuelve a pedirlo;
  - `hooks.json` y `[hooks]` en línea se funden, con una advertencia al arrancar;
  - un código de salida distinto de cero o un timeout "se reporta al usuario como fallo".
- **`[otel]` de Codex:** `exporter = { otlp-http = { endpoint, protocol = "json"|"binary", headers } }`, `log_user_prompt = false`; el exporter por defecto es `"none"`.
- **Sesiones sin transcript:** `claude -p --no-session-persistence` y `codex exec --ephemeral`.
- **OTLP/HTTP:**
  - 200 con `Export*ServiceResponse` en el mismo tipo de contenido que la petición;
  - 400 con `google.rpc.Status` si no se decodifica; 429, 502, 503 y 504 se reintentan;
  - en JSON: lowerCamelCase, `int64` como string, ids en hex y se ignoran los nombres desconocidos;
  - límite recomendado 64 MiB.

---

## Qué existe hoy

**En este repo (`origin/main`):**

- **`packages/core/src/adapter.ts`, `EngineAdapter<S>`.** Solo carril A; `PartialCrowEvent` ya trae `usageKey`/`semanticKey`.
- **`packages/core/src/crow-event.ts`.** `EventKind` ya trae `hook`, `permission`, `usage` y `api.request`; no hay kind de fin de turno ni de revisión.
- **`packages/core/src/store/store.ts`:**
  - `ingestBatch`: una transacción con `dedupe` `(source, session_id, key)`, `ensureSession` (D8), `ensureAgent`, usage con máximo por componente, `persistEvent` y offsets. **La identidad de F1 vive dentro de un carril.**
  - `persistEvent` aplica efectos por orden de llegada: `nextStatus` revive desde `ended` si `ts >= now − idle`, y `last_prompt` se sobrescribe.
  - `hasEvent` busca en `events`.
  - `ensureSession` ya hace `UPDATE events SET project_key` en el lugar (precedente de fusión en el lugar).
- **`packages/core/src/tailer/ingest.ts`, `processFile`.** Arma `PendingEvent` con `source: "transcript"` y hace commit y publicación sin `await` entre medio.
- **`apps/server/src/server.ts`, `createRequestHandler`.** `/healthz` → `{ ok: true }`; el guard solo corre si `isApiPath`; `Bun.serve` no fija `maxRequestBodySize`.
- **`apps/server/src/guard.ts`, `checkRequest`.** Rechaza `Host` no loopback y `Origin` ajeno o `"null"`; deja pasar sin `Origin`.
- **`apps/server/src/sse.ts`.** Al vaciar el buffer descarta `id <= lastSent`.
- **`apps/web/src/lib/reduce/cursor.ts` (`applyOne`), `reduce/feed.ts` (`normalize`, `append`, `KIND_LABELS`, `describeEvent`), `reduce/projects.ts` (`updateSession`, que no está guardado por `ts`), `reduce/session.ts` (`updateAgent`, que revive con `agent.start`) y `state/session.svelte.ts` (`SessionStore.start` pagina todo y dobla solo los `id > cursor`).**

**En navori-harness (solo lectura):** `collect.ts` (`flattenOtlp`, `attrScalar`, `collectAttributes`, `msFromUnixNano`, `eventNameOf`; solo logs y JSON), `parse.ts` (`ownerOf`, `PARENT_ONLY_PHASES`, `attachHookEvents`), `model.ts` (`recorderWindow`) y `_partials/audit-log.sh` (fail-open).

### Qué se porta y cómo

| Origen (navori-harness) | Destino | Modo | Por qué |
|---|---|---|---|
| `collect.ts`: `attrScalar`, `collectAttributes`, `msFromUnixNano`, `eventNameOf` y el recorrido de `flattenOtlp` | `packages/otlp/src/flatten.ts` | **Reescritura** con cabecera de procedencia (`ba6322c1`). Precedencia recurso < registro. Se agregan trazas y métricas; no quita prefijos; no descarta registros sin sesión (R17); `timeUnixNano` pasa por `BigInt` | R14, R16 |
| `collect.ts`: allowlist | Mapas OTel de cada adaptador | Principio | D17 |
| `collect.ts`: "200 ante basura" | — | No se porta | R14 pide la semántica OTLP |
| `parse.ts` `ownerOf` + `PARENT_ONLY_PHASES` | `adapters/claude/src/hook.ts` | Reescritura sin el respaldo por ventana | R10 (D4) |
| `audit-log.sh`: primer no vacío entre `agent_id`/`subagent_id` | ídem | Regla literal | R10 |
| `model.ts` `recorderWindow` | `hooksFrom` en el detalle | Concepto | R30 (D16) |
| `audit-log.sh`: fail-open | `$CROW_HOME/hooks/crow-ingest-hook` | Protocolo | R20 (D14) |
| `attachHookEvents` | — | No se porta: lo reemplaza D5 | R11–R13 |

## Drivers de decisión

1. **Integridad sin doble conteo (riesgo PLAN R8, R11–R13).** Un hecho lógico, una fila, sin importar el orden ni qué carriles estén activos.
2. **Nunca romper al motor observado (R20, riesgo R4).**
3. **Privacidad (riesgo R2, R24, R33, F1 D15).**
4. **El contrato de F1 intacto.** `id` monotónico e inmutable, `Last-Event-ID`, `after`, 409, `id <= lastApplied`, "un evento con `usage` es un usage contado" y un solo escritor con commit y publicación síncronos.
5. **Honestidad ante lo no verificado.**
6. **Agnóstico de motor.**
7. **Sin dependencias de runtime nuevas y legible en 6 meses.**
8. **Escalera de reutilización** como un driver más.

## Approach

**Eje 1, reconciliación (R11–R13).** Se evaluaron cuatro formas de publicar una fusión:

- **(a) Re-sellar la fila** (revisión 1): `UPDATE events SET id`, `retired_event_ids` y `lid`. *Descartado:*
  - reescribe una PK;
  - mueve el hecho al final del orden por `id`, así que un `tool.pre` queda después de su `tool.post` (SF2);
  - necesita una tabla de ids retirados sin retención;
  - no resuelve por sí sola BD1.
- **(b) Insertar la versión fundida y marcar la vieja `superseded`** (alternativa del challenge). *Descartado:*
  - el hecho se muda al final del orden por `id` (el mismo problema de cronología);
  - cinco caminos de lectura ganan `WHERE superseded = 0`, y olvidar uno **duplica hechos**.
- **(c) Hechos inmutables y eventos de enriquecimiento que dobla cada lector.** *Descartado:* la fusión se reimplementa en la UI, los reportes y las señales de F3.
- **(d) Elegido: el hecho conserva su `id`, el store funde su cuerpo en el lugar y agrega una fila `revision`** (`id` nuevo) con el hecho fundido.
  - Los lectores REST y F3 ven siempre el hecho fundido en su lugar cronológico.
  - Un cliente en vivo aplica la revisión a su copia.
  - Una fila `revision` no es un hecho de ningún kind, así que un conteo que la olvide no duplica nada.
  - F1 ya hace este tipo de fusión en el lugar (`UPDATE events SET project_key`).

  BD1 no se resuelve con el transporte sino con la semántica: **todo efecto no monótono se guarda por `ts`**, en el servidor y en los reducers, para inserciones, fusiones y revisiones por igual. Eso además arregla una carrera que F1 ya tenía: en backfill, el `agent.stop` del principal puede ingerirse antes que el `agent.start` del archivo del agente (F1 D6 procesa el principal primero), y `updateAgent` revive al agente.

**Eje 2, ingesta de B y C.** Se extiende el patrón del tailer (`PendingEvent` → transacción → `bus.publish`, síncrono) con `ingestEvents`, que es la misma transacción sin offsets. Hooks y OTLP comparten un drenador con prioridad para los hooks.

**Eje 3, uso entre carriles (R12).** Se evaluaron tres:

- contar lo primero que llegue con una clave compartida y máximo por componente. Atribuye al agente principal cuando OTel llega antes y no hace ganar al transcript;
- retener OTel y corregir si el transcript llega tarde (elegido, D6);
- solo contar el transcript (revisión 1). Ya no cumple el R12 reformulado.

**Flujo:**

```
Claude hook (http | command→script) ─┐
Codex hook (command→script) ─────────┴► :7777 /ingest/hook/:e ─► guard·token·≤1MiB·cuota ─► 204
                                                   │ encolar (FIFO hooks)
OTLP ───► :4318 (solo con --otlp / config) ─► decode·flatten·rutear (sin DB) ─► 200/400/413/503
                                                   │ encolar PendingEvent[] (FIFO otel)
                                                   ▼
                    drenador: hooks primero; pasos ≤200 items / 4 MiB; await entre pasos
                                                   ▼
tailer (F1) ─► processFile ──────────────► store.ingestEvents / ingestBatch — UNA transacción:
   identidad → dedupe por carril → sesión → match (buscar el hecho) → agente canónico
   → usage (transcript + marcas r:) / libro OTel → insertar hecho | fundir en el lugar (+ fila revision)
   → efectos guardados por ts → [offsets]
                                                   ▼ commit (sin await)
                                     bus.publish → SSE · REST · LaneMonitor
sweeper (30 s): sweepIdle + promoteHeldUsage (libro OTel, D6)
```

---

## Components

### `packages/core`

- **`src/crow-event.ts`.** los kinds `turn.end` y `revision`; los campos `turn`, `revision`, `permission`, `compact`, `reported`, `tool.verdict`/`msSource`, `hook.blocking`/`aggregate`/`exitCode`, `sources` y motivos nuevos. Cubre R8, R9, R11–R13, R29, R32, R33.
- **`src/adapter.ts`.** `MatchSpec`, `HookInput`/`HookResult`, `fromHook?`, `ownsOtel?`, `fromOtel?`; `PartialCrowEvent` gana `match`, `usageCallKey` y `otelUsage`; `CrowConfig` gana `token`, `otlpEnabled` y `otlpPort`. Cubre R2, R8–R10, R12, R16–R19.
- **`src/otel.ts`** (tipos). `FlatOtelRecord`. Cubre R16.
- **`src/attach.ts`** (tipos). `EngineAttacher`, planes, `AttachInspection`. Cubre R21–R28.
- **`src/config.ts`.** `CROW_TOKEN` o `$CROW_HOME/token`; `CROW_OTLP`/`CROW_OTLP_PORT` o `$CROW_HOME/config.json` (precedencia: banderas > env > archivo > default). Cubre R3, R14, R34.
- **`src/ingest-queue.ts`.** Dos FIFO (hooks y otel) y un drenador: prioridad, cuotas, bisección ante errores del store, LRU de recepción (D7). Cubre R1, R6, R7, R31.
- **`src/otel-route.ts`.** `routeOtel(records, adapters) → { accepted: PendingEvent[], unattributed }`, puro. Cubre R16, R17.
- **`src/store/migrations.ts`.** Migración 3. Cubre R11–R13.
- **`src/store/store.ts`:**
  - `ingestEvents` (reusado por `ingestBatch`) y `reconcile`/`mergeEvents`;
  - fila `revision` y efectos guardados por `ts` (`nextStatus`, `last_prompt_at`, agentes);
  - libro de uso OTel (`recordOtelUsage`, `promoteHeldUsage`, reemplazo por el transcript);
  - `hookStats`, `stats` y conversión de invariantes a `ingest.error`.

  Cubre R10–R13, R30.

### `packages/otlp` (`@crow/otlp`, puro)

- **`src/protobuf.ts`.** Decodificador del subconjunto, tope de profundidad y de valores. Cubre R14.
- **`src/flatten.ts`.** Port de `collect.ts`. Cubre R16.
- **`src/response.ts`.** `Export*ServiceResponse` y `Status` en JSON (camelCase) o protobuf. Cubre R14.

### `packages/adapters/claude` y `packages/adapters/codex`

- **`src/hook.ts`.** `fromHook`, que no depende del transporte (el cuerpo es el mismo JSON por `http` o por stdin → curl). Cubre R8/R9, R10, R32.
- **`src/otel.ts`.** `ownsOtel` y `fromOtel`, con allowlist. Cubre R12, R16–R19.
- **`src/map-line.ts`** (F1, extendido):
  - agrega `match` a `tool.*`, `prompt`, `session.start`, `agent.*` y `compact`;
  - `usageCallKey` al `assistant.message` de Claude;
  - **mapea los registros de hook del transcript (R33)**.

  Cubre R11–R13, R33.
- **`src/attach.ts`.** `EngineAttacher` puro para los dos transportes de Claude y para Codex. Cubre R20–R27, R34.

### `packages/cli` (`@crow/cli`)

- **`src/main.ts`.** Argumentos, `bin: crow`.
- **`src/commands/up.ts`.** Solo arranca el servidor con banderas.
- **`src/commands/attach.ts` y `detach.ts`.**
- **`src/commands/doctor.ts`.**
- **`src/diff.ts`.**
- **`src/fs-safe.ts`.** Realpath, backup y escritura atómica sobre el destino.
- **`src/hook-script.ts`.** Genera `$CROW_HOME/hooks/crow-ingest-hook`.
- **`src/registry.ts`.**

Cubre R20–R28 y R34.

### `apps/server`

- **`src/server.ts`.** `isIngestPath`, guard, `/healthz` con `service`, `maxRequestBodySize` explícito. Cubre R4.
- **`src/ingest-route.ts`.** Chequeos de D3, lectura en streaming cancelable y tope en vuelo. Cubre R1–R5, R7.
- **`src/otlp-server.ts`.** Solo si `otlpEnabled`: decodificar → aplanar → `routeOtel` → responder → encolar. Cubre R14, R15, R17, R34.
- **`src/lanes.ts`.** `LaneMonitor`. Cubre R28.
- **`src/api.ts`.** `/api/stats.lanes`; `/api/sessions/:id` con `hooks`/`hooksFrom`; `SessionSummary` con `lastPromptAt` y `activeAgentAt`. Cubre R7, R28, R30.
- **`src/app.ts`.** Cola, receptor opcional y apagado. Cubre R1, R15.

### `apps/web`

- **`src/lib/reduce/feed.ts`.** Las `revision` reemplazan su hecho y nunca se agregan; etiquetas y `describeEvent` nuevos. Cubre R11, R13, R29, R32.
- **`src/lib/reduce/projects.ts` y `session.ts`.** Folds guardados por `ts`; `applyRevision` que solo rellena. Cubre R11, R13.
- **`src/lib/reduce/hooks.ts`** y **`src/views/HooksPanel.svelte`.** Cubre R30.
- **`src/views/Timeline.svelte`.** Cubre R29.

### `fixtures/` y `scripts/`

- **Fixtures:** `fixtures/claude/hooks/`, `fixtures/codex/hooks/`, `fixtures/{claude,codex}/otlp/` (capturas de B0, anonimizadas), `fixtures/otlp/protobuf/*.bin` (oráculo) y `fixtures/otlp/protobuf/vectors.ts` (vectores escritos a mano).
- **`scripts/anonymize/{hook,otlp}.ts`.**
- **`scripts/encode-otlp-fixture.ts`** y **`scripts/fuzz-otlp-decoder.ts`**, con `protobufjs` como devDependency **solo** de `@crow/scripts`.
- **`scripts/b0-transport-experiment.md`**: el protocolo del experimento, cuyo resultado queda en la bitácora.

---

## Decisions

### D1 — Layout (R1–R34)

- Sigue PLAN §6.3.
- La mecánica de carril que no depende del motor (cola, ruteo OTel, reconciliación y libro de uso) vive en `core`. El conocimiento de cada motor (mapas y planes de attach) vive en su adaptador. `apps/server` cablea HTTP. `@crow/cli` depende de `@crow/server` solo para `crow up`.
- `EngineAttacher` queda fuera de `EngineAdapter`, porque el servidor no lo usa.
- *Reversión:* barata.

### D2 — Una cola, dos FIFO y un drenador (R1, R6, R7, R31; MF5, MF7, SF3)

- **Forma.** `IngestQueue` tiene dos FIFO:
  - **hooks:** `{ engine, receivedAt, seq, body }`, con tope de 2,000 items o 32 MiB;
  - **otel:** `{ events: PendingEvent[], bytes }`, ya ruteados, con tope de 64 MiB estimados.

  Un solo drenador toma **primero los hooks** y procesa pasos de ≤ 200 items (payloads o eventos) o 4 MiB en una transacción. Publica **sin `await` entre commit y publicación**, y cede el hilo con `await` antes del siguiente paso. Un lote OTLP grande se reparte en muchos pasos, así que un hook espera como mucho un paso.
- **Desborde de hooks (R7).** 204, descarte, `hookDropped` y un `ingest.error queue-overflow` por episodio en `<engine>:unknown`. **Cuota por motor:** al encolar, un motor no puede ocupar más del 60 % de la FIFO de hooks. En el drenador, un evento del carril B que crearía una sesión nueva cuando ese motor ya creó 120 en el último minuto se descarta. Las dos cosas cuentan como desborde (R7). Es la mitigación de SF3-S1 contra un proceso local que inunde la cola, sin agregar UX.
- **Cuerpos en vuelo (SF3-S2).** Hay como mucho 16 lecturas de cuerpo simultáneas en `/ingest/*`; la 17.ª recibe 204 y cuenta como desborde. La lectura cuenta bytes y **cancela el reader** al pasar 1 MiB; nunca usa `await req.arrayBuffer()`.
- **Cola OTLP llena.** `503` con `Retry-After: 5`. La spec lo define como reintentable, así que no se pierden datos y el exporter espera.
- **R6.** `invalid-json`, `unknown-type` con el nombre, y `bad-shape` si el adaptador lanza.
- **Errores del store (MF7):**
  - el store **nunca lanza por datos**: una violación de invariante pasa a `ingest.error invariant` y ese evento se salta (D5);
  - si la transacción de un paso lanza de todos modos, el drenador **biseca** el paso. Un item aislado que falla con `SQLITE_FULL`, `IOERR`, `BUSY` o `LOCKED` (ambiental) queda en la cabeza con backoff de 1 s a 30 s, y la cola sigue aceptando hasta llenarse (R7). Con cualquier otro error se descarta con un `ingest.error store-error` en una transacción aparte;
  - el tailer conserva el reintento de F1: solo le quedan errores ambientales.
- *Descartado:* una tabla de entrada durable, `503` para los hooks (lo prohíbe R7) y procesar OTLP dentro de la petición (MF5).
- *Reversión:* barata.

### D3 — Contrato de `/ingest/hook/:engine` (R1–R5)

- **Orden:**
  1. guard (403);
  2. método (405);
  3. token (401);
  4. motor (404, R2);
  5. tope de cuerpos en vuelo (204 y cuenta);
  6. tamaño mientras se lee (413, R5);
  7. encolar: cola llena o cuota del motor → 204 y cuenta (R7); si no, `204`.
- **Guard (R4).** `checkRequest` sin cambios. `isIngestPath` usa el prefijo `/ingest/` sensible a mayúsculas, igual que `isApiPath` (`/ingest` a secas cae al 404 estático). Los clientes de hook no mandan `Origin` (verificado con curl; el cliente `http` de Claude lo confirma B0).
- **Token (R3).** `Authorization: Bearer <token>` comparado en tiempo constante. El token es `CROW_TOKEN` del entorno o, si no está, `$CROW_HOME/token` (0600). **Por defecto** `attach` crea ese archivo cuando el transporte es el script (Codex siempre; Claude si B0 elige `command`), porque el script lo lee en tiempo de ejecución y el token nunca aparece en la definición confiable ni en `settings.json`. Con el transporte `http` de Claude, el token solo funciona por interpolación de entorno (`headers` + `allowedEnvVars`, doc), así que no hay token por defecto. Leer el archivo como "CROW_TOKEN definido" es una lectura de R3 que dejo explícita (§ Requisitos).
- **1 MiB (R5).** Si `Content-Length > 1 MiB`, 413 sin leer; sin `Content-Length`, conteo y cancelación en 1 MiB + 1. `maxRequestBodySize` = 8 MiB en `Bun.serve` como respaldo (hoy no está fijado).
- **204 sin cuerpo.** No se exige `Content-Type`.
- *Reversión:* barata.

### D4 — Atribución y orden de pasos en el store (R10; MF3)

**Claude** (campos doc o navori; ⚠ los que cierra B0):

- **Sesión:** `session_id`.
- **Proyecto:** `cwd` con `projectKey` y la regla de proyecto pegajoso (F1 D8).
- **Agente:**
  - las fases del padre (`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreCompact`, `PostCompact`, `Stop`, `StopFailure`) → main;
  - tools, permisos e `InstructionsLoaded` → primer no vacío entre `agent_id` y `subagent_id`, o si no hay, main;
  - `SubagentStart` → el hijo por `agent_id`;
  - `SubagentStop` → el hijo por el basename de `agent_transcript_path` ⚠, o si no hay, `agent_id`.
- **`ts`:** hora de recepción, salvo que B0 muestre un timestamp.
- **Nunca** hay atribución por ventana de tiempo.

**Codex:** el mismo esquema con los campos doc de stdin (`session_id`, `cwd`, `hook_event_name`, `tool_use_id`, `turn_id`, `transcript_path`). Queda abierto (G2) si `session_id` es la raíz o el hilo. **Solo si B0 muestra ids de hilo**, B3 agrega la resolución por `transcript_path`: el tailer ya conoce ruta → (sesión raíz, hilo) al ingerir, y se registra en una tabla `transcript_ids(path, session_id, agent_id)`. Es exacta y no hace falta ninguna ventana. Sin esa evidencia, B1 no construye alias (SF10).

**Orden de pasos por evento en `ingestEvents` (corrige MF3):**

1. identidad (solo Codex y solo si B3 lo agrega);
2. dedupe `l:`/`s:` por carril (F1);
3. `ensureSession` (F1 D8);
4. **`reconcile`: buscar el hecho** por `match`. El **agente canónico** es el del hecho si tiene una contribución del transcript; si no, el del evento entrante si es del transcript; si no, el del hecho;
5. **`ensureAgent(agente canónico)`**, con una regla: un `agent.stop` del carril hook cuyo agente **no tiene fila en `agents` ni hecho `agent-start`** se guarda como evento, pero **no crea fila de agente**. Un `SubagentStop` de un agente interno sin transcript (#560) no aparece como agente fantasma en el árbol. Los eventos de tool con `agent_id` sí crean fila (navori midió que resuelven a transcripts);
6. usage (D6);
7. insertar el hecho o fundirlo (D5);
8. efectos guardados por `ts` (D5).

- *Descartado:* crear la fila de agente antes de conocer el hecho (revisión 1).
- *Descartado:* ventanas de tiempo.
- *Reversión:* barata.

### D5 — Reconciliación: hechos inmutables, fusión en el lugar y fila `revision` (R11, R13; BD1, BD2, SF1, SF2)

**`semanticKey` no cambia:** sigue siendo identidad dentro de un carril.

**`MatchSpec`** (§ Contracts). Los modos son `exact` (clave con id nativo; alcance de sesión) y `nearest` (clave de clase más ventana; solo compactación y prompts de Codex sin id).

**No hay `enrichOnly` (BD2):** un evento de cualquier carril que no encuentra su hecho lo **crea**. Solo se descarta, con el contador `unkeyed_otel`, un registro OTel que ni siquiera tiene el id que la clave exige (p. ej. un `tool_result` sin `tool_use_id`).

**Algoritmo (en la transacción, paso 4 y 7 de D4):**

1. Busca el hecho con `SELECT … FROM events WHERE session_id = ? AND lkey = ?` (índice `events_by_lkey`). En `exact` hay como mucho una fila. En `nearest` se descartan las que ya tienen el `role`, caen fuera de ±`windowMs` o tienen un `lfp` distinto (el fingerprint es **requisito** cuando ambos lados lo traen; si a uno le falta, empareja solo por ventana), y de las restantes se elige el `|Δts|` menor.
2. **Sin hecho:** se inserta con `lkey`, `lfp` y `lmeta = { lanes: [role], prov: {…} }`; los efectos corren (guardados por `ts`).
3. **El mismo `role` ya contribuyó** (en modo exact): duplicado del carril; se descarta y cuenta `lane_duplicates`.
4. **Fusión:** `merged = mergeEvents(stored, prov, incoming, role)`.
   - `UPDATE events SET body_json, ts, agent_id, lmeta WHERE id = <id del hecho>`. **El `id` no cambia.**
   - Los efectos corren con el hecho fundido. Como son guardados por `ts` (más abajo), repetirlos no daña.
   - **Solo si cambió un campo que se pinta**, se inserta una fila `revision`: `id` nuevo (`nextId()`), `kind = 'revision'`, las columnas `session_id`, `project_key`, `agent_id` y `ts` del hecho, y `body.revision = { of: <id del hecho>, fact: merged }`. Se publica esa fila. Si solo cambiaron `sources`, `ts` o `lmeta`, no se publica nada.

**Precedencia** (§ Reconciliación). `prov` guarda qué rol puso cada campo; un campo entrante reemplaza al guardado solo si tiene mayor rango. El valor final es función del **conjunto** de contribuciones. El emparejamiento es único en `exact`; en `nearest` puede depender del orden solo con dos candidatos del mismo hecho dentro de la ventana (límite documentado).

**Efectos guardados por `ts` (BD1)**, idénticos en el store y en los reducers:

- **Estado de sesión.** Un `session.end` marca `ended` con `ended_at = MAX(ended_at, ts)`. Cualquier otro evento revive una sesión `ended` **solo si `ts > ended_at`**; si no, sigue la regla de F1 D10. Un evento viejo que llega tarde (transcript atrasado, fusión, `turn.end`) ya no revive una sesión cerrada por `SessionEnd`.
- **`last_prompt`.** Cambia solo si `ts >= last_prompt_at` (columna nueva). Un prompt fundido tarde no hace retroceder al último.
- **Agentes.**
  - `agent.start` rellena metadatos con `COALESCE` y **nunca** borra `ended_at` ni vuelve a poner `running` a un agente terminado. Ningún motor reinicia un agente.
  - `agent.stop` hace `ended_at = COALESCE(ended_at, ts)`.
- **Agente activo.** `agent.start` lo fija solo si `ts >= activeAgentAt`, donde `activeAgentAt` es el `ts` del último `agent.start` o `agent.stop` aplicado; el servidor lo expone en `SessionSummary`.
- **`last_event_at`:** `MAX`.

**Filas `revision`:**

- no son hechos: `hookStats`, los conteos y F3 filtran por `kind` y las ignoran por construcción;
- `listSessionEvents`/`listEventsAfter`/`listRecentEvents` las devuelven para que el cliente en vivo o paginando las aplique;
- el cliente **reemplaza** el hecho `of` si lo tiene y si no la ignora; nunca la agrega al timeline (D16);
- un cliente que paginó el hecho ya fundido y después ve la revisión la aplica sin efecto.

**Invariantes** (en violación: `ingest.error invariant` y se salta el evento, nunca `throw`, MF7):

- no se fusiona un evento con `usage` ni un `hook`: ningún `MatchSpec` se emite para ellos;
- una `revision` nunca lleva `usage`.

**Costo.** Casi todas las fusiones son silenciosas: el hook y el transcript traen el mismo `input` y el mismo texto. Hay revisión cuando:

- se completa una compactación;
- el transcript agrega `input` a una fila que creó OTel;
- el hook o OTel agregan `ms` o veredicto a una fila que creó el transcript;
- el transcript agrega metadatos a un `agent.start` que llegó por hook.

**Prompts (SF1).**

- Claude: clave exacta `prompt@<agent|main>:<id>` con el id de `promptId` en el transcript (100 % de las líneas `user` ✓), `prompt_id` en el hook (doc) y `prompt.id` en OTel (doc). Lleva el agente porque las líneas de un subagente podrían compartir el `promptId` del turno padre.
- Codex, hasta que G2 dé un id común: `nearest` `prompt@<agent|main>`, ±10 s, `fingerprint = sha1(text.trim())`.
- Un hook de Claude sin `prompt_id` queda como fila propia y cuenta `unkeyed_prompt`.

*Reversión:* media. Fija que un `id` es inmutable (el contrato de F1) y agrega un kind; se decide ahora.

### D6 — Uso entre carriles: libro de uso OTel (R12)

- **Qué cuenta OTel.** Solo el uso **por llamada**: el `api_request` de Claude y el `codex.sse_event` de `response.completed` ⚠. Las métricas `token.usage`/`cost.usage` agregan esas mismas llamadas y **nunca** cuentan: van en `reported`.
- **Clave por llamada.**
  - Claude: `req:<request_id>` en OTel (doc) contra el `requestId` de cada línea `assistant` (100 % ✓). El adaptador de transcript pone `usageCallKey = "req:" + requestId`.
  - Codex: no hay id común conocido (G4), así que el alcance es **la sesión**.
- **Marcas del transcript.** Al contar uso de una línea con `usageCallKey`, el store inserta `dedupe('transcript', session, 'r:<id>')` y pone `sessions.tu_keyed = 1`. Sin clave (Codex `token_count`, o una línea de Claude sin `requestId`) pone `sessions.tu_unkeyed = 1`.
- **Llega uso OTel** (`otelUsage` en el evento; el `api.request` se guarda como hecho con los números en `reported`):
  - alcance llamada: si existe la marca `r:<id>` **o** `tu_unkeyed = 1` → no cuenta;
  - alcance sesión: si `tu_keyed` o `tu_unkeyed` → no cuenta;
  - si no, fila en `otel_usage` con `state = 'held'` y `hold_until = now + 30 s`.
- **Promoción** (`promoteHeldUsage`, en el sweeper cada 30 s). Cada `held` vencido se vuelve a comprobar. Si el transcript sigue sin traer la llamada (o la sesión), pasa a `counted`: `applyUsage` al agente principal (OTel no trae id de agente) con el `ts` del registro, y se publica un evento `kind: "usage"`, `source: "otel"`, con ese `usage` (contado). Los totales de una sesión solo-OTel aparecen en ≤ 60 s.
- **Llega el transcript de una llamada ya en el libro:**
  - si estaba `held` → pasa a `dropped`, sin eventos;
  - si estaba `counted` → **reemplazo**: `applyUsage` con los componentes **negativos** en el agente principal y el día del registro, un evento `usage` de corrección con ese `usage` negativo, y `state = 'dropped'`. El transcript cuenta lo suyo como siempre.
  - Una línea sin clave reemplaza **todas** las filas `counted` de la sesión: es conservador, puede sub-contar y nunca duplica.
- **Sin doble conteo en ningún orden:**
  - OTel → transcript dentro de la retención: se descarta;
  - transcript → OTel: la marca la descarta;
  - OTel → promoción → transcript: la corrección neta es 0 más el transcript;
  - un reintento del mismo lote: `l:` y la PK del libro;
  - el mismo transcript dos veces: F1.

  `usage-lanes.test.ts` prueba todas las permutaciones con el reloj inyectado.
- **Migración (clave):** las sesiones con uso contado antes de v3 no tienen marcas `r:`, así que la migración pone `tu_unkeyed = 1` en toda sesión con totales mayores que 0. OTel nunca duplica una sesión de F1.
- **Costo:** con el precio de crow (D12 de F1), no con el `cost_usd` de OTel, que queda en `reported`. Una corrección negativa baja `t_unpriced` en 1 si el modelo no tiene precio.
- **Invariante de F1 preservado:** "un evento con `usage` es un usage contado", incluidas las correcciones negativas, que son un delta contado.
- *Descartado:* contar lo primero que llegue con máximo por componente. OTel primero atribuye al principal y el transcript no gana; exige la misma corrección en la mitad de las llamadas, porque la carrera de 1 s es pareja.
- *Descartado:* contar solo el transcript (revisión 1): no cumple el R12 nuevo.
- *Reversión:* media (tabla y columnas).

### D7 — `ms` y veredicto de la tool (R11; MF6)

- **Precedencia de `tool.ms`, con su origen en `tool.msSource`:**
  1. `engine`: duración en el payload del hook ⚠;
  2. `engine`: `duration_ms` de OTel `tool_result` (doc);
  3. `hook-receipt`: recepción de `PostToolUse` menos recepción de `PreToolUse` (LRU de 4,096 en la cola). **Se descarta si hubo un `PermissionRequest` para esa llamada**, porque incluiría la espera del usuario (doc: Claude separa `blocked_on_user` de la ejecución);
  4. `transcript`: diferencia de `ts` del transcript.
- R11 dice "`ms` del hook". Esta precedencia lo cumple si se lee como "del carril hook, salvo que el motor dé su propia medición" (§ Requisitos).
- **`tool.verdict`:** `allow` (`PostToolUse`), `error` (`PostToolUseFailure`), `deny` (`PermissionDenied`), y `allow`/`deny` desde OTel `tool_decision`, con `decisionSource`. Precedencia: hook > otel.
- *Reversión:* barata.

### D8 — Receptor OTLP (R14, R15, R17, R34; MF5, SF5)

- **Opt-in (R34).** El receptor arranca solo si `otlpEnabled`: `crow up --otlp`, `CROW_OTLP=1` o `$CROW_HOME/config.json` `{ "otlp": { "enabled": true } }`, que `attach` escribe al configurar la telemetría de un motor. Los tests usan `otlpEnabled = false` o el puerto 0.
- **Puerto ocupado (R15).** `EADDRINUSE` (✓, síncrono) deja el carril en `port-in-use`, un log sin contenido, y todo lo demás sigue.
- **Rutas:**
  - `POST /v1/{logs,traces,metrics}`;
  - cualquier otro método sobre esas rutas → 405;
  - `GET /healthz` → `{ service: "navori-crow-otlp", version }`;
  - todo lo demás → 404.
- **Guard.** Mismo `checkRequest`.
- **Tipos.** Se comparan como media type (`application/json; charset=utf-8` vale): JSON o `application/x-protobuf`; otro → 415.
- **Compresión.** `gzip` por `DecompressionStream` contando bytes y cancelando.
- **Topes.** 16 MiB crudo y 32 MiB descomprimido (413). La spec recomienda 64 MiB, pero con un solo hilo se prefiere acotar el bloqueo. El `BatchLogRecordProcessor` de los SDK limita los lotes a 512 registros, muy por debajo de eso.
- **En la petición (sin DB):** decodificar → aplanar → `routeOtel` → responder → **encolar** los `PendingEvent` aceptados en la FIFO otel (D2). Si no caben → 503 más `Retry-After`.
- **Respuestas (camelCase en JSON, doc):**
  - 200 con `{}`;
  - `partialSuccess` (`rejectedLogRecords`/`rejectedSpans`/`rejectedDataPoints` como string, más `errorMessage`) **solo** para registros individuales indecodificables;
  - los registros sin motor o sin sesión se aceptan (200), se cuentan y producen el `ingest.error` por episodio de D10, porque avisarlo en cada export llenaría de warnings a los SDK ajenos;
  - 400 con `Status` si el cuerpo no se decodifica;
  - 413, 415 y 503.
- *Descartado:* encendido por defecto (lo contradicen R34 y PLAN §6.2).
- *Reversión:* barata.

### D9 — Decodificador protobuf propio con oráculo de desarrollo (R14; SF4)

- **Decodificador** (`packages/otlp/src/protobuf.ts`):
  - wire types 0, 1, 2 y 5;
  - los 3 y 4 (grupos) y el 6 y 7 son error;
  - varints con `BigInt` y error si pasan de 10 bytes;
  - largos con aritmética, nunca `<<`/`|`;
  - `int_value` con `BigInt.asIntN(64)`; `as_int` (campo 6) como **sfixed64**, con signo; `time_unix_nano` como fixed64;
  - `double` y `float` por `DataView` little-endian;
  - strings con `TextDecoder` no fatal;
  - un campo de mensaje no repetido que aparece dos veces se queda con el último, y el `oneof` de `AnyValue` también (documentado);
  - los campos empaquetados que se saltan se saltan por su largo;
  - **todo campo desconocido se salta por wire type**, en cualquier nivel;
  - cuerpo vacío = petición vacía válida.
- **Topes.** Profundidad de `AnyValue` 32 y 1,000,000 de valores por petición. Pasarse lanza `ProtobufError` (400), nunca un `RangeError`/500.
- **Números de campo** de un tag fijado de `opentelemetry-proto`, anotado en la cabecera (búsqueda en B4, no un gap).
- **Oráculo (decidido).**
  - `protobufjs`, versión exacta, como devDependency solo de `@crow/scripts`.
  - `scripts/encode-otlp-fixture.ts` codifica las capturas JSON a `.bin` para los tests de igualdad.
  - `scripts/fuzz-otlp-decoder.ts` es un diferencial aleatorio sobre los vectores, manual y fuera de CI.
  - **Los vectores del checklist se escriben a mano** (`vectors.ts`) y no los genera el oráculo.
  - Un test de higiene impide protobuf en `apps/*` y `packages/*`.
- **JSON.** `int64` siempre como string en `FlatOtelRecord.attrs` si no es un entero seguro, y los adaptadores leen con `typeof`. `timeUnixNano` (número o string) pasa por `BigInt`.
- *Descartado:* `protobufjs` en runtime (`@protobufjs/inquire` usa `eval` y el codegen usa `Function`) y `@bufbuild/protobuf` (exige toolchain de codegen).
- *Reversión:* barata.

### D10 — Aplanado y ruteo (R16, R17; MF10, SF10)

- **`FlatOtelRecord`** (§ Contracts): recurso ∪ registro (gana el registro), escalares, `name` crudo, `ts`/`endTs` en ms vía `BigInt`, y `hash` como identidad `l:`.
- **Ruteo a motor por firma del registro, no por `service.name`:**
  - **Claude:** métrica `claude_code.*`; log con `event.name` ∈ {`user_prompt`, `tool_result`, `tool_decision`, `api_request`} (con o sin prefijo `claude_code.`) **y** `session.id`; span con prefijo `claude_code.` ⚠ y `session.id`.
  - **Codex:** `service.name` (valor ⚠, doc dice que lo manda) o nombres `codex.*`, más `conversation.id`.
  - **`attach` no fija `OTEL_RESOURCE_ATTRIBUTES`**: se heredaría a los procesos hijos (D14) y los etiquetaría como Claude.
- **Sesión (R16).** `session.id` / `conversation.id`.
- **Sin motor o sin sesión (R17).** Se cuentan en `stats.otelUnattributed` y producen **un** `ingest.error unattributable` por episodio de (`service.name` o `"unknown"`, 10 min), en `otel:unattributed` o `<engine>:unknown`. Así, un SDK local que exporta a 4318 cada 5 s produce un error cada 10 min y no un flujo.
- **Métricas.** Los puntos de una misma petición se agrupan por (sesión, métrica, modelo, `ts`) en **un** evento `usage` con `reported.byType`. Las de valor 0 no se guardan. Consumidor: F3 (costo reportado contra calculado); no se pintan.
- **Registros conocidos que no se mapean** → `otelIgnored`.
- *Reversión:* barata.

### D11 — Vocabulario (R8, R32, R33)

- **`turn.end` (R32).** Lleva `turn: { ok: boolean; category?: string }`. `Stop` da `{ ok: true }`; `StopFailure` da `{ ok: false, category }`, con la categoría del conjunto cerrado de la doc. Nunca se guarda `last_assistant_message`.
- **`revision`** (D5).
- **`hook` gana tres campos:** `blocking` (lo estampa el adaptador), `aggregate: true` (spans beta, que resumen varios hooks) y `exitCode` (registros del transcript).
- **`tool` gana** `verdict`, `decisionSource` y `msSource`.
- **Campos nuevos en `CrowEvent`:** `permission`, `compact`, `reported`, `sources` y `turn`.
- *Reversión:* barata.

### D12 — `crow up` mínimo (R34; SF10)

- `crow up [--otlp] [--otlp-port <n>] [--port <n>]` solo traduce las banderas a `CrowConfig` y llama a `startApp`. Nada más: `apps/server/src/index.ts` sigue como está para `dev`.
- `crow attach|detach <claude|codex> [--yes] [--traces]` y `crow doctor`.
- El script raíz es `"crow": "bun packages/cli/src/main.ts"`.
- *Reversión:* barata.

### D13 — Marcado, unidades, symlinks y backups (R21–R27; MF8, SF9)

**Unidades.** `attach` escribe **unidades** con identidad propia y el manifiesto guarda el texto o el valor exacto de cada una. `$CROW_HOME/attach/<engine>-<sha1(realpath de la config)[:8]>.json` es uno por archivo de configuración (SF9b), con permisos 0600.

- **Claude (JSON):**
  - unidad = un handler de crow en un evento. Se reconoce por la firma: `type` y URL, `^http://(127\.0\.0\.1|localhost):\d+/ingest/hook/claude$`, o el comando `…/crow-ingest-hook claude`;
  - unidad = cada clave `env` que crow escribió.
- **Codex (TOML):** unidad = cada grupo `[[hooks.X]]` con su `[[hooks.X.hooks]]` y sus claves, y la tabla `[otel]`. Todas van dentro de un bloque marcado al final del archivo.

**`detach`, cumpliendo R26 por unidades:**

- Una unidad **intacta** (igual al manifiesto) se quita.
- Una unidad **que el usuario editó** se conserva y se informa: un handler con claves extra (`headers`, `if`), un `env` con otro valor, o un grupo TOML con una línea cambiada.
- Las líneas o claves que el usuario **agregó** se conservan siempre.
- Los marcadores se quitan.
- Los contenedores (`hooks.<Evento>`, `hooks`, `env`) solo se quitan si quedan vacíos y crow los había creado.
- **Verificación semántica:** `parse(después)` debe ser igual a `parse(antes)` menos exactamente las unidades quitadas. Si no se cumple (por ejemplo, una clave suelta del usuario quedó dentro de una unidad TOML y quitarla la movería de tabla), **se aborta sin escribir** y se explica.
- **Sin manifiesto:** firma de URL o comando para los handlers, y valor exacto para `env`.

Conservar una unidad de crow que el usuario editó contradice la letra de "remove exactly the entries crow added". Es inevitable (quitarla borra el cambio del usuario), así que pido el ajuste de R26 (§ Requisitos).

**Otras reglas:**

- **Idempotencia (R25):** si el estado deseado ya coincide, se informa y no se escribe ni se respalda.
- **Parseo (R27):** si falla, se aborta sin escribir.
- **Verificación semántica en `attach`** también.
- **JSON.** Se re-serializa con la indentación detectada. Si el archivo no estaba en ese formato, el diff avisa "N líneas cambian solo de formato" antes de confirmar (SF9); se prueba con un fixture formateado a mano. *Descartado:* un editor quirúrgico de JSON, porque el costo no se justifica.
- **Diff:** contexto 0, y se enmascaran los `env` que crow no escribió.
- **Confirmación:** TTY o `--yes`; sin ninguna de las dos se aborta.
- **Carrera:** se compara el sha256 del archivo antes de escribir. Queda una ventana TOCTOU entre la relectura y el `rename`, que es aceptable y está documentada.
- **Symlinks (MF8).** Se escribe **a través del destino**: `realpath` de la ruta, archivo temporal en el directorio del destino, `rename` sobre el destino y se conservan modo y dueño. El symlink queda intacto. Si el destino no se puede escribir, se aborta. Se prueba.
- **Backup (R22):**
  - `$CROW_HOME/backups/<engine>/<basename>.<UTC>.bak`, 0600 en un directorio 0700, antes de escribir; si falla, se aborta;
  - **se conservan los 10 más recientes** por motor;
  - la salida avisa que el backup copia los secretos del archivo.
- **R23.** Solo se escriben el archivo del motor (su destino real) y `$CROW_HOME`.
- **TOML.** La verificación usa `Bun.TOML.parse`, no el parser de Codex (Rust). Fechas y rasgos de TOML 1.1 pueden diferir (nota).
- *Reversión:* barata.

### D14 — Lo que escribe `attach` (R20, R24, R34; MF1, MF2, MF9, SF6)

**Script propio de crow** (`$CROW_HOME/hooks/crow-ingest-hook`, 0700, `#!/bin/sh`, lo genera `attach`):

- lee el JSON de stdin;
- lleva el puerto grabado en el script;
- lee el token de `$CROW_HOME/token` si existe;
- ejecuta `curl -s -m 2 -X POST -H 'Content-Type: application/json' [-H "Authorization: Bearer …"] --data-binary @- http://127.0.0.1:<port>/ingest/hook/$1 >/dev/null 2>&1`;
- termina con **`exit 0` siempre**, y nada va a stdout.

Si falta `curl`, el shell también manda su error a `/dev/null` y el script sale con 0. Cambiar de puerto o de token **reescribe el script, no la definición confiable**.

**Claude: dos transportes; el experimento de B0 elige.**

| | `http` | `command` + `async` |
|---|---|---|
| Handler | `{ "type": "http", "url": "http://127.0.0.1:<port>/ingest/hook/claude", "timeout": 2 }` (`SessionEnd`: `timeout: 1`, por su presupuesto de 1.5 s) | `{ "type": "command", "command": "<CROW_HOME>/hooks/crow-ingest-hook claude", "async": true, "timeout": 2 }` |
| Latencia en la ruta de la tool | síncrona: ~1 ms con crow arriba, hasta 2 s si está colgado | ninguna (async, doc) |
| crow abajo, 401, 403, 404, 413 | "non-blocking error" (doc); ⚠ si se ve | el script sale con 0 (✓ con el puerto cerrado) |
| Token | solo por entorno (`headers` + `allowedEnvVars`) | archivo leído por el script |
| Fork por evento | no | sí, fuera de la ruta crítica |
| Riesgos | allowlist administrada `allowedHttpHookUrls` | `curl` en el PATH (se verifica en `attach` y en `doctor`) |

**Entregable de B0** (`scripts/b0-transport-experiment.md` más la bitácora):

- para cada transporte, con Claude real y un `CLAUDE_CONFIG_DIR` temporal, en cuatro estados: crow abajo, crow colgado, 401 y 413;
- se registra: (1) error visible en la TUI, (2) líneas `hook_*` en el transcript, (3) latencia añadida por tool (p50 y p95 de 20 llamadas) y (4) si llegan los eventos.

**Criterio:** gana `command`+`async` salvo que muestre errores visibles o pierda eventos que `http` no pierde. `fromHook` y R33 funcionan con cualquiera: la constante vive en el attacher.

**Decisión (B0, 2026-09-29): el transporte de Claude es `command` + `async: true`.** Con el criterio de arriba, evidencia en [`b0-bitacora.md`](b0-bitacora.md) § G1:

- `command`+`async` no muestra error visible con crow abajo, colgado, 401 ni 413; `http` lo muestra en los cuatro (stderr y `hook_response` de error o cancelado).
- `command` no pierde eventos que `http` no pierda, y `http` pierde `SessionStart` (44 contra 45 requests).
- Latencia con crow colgado: `http` p50 4046 ms contra 73 ms de `command`+`async` (base 52 ms).
- `http` deja 42 líneas `hook_*` en el transcript cuando falla; `command` async, 0.
- Caveat: medido con `claude -p` (stderr y `hook_response`), no con el TUI. Ajuste condicional de R5/R20: **no aplica** (ver B0.T1), porque con `command` el 413 y el 401 no se ven.

**OTel de Claude (`env` en `settings.json`):**

```json
"CLAUDE_CODE_ENABLE_TELEMETRY": "1",
"OTEL_LOGS_EXPORTER": "otlp",
"OTEL_METRICS_EXPORTER": "otlp",
"OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
"OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:<otlpPort>",
"OTEL_LOGS_EXPORT_INTERVAL": "1000"
```

- Con `--traces`: además `"CLAUDE_CODE_ENHANCED_TELEMETRY_BETA": "1"` y `"OTEL_TRACES_EXPORTER": "otlp"`.
- **Fuga a procesos hijos (MF9).** El `env` de settings probablemente lo heredan los subprocesos de la tool Bash (B0 lo verifica), y **no se puede evitar**: es el único canal documentado para configurar la telemetría de Claude a nivel usuario. Mitigaciones:
  1. **endpoint genérico igual al default de OTel** (`127.0.0.1:4318`). Un SDK hijo que no configura nada ya apuntaba ahí, y uno que fija su propio `OTEL_EXPORTER_OTLP_ENDPOINT` lo sobrescribe. Por eso se descartan las variables por señal, que ganarían sobre la del hijo. Con `CROW_OTLP_PORT ≠ 4318` el diff avisa que redirige a los hijos;
  2. **no se fija `OTEL_RESOURCE_ATTRIBUTES`** (D10);
  3. `attach` lee **el entorno del shell** (`process.env.OTEL_*`) además de `settings.json`. Si ya hay un endpoint u exporter con otro valor, **se omite el carril C** y se informa (la misma regla de conflicto que para `settings.json`);
  4. lo que exportan los hijos llega como no atribuible con episodios de 10 min (D10) y no ensucia los datos;
  5. la nota queda en el diff.
- **R24 (ampliado).** Nunca se escriben `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT` ni ningún flag de cuerpos crudos que B0 encuentre en la doc (lista cerrada en `attach.ts`), ni `log_user_prompt = true` en Codex. `attach` y `doctor` avisan si el usuario ya los tiene activos.
- **R34.** Si se configuró el carril C, `attach` escribe `$CROW_HOME/config.json` `{ "otlp": { "enabled": true, "port": <n> } }` y avisa que hay que reiniciar crow si está corriendo.

**Codex (`config.toml`, doc; bloque marcado al final):**

```toml
# >>> crow v1 — crow attach codex; quitar con: crow detach codex >>>
[otel]
exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/logs", protocol = "json" } }

[[hooks.PreToolUse]]
[[hooks.PreToolUse.hooks]]
type = "command"
command = "/Users/<u>/.crow/hooks/crow-ingest-hook codex"
timeout = 2
# …one group per event in R9
# <<< crow <<<
```

- **Confianza (MF2).** Codex no ejecuta un hook no administrado hasta que el usuario lo revisa y confía (doc). La definición es fija (ruta del script más `codex`), así que se confía **una sola vez**: el puerto y el token viven en el script y en `$CROW_HOME`.
  - `attach` termina con: "Abre Codex y corre `/hooks` para revisar y confiar en los 10 hooks de crow".
  - Si `hooks.json` existe, se avisa que Codex fundirá ambos y advertirá al arrancar.
  - `doctor` distingue "configurado pero sin recibir nada mientras hay sesiones de Codex vivas" como **confianza pendiente probable**. crow no lee el estado interno de Codex.
  - La aceptación de B6 incluye el paso de confianza.
- **Matcher.** Se omite, que significa todos (⚠ B0).

*Reversión:* barata.

### D15 — `crow doctor` y `/api/stats.lanes` (R28, R15)

- **Fuente.** La API del servidor en marcha (`LaneMonitor` en memoria, desde el arranque); con el servidor apagado, solo las verificaciones de configuración.
- **Por motor:**
  - **Carril A:** la raíz de watch existe y `lastStoredAt`.
  - **Carril B:**
    - configuración (`inspect`): unidades presentes (x/15 o x/10), transporte, puerto, token, `curl` en el PATH si es `command`, `disableAllHooks`/`allowManagedHooksOnly`, y el archivo de settings administrado si existe (ruta de la doc ⚠, leído de solo lectura);
    - servidor: último hook recibido, rechazos por motivo, **"confianza pendiente probable"** en Codex y **"posibles errores visibles en el motor"** si hay 401 o 413 con `http`.
  - **Carril C:**
    - configuración: endpoint igual a `otlpPort`; flags de contenido (los cuatro de la doc más `log_user_prompt`); un `OTEL_*` del shell que choca;
    - servidor: estado (`listening | disabled | port-in-use | error`) y el sondeo `GET :otlpPort/healthz` (crow, **otro collector** o nadie);
    - "configurado en el motor pero apagado en crow" (R34);
    - último registro recibido y no atribuibles.
- *Reversión:* barata.

### D16 — UI (R29–R32)

- **Timeline (R29, R32):**
  - `hook`: nombre · fase · veredicto · duración, y marcado si es bloqueante;
  - `permission`: herramienta · decisión (origen);
  - `turn.end`: "Fin de turno" o "Turno fallido: <categoría>";
  - `compact`: estado y duración;
  - `api.request`: modelo · latencia · costo reportado;
  - `usage` y `revision` no se pintan.
- **Cronología.** El `id` del hecho no cambia (D5), así que el orden por `id` de F1 se mantiene y un `tool.pre` nunca aparece después de su `tool.post` (SF2).
- **Revisiones.**
  - `applyToFeed` y `normalize`: una `revision` **reemplaza** el hecho `of` si está en la ventana, si no se ignora, y nunca se agrega.
  - Folds de sesión y proyectos: `applyRevision(fact)` **solo rellena**: `lastPrompt` si `fact.ts >= lastPromptAt`, y el tipo y la descripción del agente si faltaban. Nunca toca estado, `endedAt`, agente activo ni totales.
- **Folds guardados por `ts`**, para hechos nuevos (BD1):
  - `updateSession` revive `ended` solo con `e.ts > endedAt`;
  - `lastPrompt` solo con `e.ts >= lastPromptAt`;
  - el agente activo solo con `e.ts >= activeAgentAt`;
  - `updateAgent` no revive a un agente `done`.

  `SessionSummary` gana `lastPromptAt` y `activeAgentAt` (aditivo).
- **Panel de hooks (R30).**
  - `GET /api/sessions/:id` gana `hooks: HookStat[]` y `hooksFrom`, agregados sobre los `kind = 'hook'` con `aggregate` distinto de true (los spans beta resumen una invocación entera, incluidos los hooks de crow, así que no representan un hook por nombre). La UI dobla los nuevos con `id > cursor`.
  - **Estado vacío explícito:** "Sin registros de hooks para este motor" (Codex no tiene fuente).
  - **Horizonte** (`recorderWindow`): "registrados desde HH:MM".
- **Latencia (R31).** La cola da prioridad a los hooks y los pasos están acotados. `e2e/hook-latency.test.ts` mide el p95 con presupuesto holgado y el umbral estricto queda en la medición manual (N1).
- *Reversión:* barata.

### D17 — Qué se guarda (riesgo R2; F1 D15)

- **Hooks:**
  - `prompt` → `text` ≤ 8 KiB;
  - `tool_input` → `trimInput`;
  - errores ≤ 1 KiB;
  - **nunca** `tool_response`, `last_assistant_message`, `transcript_path` ni `raw`.
- **Registros de hook del transcript (R33):** allowlist `hookName`, `hookEvent`, `durationMs`, `exitCode` y el subtipo; **nunca** `stdout`, `stderr`, `content` ni `command` (este último se lee en memoria solo para excluir los hooks de crow).
- **OTel:** allowlist por evento; nunca `prompt`, entradas o respuestas de tools, cuerpos, `user.email`, `user.account_uuid` ni `organization.id`.
- **CLI:** diff enmascarado y backups 0600 con rotación.
- *Reversión:* barata hacia guardar más.

### D18 — Registros de hook del transcript de Claude (R33)

- **Qué se mapea.** Una línea `attachment` cuyo `attachment.type` empieza con `hook_` **y** trae `hookName` y `hookEvent` → `hook` con:
  - `name = hookName`, `phase = hookEvent`, `ms = durationMs`, `exitCode`;
  - `verdict` = el subtipo sin `hook_` (`success`, y los demás que capture B0 ⚠);
  - `blocking` = el subtipo es el de bloqueo ⚠ o `exitCode === 2` (la convención de bloqueo de los hooks `command`, doc ⚠).
  - Agente: el de la línea. `semanticKey` como F1 (`uuid`).
- **Qué se excluye:**
  - `hook_additional_context` (no es una ejecución y trae contenido), y cualquier `hook_*` sin `hookName`/`hookEvent`;
  - **los hooks de crow**: `command` contiene `crow-ingest-hook` o la URL cumple la firma de ingesta de D13. Se descartan sin guardar nada. Cómo registra el transcript los hooks `http` lo confirma B0 ⚠; si no deja rastro distinguible, crow queda excluido de todos modos porque no hay registro.
- **Cobertura.** El transcript no registra todas las ejecuciones: en el fixture hay 8 en una sesión con hooks de navori en cada Bash ✓. El panel lo dice con el horizonte y la nota de cobertura. Qué registra y qué no, lo mide B0.
- **Spans beta y registros del transcript son hechos distintos:** no se reconcilian, y el invariante "un `hook` nunca se fusiona" se mantiene (N3).
- **El snapshot de contrato de F1** gana 8 eventos `hook` (cambio deliberado).
- *Reversión:* barata.

---

## Contracts

### `CrowEvent`: adiciones

```ts
export type EventKind = /* F1 kinds */ | "turn.end" | "revision";

export type IngestErrorReason = /* F1 */ | "queue-overflow" | "unattributable" | "invariant" | "store-error";

export interface CrowEventTool { /* F1 */ verdict?: "allow" | "deny" | "error"; decisionSource?: string;
  msSource?: "engine" | "hook-receipt" | "transcript" }
export interface CrowEventHook { /* F1 */ blocking?: boolean; aggregate?: boolean; exitCode?: number }
export interface CrowEventPermission { decision?: "ask" | "allow" | "deny"; decisionSource?: string; reason?: string }
export interface CrowEventCompact { trigger?: string; startedAt?: number; endedAt?: number }
export interface CrowEventTurn { ok: boolean; category?: string }                       // R32
/** Engine-reported numbers (OTel). NEVER summed (D6). */
export interface CrowEventReported { metric?: string; byType?: Record<string, number>; temporality?: "delta" | "cumulative";
  model?: string; costUsd?: number; ms?: number; input?: number; output?: number; cacheRead?: number; cacheCreation?: number }
export interface CrowEventRevision { of: string; fact: CrowEvent }                     // D5

export interface CrowEvent { /* F1 */ sources?: EventSource[]; permission?: CrowEventPermission;
  compact?: CrowEventCompact; turn?: CrowEventTurn; reported?: CrowEventReported; revision?: CrowEventRevision }
```

### Contrato de adaptador

```ts
export interface MatchSpec {
  key: string;                       // session-scoped; include the agent in class keys
  mode: "exact" | "nearest";
  windowMs?: number; fingerprint?: string;   // "nearest" only
  role?: string;                     // one contribution per role; default = source
}
export type PartialCrowEvent = /* F1 */ & {
  usageKey?: string; semanticKey?: string;
  match?: MatchSpec;
  usageCallKey?: string;             // transcript: "req:<requestId>" (D6)
  otelUsage?: CrowEventUsage;        // OTel candidate usage: the store decides (D6); never counted directly
};
export interface HookInput { body: unknown; receivedAt: number }
export type HookResult =
  | { ok: true; events: PartialCrowEvent[]; warnings?: LineWarning[] }
  | { ok: false; reason: IngestErrorReason; detail?: string; sessionId: string | null; agentId: string | null };
export type OtelResult = { ok: true; events: PartialCrowEvent[] } | { ok: false; reason: "unattributable"; detail?: string };
export interface CrowConfig { /* F1 */ token: string | null; otlpEnabled: boolean; otlpPort: number }
export interface EngineAdapter<S extends JsonValue> {
  /* F1 members */
  fromHook?(input: HookInput): HookResult;           // pure, stateless, transport-agnostic
  ownsOtel?(record: FlatOtelRecord): boolean;        // signature-based (D10)
  fromOtel?(record: FlatOtelRecord): OtelResult;     // pure, allowlist
}
```

`packages/core/src/otel.ts`:

```ts
export type OtelScalar = string | number | boolean;
export interface FlatOtelRecord {
  signal: "log" | "span" | "metric";
  name: string;                                  // raw, prefix kept (D10)
  ts: number; endTs?: number;                    // epoch ms, via BigInt from *UnixNano
  attrs: Readonly<Record<string, OtelScalar>>;   // resource ∪ record, record wins; int64 not safe → string; transient
  service: string | null; scope: string | null;
  value?: number; temporality?: "delta" | "cumulative";   // metric points
  status?: "unset" | "ok" | "error";                       // spans
  hash: string;                                  // sha1 of the canonical record → `l:` identity
}
```

`packages/core/src/attach.ts`:

```ts
export interface AttachOptions {
  crowPort: number; otlpPort: number; configureOtel: boolean; traces: boolean;
  claudeTransport: "http" | "command";           // fixed after B0 (D14)
  hookScriptPath: string;                        // $CROW_HOME/hooks/crow-ingest-hook
  tokenInEnv: boolean;                           // CROW_TOKEN set in the environment (http transport only)
  shellEnv: Readonly<Record<string, string>>;    // OTEL_* seen in process.env (D14, MF9)
}
export type AttachPlan =
  | { ok: true; changed: false; notes: string[] }                                   // R25
  | { ok: true; changed: true; nextText: string; manifest: JsonValue;
      lanes: { hook: boolean; otel: boolean }; skipped: string[]; notes: string[] }
  | { ok: false; reason: string };                                                  // R27
export type DetachPlan =
  | { ok: true; changed: false; notes: string[] }
  | { ok: true; changed: true; nextText: string; removed: string[];
      kept: { unit: string; reason: string }[]; notes: string[] }                   // R26 (D13)
  | { ok: false; reason: string };
export interface AttachInspection {
  hooks: { configured: number; expected: number; transport: "http" | "command" | null;
           port: number | null; token: boolean; disabled: boolean };
  otel: { configured: boolean; port: number | null; contentFlags: string[]; conflicts: string[] };
}
export interface EngineAttacher {
  readonly id: EngineId;
  configPath(cfg: CrowConfig): string;
  planAttach(current: string | null, opts: AttachOptions): AttachPlan;              // pure
  planDetach(current: string | null, manifest: JsonValue | null, opts: AttachOptions): DetachPlan;
  inspect(current: string | null, opts: AttachOptions): AttachInspection;
}
```

### HTTP

**Carril B** (`:CROW_PORT`):

| Petición | Respuesta | R |
|---|---|---|
| `Host` no loopback, o `Origin` ajeno o `"null"` | 403 | R4 |
| Método distinto de `POST` | 405 | — |
| Token exigido y ausente o incorrecto (`Authorization: Bearer`) | 401, sin encolar | R3 |
| `:engine` inválido o sin `fromHook` | 404, sin encolar | R2 |
| Tope en vuelo, cuota del motor o cola llena | 204, descartado y contado | R7 |
| Cuerpo > 1 MiB | 413, sin encolar | R5 |
| Resto | 204 vacío; procesado después | R1 |

**Carril C** (solo con `otlpEnabled`):

| Petición | Respuesta |
|---|---|
| `POST /v1/{logs,traces,metrics}` válido | 200 `{}` (o `partialSuccess` por registros indecodificables), en el tipo de la petición |
| Indecodificable | 400 + `Status` |
| > 16 MiB crudo o > 32 MiB descomprimido | 413 |
| Media type o encoding no soportado | 415 |
| Otro método en `/v1/*` | 405 |
| Cola otel llena | 503 + `Retry-After: 5` |
| Guard | 403 |
| `GET /healthz` | `{ service: "navori-crow-otlp", version }` |

- `/healthz` del principal → `{ ok: true, service: "navori-crow", version }`.

### REST: adiciones

```ts
interface IngestStats { /* F1 */ laneDuplicates: number; unkeyedOtel: number; unkeyedPrompt: number;
  otelIgnored: number; otelUnattributed: number; hookDropped: number }
interface SessionSummary { /* F1 */ lastPromptAt: number | null; activeAgentAt: number | null }
interface LaneCounters {
  lastReceivedAt: number | null; lastStoredAt: number | null; received: number;
  rejected: Partial<Record<"unauthorized" | "unknown-engine" | "too-large" | "bad-request"
    | "unsupported-media-type" | "queue-overflow" | "unattributable", number>>;
}
interface LanesStatus {
  since: number;                                // server start; counters are in-memory
  otlp: { enabled: boolean; port: number; state: "listening" | "disabled" | "port-in-use" | "error"; error: string | null };
  engines: Record<string, {
    transcript: { roots: string[]; lastStoredAt: number | null };
    hook: LaneCounters & { trustPending: boolean };   // Codex: configured, silent, sessions live (D15)
    otel: LaneCounters;
  }>;
}
interface StatsResponse { ingest: IngestStats; lanes: LanesStatus }
interface HookStat { name: string; runs: number; totalMs: number; maxMs: number; blocking: number }
interface SessionDetailResponse { /* F1 */ hooks: HookStat[]; hooksFrom: number | null }
```

### Esquema v3 (migración 3, aditiva)

```sql
ALTER TABLE events   ADD COLUMN lkey  TEXT;
ALTER TABLE events   ADD COLUMN lfp   TEXT;
ALTER TABLE events   ADD COLUMN lmeta TEXT;          -- {"lanes":[role…],"prov":{"<field>":"<role>"}}
CREATE INDEX events_by_lkey ON events(session_id, lkey) WHERE lkey IS NOT NULL;
ALTER TABLE sessions ADD COLUMN last_prompt_at INTEGER;
ALTER TABLE sessions ADD COLUMN tu_keyed   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN tu_unkeyed INTEGER NOT NULL DEFAULT 0;
UPDATE sessions SET tu_unkeyed = 1
  WHERE t_input + t_output + t_cache_read + t_cache_creation > 0;   -- pre-v3 usage has no r: marks (D6)
CREATE TABLE otel_usage (
  session_id TEXT NOT NULL, key TEXT NOT NULL,        -- 'req:<request_id>' | 'rec:<record hash>'
  scope TEXT NOT NULL CHECK (scope IN ('call','session')),
  state TEXT NOT NULL CHECK (state IN ('held','counted','dropped')),
  hold_until INTEGER NOT NULL, ts INTEGER NOT NULL, model TEXT,
  u_input INTEGER NOT NULL, u_output INTEGER NOT NULL, u_cache_read INTEGER NOT NULL,
  u_cache_creation INTEGER NOT NULL, u_cache_creation_1h INTEGER NOT NULL,
  PRIMARY KEY (session_id, key)
) WITHOUT ROWID;
CREATE INDEX otel_usage_held ON otel_usage(hold_until) WHERE state = 'held';
```

**Identidad `l:` por carril:**

- hook: única por petición (`sha1("hook:" + engine + ":" + receivedAt + ":" + seq)`); B0 confirma que no hay reintentos;
- otel: `FlatOtelRecord.hash`;
- `revision`: no pasa por `dedupe`, porque la genera el store.

### Configuración

| Fuente | Clave | Default | R |
|---|---|---|---|
| env / `$CROW_HOME/token` | `CROW_TOKEN` | sin token (el script lo crea al hacer attach) | R3 |
| bandera / env / `$CROW_HOME/config.json` | `--otlp` / `CROW_OTLP=1` / `otlp.enabled` | **apagado** | R14, R34 |
| bandera / env / `config.json` | `--otlp-port` / `CROW_OTLP_PORT` / `otlp.port` | `4318` | R14, R15 |

---

## Reconciliación: claves y precedencia (D5) — R11–R13

| Hecho | Clave | Contribuyentes (`role`) |
|---|---|---|
| Tool, inicio | `tool-pre:<callId>` (exact) | `transcript`, `hook`, `otel` (`tool_decision`) |
| Tool, fin | `tool-post:<callId>` (exact) | `transcript`, `hook` (`PostToolUse`/`PostToolUseFailure`/`PermissionDenied`), `otel` (`tool_result`) |
| Permiso | `permission:<callId>` (exact) | `hook:request`, `hook:denied`, `otel` |
| Prompt, Claude | `prompt@<agent\|main>:<promptId>` (exact) | `transcript`, `hook`, `otel` |
| Prompt, Codex (hasta G2) | `prompt@<agent\|main>` (nearest ±10 s, fingerprint) | `transcript`, `hook` |
| Inicio de sesión | `session-start@main` (exact) | `transcript`, `hook` (`startup`/`clear`/`fork`) |
| Subagente | `agent-start:<id>` / `agent-stop:<id>` (exact) | `transcript`, `hook` |
| Compactación | `compact@<agent\|main>` (nearest ±10 min) | `transcript`, `hook:pre`, `hook:post` |

- `SessionStart` con `resume` → fila propia; con `compact` → nada.
- `session.end`, `turn.end`, `instructions.loaded`, `api.request`, `usage` y `hook` llegan por un solo carril: sin `match`.

**Precedencia:**

| Campo | Orden (mayor primero) |
|---|---|
| `ts`, `agentId`, `parentAgentId`, `cwd`, `text`, `tool.name`, `tool.input`, `tool.ok`, `error.message`, `agent.*` | transcript > hook > otel |
| `tool.ms` y `msSource` | engine (hook o otel) > `hook-receipt` > transcript (D7) |
| `tool.verdict`, `decisionSource` | hook > otel |
| `permission.decision`/`reason` | `hook:denied` > otel > `hook:request` |
| `compact.trigger`/`startedAt` | `hook:pre`; `compact.endedAt`: `hook:post` |
| `kind` (`tool.post` contra `tool.error`) | `tool.error` si alguno lo dice |
| `sources` | unión |
| `usage`, `hook`, `reported` | nunca se funden |

## Mapeo de hooks (R8, R9)

Campos: **n** = los usa navori; **doc** = los documenta el motor; ⚠ = los cierra B0. El nombre del evento sale de `hook_event_name` (doc).

### Claude (`packages/adapters/claude/src/hook.ts`)

| `hook_event_name` | Evento | Agente (D4) | `match` | Campos |
|---|---|---|---|---|
| `SessionStart` | `session.start` (`source` `startup`/`clear`/`fork`/ausente); fila sin clave (`resume`); nada (`compact`) | main | `session-start@main` | — |
| `SessionEnd` | `session.end` | main | — | — |
| `UserPromptSubmit` | `prompt` | main | `prompt@main:<prompt_id>` (doc); sin id → sin clave y `unkeyed_prompt` | `prompt` n → `text` ≤ 8 KiB |
| `PreToolUse` | `tool.pre` | `agent_id`/`subagent_id` n | `tool-pre:<tool_use_id>` n | `tool_name` n, `tool_input` n recortado |
| `PostToolUse` | `tool.post` (`ok`, `verdict: allow`, `ms` D7) | ídem | `tool-post:<id>` | nunca `tool_response` |
| `PostToolUseFailure` | `tool.error` (`verdict: error`) | ídem | `tool-post:<id>` | error ⚠ → ≤ 1 KiB |
| `PermissionRequest` | `permission` (`decision: ask`) | ídem | `permission:<tool_use_id ⚠>` (`hook:request`) | `tool_name`, `tool_input` recortado |
| `PermissionDenied` | `permission` (`deny`) + `tool.error` (`verdict: deny`) | ídem | `permission:<id>` (`hook:denied`) y `tool-post:<id>` | motivo ⚠ ≤ 1 KiB |
| `SubagentStart` | `agent.start` (`type` = `agent_type` n) | hijo: `agent_id` | `agent-start:<id>` | — |
| `SubagentStop` | `agent.stop` | hijo: basename de `agent_transcript_path` ⚠ ?? `agent_id` | `agent-stop:<id>` | sin fila de agente si es desconocido (D4) |
| `PreCompact` | `compact` (`startedAt`, `trigger` ⚠) | main | `compact@main` (`hook:pre`) | — |
| `PostCompact` | `compact` (`endedAt`) | main | `compact@main` (`hook:post`) | — |
| `InstructionsLoaded` | `instructions.loaded` | `agent_id` ?? main | — | `file_path` ⚠ → `text` |
| `Stop` | `turn.end` `{ ok: true }` | main | — | nunca `last_assistant_message` |
| `StopFailure` | `turn.end` `{ ok: false, category }` | main | — | categoría del conjunto cerrado (doc; campo ⚠) |
| Otro nombre | `ingest.error unknown-type` (R6) | — | — | — |

### Codex (`packages/adapters/codex/src/hook.ts`)

Los 10 eventos de R9 con el mismo mapeo (sin `PostToolUseFailure`, `PermissionDenied`, `InstructionsLoaded`, `Stop` ni `StopFailure`), con los campos doc de stdin (`session_id`, `hook_event_name`, `cwd`, `tool_use_id`, `turn_id`, `transcript_path`). `PostToolUse` con error → `tool.error` (PLAN §8.1; campo ⚠). El prompt usa `nearest` (±10 s, fingerprint) hasta que G2 muestre un id compartido con el rollout.

### Claves nuevas en los mapas de línea de F1 (`map-line.ts`)

- **Claude:**
  - `tool.pre` → `tool-pre:<tool_use.id>`;
  - `tool.post`/`tool.error` → `tool-post:<tool_use_id>`, sin clave si el id es `unknown`;
  - `prompt` → `prompt@<agent|main>:<promptId>`;
  - `session.start` → `session-start@main`;
  - `agent.*` → `agent-*:<agentId>`;
  - `compact` → `compact@<agent|main>`;
  - `assistant.message` con `usageCallKey = req:<requestId>`;
  - registros `hook_*` → `hook` (D18).
- **Codex:** lo mismo con `call_id`; el prompt, `nearest` con fingerprint; el `session_meta` del principal → `session-start@main`; `token_count` sin `usageCallKey`, que pone `tu_unkeyed` (D6).

## Mapeo OTel (R18, R19)

**Claude:**

| Registro | Evento |
|---|---|
| `user_prompt` | `prompt`, clave `prompt@main:<prompt.id>` |
| `tool_result` | `tool.post`/`tool.error` (`tool-post:<tool_use_id>`); `duration_ms` → `ms` (`engine`) |
| `tool_decision` | `tool.pre` y `permission` (`tool-pre:`/`permission:<tool_use_id>`) |
| `api_request` | `api.request` con `reported` y `otelUsage`, clave `req:<request_id>` (D6) |
| `claude_code.token.usage` / `cost.usage` | `usage` agrupado, solo `reported` |
| span beta de hook | `hook` con `aggregate: true`, `name = hook_name`, `phase = hook_event`, `ms = duration_ms`, `blocking = num_blocking > 0` |

**Codex:**

| Registro | Evento |
|---|---|
| `codex.api_request` | `api.request` |
| `codex.sse_event` `response.completed` | `usage` con `otelUsage` en alcance de sesión |
| otros `sse_event` | ignorados |
| `codex.tool_decision` / `tool_result` | `tool-pre:`/`tool-post:<call_id ⚠>` |

**Allowlist** en todos los casos (D17).

---

## Failure modes

| Falla | Qué pasa | Contención |
|---|---|---|
| crow abajo, colgado, 401 o 413 | Depende del transporte (tabla D14) | Experimento de B0; `doctor` |
| Codex sin confianza en los hooks | El carril B queda mudo | `attach` pide `/hooks`; `doctor` avisa "confianza pendiente" (D14, D15) |
| `curl` ausente | Los hooks del script no llegan; el motor sigue sin errores | `doctor` y `attach` lo verifican |
| Cola de hooks llena, cuota o tope en vuelo | 204, descarte, contador y un error por episodio | R7, D2 |
| Cola otel llena | 503 reintentable | D2, D8 |
| Lote OTLP grande | Decodificar y aplanar acotado a 16/32 MiB; el guardado se reparte en pasos | D8 (MF5) |
| Error de SQLite en el drenador | Bisección: los ambientales esperan con backoff y los de datos se descartan con `store-error` | D2 (MF7) |
| Violación de invariante | `ingest.error invariant` y se salta el evento; nunca se lanza | D5 |
| OTel antes que el hecho | Crea la fila; los demás funden | D5 (BD2) |
| Fusión tardía de prompt o agente | Fusión en el lugar más `revision` que solo rellena; efectos guardados por `ts` | D5, D16 (BD1) |
| `SessionEnd` y después eventos viejos | No reviven la sesión (`ts <= ended_at`) | D5 |
| Uso OTel antes, después o sin transcript | Retención, marca o reemplazo con corrección | D6 |
| Línea de transcript de Claude sin `requestId` | La sesión pasa a `tu_unkeyed` y OTel no cuenta | D6 |
| Hilo de Codex antes de su rollout | Sesión propia, solo si G2 muestra ids de hilo; B3 lo resuelve por `transcript_path` | D4 |
| `SubagentStop` de agente interno | Evento sin fila de agente | D4 (MF3) |
| SDK ajeno exportando a 4318 (fuga de env o default) | No atribuible con un error cada 10 min | D10 |
| `OTEL_*` del shell en conflicto | Se omite el carril C y se informa | D14 |
| Settings administrados quitan la telemetría | Configurado pero nada llega | `doctor` |
| Symlink de configuración | Se escribe en el destino y el enlace queda intacto | D13 (MF8) |
| El usuario editó una unidad de crow | `detach` la conserva y la informa; si no puede verificar, aborta | D13 |
| Protobuf anidado de forma maliciosa | Profundidad > 32 → 400 | D9 |
| DB v3 con un build de F1 | Rechazo (F1 D2) | § Migration |
| Apagado | sweeper → tailer → la cola deja de aceptar (204, contado) y termina solo su paso en curso (lo que sigue en cola sin drenar se pierde al apagar) → receptor OTLP → streams → HTTP → DB | `AppHandle.stop` |

## Migration

- v3 aditiva (§ Contracts), con dos `UPDATE` de datos: marcar `tu_unkeyed` en las sesiones con uso previo, y `last_prompt_at` en `NULL` (el siguiente prompt la llena).
- **Rollback:** con crow detenido, `PRAGMA user_version = 2;`. F1 ignora las columnas y tablas nuevas. Las filas `revision` que F1 lea aparecerán como kind desconocido en su timeline, que es solo cosmético. Otra salida es borrar la DB y re-ingerir los transcripts (idempotente), perdiendo lo que llegó por hook y OTel.
- **Contratos:** solo adiciones. `EventKind` gana `turn.end` y `revision`. `CrowConfig` gana 3 campos (se actualizan los tests que lo construyen literal). `SessionSummary` gana 2 campos.
- **Reducers de F1:** pasan a estar guardados por `ts`. Arregla la carrera de backfill de F1 (§ Approach).

---

## Testing strategy

Ningún test lee homes reales. Todo test lleva `// Covers: R<n>`. OTLP va apagado en los tests salvo en los suyos, con puerto 0.

| Riesgo | Test | R |
|---|---|---|
| El cliente espera el procesamiento | `ingest-route.test.ts`: con el drenador pausado → 204 inmediato y el evento aparece después | R1 |
| Motor desconocido | `ingest-route.test.ts`: 404 y nada encolado | R2 |
| Token | `ingest-route.test.ts`: env y archivo; incorrecto → 401 | R3 |
| Guard | `ingest-route.test.ts`, `guard.test.ts`: estilo curl → 204; `Host` u `Origin` ajenos → 403; `/INGEST/x` → 404 estático | R4 |
| Tope | `ingest-route.test.ts`: 1 MiB + 1 con `Content-Length` y chunked → 413, con el reader cancelado; exacto → 204 | R5 |
| Payload roto | `ingest-queue.test.ts`: `invalid-json`, `unknown-type`, `bad-shape` | R6 |
| Desborde, cuota y en vuelo | `ingest-queue.test.ts`: capacidad 3 con 5 envíos → un solo `ingest.error`; un motor que acapara choca con el 60 %; la conexión 17.ª → 204 y cuenta | R7 |
| Deriva de hooks de Claude | `claude/hook.test.ts`: capturas de B0 de los 15 eventos; `Stop`/`StopFailure` → `turn.end` | R8, R32 |
| Deriva de hooks de Codex | `codex/hook.test.ts`: capturas de B0 | R9 |
| Atribución | `hook.test.ts` (fases del padre, primer no vacío, `SubagentStop` por basename); `store/agents.test.ts`: `SubagentStop` de hook con id desconocido más `agent.stop` del transcript de otro → **una** fila de agente (MF3) | R10 |
| Doble fila de tool o campos del carril equivocado | `store/reconcile.test.ts`: **720 permutaciones** de {pre transcript, pre hook, post transcript, post hook, OTel `tool_result`, OTel `tool_decision`} → 2 hechos idénticos (salvo `id`) en todos los órdenes; `input` del transcript, `ms` del motor, `verdict` del hook (BD2) | R11 |
| Doble conteo o pérdida de uso | `store/usage-lanes.test.ts`: todas las permutaciones de {transcript, OTel `api_request`, promoción} con reloj inyectado → totales = transcript cuando está, OTel cuando no; el reemplazo emite una corrección negativa; una línea sin `requestId` pone `tu_unkeyed`; una sesión de F1 migrada no cuenta OTel; métricas nunca cuentan | R12 |
| Hechos multi-carril duplicados | `reconcile.test.ts`: prompt de Claude en los 3 carriles (6 órdenes) → 1; prompt de Codex nearest → 1; `session-start`, `agent-*` y compactación en todos los órdenes → 1 cada uno | R13 |
| Efectos no monótonos (BD1) | `reconcile.test.ts` y `status.test.ts`: (1) P1 hook, P2, luego P1 transcript fundido → `last_prompt` sigue P2; (2) `SubagentStop` antes de `agent.start` fundido → el agente sigue terminado; (3) `SessionEnd` y después un evento con `ts` menor → `ended`. `apps/web/src/lib/reduce/{projects,session,feed}.test.ts`: las mismas tres secuencias con `revision` y con hechos tardíos; una `revision` nunca se agrega al feed | R11, R13 |
| Contrato SSE intacto | `sse-replay.test.ts` (agregado): la revisión llega una vez en el relevo; un `Last-Event-ID` anterior la recibe; los `id` del hecho no cambian | R11 |
| Invariantes y poison pills | `store/invariants.test.ts`: un `match` sobre un evento con `usage` → `ingest.error invariant` sin excepción. `ingest-queue.test.ts`: un store que lanza con un item envenenado en un paso de 10 → bisección y los otros 9 se guardan; `SQLITE_FULL` → backoff sin descartar | MF7 |
| Protobuf | `protobuf.test.ts`: igualdad con los `.bin` del oráculo; **los vectores a mano** de D9; profundidad 33 → `ProtobufError` y 400 | R14 |
| Aplanado | `flatten.test.ts`: casos de `collect.ts`; `timeUnixNano` como número y como string mayor que 2^53 | R16 |
| Receptor | `otlp-server.test.ts`: JSON, protobuf y gzip → 200 en el tipo de la petición; camelCase en `partialSuccess`; 400, 405, 413 (bomba), 415; 503 con la cola llena; el hilo no se bloquea por el guardado | R14 |
| Opt-in | `otlp-server.test.ts` y `config.test.ts`: sin bandera, env ni archivo no hay listener; `--otlp`, `CROW_OTLP=1` y `config.json` lo encienden | R34 |
| Puerto ocupado | `otlp-server.test.ts`: `startApp` resuelve, el resto sirve y `lanes` dice `port-in-use` | R15 |
| Ruteo sin `service.name` | `otlp-server.test.ts`: logs y métricas de Claude sin `service.name` → Claude; un SDK ajeno cada 5 s por 30 min → 3 `ingest.error` | R16, R17 |
| Mapas OTel y privacidad | `claude/otel.test.ts`, `codex/otel.test.ts`: capturas de B0; los atributos de contenido nunca pasan; spans → `aggregate` | R18, R19, R24 |
| Fail-open del script | `cli/hook-script.test.ts`: el script generado con el puerto cerrado, un servidor colgado, 401 y 413 → código 0, stdout vacío, ≤ 2.2 s; sin `curl` en el PATH → 0. **Experimento de B0 con Claude real** (manual, bitácora) | R20 |
| Attach | `attach.test.ts`: diff enmascarado y aviso de formato; confirmación; backup con nombre, 0600 y rotación a 10; **symlink escrito en el destino**; solo cambian el archivo del motor y `$CROW_HOME`; `OTEL_*` en `process.env` → carril C omitido; `config.json` escrito si hay carril C | R21–R24, R34 |
| Idempotencia y parseo | `attach-*.test.ts` | R25, R27 |
| Detach por unidades | `detach-*.test.ts`: una unidad intacta se quita; un handler con `headers` agregado se conserva y se informa; un `env` cambiado se conserva; una unidad TOML con `timeout` editado se conserva y las demás se quitan; líneas del usuario dentro del bloque se conservan; una clave suelta que cambiaría de tabla → aborta | R26 |
| Doctor | `doctor.test.ts`: transporte, `curl`, confianza pendiente, 401 con `http`, `port-in-use`, collector ajeno, flags de contenido (los 4 más `log_user_prompt`), conflicto de shell, R34 apagado | R28, R15 |
| Timeline | `feed.test.ts`: `describeEvent` para `hook`, `permission`, `turn.end`, `compact` y `api.request` | R29, R32 |
| Panel | `hooks.test.ts`, `api.test.ts`: agregado sin `aggregate`; estado vacío; horizonte | R30 |
| Latencia | `e2e/hook-latency.test.ts`: p95 < 1000 ms en 50 envíos con backfill y un lote OTLP de 16 MiB en paralelo; presupuesto de CI documentado | R31 |
| Registros de hook del transcript | `claude/contract.test.ts` (snapshot con 8 `hook`); `claude/hook-records.test.ts`: allowlist sin `stdout`/`stderr`/`command`; un registro de `crow-ingest-hook` o de la URL de ingesta se excluye; `hook_additional_context` → nada | R33 |
| Carriles de punta a punta | `e2e/lanes.test.ts` (B5): la sesión de 3 carriles de G5b en orden aleatorio | R11–R13 |
| PII y dependencia | `fixtures/hygiene.test.ts` extendido | Riesgo R2, D9 |
| Migración | `migrations.test.ts`: v2 con datos → v3, `tu_unkeyed` marcado; con `user_version = 2` de vuelta, las lecturas de F1 funcionan | Migración |

---

## Evidence gaps

Lo que la doc ya contestó (§ Evidencia, marca doc) **no** es un gap, pero se confirma de paso en las capturas. **Cómo:** receptor de scratch, `CLAUDE_CONFIG_DIR`/`CODEX_HOME` temporales, anonimizadores con allowlist y registro de solo formas y conteos (como F1 B4.T3/B7.T2).

| # | Qué falta | Cómo | Lote |
|---|---|---|---|
| **G1** | **Experimento de transporte de Claude** (D14): error visible y latencia para `http` y para `command`+`async` con crow abajo, colgado, 401 y 413. Además: duración en el payload de `PostToolUse`; campos de `SubagentStop` (`agent_transcript_path`), `PermissionDenied`, `Pre/PostCompact`, `StopFailure` (nombre del campo de categoría); reintentos; tolerancia a claves desconocidas; si los subprocesos de Bash heredan el `env` de settings (MF9); ruta de los settings administrados; **cómo registra el transcript los hooks de crow y qué subtipos `hook_*` hay** (R33) | Claude real con `CLAUDE_CONFIG_DIR` temporal; protocolo en `scripts/b0-transport-experiment.md` | B0 |
| **G2** | Codex: si `command` corre por un shell (el script lo vuelve irrelevante); si existen `SubagentStart`/`Stop`; **`session_id` raíz o hilo** y `transcript_path` real; un id de prompt compartido con el rollout (`turn_id`); campo de error en `PostToolUse`; matcher omitido; forma exacta del paso de confianza | Codex real con `CODEX_HOME` temporal y un shim de scratch | B0 |
| **G3** | Claude OTel: payloads `http/json` reales (nombres y tipos), nombre del span de hook y su prefijo, flags de cuerpos crudos | Captura con logs, métricas y trazas | B0 |
| **G4** | Codex OTel: valor de `service.name`; semántica de `conversation.id`; atributos de los 4 eventos; **un id por llamada** para el libro de uso | Captura json y binary | B0 |
| **G5a** | Igualdades documentadas, confirmadas sobre ids capturados: `tool_use_id` (hook y OTel) = `tool_use.id` del transcript; `prompt_id` = `prompt.id` = `promptId`; `request_id` = `requestId`; `agent_id` de `SubagentStart` = `agentId` | Script de scratch sobre las capturas de G1/G3 más el transcript de esa corrida (conteos) | B0 (bloquea las claves de B1) |
| **G5b** | Sesión de 3 carriles como fixture de punta a punta | La misma captura, anonimizada | B5 |
| — | G6 (Bun) cerrado. G7 **ya no es un gap**: la spec contesta; queda fijar el tag de `opentelemetry-proto` (búsqueda en B4) | — | — |

---

## Requisitos que necesito cambiar (no edito `requirements.md`)

> **Estado (orquestador):** los puntos 1, 2, 4 y 6 ya están aplicados en `requirements.md` (R26, R11, R3, R7 y R17). El punto 3 queda condicionado al resultado de B0.T1.

1. **R26, necesario.** Si el usuario editó una entrada que agregó crow, quitarla borra su cambio y conservarla contradice "remove exactly the entries crow added". Propuesta: *"…SHALL remove the entries crow added that the user has not modified, preserve every other setting including later user changes, keep and report any crow entry the user modified, and abort without writing if it cannot verify the result."* D13 ya está diseñado así.
2. **R11, aclaración.** "`ms`/verdict comes from the hook" debería poder leerse como "del carril hook, salvo que el motor dé su propia medición (payload u OTel)". El delta de recepción incluye la espera de permisos (MF6). Si no aceptas, D7 pone `hook-receipt` por encima de OTel y `msSource` lo deja visible.
3. **R5 y R20, condicional al resultado de B0.** Si B0 elige `http` y los 413 y 401 se ven como errores en Claude, R5 ("respond 413") choca con la intención de R20. En ese caso propondré responder 204 y contar. Con `command`+`async` no hay conflicto.
4. **R3, lectura.** Tomo "`CROW_TOKEN` is set" como "definido por env o por `$CROW_HOME/token`", para tener token por defecto con el script. Si no, el token por defecto se apaga (una constante).
5. **R13 "session end"**: sigue siendo de un solo carril en F2a; se cumple de forma trivial (sin cambio).
6. **R7 y R17, lectura.** Un `ingest.error` por episodio (desborde; o servicio no atribuible y 10 min), con el conteo, cubre a todos los registros del episodio, y `/api/stats` cuenta cada uno. Si se exige un error por registro, se pierde la protección contra avalanchas de D10 (sin cambio si aceptas esta lectura).

## NOT in scope

- **F2b:** Gemini, OpenCode, carril D y la aceptación 3 de F2.
- **OTLP por gRPC**, y el token en el receptor OTLP.
- **Resolución de hilos de Codex por `transcript_path`**, salvo que G2 la pida (B3).
- **Uso OTel atribuido a subagentes:** OTel no trae id de agente, así que cuenta en el principal.
- **Spans que no son de hook** y métricas distintas de las dos de R18.
- **`hooks.json` de Codex**, salvo el aviso.
- **Badges de carril**, la vista de costo reportado y pintar `usage`.
- **Reintento del bind de OTLP.**
- **Hooks que se reportan a sí mismos** (navori, F4).
- **Carril de prioridad para eventos de ciclo de vida** en la cola (N6).
- **`crow up --daemon`, npm, redacción y retención** (incluida la de filas `revision` y backups más allá de 10).
- **Contadores de carril persistidos.**
- **Soporte garantizado fuera de macOS.**

## Open questions

1. **[human]** Los cuatro puntos de § Requisitos que necesito cambiar.
2. **[B0 → decisión]** Transporte de Claude (D14): el criterio está fijado y lo decide el orchestrator con los datos del experimento.
3. **[assumed]** 30 s de retención y promoción en el sweeper de 30 s: una sesión solo-OTel ve su costo en ≤ 60 s.
4. **[assumed]** Uso OTel promovido en el agente principal.
5. **[assumed]** Tope OTLP de 16/32 MiB en lugar de los 64 MiB que recomienda la spec (un solo hilo; los SDK cortan en 512 registros).
6. **[assumed]** Cuota del 60 % por motor, 120 sesiones nuevas por minuto y 16 cuerpos en vuelo.
7. **[assumed]** Ventanas: compactación ±10 min, prompt de Codex ±10 s.

## Batches propuestos

| Batch | Contenido | R | Depende de |
|---|---|---|---|
| **B0 · evidencias** | **T1:** experimento de transporte de Claude (G1) más capturas de hooks de Claude. **T2:** hooks de Codex (G2) y OTLP de los dos (G3/G4), con anonimizadores. **T3:** confirmación de ids (G5a), `encode-otlp-fixture.ts` y vectores | habilitan R8–R12, R18–R20, R33 | — |
| **B1 · core** | **T1:** contratos y config (token, R34). **T2:** migración 3, `ingestEvents`, reconciliación con hechos inmutables, `revision` y efectos guardados por `ts` (con su arreglo en los reducers de la web). **T3:** libro de uso (D6) más las claves `match`/`usageCallKey` y los registros de hook (R33) en `map-line.ts` | R10–R13, R33 | B0 |
| **B2 · carril B y Claude** | **T1:** `IngestQueue`. **T2:** `ingest-route.ts`, `LaneMonitor`, `/healthz`. **T3:** `fromHook` de Claude y latencia | R1–R8, R10, R31, R32 | B1 |
| **B3 · hooks de Codex** | `fromHook` y, si G2 lo pide, resolución por `transcript_path` | R9, R10, R13 | B2 |
| **B4 · receptor OTLP** | **T1:** `packages/otlp` (vectores, oráculo). **T2:** `otlp-server.ts`, `routeOtel`, opt-in y puerto ocupado | R14–R17, R34 | B1 |
| **B5 · mapas OTel** | **T1:** Claude. **T2:** Codex más `e2e/lanes.test.ts` (G5b) | R12, R18, R19 | B3, B4 |
| **B6 · CLI** | **T1:** `up`, `fs-safe`, `diff` y script. **T2:** attachers (dos transportes, Codex anidado, confianza) y `attach`/`detach` por unidades. **T3:** `doctor` | R20–R28, R34 | B2, B4 |
| **B7 · UI** | **T1:** revisiones y etiquetas. **T2:** panel de hooks | R29–R32 | B2 |

## Cobertura R1–R34

| R | Decisión | Test | Batch |
|---|---|---|---|
| R1 | D2, D3 | `ingest-route.test.ts` | B2 |
| R2 | D3 | `ingest-route.test.ts` | B2 |
| R3 | D3 | `ingest-route.test.ts` | B2 |
| R4 | D3 | `ingest-route.test.ts`, `guard.test.ts` | B2 |
| R5 | D3 | `ingest-route.test.ts` | B2 |
| R6 | D2 | `ingest-queue.test.ts` | B2 |
| R7 | D2 | `ingest-queue.test.ts` | B2 |
| R8 | § Mapeo de hooks | `claude/hook.test.ts` | B0, B2 |
| R9 | ídem | `codex/hook.test.ts` | B0, B3 |
| R10 | D4 | `hook.test.ts`, `store/agents.test.ts` | B1–B3 |
| R11 | D5, D7 | `reconcile.test.ts`, `sse-replay.test.ts`, `feed.test.ts` | B1, B2, B7 |
| R12 | D6 | `usage-lanes.test.ts`, `e2e/lanes.test.ts` | B1, B5 |
| R13 | D5 | `reconcile.test.ts`, reducers, `e2e/lanes.test.ts` | B1, B3, B7 |
| R14 | D8, D9 | `protobuf.test.ts`, `otlp-server.test.ts` | B4 |
| R15 | D8, D15 | `otlp-server.test.ts`, `doctor.test.ts` | B4, B6 |
| R16 | D10 | `flatten.test.ts`, `otlp-server.test.ts` | B4 |
| R17 | D10 | `otlp-server.test.ts` | B4 |
| R18 | § Mapeo OTel | `claude/otel.test.ts` | B5 |
| R19 | ídem | `codex/otel.test.ts` | B5 |
| R20 | D14 | `hook-script.test.ts`, experimento de B0 | B0, B6 |
| R21 | D13 | `attach.test.ts` | B6 |
| R22 | D13 | `attach.test.ts` | B6 |
| R23 | D13 | `attach.test.ts` | B6 |
| R24 | D14, D17 | `attach-*.test.ts`, `*/otel.test.ts` | B5, B6 |
| R25 | D13 | `attach-*.test.ts` | B6 |
| R26 | D13 (requiere el ajuste 1) | `detach-*.test.ts` | B6 |
| R27 | D13 | `attach-*.test.ts` | B6 |
| R28 | D15 | `doctor.test.ts` | B2, B6 |
| R29 | D16 | `feed.test.ts` | B7 |
| R30 | D16, D18 | `hooks.test.ts`, `api.test.ts` | B1, B7 |
| R31 | D2, D16 | `e2e/hook-latency.test.ts` | B2 |
| R32 | D11 | `claude/hook.test.ts`, `feed.test.ts` | B2, B7 |
| R33 | D18 | `claude/hook-records.test.ts`, `claude/contract.test.ts` | B1 |
| R34 | D8, D12, D14 | `otlp-server.test.ts`, `config.test.ts`, `attach.test.ts` | B4, B6 |

## Conocimiento durable (propuesta de destino)

- **Dominio:**
  - "un hecho lógico, una fila con `id` inmutable; los carriles se funden en el lugar y las fusiones visibles viajan como filas `revision`";
  - "todo efecto de estado se guarda por `ts`: insertar, fundir o repetir en cualquier orden converge";
  - "el uso OTel por llamada se retiene, se descarta o se reemplaza: el transcript gana y nunca hay doble conteo";
  - "`semanticKey` es identidad dentro de un carril; `match` es identidad entre carriles".
- **CLAUDE.md (usuario):** "`attach` nunca escribe secretos literales; la definición confiable apunta al script de crow; toda edición pasa por plan puro, diff, confirmación, backup y verificación semántica, a través de symlinks".
- **PLAN.md:** §8 (contrato real), §8.1 (`turn.end`), §6.2 (OTLP opt-in, ya alineado con R34), §15 R3/R4 (D8/D14) y §7.4 (libro de uso y revisiones).
