# navori-crow: plan maestro

> **Estado:** diseño · **Fecha:** 2026-09-23 · **Stack:** TypeScript + Bun (servidor) · Svelte 5 + Vite (frontend)
>
> Este documento es la guía para construir navori-crow desde cero hasta la paridad con `navori audit` y más allá. Cubre:
> - lo que ya existe hoy en `navori-harness`;
> - lo que ofrece el ecosistema;
> - la arquitectura objetivo;
> - las tareas concretas por fase, con sus criterios de aceptación.

---

## Índice

1. [Visión y objetivo](#1-visión-y-objetivo)
2. [Principios](#2-principios)
3. [Punto de partida: `navori audit` hoy](#3-punto-de-partida-navori-audit-hoy)
4. [Panorama externo](#4-panorama-externo)
5. [Mecanismos de captura por motor](#5-mecanismos-de-captura-por-motor)
6. [Arquitectura objetivo](#6-arquitectura-objetivo)
7. [Modelo de datos neutral](#7-modelo-de-datos-neutral)
8. [Contrato de adaptador](#8-contrato-de-adaptador)
9. [API y tiempo real](#9-api-y-tiempo-real)
10. [Frontend](#10-frontend)
11. [Capa de señales (plugins)](#11-capa-de-señales-plugins)
12. [Qué se reutiliza de navori-harness](#12-qué-se-reutiliza-de-navori-harness)
13. [Cómo se engancha cada motor](#13-cómo-se-engancha-cada-motor)
14. [Roadmap por fases](#14-roadmap-por-fases)
15. [Riesgos y decisiones abiertas](#15-riesgos-y-decisiones-abiertas)
16. [Fuentes](#16-fuentes)

---

## 1. Visión y objetivo

**navori-crow** es un observador local y en tiempo real para agentes de código. Se "monta" sobre cualquier sesión de:
- Claude Code;
- Codex CLI;
- OpenCode, que es la vía para DeepSeek y otros modelos;
- Gemini CLI;
- cualquier otro CLI que deje rastro.

Levanta un puerto local con una UI web donde se ve **qué está haciendo el agente o harness ahora mismo**:
- prompts;
- herramientas;
- subagentes;
- hooks;
- tokens y costo;
- archivos tocados;
- errores.

A eso suma la **información de auditoría**: señales de fricción, desperdicio y salud del harness.

**Caso de uso central:** tengo dos o más proyectos corriendo con agentes al mismo tiempo, cada uno con su harness, y quiero verlos todos en una sola pantalla.

**Qué NO es:**
- **No es un orquestador.** No lanza, no detiene y no controla agentes, como sí hacen Vibe Kanban o Claude Squad. Es **solo lectura**.
- **No es un backend de observabilidad genérico para apps LLM**, como Langfuse o Phoenix. Está pensado para *CLIs de código* y entiende la semántica de *harness*: skills, subagentes, hooks e instrucciones cargadas.
- **No está acoplado a navori-harness.** navori pasa a ser un *productor* más y un *paquete de señales* opcional.

### Objetivo final (definición de "terminado")

- [ ] `bunx navori-crow` levanta la UI en `http://127.0.0.1:7777` sin configurar nada.
- [ ] Detecta y muestra en vivo las sesiones activas de Claude Code y Codex en **cualquier** repo, sin instalar nada en ellos.
- [ ] Con `crow attach <engine>` se suma la ingesta fina (hooks y OTel) para Claude, Codex, Gemini y OpenCode.
- [ ] La vista multi-proyecto muestra 2 o más proyectos a la vez, cada uno con sus sesiones, un árbol de agentes y un timeline en vivo.
- [ ] Hay señales de auditoría genéricas y existe un paquete `navori` que da paridad funcional con `navori audit`.
- [ ] navori-harness deja de tener su propio receptor OTLP y su propio parser, y delega en navori-crow.

---

## 2. Principios

1. **Agnóstico de motor.** El núcleo solo conoce `CrowEvent`. Todo lo específico de un motor vive en su adaptador.
2. **Pasivo primero.** El modo por defecto lee lo que los motores ya escriben en disco (transcripts y rollouts). Los hooks y OTel son mejoras opcionales, nunca un requisito.
3. **Local-first.** Bind a `127.0.0.1`. No hay nube ni telemetría saliente. Todo se guarda en `~/.crow/`.
4. **Fail-open.** Un hook o exporter que apunta a crow **nunca** bloquea ni rompe al agente: lleva timeout corto, corre async y, si no hay servidor, no pasa nada.
5. **Solo lectura sobre los proyectos.** crow no escribe en los repos observados. `crow attach` escribe únicamente en la config del *motor* (a nivel usuario) y siempre muestra el diff antes.
6. **Privacidad configurable.** Los prompts y el contenido de las herramientas se pueden redactar (`redact: prompts|tools|none`), y la retención es configurable.
7. **Identidad de proyecto estable.** Un proyecto se identifica por su raíz git real, no por el nombre de la carpeta.
8. **Simple de leer en 6 meses.** Pocas dependencias y un monorepo con límites claros.

---

## 3. Punto de partida: `navori audit` hoy

Repo: `navori-harness`. Todas las rutas son relativas a su raíz.

### 3.1 Módulos

| Módulo | LOC | Rol |
|---|---:|---|
| `packages/cli/src/commands/audit.ts` | 655 | Comando citty con los flags `--start`, `--stop`, `--arm`, `--disarm`, `--collect`, `--session`, `--days`, `--since`, `--until`, `--cwd`, `--json`, `--out` |
| `packages/cli/src/lib/audit/paths.ts` | 230 | Raíz del store, resolución del nombre de repo, builders de rutas con validación de id y día |
| `packages/cli/src/lib/audit/discovery.ts` | 159 | Lista los `session-*.log`, lee el header y localiza el transcript |
| `packages/cli/src/lib/audit/parse.ts` | 1580 | Convierte el JSONL de Claude en `SessionAudit`; `attachHookEvents` junta el log de hooks con las líneas de OTel |
| `packages/cli/src/lib/audit/model.ts` | 913 | Tipos de dominio, correlación de gates, ventana del recorder. `AuditReport.schemaVersion: 9` |
| `packages/cli/src/lib/audit/signals.ts` | 1392 | Detectores de señales (funciones puras) |
| `packages/cli/src/lib/audit/report.ts` | 1573 | `buildReport`, `renderMarkdown`, `renderJson`, `weightedTokens` |
| `packages/cli/src/lib/audit/harness.ts` | 408 | Lee lo que declara el repo: `.claude/agents`, skills, `CLAUDE.md` |
| `packages/cli/src/lib/audit/collect.ts` | 527 | Receptor OTLP/HTTP-JSON en `127.0.0.1:4318` |
| `packages/cli/src/lib/audit/launchd.ts` | 227 | LaunchAgent de macOS `com.navori.audit-collect` |
| `packages/core/core-assets/hooks/audit-mode-trigger.sh` | 126 | En UserPromptSubmit arma o inicia la sesión y registra el `prompt` |
| `packages/core/core-assets/hooks/audit-mode-close.sh` | 42 | En SessionEnd registra `session-end` |
| `packages/core/core-assets/hooks/_partials/audit-log.sh` | 271 | Recorder por hook que se inyecta en 13 hooks y en los plugins semgrep y jscpd |
| `packages/core/core-assets/hooks/_partials/audit-{arm,repo,signal}.sh` | ~110 | Flag `.armed`, resolución del repo, `gate-killed` |

El conjunto suma unas **7.7k LOC de TS y ~550 de shell**. La cobertura es de **367 tests**, repartidos en:
- `lib/audit/__tests__/`;
- `commands/__tests__/audit.test.ts`;
- `__tests__/audit-hooks.test.ts`;
- el fixture en `packages/cli/src/__tests__/fixtures/audit/`.

### 3.2 Fuentes de datos (hoy)

Son tres, y se juntan por `session_id`:

1. **Log de hooks.** Es un JSONL append-only en `~/.navori/audits/<repo>/session-<id>.log`, escrito con `jq` desde los hooks de navori.
2. **Transcripts de Claude.** Viven en `~/.claude/projects/<slug>/<sessionId>.jsonl` y en `<sessionId>/subagents/agent-<id>.jsonl` junto con su `.meta.json`. Son la **única fuente de tokens**.
3. **OTel.** Es `POST 127.0.0.1:4318/v1/logs`, solo `http/json`. Pasa por una allowlist (`tool_decision`, `tool_result` fallido, `api_request` con `skill.name`) y se enruta por `session.id`. **En la práctica no se usa**: no hay LaunchAgent instalado.

**Tipos de línea del log:**
- `start`
- `prompt`
- `hook {tsMs, name, phase, verdict, ms, source, tool?, reason?, agentId?, toolUseId?}`
- `stop`
- `session-end`
- `otel-start`
- `tool_decision`
- `tool_result`
- `api_request`

**Layout del store:**
```
~/.navori/audits/<repoName>/
  session-<id>.log                  # fuente de verdad (hooks + CLI + OTel)
  pending-<id>.jsonl                # spool de SessionStart
  .armed
  sessions/<YYYY-MM-DD>-<id8>/{report.md,report.json,session.log}
  ranges/<from>--<to>/{report.md,report.json,sessions.txt}
```

### 3.3 Qué NO existe hoy

- No hay **vista en vivo**, TUI, servidor web, SSE ni WebSocket, ni tampoco un watcher de archivos.
- No hay **adaptador por motor**: `parse.ts` solo entiende transcripts de Claude y no existe parser de rollouts de Codex.
- No hay vista **multi-proyecto**: los reportes son por repo y por rango, y se generan en batch.

### 3.4 Bugs y limitaciones conocidas (no se deben heredar)

| ID | Problema | Cómo lo resuelve crow |
|---|---|---|
| Repo fantasma | `_partials/audit-repo.sh` usa `basename`, así que se crean `~/.navori/audits/{skills,cli,core-assets,progress}/`. El fix en TS (#897/#899) salió en la CLI 0.10.0, pero la shell nunca se corrigió y la versión instalada es la 0.8.7 | `projectKey` derivado de la raíz git (§7.3), con **un solo resolvedor** del lado del servidor. Los hooks solo mandan `cwd` |
| B2 | Dos repos con el mismo nombre comparten directorio | Igual: `projectKey` es un hash de la ruta real |
| B6 | Los prompts se guardan en texto plano y además se copian junto a cada reporte | Redacción configurable y un único store |
| M1 | Bash que está en la allowlist se cuenta como round-trip del clasificador | Hay que revisarlo al portar la señal |
| M2 | El carril *wrapper* es invisible | El modelo neutral incluye `source` |
| M3/M4 | Los errores de parseo se mezclan y se pierden los de subagentes | Error de parseo tipado por fuente (`ingest.error`) |
| M5 | El *format drift* con JSON válido pasa en silencio | Tests de contrato por adaptador y un contador de líneas desconocidas |
| M6 | `findVerdict` compara por substring | Se queda en el paquete navori y se corrige ahí |
| M7 | Las reemisiones del permission-mode se cuentan dos veces | Dedupe por `(source, sessionId, seq)` |
| `readJsonl` | Carga archivos completos (hay logs de 3 MB y un `report.json` de 7.8 MB) | Tail incremental con offsets persistidos |
| Otros | La primera sesión pierde SessionStart, los prompts encolados no llegan al hook, el inicio de subagente no es observable y el escaneo de subagentes es plano | Hooks `SubagentStart` nativos, más tail de `subagents/` recursivo |

Los issues #924, #926 y #927 ya están corregidos en navori (toll por evento, severidad por tasa, `weightedTokens`). **Hay que portar esa aritmética tal cual.**

---

## 4. Panorama externo

Estrellas, licencias y actividad consultadas el 2026-09-23.

| Herramienta | Captura | ¿Multi-proyecto? | ¿Tiempo real? | ¿Local? | Motores | Licencia / ⭐ |
|---|---|---|---|---|---|---|
| **simple10/agents-observe** | Hooks → `observe_cli.mjs` → POST → SQLite → WS. Árbol de subagentes y tokens/costo | ✅ (slug derivado de `transcript_path`) | ✅ WS | ✅ Docker | Claude (Codex en roadmap) | MIT / 682 |
| **disler/claude-code-hooks-multi-agent-observability** | Hooks en Python → POST a Bun → SQLite WAL → WS → Vue | ✅ (`--source-app` manual) | ✅ WS | ✅ | Claude | Sin licencia / 1.5k. Parado desde feb-2026 |
| **ccusage** | Lee los JSONL locales de cada CLI | ✅ agrega | Casi (`blocks`, `statusline`) | ✅ | ~20 (Claude, Codex, OpenCode, Gemini, Copilot, Amp…) | MIT / 18.7k |
| **claude-code-log**, **claude-code-trace**, **simonw/claude-code-transcripts** | Parsean `~/.claude/projects` a HTML o TUI | Por proyecto | Solo trace (live tail) | ✅ | Claude | MIT / Apache |
| **sniffly** | Analítica sobre los JSONL | ✅ | ❌ | ✅ | Claude | MIT. Abandonado |
| **Claude-Code-Usage-Monitor** | JSONL en terminal | — | ✅ | ✅ | Claude | MIT / 8.7k |
| **ColeMurray/claude-code-otel** | OTel → Collector → Prometheus/Loki → Grafana | Por `session.id` | Casi | ✅ Docker | Claude | MIT. Sin mantenimiento |
| **o11y-dev/opentelemetry-hooks** | Un binario de hook por agente que emite spans OTLP `gen_ai.*`. Sin backend, cae a `local_spans/*.jsonl` | ✅ | Depende del backend | ✅ | Cursor, Claude, Copilot, Gemini, Codex, OpenCode, Windsurf | Sin licencia / 39. **Buena referencia para los adaptadores** |
| **Arize coding-harness-tracing → Phoenix** | Hooks → spans OpenInference con el árbol de subagentes | ✅ | Casi | ✅ (`:6006`) | 11+ | Apache |
| **Langfuse** (plugins) | Hook `Stop` que manda el turno completo | ✅ | ❌ (por turno) | Self-host pesado | Varios | MIT/EE / 35k |
| **Laminar** | Proxy en Rust para el Agent SDK | ✅ | ✅ | Self-host | Agent SDK | Apache |
| Opik, Logfire, Weave, OpenLLMetry, AgentOps, Helicone, LangSmith | SDKs o proxies para *apps* LLM | ✅ | Parcial | Algunos | Genéricos | Varias |
| **Vibe Kanban, Claude Squad, Crystal/Nimbalyst, opcode** | **Orquestadores**: lanzan y controlan agentes | ✅ | ✅ | ✅ | Varios | Apache / AGPL / MIT |

### 4.1 Huecos que nadie cubre (la razón de construir crow)

1. **Semántica de harness.** Ninguna herramienta modela de forma unificada qué *skill*, *subagente*, `CLAUDE.md`/`AGENTS.md` o *hook* se activó y con qué veredicto. Langfuse admite que no captura skills ni archivos de contexto. Claude expone `InstructionsLoaded` y `agent_type`, pero nadie los visualiza.
2. **Esquema normalizado entre motores.** Cada motor usa su vocabulario: `PreToolUse` (Claude/Codex), `BeforeTool` (Gemini), `preToolUse` (Cursor). o11y-dev y Arize normalizan, pero hacia backends pesados, no hacia una vista en vivo.
3. **Vista en vivo, local y de solo lectura, multi-proyecto y multi-motor.** Hoy todo es de un solo motor, histórico, o un orquestador.
4. **Costo real cruzado con eventos.** ccusage tiene el costo pero no los eventos; los dashboards de hooks tienen los eventos pero no un costo confiable.
5. **Proyectos abandonados o sin licencia** entre las opciones más cercanas.

---

## 5. Mecanismos de captura por motor

Verificados contra la documentación oficial el 2026-09-23.

| Motor | Hooks | OTel | Archivos en disco | Canal en vivo |
|---|---|---|---|---|
| **Claude Code** | Más de 30 eventos: `SessionStart/End`, `UserPromptSubmit`, `Pre/PostToolUse`, `PostToolUseFailure`, `PermissionRequest/Denied`, `PostToolBatch`, `SubagentStart/Stop`, `TaskCreated/Completed`, `Pre/PostCompact`, `Stop`, `StopFailure`, `Notification`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `FileChanged`, `Worktree*`, `Pre/PostModelSwitch`. **Hook tipo `http` nativo** con `async: true` | `CLAUDE_CODE_ENABLE_TELEMETRY=1`. Métricas (`claude_code.cost.usage`, `token.usage`…), eventos (`user_prompt`, `tool_result`, `tool_decision`, `api_request`, `api_response`…) y **trazas beta** (`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`). Protocolos `grpc`, `http/json` y `http/protobuf`. El contenido va apagado por defecto (`OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS`) | `~/.claude/projects/<slug>/<id>.jsonl` + `subagents/` | Tail de JSONL o hook http |
| **Codex CLI** | Activos por defecto. Se configuran en `hooks.json` o en `[hooks]` de `config.toml`. Eventos `SessionStart/End`, `Pre/PostToolUse`, `PermissionRequest`, `Pre/PostCompact`, `UserPromptSubmit`, `SubagentStart/Stop`, `Interrupt`. Solo handlers `command` y `mcp_tool` (**sin http**) | Bloque `[otel]` en `config.toml` (**no usa env `OTEL_*`**), con `otlp-http` (json o binary) u `otlp-grpc`. Eventos `codex.api_request`, `codex.sse_event`, `codex.tool_decision` y `codex.tool_result`, con `conversation.id` | `~/.codex/sessions` (o `$CODEX_HOME/sessions`), en formato rollout JSONL (⚠ la ruta viene de fuentes de terceros) | Tail de rollouts |
| **Gemini CLI** | Solo `command`, con 11 eventos: `SessionStart/End`, `BeforeAgent/AfterAgent`, `BeforeModel/AfterModel`, `BeforeToolSelection`, `BeforeTool/AfterTool`, `PreCompress`, `Notification` | `.gemini/settings.json` con `otlpEndpoint`, `otlpProtocol` y **`outfile`**. Eventos `gemini_cli.*` según las GenAI semconv | Archivo de telemetría (`outfile`) | Tail del outfile o hooks |
| **OpenCode** (DeepSeek y otros) | Plugins TS: `tool.execute.before/after`, `session.*`, `message.part.updated`, `file.edited`, `permission.*`, `todo.updated` | No documentado | Su propio storage | **`opencode serve` expone SSE en `GET /event` y `/global/event`** |
| **Aider** | ❌ | ❌ | `--llm-history-file`, `--chat-history-file`, `--analytics-log` | Solo tail de archivos |
| **Cursor** | `~/.cursor/hooks.json`: `sessionStart/End`, `pre/postToolUse`, `subagentStart/Stop`, `before/afterShellExecution`, `afterFileEdit`, `stop`… (⚠ no está claro si aplica al CLI) | Solo Enterprise | — | Hooks |
| **Cline** | `preToolUse`… (vía SDK Plugins, sin verificar) | Eventos `task.*`, `hooks.execution`, `worktree.*` | — | OTel |

### 5.1 Qué aporta cada fuente

| Dato | Transcript / rollout | Hooks | OTel |
|---|---|---|---|
| Tokens por mensaje (input, output, cache) | ✅ fuente de verdad | ❌ | ✅ agregados |
| Costo USD | Se calcula con tabla de precios | ❌ | ✅ (`cost.usage`) |
| Tool calls con sus argumentos | ✅ | ✅ | Parcial (hay que activarlo) |
| Veredicto y duración de **hooks** | ❌ | ✅ (solo si el hook se reporta a sí mismo) | ✅ (trazas beta de Claude: span `hook`) |
| Árbol de subagentes | ✅ (`subagents/` + `meta.json`) | ✅ (`SubagentStart/Stop`, `agent_id`) | ✅ (trazas) |
| Skills e instrucciones cargadas | Parcial | ✅ (`InstructionsLoaded`) | ✅ (`skill.name` en `api_request`) |
| Latencia real | Parcial | ✅ | ✅ |
| Funciona sin tocar config | ✅ | ❌ | ❌ |

**Conclusión:** el transcript da la **base pasiva**, los hooks dan la **semántica fina** y OTel da **costo y latencia**. crow junta las tres por `sessionId`, igual que hoy lo hace navori, pero sin depender de navori.

### 5.2 GenAI semantic conventions

Las operaciones `invoke_agent`, `execute_tool`, `chat`, `create_agent` e `invoke_workflow`, y los atributos `gen_ai.tool.name` y `gen_ai.tool.call.id`, siguen en **estado "Development"** a julio de 2026. crow las **acepta** en la ingesta (mapea `gen_ai.*` → `CrowEvent`), pero **no las usa como modelo interno**.

---

## 6. Arquitectura objetivo

```
┌──────────────────────── motores ────────────────────────┐
│ Claude Code   Codex CLI   Gemini CLI   OpenCode   Aider │
└──┬───────────────┬────────────┬────────────┬────────┬───┘
   │ JSONL disco   │ hooks      │ OTLP       │ SSE    │ archivos
   ▼               ▼            ▼            ▼        ▼
┌──────────────────────────── crow server (Bun) ──────────────────────────┐
│  Carril A: tailers      Carril B: /ingest/hook/:engine                  │
│  Carril C: OTLP :4318   Carril D: clientes SSE (opencode serve)         │
│            │                    │                                       │
│            ▼                    ▼                                       │
│     adaptadores por motor ──► normalizer ──► CrowEvent                  │
│                                              │                          │
│                     ┌────────────────────────┼─────────────┐            │
│                     ▼                        ▼             ▼            │
│              SQLite (WAL)          bus en memoria    signal packs       │
│              ~/.crow/crow.db       (pub/sub)         (on-event/on-close)│
│                     │                        │                          │
│                     ▼                        ▼                          │
│               REST /api/*               SSE /api/stream                 │
└─────────────────────┬────────────────────────┬──────────────────────────┘
                      ▼                        ▼
               ┌────────── UI web (Svelte 5, estático) ──────────┐
               │ rejilla multi-proyecto · sesión · feed en vivo │
               └────────────────────────────────────────────────┘
```

### 6.1 Carriles de ingesta, en orden de prioridad

| Carril | Qué es | Fase | Por qué |
|---|---|---|---|
| **A: tail de archivos** | Watcher sobre `~/.claude/projects/**` y `~/.codex/sessions/**`, con offsets persistidos | F1 | Cero configuración; se "monta" sobre cualquier sesión, incluso una ya iniciada. Además da los tokens |
| **B: hooks** | `POST /ingest/hook/:engine` con el payload crudo del hook | F2 | Hooks, permisos y subagentes en el instante. Claude usa su hook `http` nativo; los demás, un shim `curl` |
| **C: OTLP** | `POST /v1/logs`, `/v1/traces` y `/v1/metrics` en `:4318`, con JSON **y** protobuf | F2 | Costo y latencia; trazas de Claude; Codex, Gemini y Cline |
| **D: SSE remoto** | Cliente SSE a `opencode serve` (`/global/event`) | F2 | La vía natural para DeepSeek |

### 6.2 Puertos

- **`127.0.0.1:7777`** sirve la UI estática, `/api/*`, `/api/stream` y `/ingest/*`. Se puede cambiar con `CROW_PORT`.
- **`127.0.0.1:4318`** es el receptor OTLP, opcional (`crow up --otlp`). Si el puerto ya está ocupado, por ejemplo por otro collector, se usa `CROW_OTLP_PORT` y `crow attach` imprime el endpoint correcto.

### 6.3 Estructura del repo (monorepo Bun workspaces)

```
navori-crow/
  apps/
    server/            # Bun.serve: ingest, API, SSE, estáticos
    web/               # Svelte 5 + Vite → build a apps/server/public
  packages/
    core/              # CrowEvent, store SQLite, bus, projectKey, pricing
    adapters/
      claude/          # tailer transcripts + hookMap + OTel map
      codex/           # tailer rollouts + hookMap + [otel] map
      gemini/
      opencode/
    otlp/              # receptor OTLP (JSON + protobuf) → atributos planos
    signals/           # SignalPack API + señales genéricas
    cli/               # `crow up | attach | report | doctor`
  fixtures/            # transcripts/rollouts reales anonimizados por motor
  PLAN.md
  README.md
```

---

## 7. Modelo de datos neutral

### 7.1 `CrowEvent`

```ts
type EngineId = "claude" | "codex" | "gemini" | "opencode" | "aider" | "cursor" | (string & {});

type EventSource = "transcript" | "hook" | "otel" | "sse" | "file";

type EventKind =
  | "session.start" | "session.end"
  | "prompt"
  | "assistant.message"          // texto/thinking + usage
  | "tool.pre" | "tool.post" | "tool.error"
  | "agent.start" | "agent.stop" // subagentes
  | "hook"                       // hook del harness con veredicto/duración
  | "permission"                 // request/decision
  | "compact"
  | "instructions.loaded"        // CLAUDE.md/AGENTS.md/skill
  | "usage"                      // tokens/costo agregados (OTel)
  | "api.request"
  | "ingest.error";              // línea no parseable / formato desconocido

interface CrowEvent {
  id: string;              // ulid; orden global
  engine: EngineId;
  source: EventSource;
  projectKey: string;      // hash estable (§7.3)
  projectPath: string;     // raíz git real, para mostrar
  sessionId: string;       // id nativo del motor
  agentId: string | null;  // null = hilo principal (orquestador)
  parentAgentId: string | null;
  kind: EventKind;
  ts: number;              // epoch ms del evento (no de ingesta)
  seq?: number;            // posición en la fuente (línea/offset) para dedupe
  tool?: { name: string; callId?: string; input?: unknown; ok?: boolean; ms?: number };
  usage?: { input: number; output: number; cacheRead: number; cacheCreation: number; model?: string; costUsd?: number };
  hook?: { name: string; phase: string; verdict?: string; ms?: number; reason?: string };
  text?: string;           // prompt/mensaje (sujeto a redacción)
  raw?: unknown;           // payload original (opcional, recortado)
}
```

### 7.2 Tablas SQLite (`~/.crow/crow.db`, WAL)

| Tabla | Columnas clave | Nota |
|---|---|---|
| `projects` | `key` PK, `path`, `name`, `first_seen`, `last_seen` | `name` es solo para mostrar |
| `sessions` | `id` PK (`engine:sessionId`), `project_key`, `engine`, `started_at`, `ended_at`, `status` (`live`/`idle`/`ended`), `model`, `totals_json` | `status` pasa a `idle` tras N minutos sin eventos |
| `agents` | `id` PK, `session_id`, `parent_id`, `type`, `started_at`, `ended_at`, `totals_json` | Árbol de subagentes |
| `events` | `id` PK, `session_id`, `agent_id`, `kind`, `ts`, `source`, `body_json` | Índices `(session_id, ts)` y `(project_key, ts)` |
| `ingest_offsets` | `path` PK, `inode`, `offset`, `updated_at` | Reanudación del tail sin releer |
| `dedupe` | `source`, `session_id`, `seq`, UNIQUE | También `message.id` para el usage |

Los totales se mantienen **incrementalmente**, en la misma transacción que el evento, para que la UI no tenga que agregar en cada request.

### 7.3 `projectKey`

1. Tomar el `cwd` del evento. En transcripts viene en cada línea; en hooks, en el payload.
2. Resolver `git rev-parse --path-format=absolute --git-common-dir`. Esto hace que todos los worktrees caigan en el mismo proyecto.
3. Aplicar `realpath` y quitar el `/.git` final.
4. `projectKey = sha1(ruta).slice(0,12)`.
5. Si no hay git, usar el `realpath(cwd)`.
6. Guardar el resultado en caché en memoria por `cwd`.

Así se evitan los repos fantasma cuando el agente trabaja desde un subdirectorio, y la colisión B2.

### 7.4 Deduplicación entre carriles

Un mismo hecho puede llegar por transcript, por hook y por OTel. Reglas:
- **El usage** se deduplica por `message.id`, que es la regla que ya aplica navori, y **gana el transcript**.
- **Las tool calls** se reconcilian por `tool.callId`/`tool_use_id`. Del hook se toma `ms`/`verdict` y del transcript el `input`.
- **Todo lo demás** se deduplica por `(source, sessionId, seq)`.

---

## 8. Contrato de adaptador

```ts
interface EngineAdapter {
  id: EngineId;
  /** Rutas a vigilar (carril A). Vacío si el motor no deja archivos. */
  watchRoots(): string[];
  /** ¿Este archivo es una sesión de este motor? */
  matches(path: string): boolean;
  /** Línea cruda → 0..n eventos (sin projectKey; lo resuelve core). */
  parseLine(line: string, ctx: FileContext): PartialCrowEvent[];
  /** Payload de hook (carril B) → eventos. */
  fromHook?(payload: unknown): PartialCrowEvent[];
  /** Registro OTLP ya aplanado (carril C) → eventos. */
  fromOtel?(record: FlatOtelRecord): PartialCrowEvent[];
  /** Conector activo (carril D), p. ej. SSE de opencode. */
  connect?(emit: (e: PartialCrowEvent) => void): () => void;
  /** Snippets de configuración para `crow attach`. */
  attach?(opts: AttachOptions): AttachPlan;
}
```

### 8.1 Mapa de vocabularios

| CrowEvent `kind` | Claude | Codex | Gemini | OpenCode | Cursor |
|---|---|---|---|---|---|
| `session.start` | `SessionStart` | `SessionStart` | `SessionStart` | `session.created` | `sessionStart` |
| `prompt` | `UserPromptSubmit` | `UserPromptSubmit` | `BeforeAgent` | `message.updated` (user) | — |
| `tool.pre` | `PreToolUse` | `PreToolUse` | `BeforeTool` | `tool.execute.before` | `preToolUse` |
| `tool.post` | `PostToolUse` | `PostToolUse` | `AfterTool` | `tool.execute.after` | `postToolUse` |
| `tool.error` | `PostToolUseFailure` | (`PostToolUse` + error) | `AfterTool` + error | — | — |
| `agent.start` | `SubagentStart` | `SubagentStart` | — | — | `subagentStart` |
| `agent.stop` | `SubagentStop` | `SubagentStop` | — | — | `subagentStop` |
| `permission` | `PermissionRequest/Denied` | `PermissionRequest` | — | `permission.*` | — |
| `compact` | `Pre/PostCompact` | `Pre/PostCompact` | `PreCompress` | — | — |
| `instructions.loaded` | `InstructionsLoaded` | — | — | — | — |
| `session.end` | `SessionEnd` | `SessionEnd` | `SessionEnd` | `session.idle`? | `sessionEnd` |

### 8.2 Tests de contrato

Cada adaptador trae fixtures reales anonimizados en `fixtures/<engine>/` y un snapshot del `CrowEvent[]` esperado. Cuando un motor cambia su formato, el test falla **antes** que el usuario. Además, una línea desconocida en producción genera un `ingest.error` visible en la UI; nunca se descarta en silencio (esto corrige M5).

---

## 9. API y tiempo real

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/healthz` | `{service:"navori-crow", version}` |
| GET | `/api/projects` | Lista de proyectos con sus sesiones `live` e `idle` y los totales |
| GET | `/api/sessions?project=&status=&since=` | Sesiones filtradas |
| GET | `/api/sessions/:id` | Detalle: árbol de agentes y totales |
| GET | `/api/sessions/:id/events?after=&limit=` | Página de eventos (backfill) |
| GET | `/api/stream?project=&session=` | **SSE**. Reanuda con `Last-Event-ID` (= `CrowEvent.id`) y manda un heartbeat cada 15 s |
| GET | `/api/sessions/:id/signals` | Señales calculadas |
| GET | `/api/reports?project=&since=&until=` | Reporte md/json, con paridad con `navori audit` |
| POST | `/ingest/hook/:engine` | Payload crudo del hook. **Siempre responde 204 rápido**; lo procesa después |
| POST | `/v1/logs`, `/v1/traces`, `/v1/metrics` | OTLP/HTTP con JSON o protobuf (en el puerto OTLP) |

**Por qué SSE y no WebSocket:** la UI es solo lectura. SSE es unidireccional, reconecta solo, pasa por proxies sin problema y en Bun se implementa con un `ReadableStream`, sin dependencias.

**Seguridad:**
- bind a `127.0.0.1`;
- se valida `Origin`/`Host` para evitar DNS rebinding;
- `/ingest/*` acepta un token opcional (`CROW_TOKEN`) en la cabecera.

---

## 10. Frontend

**Stack:** Svelte 5 (runes) + Vite + TypeScript. SolidJS es una alternativa equivalente si se prefiere. El resultado es un build estático en `apps/server/public` que sirve el propio servidor, sin un segundo proceso.

### 10.1 Vistas

1. **Rejilla multi-proyecto (home).**
   - Una tarjeta por proyecto con: nombre, motor o motores, sesiones `live` (con un punto pulsante), prompt actual, agente activo, tokens y costo del día, y el último error.
   - **Modo "split"**: se eligen 2–4 proyectos y se ven lado a lado, cada uno con su feed en vivo. Este es el caso de uso central.
2. **Detalle de sesión.**
   - **Timeline** vertical de eventos, con filtros por kind, agente y herramienta.
   - **Árbol de agentes**: el orquestador y sus subagentes (con profundidad mayor a 1), con estado, duración y tokens de cada uno.
   - **Panel de costo**: input, output y cache, `weightedTokens`, USD y modelo.
   - **Archivos tocados**: lista a partir de Edit/Write/`FileChanged`.
   - **Hooks**: tabla con nombre, fase, veredicto y ms, y el *toll* por evento.
   - **Señales** de auditoría con su severidad.
3. **Feed global.** Es un stream de todos los proyectos, con filtros.
4. **Reportes.** Muestra el reporte histórico por rango (md renderizado y json descargable).

### 10.2 Reglas de UI

- El estado de la sesión se deriva del stream. Al abrir, se hace **backfill** por REST y luego se engancha el SSE desde el último `id`.
- Las listas largas se virtualizan, porque hay sesiones con más de 12k eventos.
- Tema claro y oscuro.
- Sin librerías de componentes pesadas.

---

## 11. Capa de señales (plugins)

```ts
interface SignalPack {
  id: string;                               // "core" | "navori" | ...
  /** Se evalúa en vivo sobre cada evento (barato, O(1)). */
  onEvent?(e: CrowEvent, state: SessionState): Signal[];
  /** Se evalúa al cerrar/idle la sesión o al pedir reporte. */
  onSession?(s: SessionSnapshot): Signal[];
  /** Señales de rango (varias sesiones). */
  onRange?(ss: SessionSnapshot[]): Signal[];
}
interface Signal { id: string; severity: "info" | "warn" | "high"; title: string; detail: string; evidence: string[] }
```

### 11.1 Pack `core` (genérico, se porta desde `signals.ts`)

- `tool-errors` (por tasa, #929)
- `repeated-commands`
- `friction`
- `startup-overhead`
- `permission-mode`
- `tool-mix`
- `format-drift` (con el fix de M5)
- `serial-fanout`, en versión genérica: detecta subagentes lanzados en serie cuando podrían ir en paralelo, sin nombres de roster
- `weighted-tokens` / "a dónde se fueron los tokens"

### 11.2 Pack `navori` (se queda en navori-harness y se publica como `@navori/crow-signals`)

- `reviewer-gate-*` (duplicate, unknown-handle, overlap, timeout, duration)
- `quality-gate-aborted`
- `routing-notice`
- `hook-misfire`
- `unreachable-instructions`
- las filas de engram
- `harness-regime`
- lectura del harness declarado (`harness.ts`: agents, skills, secciones de `CLAUDE.md`, markers managed)

Este pack depende de `RETIRED_AGENTS`, `MAIN_THREAD_ONLY_HOOKS`, `GATE_HOOK_NAMES` y `MCP_HINTS`, y **por eso no entra al core**.

### 11.3 Carga de packs

Se declaran en `~/.crow/config.json` (`"signalPacks": ["core", "@navori/crow-signals"]`) o se detectan automáticamente cuando el proyecto trae `navori.config.json`. Esto último es opcional y se puede desactivar.

---

## 12. Qué se reutiliza de navori-harness

| Se lleva casi igual | Se reescribe | Se queda en navori |
|---|---|---|
| `collect.ts`: aplanado OTLP y ruteo por `session.id`. Pasa a `packages/otlp`, con puerto y host configurables y soporte protobuf | `parse.ts`: es solo Claude y lee archivos completos. Se convierte en `adapters/claude` con parseo **incremental por línea** | `harness.ts` (lee `.claude/agents`, skills, `CLAUDE.md`, markers) → pack navori |
| `paths.ts`: validación de ids (`^[A-Za-z0-9_-]+$`) y builders seguros | Resolución de repo (`repoFromCwd`, `audit-repo.sh`) → `projectKey` en el servidor (§7.3) | Señales de roster y gates (§11.2) |
| Tipos de `model.ts` (`TokenTotals`, `AgentRun`, `HookEvent`, `Signal`) como base de `packages/core` | Discovery y reportes batch → store SQLite y reportes sobre la DB | Render de hooks (`{{shq:}}`, `navori:include`), `build-settings.ts` |
| `chronological`, `ownerOf`, `attachHookEvents` y `recorderWindow` de `parse.ts`/`model.ts`: la lógica de a quién pertenece un evento de hook | CLI `commands/audit.ts` → `packages/cli` (`crow report`) | `doctor` y `global collect`: se reemplazan por `crow doctor` y `crow up --daemon` |
| `weightedTokens` de `report.ts` (input + 5·output + 1.25·cacheCreation + cacheRead·0.1, o 0.05 para Opus 5.5 y 0.025 para Fable/Mythos) | `launchd.ts` → servicio multiplataforma (launchd, systemd user, o simplemente `crow up`) | i18n de navori, `navori.config.json` |
| `renderMarkdown`/`renderJson`, como esqueleto de los reportes | — | — |
| Protocolo fail-open de `audit-log.sh`: timeout corto, nunca hacer fallar al hook | El recorder shell con `jq` → hook `http` nativo, o un shim `curl` | — |
| **Los 367 tests como oráculo**: sus fixtures sirven para los tests de paridad | — | — |

**Migración de datos:** `crow import ~/.navori/audits` lee los `session-*.log` históricos junto con sus transcripts y los carga a SQLite. Los directorios fantasma se re-asignan por `cwd`.

---

## 13. Cómo se engancha cada motor

### 13.1 Modo pasivo (por defecto, sin tocar nada)

```bash
bunx navori-crow            # = crow up
# → http://127.0.0.1:7777
```

Vigila `~/.claude/projects` y `~/.codex/sessions`. Cualquier sesión nueva o activa aparece sola.

### 13.2 `crow attach <engine>` (opcional, para obtener la semántica fina)

El comando muestra el diff y pide confirmación. Todo se escribe **a nivel usuario**, nunca en el repo observado.

**Claude Code** (`~/.claude/settings.json`): hook `http` nativo, asíncrono.
```json
{
  "hooks": {
    "PreToolUse":   [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:7777/ingest/hook/claude", "async": true, "timeout": 2 }] }],
    "PostToolUse":  [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:7777/ingest/hook/claude", "async": true, "timeout": 2 }] }],
    "SubagentStart":[{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:7777/ingest/hook/claude", "async": true, "timeout": 2 }] }]
  },
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:4318",
    "OTEL_LOGS_EXPORT_INTERVAL": "1000"
  }
}
```
Así con todos los eventos relevantes: `SessionStart/End`, `UserPromptSubmit`, `SubagentStop`, `PermissionRequest`, `Pre/PostCompact`, `InstructionsLoaded`, `Stop` y `StopFailure`. Hay que validar el formato exacto del hook `http` contra la doc vigente al implementar.

**Codex** (`~/.codex/config.toml`):
```toml
[otel]
exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/logs", protocol = "json" } }

# hooks: solo tipo command → shim
[[hooks.PreToolUse]]
command = "curl -s -m 2 -X POST --data-binary @- http://127.0.0.1:7777/ingest/hook/codex >/dev/null 2>&1 || true"
```

**Gemini CLI** (`~/.gemini/settings.json`): `telemetry.otlpEndpoint = "http://127.0.0.1:4318"`, `otlpProtocol = "http"`, más hooks `command` con el mismo shim `curl`.

**OpenCode:** `crow attach opencode --url http://127.0.0.1:4096` registra el servidor `opencode serve`, y crow se suscribe a `/global/event`.

**Aider:** `crow attach aider --history <ruta>` agrega la ruta a los tailers.

**Otros comandos:** `crow detach <engine>` revierte exactamente lo que escribió `attach`, gracias a un bloque marcado. `crow doctor` muestra qué carriles están activos por motor y los últimos eventos recibidos.

---

## 14. Roadmap por fases

Cada fase termina con: tests en verde, `bun run check` (lint, typecheck y tests) en verde y una demo manual.

### F0: Bootstrap (≈1–2 días)

- [ ] Monorepo con Bun workspaces y la estructura de §6.3.
- [ ] TypeScript strict, oxlint y oxfmt (igual que navori-harness), `bun test`.
- [ ] CI en GitHub Actions: lint, typecheck y test.
- [ ] `packages/core`: tipos `CrowEvent`, `projectKey()` con sus tests (subdirectorio, worktree, sin git, symlink).
- [ ] `apps/server`: `Bun.serve` con `/healthz`.
- [ ] `apps/web`: Svelte 5 + Vite con un "hello" servido por el server.

**Aceptación:** `bun run dev` levanta server y web, y `curl /healthz` responde.

### F1: MVP pasivo (≈1–2 semanas) ⭐ entrega el caso de uso central

- [ ] Store SQLite (WAL) con migraciones, más las tablas de §7.2.
- [ ] Tailer genérico: watcher recursivo, offsets por `inode`, manejo de truncado y rotación, líneas parciales.
- [ ] `adapters/claude`: transcripts, subagentes (`subagents/*.jsonl` + `meta.json`), usage con dedupe por `message.id`. Portar la lógica de `parse.ts` y usar su fixture.
- [ ] `adapters/codex`: rollouts de `~/.codex/sessions` con fixture real.
- [ ] Bus en memoria y `/api/stream` (SSE con `Last-Event-ID`).
- [ ] REST: `/api/projects`, `/api/sessions`, `/api/sessions/:id/events`.
- [ ] Totales incrementales por sesión y agente, con `weightedTokens` y tabla de precios por modelo.
- [ ] UI: rejilla multi-proyecto, modo split, detalle de sesión (timeline, árbol de agentes, costo).
- [ ] Estados `live`, `idle` y `ended` por inactividad o `session.end`.

**Aceptación:**
1. Con dos repos distintos corriendo Claude Code (y uno con Codex), ambos aparecen en la rejilla **en vivo** en menos de 2 s por evento.
2. En modo split se ven lado a lado.
3. Al reiniciar crow no se duplican eventos.
4. Una sesión iniciada **antes** de levantar crow se hidrata completa.

### F2: Ingesta activa (≈1–2 semanas)

- [ ] `POST /ingest/hook/:engine`: responde 204 inmediato, encola y procesa.
- [ ] Reconciliación hook ↔ transcript por `tool_use_id` (§7.4).
- [ ] `packages/otlp`: logs, traces y metrics en JSON **y protobuf**. Portar el aplanado de `collect.ts`.
- [ ] Mapas OTel → `CrowEvent` para Claude (incluidas las trazas beta), Codex y Gemini.
- [ ] `adapters/opencode`: cliente SSE a `opencode serve`.
- [ ] `adapters/gemini`: hooks y OTel/outfile.
- [ ] `crow attach|detach <engine>` con diff, confirmación y bloque marcado.
- [ ] `crow doctor`.
- [ ] UI: panel de hooks (veredicto, ms, toll) y permisos.

**Aceptación:**
1. Con `crow attach claude`, los hooks, `SubagentStart` y los permisos aparecen en el timeline al instante.
2. Si crow está caído, el agente no se ve afectado (verificado con el servidor apagado).
3. Una sesión de OpenCode con DeepSeek aparece en la rejilla.

### F3: Señales y reportes (≈1–2 semanas)

- [ ] API `SignalPack` y pack `core` (§11.1), portados desde `signals.ts` con sus tests.
- [ ] Señales en vivo (`onEvent`) y al cierre (`onSession`).
- [ ] Reportes por rango en md y json (`crow report --since --until --project`), portando `renderMarkdown`/`renderJson`.
- [ ] UI: panel de señales y vista de reportes.
- [ ] Redacción de prompts (`redact`) y retención (`retentionDays`).

**Aceptación:** sobre las mismas sesiones históricas, `crow report` produce los mismos totales de tokens y las mismas señales genéricas que `navori audit`. Esto se comprueba con un test de paridad sobre los fixtures de navori.

### F4: Integración navori (≈1 semana, en el repo navori-harness)

- [ ] Publicar `@navori/crow-signals` con las señales de §11.2 y `harness.ts`.
- [ ] Los hooks de navori dejan de escribir `~/.navori/audits`: si detectan crow, hacen `POST /ingest/hook/claude` con `hook.name` y `verdict`.
- [ ] `navori audit` pasa a ser un alias de `crow report` o se depreca con aviso. Se retiran `collect.ts`, `launchd.ts` y `global collect`.
- [ ] `crow import ~/.navori/audits` para el histórico.
- [ ] Borrar los partials `audit-*.sh`, lo que elimina de raíz el bug del repo fantasma.

**Aceptación:** navori-harness no abre ningún puerto, y su test que prohíbe listeners sigue en verde. Los proyectos con navori muestran en crow las señales del pack navori.

### F5: Pulido y distribución

- [ ] Publicar en npm (`navori-crow`, o el nombre final); `bunx navori-crow` funciona.
- [ ] `crow up --daemon` con launchd y systemd user.
- [ ] Rendimiento: sesiones de más de 50k eventos, virtualización y `VACUUM`/retención.
- [ ] Docs: README con GIF, guía por motor y guía para escribir un adaptador o un SignalPack.
- [ ] Adaptadores extra: Aider (tail), Cursor y Cline, según haya demanda.

---

## 15. Riesgos y decisiones abiertas

| # | Riesgo o decisión | Mitigación o propuesta |
|---|---|---|
| R1 | Los formatos de transcript y rollout **no son contrato público** y cambian entre versiones | Tests de contrato con fixtures por versión, `ingest.error` visible y parseo tolerante (campos opcionales) |
| R2 | **Privacidad**: prompts y contenido de las tools terminan en SQLite | `redact` configurable, retención, DB con permisos `0600` y bind a loopback. Nunca se exporta nada |
| R3 | El puerto **4318 ocupado** por otro collector (Grafana Alloy, otel-collector) | OTLP opcional y configurable. `crow doctor` lo detecta |
| R4 | **Costo de los hooks**: navori pagaba un fork de `jq` por hook | Hook `http` async nativo (sin fork) en Claude. En los demás, `curl -m 2` en background. Medirlo en F2 |
| R5 | GenAI semconv inestables | Se aceptan en la ingesta, sin acoplar el modelo interno |
| R6 | **Nombre**: el prefijo "navori" contradice "no acoplado" | Decidir antes de publicar en npm (F5). El repo puede renombrarse sin costo |
| R7 | La ruta `~/.codex/sessions` no está confirmada en la doc oficial | Verificarla en F1 contra una instalación real y respetar `CODEX_HOME` |
| R8 | Un evento puede llegar por 3 carriles y contarse doble | Reglas de §7.4 más tests de reconciliación |
| R9 | Watchers en árboles grandes (`~/.claude/projects` con cientos de sesiones) | Vigilar solo archivos con mtime reciente y hacer backfill perezoso de sesiones viejas |

### Decisiones ya tomadas (2026-09-23)

- Servidor en **TypeScript + Bun** (`bun:sqlite`, `Bun.serve`, SSE).
- Frontend en **Svelte 5 + Vite** (SolidJS como alternativa equivalente).
- Se construye **desde cero**, con agents-observe, disler y o11y-dev solo como referencia y reutilizando código propio de navori.
- **Solo lectura** sobre los proyectos, y **pasivo primero**.

---

## 16. Fuentes

**Documentación oficial**
- Claude Code hooks: https://code.claude.com/docs/en/hooks
- Claude Code monitoring (OTel): https://code.claude.com/docs/en/monitoring-usage
- Codex hooks: https://learn.chatgpt.com/docs/hooks
- Codex config avanzada (`[otel]`): https://learn.chatgpt.com/docs/config-file/config-advanced
- Gemini CLI hooks: https://geminicli.com/docs/hooks/
- Gemini CLI telemetry: https://geminicli.com/docs/cli/telemetry/
- OpenCode plugins: https://opencode.ai/docs/plugins/
- OpenCode server (SSE): https://opencode.ai/docs/server/
- Aider options: https://aider.chat/docs/config/options.html
- Cursor hooks: https://cursor.com/docs/agent/hooks
- Cline OTel events: https://docs.cline.bot/enterprise-solutions/monitoring/opentelemetry-events
- OTel GenAI: https://opentelemetry.io/blog/2026/genai-observability/

**Proyectos de referencia**
- https://github.com/simple10/agents-observe
- https://github.com/disler/claude-code-hooks-multi-agent-observability
- https://github.com/ccusage/ccusage
- https://github.com/o11y-dev/opentelemetry-hooks
- https://github.com/Arize-ai/coding-harness-tracing
- https://github.com/delexw/claude-code-trace
- https://github.com/ColeMurray/claude-code-otel
- https://langfuse.com/resources/engineering/coding-agent-tracing
- https://laminar.sh/docs/tracing/integrations/claude-agent-sdk
- https://github.com/BloopAI/vibe-kanban · https://github.com/smtg-ai/claude-squad · https://github.com/stravu/crystal · https://github.com/winfunc/opcode

**Artículos**
- https://dev.to/azena-ai/opentelemetrys-genai-semantic-conventions-are-not-stable-yet-heres-what-actually-shipped-in-2026-3mke
- https://codex.danielvaughan.com/2026/03/28/codex-cli-opentelemetry-observability/

**Internas (navori-harness)**
- `packages/cli/src/lib/audit/*`, `packages/cli/src/commands/audit.ts`
- `packages/core/core-assets/hooks/audit-*.sh`, `_partials/audit-*.sh`
- `specs/0013-audit-redefinition/`, `specs/0021-eventos-otel-como-tercera-fuente/`
- `.claude/progress/audit_deep_navori-audit.md`, `.claude/progress/audit_gap_audit_logs.md`
