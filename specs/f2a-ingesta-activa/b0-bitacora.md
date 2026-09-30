# F2a Ingesta activa — Bitácora de B0 (B0.T1, B0.T2, B0.T3)

Fecha: 2026-09-29. Versiones: Claude Code 2.1.285, Codex 0.158.0. Solo formas y conteos: las capturas crudas contienen prompts y rutas y no entran al repo; los ids, rutas y prompts se escriben como `<…>`. Los números salen de `scripts/b0/summarize-captures.ts` sobre esas capturas.

## Desviaciones del protocolo (`scripts/b0-transport-experiment.md`)

- **Claude: sin `CLAUDE_CONFIG_DIR` temporal.** Se corrió `claude -p` con `--settings <archivo> --setting-sources project,local --output-format stream-json --verbose --include-hook-events`, cwd = proyecto de juguete y `env -u` de las variables de la sesión padre. Ventaja: no se copian credenciales y los hooks y plugins de usuario quedan fuera. Limitaciones: modo headless (`-p`), no TUI; el "error visible" se midió por stderr más los eventos `hook_response` del stream-json. Modelo `haiku`. Los transcripts quedan en `~/.claude/projects/<cwd codificado>/`.
- **Codex: sin copiar `auth.json`.** `CODEX_HOME` temporal con symlink a `~/.codex/auth.json` (se borra al terminar) y `check_for_update_on_startup = false`. `codex exec --json` para los guiones; el TUI (por pty) solo para el paso de confianza, con `--no-daemon` porque el socket del daemon excede `SUN_LEN` con la ruta larga.
- **Incidente.** En un primer intento del TUI de Codex, un Enter cayó sobre el aviso de actualización (0.159.2) y disparó `brew update` (taps actualizados). No se instaló nada; `codex` sigue en 0.158.0.
- **Uso de Codex mínimo:** la cuenta avisó "<10% del límite semanal".

## G1 — Matriz de transporte de Claude (20 tool calls `true`, receptor `--mode X`, `-p`)

Base (sin hooks): p50 = 52 ms, p95 = 1327 ms, 0 líneas `hook_*` en el transcript.

| # | Transporte | Receptor | Error visible | p50 ms | p95 ms | Requests de hook recibidos | Líneas `hook_*` en transcript |
|---|---|---|---|---|---|---|---|
| 1 | http | abajo | SÍ: stderr `SessionEnd hook [http://127.0.0.1:<port>/hook/claude] failed: connect ECONNREFUSED …`; 42 `hook_response` con outcome=error | 58 | 1392 | 0 | 42 |
| 2 | http | colgado | SÍ: `failed: Hook cancelled` (outcome=cancelled ×42) | **4046** | 5139 | 44 | 42 |
| 3 | http | 401 | SÍ: `HTTP 401 from …` (error ×42, exit_code 401) | 45 | 369 | 44 | 42 |
| 4 | http | 413 | SÍ: `HTTP 413 from …` (error ×42) | 58 | 923 | 44 | 42 |
| 5 | command+async | abajo | NO (43 success; 1 `Stop` cancelled, exit 1, al salir) | 38 | 683 | 0 | 0 |
| 6 | command+async | colgado | NO (41 success; 3 cancelled: `PreToolUse`/`PostToolUse`/`Stop`) | 73 | 1299 | 45 | 0 |
| 7 | command+async | 401 | NO | 47 | 1090 | 45 | 0 |
| 8 | command+async | 413 | NO | 65 | 1369 | 45 | 0 |
| 10 | http | ok | no | 44 | 1014 | 44 (sin `SessionStart`) | 0 |
| 11 | command+async | ok | no | 53 | 708 | 45 (con `SessionStart`) | 0 |

- Sin reintentos: 44 (http) y 45 (command) requests de hook = eventos esperados.
- `http` **no entrega `SessionStart`** (ausente en las celdas 10 y 12; presente con `command`).
- Las líneas `hook_*` del transcript solo aparecen cuando el hook **falla** (http en error o colgado). Con éxito, o con `command` async: 0.
- Latencia: con el receptor colgado, `http` suma ~4 s por tool call (dos hooks síncronos por llamada, timeout 2 s cada uno); `command`+`async` no añade latencia medible (las diferencias de p50 están dentro del ruido de la base).

