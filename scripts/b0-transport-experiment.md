# B0 · protocolo de captura de evidencias (F2a)

Cubre B0.T1 (experimento de transporte de Claude, gap G1), B0.T2 (hooks de Codex y cuerpos OTLP, G2–G4) y la entrada de B0.T3 (ids entre carriles, G5a). Tiempo estimado: ~15 min de captura más lo que tarden tus sesiones.

## Reglas (no negociables)

- **Las capturas crudas se quedan en el directorio temporal. Nunca se commitean.** Contienen prompts, rutas y código. Solo entran al repo fixtures **anonimizados** (siguiente paso, ver el final).
- Al orquestador/agente solo se le pasa la salida de `summarize-captures.ts` (formas y conteos). No le pegues cuerpos crudos.
- Tú haces el login de cada motor. Nada de esto automatiza credenciales.
- Usa un proyecto de juguete sin nada sensible (abajo se crea uno).
- Sin flags de contenido: no actives `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS`, `log_user_prompt = true` ni similares. (Si quieres confirmar que existen flags de cuerpos crudos (G3), léelos de la doc; no los actives.)

## 0. Preparación

```zsh
export CROW_REPO="/Users/ulisescm/Documents/Dev - Docs/navori-crow"   # ajusta al worktree donde esté esta rama
export B0="$(mktemp -d /tmp/crow-b0.XXXXXX)"
mkdir -p "$B0"/{claude-home,codex-home,work,cap}
# el shim se copia a una ruta SIN espacios (el repo tiene espacios y los motores pueden partir `command` distinto)
cp "$CROW_REPO/scripts/b0/hook-shim.sh" "$B0/hook-shim.sh" && chmod +x "$B0/hook-shim.sh"
# proyecto de juguete con un CLAUDE.md inocuo (dispara InstructionsLoaded)
cd "$B0/work" && git init -q . && echo "Responde breve." > CLAUDE.md && echo "# demo" > README.md
echo "$B0"   # anótalo
```

Comprueba que hay `curl` y `bun`: `command -v curl bun`.

Configs administradas que pisarían el experimento (G1, ruta de settings administrados): `ls "/Library/Application Support/ClaudeCode/" 2>&1` y anota lo que salga.

## 1. Receptor

Una terminal aparte (deja esa terminal abierta; solo imprime contadores y rutas, nunca cuerpos):

```zsh
cd "$CROW_REPO" && bun scripts/capture-receiver.ts --out "$B0/cap/run-01" --mode ok
```

Puertos por defecto: hooks `7790`, OTLP `4319` (no choca con un collector real en 4318). Cambia con `--port` y `--otlp-port`. Cada request queda como `NNNNNN.json` (método, ruta, headers con credenciales censuradas), `NNNNNN.body` (bytes tal cual; gzip se conserva) y `NNNNNN.body.decoded` si venía en gzip.

Modos: `--mode ok` (204/200), `--mode hang` (retiene la respuesta 30 s), `--mode 401`, `--mode 413`. **"Abajo" = receptor apagado** (Ctrl-C). Usa un `--out` distinto por corrida (`run-01`, `run-02`, ...) y apunta en la tabla cuál es cuál.

## 2. Claude Code con configuración temporal

```zsh
export CLAUDE_CONFIG_DIR="$B0/claude-home"
cd "$CROW_REPO"
bun scripts/b0/gen-config.ts claude --transport http    --shim "$B0/hook-shim.sh" > "$B0/settings.http.json"
bun scripts/b0/gen-config.ts claude --transport command --shim "$B0/hook-shim.sh" > "$B0/settings.command.json"
# variantes de OTel para el gap G3 (protobuf y trazas beta de hooks):
bun scripts/b0/gen-config.ts claude --transport command --shim "$B0/hook-shim.sh" --otlp-protocol http/protobuf > "$B0/settings.command.pb.json"
bun scripts/b0/gen-config.ts claude --transport command --shim "$B0/hook-shim.sh" --traces > "$B0/settings.command.traces.json"
```

Cada archivo trae los 15 eventos de R8 en un solo transporte y el bloque `env` de OTel (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, exporters `otlp` de logs y métricas, `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4319`, intervalo 1 s). Forma resumida:

- `http`: `{ "type": "http", "url": "http://127.0.0.1:7790/hook/claude", "timeout": 2 }` (`SessionEnd`: `timeout: 1`).
- `command`: `{ "type": "command", "command": "<B0>/hook-shim.sh claude", "async": true, "timeout": 2 }`.

Para cambiar de transporte: `cp "$B0/settings.<variante>.json" "$CLAUDE_CONFIG_DIR/settings.json"` y **reinicia** Claude.

**Login.** Con `CLAUDE_CONFIG_DIR` vacío Claude arranca sin sesión: en la TUI corre `/login` tú mismo (o `claude auth login` si tu versión lo trae) y, si aplica, guarda las credenciales en ese directorio temporal. Alternativa solo si el login normal no funciona: copiar credenciales desde tu config real. **Es sensible** (contiene tokens): no la hagas salvo necesidad, cópiala tú a mano, y bórrala al terminar (`rm -r "$B0/claude-home"`). No la automatices ni la guardes fuera de `$B0`. (Nota: en macOS las credenciales pueden vivir en el Keychain y no en el directorio; si el login del directorio temporal no persiste entre reinicios, anótalo.)

Verifica: `claude` → `/hooks` debe listar los hooks del settings temporal.

## 3. Matriz G1 (transporte × estado del receptor)

8 corridas. Para cada celda:

1. Prepara el estado: receptor `ok`/`hang`/`401`/`413` con su `--out` nuevo, o **apagado** para "abajo".
2. Copia el `settings.<transporte>.json` y abre `cd "$B0/work" && claude` (TUI, para ver errores visibles).
3. Pega este prompt (20 llamadas Bash separadas, cada una una tool call):
   `Ejecuta 20 veces, cada vez en una llamada Bash distinta y sin encadenar, el comando: true`
   Acepta los permisos (o autoriza Bash para la sesión con la opción "don't ask again").
4. Anota **mientras corre**: ¿apareció algún error, aviso o mensaje de hook en la TUI (captura solo el texto del error, sin contenido de prompts)?
5. `/exit`. Anota el `session id` (nombre del `.jsonl`) y calcula:

```zsh
cd "$CROW_REPO"
T="$(ls -t "$CLAUDE_CONFIG_DIR"/projects/*/*.jsonl | head -1)"     # transcript de la corrida
bun scripts/b0/summarize-captures.ts "$B0/cap/run-NN" --transcript "$T"    # capturas + latencia p50/p95 + igualdad de ids
grep -c '"hook_' "$T"                                                     # líneas hook_* del transcript (solo el conteo)
```

La salida de latencia (`tool latency ms ... p50= p95=`) mide `tool_use → tool_result` incluyendo hooks síncronos: compárala contra la corrida **base** (sin hooks: `CLAUDE_CONFIG_DIR` con settings vacío, `{}`), que también debes hacer una vez.

Tabla de resultados (llénala; una fila por celda):

| # | Transporte | Receptor | Error visible en TUI (texto) | p50 ms | p95 ms | Eventos recibidos (capturas) | Líneas `hook_*` en transcript | Notas |
|---|---|---|---|---|---|---|---|---|
| 0 | (base, sin hooks) | — | — | | | 0 | 0 | |
| 1 | http | abajo | | | | | | |
| 2 | http | hang | | | | | | |
| 3 | http | 401 | | | | | | |
| 4 | http | 413 | | | | | | |
| 5 | command+async | abajo | | | | | | |
| 6 | command+async | hang | | | | | | |
| 7 | command+async | 401 | | | | | | |
| 8 | command+async | 413 | | | | | | |

Criterio de D14: gana `command`+`async` salvo que muestre errores visibles o pierda eventos que `http` no pierde. Anota también cualquier reintento (misma petición repetida en la captura: `ls "$B0/cap/run-NN"/*.json | wc -l` contra las tool calls esperadas).

### 3b. Tolerancia a claves desconocidas (G1, D14)

Con receptor `ok`: agrega `"crowProbe": true` dentro de la **entrada de hook** (el objeto `{ "type": ..., "timeout": 2 }`) de un solo evento (p. ej. `PreToolUse`) en el `settings.json` temporal, para cada transporte. Abre `claude`, `/hooks`, corre una tool call y anota: ¿Claude acepta la clave en silencio, la ignora con aviso o rechaza/omite el settings (error al arrancar o en `/hooks`)? ¿El evento igual llegó al receptor? Repite en Codex (sección 5) agregando `crow_probe = true` a un `[[hooks.PreToolUse.hooks]]`; anota lo mismo, incluido si cambia el paso de confianza.