### Veredicto D14

Gana **`command` + `async: true`**. `http` muestra error visible en los cuatro estados (abajo, colgado, 401, 413), añade ~4 s por tool call con crow colgado y pierde `SessionStart`. `command` no pierde ningún evento que `http` no pierda. Detalle en design.md § D14 (Decisión de B0).

### 3b — Claves desconocidas

- Claude acepta `crowProbe` en la entrada de hook **en silencio**, con `http` (celda 17) y con `command` (celda 18); el evento `PreToolUse` llegó.
- Codex acepta `crow_probe = true` en `[[hooks.PreToolUse.hooks]]` en silencio; el evento llegó y el hash de confianza **no** se invalidó (celda 34).

## R8 — Eventos de Claude recibidos por hook (`command`)

- **Recibidos (14 de 15):** `InstructionsLoaded`, `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest` (celda 22, con regla `permissions.ask`), `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact` (celda 15, `--resume` y `/compact`), `Stop`, `StopFailure` (celda 16, `--model modelo-inexistente`; stderr `[claude-code:unrecognized_model]`), `SessionEnd`.
- **No reproducido: `PermissionDenied`.** En `-p` no hay diálogo de permisos y una regla `deny` no lo emitió. Queda como deuda (ver § Deuda).
- **Formas** (`claude-13.txt`):
  - todos llevan `session_id`, `transcript_path`, `cwd`, `hook_event_name`; `prompt_id` en casi todos;
  - `PreToolUse`/`PostToolUse`/`PostToolUseFailure`: `tool_use_id`, `tool_name`, `tool_input`;
  - `PostToolUse`: `duration_ms` y `tool_response`;
  - `PostToolUseFailure`: `error` (string), `is_interrupt`, `duration_ms`;
  - `Stop`/`SubagentStop`: `stop_hook_active`, `last_assistant_message`, `background_tasks`;
  - `SubagentStop`: `agent_transcript_path`, `agent_id`, `agent_type`;
  - los hooks dentro de un subagente traen `agent_id` y `agent_type`;
  - `SessionEnd`: `reason`; `SessionStart`: `source`; `InstructionsLoaded`: `file_path`, `memory_type`, `load_reason`.

## G2 — Hooks de Codex