| Motor | Transporte | Clave desconocida | Resultado (acepta / avisa / rechaza) | ¿Llega el evento? |
|---|---|---|---|---|
| Claude | http | `crowProbe` en la entrada | | |
| Claude | command | `crowProbe` en la entrada | | |
| Codex | command | `crow_probe` en la entrada | | |

Quita la clave después de la prueba.

## 4. Sesión guionada de Claude (una vez por transporte, con receptor `ok`)

Con receptor `ok` y un `--out` limpio (p. ej. `run-11` para `http`, `run-12` para `command`), en `$B0/work`:

1. **Prompt + SessionStart/InstructionsLoaded**: arrancar `claude` (el `CLAUDE.md` se carga) y escribir `di hola`.
2. **Tool call**: `lee README.md` (PreToolUse/PostToolUse).
3. **Permiso**: `crea el archivo /tmp/crow-b0-perm.txt con el texto ok` (PermissionRequest; acepta una vez). Repite pero **deniega** (PermissionDenied si tu modo lo emite; anota si no aparece).
4. **Fallo**: `ejecuta el comando false` y `lee el archivo /no/existe` (PostToolUseFailure).
5. **Subagente**: `usa un subagente para listar los archivos de este directorio` (SubagentStart/Stop).
6. **Compactación**: `/compact` (PreCompact/PostCompact).
7. **Herencia de env (MF9)**: `ejecuta: env | grep -c '^OTEL_'` (solo cuenta; anota el número).
8. **StopFailure** (si es viable): en otra sesión `claude --model modelo-inexistente` con un prompt; anota si llega `StopFailure` y el nombre del campo de categoría.
9. `/exit` (SessionEnd).

Después: `bun scripts/b0/summarize-captures.ts "$B0/cap/run-NN" --transcript "$T"`. De la salida anota: qué eventos de R8 llegaron (¿los 15?), duración en `PostToolUse`, campos de `SubagentStop` (¿`agent_transcript_path`?), campo de error de `PostToolUseFailure`/`PermissionDenied`/`StopFailure`, `trigger` de `PreCompact`, y los subtipos `hook_*` del transcript (`grep -o '"subtype":"hook_[a-z_]*"' "$T" | sort | uniq -c`).

**OTel (G3).** Con la variante `command` y `--out` propio, repite un mini-guion (prompt + 2 tool calls + `/exit`). Luego una vez con `settings.command.pb.json` (protobuf) y otra con `settings.command.traces.json` (span de hook beta). El resumen imprime nombres de evento/span/métrica, `service.name` y tipos de atributos (nunca valores). Anota: prefijo y nombre del span de hook, tipos de `timeUnixNano`/`intValue`, y si `tool_use_id`, `prompt.id`, `request_id` aparecen como atributos.

## 5. Codex con `CODEX_HOME` temporal

```zsh
export CODEX_HOME="$B0/codex-home"
cd "$CROW_REPO"
bun scripts/b0/gen-config.ts codex --shim "$B0/hook-shim.sh" --protocol json   > "$CODEX_HOME/config.toml"
bun scripts/b0/gen-config.ts codex --shim "$B0/hook-shim.sh" --protocol binary > "$B0/config.binary.toml"
```

`config.toml` trae `[otel]` (exporter `otlp-http` hacia `http://127.0.0.1:4319/v1/logs`, `log_user_prompt = false`) y un `[[hooks.X]]` + `[[hooks.X.hooks]]` anidado por cada evento de R9, con el shim como `command` y `timeout = 2`. Si Codex exige un flag de feature para hooks y `/hooks` no muestra nada, anótalo (cierra parte de G2) y agrégalo tú a mano.

**Login.** Corre `codex login` con `CODEX_HOME` ya exportado, tú mismo. Si necesitas copiar `auth.json` desde tu `~/.codex` (no lo lea nadie más que tú), es **sensible**: cópialo tú a mano, y bórralo al final.