- **Paso de confianza.** `codex exec` **no** ejecuta hooks no confiados y **no avisa** (celda 31: 0 hooks, solo `/v1/logs`). En el TUI, con el config temporal en `CODEX_HOME`, tras "Trust this folder?" aparece: "Hooks need review — 10 hooks are new or changed. Hooks can run outside the sandbox after you trust them." con las opciones "1. Review hooks / 2. Trust all and continue / 3. Continue without trusting (hooks won't run)". `/hooks` lista por evento Installed/Active/Review; la tecla `t` = "trust all".
- **Archivo que cambia al confiar:** solo el `config.toml` del `CODEX_HOME`, con una sección `[hooks.state."<ruta config.toml>:<evento_snake_case>:<grupo>:<hook>"] trusted_hash = "sha256:<…>"` por evento; además `[projects."<cwd>"] trust_level = "trusted"` por el paso de carpeta.
- **Eventos recibidos por hook** (celda 32, `json`): `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`, `SessionEnd`. `SubagentStart/Stop` **existen**. `codex exec` corre los comandos vía `/bin/zsh -lc`; el `tool_name` de un comando es `Bash`, y los de colaboración son `collaborationspawn_agent` y `collaborationwait_agent`.
- **No reproducidos:** `PermissionRequest`, `PreCompact`, `PostCompact`. `Stop` no está en el config de R9, así que no se probó.
- **Formas** (`codex-32.txt`): `session_id`, `turn_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, …

## G3/G4 — OTel

**Claude**
- `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` → `content-type: application/x-protobuf` en `/v1/logs` y `/v1/metrics`; JSON → `application/json`. `service.name = claude-code`.
- Eventos de log (capturas): `user_prompt`, `api_request`, `assistant_response`, `tool_decision`, `tool_result`, `hook_registered`, `hook_execution_start`, `hook_execution_complete`, `managed_settings_resolved`, `mcp_server_connection`, `plugin_loaded` (celdas 13/20/15/16/22), más `subagent_completed` (1 en la 13, con subagente), `compaction` (1 en la 15) y `api_error` (1 en la 16). `fixtures/otlp/claude/logs.json` conserva un registro por nombre salvo `api_error` y `compaction`: se vieron en captura pero no están en el fixture.
- Métricas vistas: `claude_code.session.count`, `cost.usage`, `token.usage`, `active_time.total` (`cost.usage`/`token.usage` no salen en la celda 16, que emitió `api_error`). `lines_of_code.count` y `code_edit_tool.decision` **no** se vieron; están en la allowlist de `scripts/anonymize/otlp.ts` por prudencia.
- Trazas beta (variante `--traces`, `/v1/traces`, celda 20): spans `claude_code.interaction`, `claude_code.llm_request`, `claude_code.tool`, `claude_code.tool.blocked_on_user`, `claude_code.tool.execution` y `gen_ai.request.attempt` (2 en la celda 20; hijo del `llm_request`).
- `total_duration_ms` viaja como string (`stringValue`) en los logs de `hook_execution_complete`.

**Codex**
- `service.name = codex_exec` (en `exec`). `protocol = "binary"` → `application/x-protobuf` en `/v1/logs`.
- Logs: `codex.user_prompt`, `codex.tool_decision`, `codex.tool_result`, `codex.api_request`, `codex.conversation_starts`, `codex.sse_event`, `codex.websocket_*`, `codex.turn_ttft`, `codex.agent_communication`, `codex.startup_phase`.

## MF9 — Herencia de env

`env | grep -c '^OTEL_'` dentro de una tool Bash de Claude (celdas 12 y 13, con las variables de OTel puestas vía `--settings`): **0** en ambas. El `env` del settings **no llegó** a los subprocesos de Bash, al revés de la suposición de D14. Caveat: modo `-p`, y las `OTEL_*` venían de `--settings`, no del `settings.json` de usuario; falta confirmarlo en el TUI con `settings.json` (ver § Deuda).

## G5a — Igualdad de ids entre carriles (solo conteos)

`captured` = ids distintos en la captura; `transcript` = en el transcript o rollout; `matched` = en ambos.

| Motor / celda | Par | Carril | captured | transcript | matched |
|---|---|---|---|---|---|
| Claude 13 (con subagente) | `tool_use_id` ↔ `tool_use.id` | hook | 7 | 268 ¹ | **7** |
| Claude 13 | `tool_use_id` ↔ `tool_use.id` | otel | 7 | 268 ¹ | **7** |
| Claude 13 | `prompt_id` ↔ `promptId` | hook / otel | 2 / 2 | 27 ¹ | 2 / 2 |
| Claude 13 | `request_id` ↔ `requestId` | hook | 0 | 57 ¹ | 0 (el hook no lo trae) |
| Claude 13 | `request_id` ↔ `requestId` | otel | 7 | 57 ¹ | **7** |
| Claude 13 | `agent_id` ↔ `agentId` | hook | 1 | 2 ¹ | 1 |
| Claude 13 | `agent_id` ↔ `agentId` | otel | 0 | 2 ¹ | 0 (no viaja en OTel) |
| Claude 6/7/8 (20 tool calls) | `tool_use_id` ↔ `tool_use.id` | hook | 20 | — | 20 / 20 / 20 |
| Claude 6/7/8 | `tool_use_id` | otel | — | — | 0 / 20 / 20 (en 6 el receptor colgado descartó OTLP) |
| Codex 32 (con subagente) | `tool_use_id` ↔ `call_id` de colaboración | hook | 2 | 6 ² | 2 |
| Codex 32 | `tool_use_id` (`Bash`, forma `exec-<id>`) ↔ `payload.item.id` | hook | 4 | — ² | **4** |
| Codex 32 | todos los `tool_use_id` (por `call_id` u `item.id`) | hook | 6 | — | **6 / 6** |
| Codex 32 | `call_id` ↔ `call_id` | otel | 10 | 6 ² | 6 (los 6 del rollout) |
| Codex 32 | `turn_id` ↔ `turn_id` | hook / otel | 2 / 0 | 2 ² | 2 / 0 (no viaja en OTel) |
| Codex 32 | `session_id` ↔ `session_meta.id` | hook / otel | 1 / 0 | — | 1 / 0 |

¹ Transcripts de Claude: para que cuente el `tool_use_id` del subagente hay que pasar `--transcript` con el directorio del proyecto (contiene el `.jsonl` de la sesión y `<sesión>/subagents/*.jsonl`); ese directorio incluye también otras sesiones, por eso `transcript` es mayor que los 7 ids de la celda. Solo con el `.jsonl` principal, `tool_use_id` da 6 de 7 (falta el del subagente) y `request_id` [otel] 5 de 7. Pasar solo `<sesión>/` (sin el `.jsonl` principal) da solo lo del subagente (1 de 7), no sirve.

² Rollouts de la celda 32: los dos hilos (principal y subagente, con `--transcript` sobre una carpeta que solo contiene esos dos `rollout-*.jsonl`): 6 `call_id` distintos.

### Por qué "6 capturados, 2 coinciden" en Codex

No faltaba cargar el rollout del subagente ni mapear los `call_id` de `collab_tool_call`. El resumen compara `tool_use_id` con `call_id` del rollout y eso solo vale para las herramientas de colaboración (`spawn_agent`, `wait_agent`: el hook trae el `call_id` real, 2 coincidencias). Para los comandos `Bash` el hook manda `tool_use_id = exec-<uuid>`, que **no** es el `call_id` de la `function_call` (`call_<…>`) sino el `payload.item.id` de los eventos `item_completed` del rollout (4 ids, 3 en el hilo principal y 1 en el del subagente). Con esa correspondencia el resultado correcto es **6 de 6**: 2 por `call_id` + 4 por `item.id`. En OTel de Codex, el atributo `call_id` de OTLP contiene los 6 `tool_use_id` de hook, incluidos los `exec-<id>` de `Bash` (6/6, verificado en la celda 32 y fijado por `fixtures/codex/0.158.0` y `fixtures/b0-codex.test.ts`). Consecuencia para D5/B1: la unión hook ↔ OTel de Codex por id de llamada **sí está confirmada**; lo que no coincide es el `call_id` de la `function_call` del rollout con el `exec-<id>` para los comandos de shell (hay que usar `item.id` en el rollout). Además, `scripts/b0/summarize-captures.ts` debería añadir `item.id` como clave de transcript para Codex (deuda menor, fuera de este alcance).

## Deuda explícita (no se pudo reproducir)

- **Claude `PermissionDenied`:** en `-p` no hay diálogo y una regla `deny` no lo emite. Requiere TUI o modo de permisos `auto` con clasificador; sin captura, el mapeo de R8 para ese evento queda solo con la documentación.
- **Codex `PermissionRequest`, `PreCompact`, `PostCompact`:** no se generaron con `codex exec`. `Stop` no estaba en el config de R9 y tampoco se probó.
- **MF9 en TUI:** el 0 se midió en modo `-p` con `OTEL_*` vía `--settings`.
- **Claude en TUI:** el "error visible" se midió por stderr y `hook_response`, no por lo que pinta el TUI.
- ~~Hook ↔ OTel en Codex por id de llamada~~: resuelta, confirmada 6/6 (ver arriba). Queda solo que `summarize-captures.ts` no usa `item.id` como clave de transcript de Codex.
- **Limitación de la anonimización:** `tool_name`, `agent_type`, `agent.name`, `model` y `hook_name` se validan por forma (`ENUM_RE`), no por lista. Al re-anonimizar capturas de otros entornos (MCP, agentes o plugins propios) hay que revisar a mano esos campos antes de commitear.