**Paso de confianza (G2).** Antes de usarlo: `cd "$B0/work" && codex`, luego `/hooks`. Anota **textualmente** (solo el texto de UI, sin contenido) el aviso de hooks no confiables, los pasos para confiar, y qué archivo cambió al confiar: `find "$CODEX_HOME" -type f -newer "$CODEX_HOME/config.toml"`. Corre un prompt **antes** de confiar (¿llega algo al receptor?) y otro **después**.

Guion (receptor `ok`, `--out` `run-21`, con protocolo `json`), una sola sesión: `di hola` · `lee README.md` · `crea /tmp/crow-b0-perm.txt con ok` (permiso) · `ejecuta: false` · un subagente si tu Codex lo permite (`SubagentStart/Stop`: ¿existen?) · `/compact` · `/exit`. Observa: si `command` corre por shell (el script lo vuelve irrelevante, anota igual), **`session_id` raíz o de hilo** (¿cambia entre prompts y subagentes?), `turn_id`, `transcript_path` real, campo de error de `PostToolUse`, y si con matcher omitido llegan todos los eventos.

Después repite un mini-guion con `cp "$B0/config.binary.toml" "$CODEX_HOME/config.toml"` (nueva `--out` `run-22`, y ojo: hay que volver a confiar si Codex lo pide) para capturar OTLP protobuf. Anota: `service.name`, semántica de `conversation.id`, atributos de los 4 eventos y **si hay un id por llamada**.

Resumen: `bun scripts/b0/summarize-captures.ts "$B0/cap/run-21" --engine codex --transcript "$CODEX_HOME/sessions"` (el rollout está en `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`).

## 6. G5a: igualdad de ids entre carriles

El mismo comando de resumen con `--transcript` imprime, por par y por carril (`hook`/`otel`), `captured` (ids distintos en la captura), `transcript` (en el transcript/rollout) y `matched` (en ambos). Nunca imprime los ids. Pares de Claude: `tool_use_id ↔ tool_use.id`, `prompt_id`/`prompt.id ↔ promptId`, `request_id ↔ requestId`, `agent_id ↔ agentId`. Pares de Codex (`--engine codex`): `tool_use_id`/`call_id ↔ call_id`, `turn_id`, `session_id ↔ id`. Para que salgan `agent_id` y los ids de subagentes, pasa también el directorio de la sesión (`--transcript "$(dirname "$T")"`): incluye `subagents/*.jsonl`.

`matched = captured` en cada par con `captured > 0` confirma la igualdad; si no, anota qué pares fallan.

## 7. Dónde queda todo

- Capturas crudas: `$B0/cap/run-NN/` (contienen contenido: NO commitear, NO pegar).
- Transcripts/rollouts: `$B0/claude-home/projects/...`, `$B0/codex-home/sessions/...`.
- Al terminar: `rm -r "$B0/claude-home" "$B0/codex-home"` para borrar credenciales; conserva `$B0/cap` hasta anonimizar.
- Lo que sí vuelve al repo: la tabla de la sección 3, las notas de cada gap y, después, fixtures anonimizados.

Para el orquestador, entrega: la tabla llena, la salida (solo formas y conteos) de cada `summarize-captures.ts`, y tus notas de G1/G2 (texto de errores visibles, paso de confianza).

## Siguiente paso (fuera de esta herramienta)

Además, el resumen (`summarize-captures.ts`) imprime hoy los nombres de clave tal cual (salvo los que no parecen identificadores); cuando se conozcan las formas de B0 se le pondrá una **allowlist de claves** y todo lo demás saldrá como `<key>`.

El receptor rechaza un `--out` dentro de un repo git, y guarda solo los valores de headers de una allowlist (`content-type`, `content-encoding`, `content-length`, `user-agent`, ...) y los nombres, no los valores, de los parámetros de query. El `.gitignore` de la raíz ignora `crow-b0*/` como red de seguridad.

Los anonimizadores de allowlist para hooks y OTLP (`scripts/anonymize/*`, B0.T1/T2) dependen de las formas capturadas aquí, así que se escriben después de analizar el resumen, junto con `scripts/encode-otlp-fixture.ts` (B0.T3). `fixtures/hygiene.test.ts` corre sobre los fixtures anonimizados, nunca sobre las capturas crudas.
