# F2a Ingesta activa (Claude Code y Codex) — Requirements

## Context
F1 observa las sesiones solo por lo que los motores escriben en disco (carril A). F2a agrega, para Claude Code y Codex CLI, los carriles de hooks (B) y OTLP (C) de PLAN.md §6.1: hooks, permisos y subagentes llegan al instante, OTel aporta costo y latencia, y `crow attach|detach|doctor` los configura a nivel usuario sin tocar los repos observados. Gemini, OpenCode (carril D) y la aceptación 3 de F2 quedan para F2b.

## Requirements (EARS)

### Carril B: ingesta de hooks
- **R1** — WHEN a `POST /ingest/hook/:engine` arrives for an engine whose adapter supports hooks, the system SHALL respond `204` without waiting for the payload to be processed, and process it asynchronously.
- **R2** — IF `:engine` has no registered adapter with hook support THEN the system SHALL respond `404` and SHALL NOT enqueue the payload.
- **R3** — IF an ingest token is configured (by `CROW_TOKEN` or the file `$CROW_HOME/token`) and the request does not carry it in the ingest token header THEN the system SHALL respond `401` and SHALL NOT enqueue the payload.
- **R4** — IF a request to `/ingest/*` carries a non-loopback `Host` or a foreign `Origin` THEN the system SHALL reject it with `403`, with the same rule as `/api/*`.
- **R5** — IF a hook request body exceeds 1 MiB THEN the system SHALL respond `413` and SHALL NOT enqueue it.
- **R6** — IF an enqueued hook payload is not valid JSON, or carries an event name the adapter does not know, THEN the system SHALL record a visible `ingest.error` with the engine and the reason, and SHALL NOT drop it silently.
- **R7** — IF the hook processing queue is full THEN the system SHALL still answer the request, discard the payload, count every discarded payload in `/api/stats`, and record one `ingest.error` per overflow episode carrying the discarded count.
- **R8** — The Claude adapter SHALL map the hook events `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `InstructionsLoaded`, `Stop` and `StopFailure` to `CrowEvent`s with `source = "hook"`, following the vocabulary of PLAN.md §8.1, with `Stop` and `StopFailure` mapped to `turn.end` (R32).
- **R9** — The Codex adapter SHALL map the hook events `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `SubagentStart`, `SubagentStop`, `PreCompact` and `PostCompact` to `CrowEvent`s with `source = "hook"`, following PLAN.md §8.1.
- **R10** — WHEN a hook event is stored, the system SHALL attribute it to the same project (via the payload `cwd` and the `projectKey` rule) and the same session and agent as the transcript/rollout events of that run.

### Reconciliación entre carriles (PLAN.md §7.4)
- **R11** — WHEN the same tool call arrives through the transcript and a hook with the same call id, the system SHALL keep one logical tool call whose `input` comes from the transcript and whose verdict comes from the hook, with `ms` taken from the engine's own measurement when a lane provides one and from the hook lane otherwise, whatever the arrival order.
- **R12** — The system SHALL NOT count the tokens or cost of the same model call more than once across the transcript, hook and OTLP lanes; WHEN the call is present in the transcript its value SHALL win, and WHEN it is present only in OTLP (e.g. a session that writes no transcript) the OTLP value SHALL count.
- **R13** — WHEN the same logical prompt, session start/end, subagent start/stop or compaction arrives through more than one lane, the session timeline SHALL show it once.

### Carril C: receptor OTLP
- **R14** — WHERE the OTLP lane is enabled (it is off by default and enabled explicitly, see R34), the system SHALL accept `POST /v1/logs`, `/v1/traces` and `/v1/metrics` on `127.0.0.1:CROW_OTLP_PORT` (default `4318`) with `application/json` and `application/x-protobuf` bodies, gzip-encoded or not, and answer as OTLP/HTTP specifies.
- **R15** — IF the OTLP port is already in use THEN the system SHALL keep serving the UI, API and the other lanes, log the conflict, and expose it through `crow doctor`.
- **R16** — WHEN an OTLP record arrives, the system SHALL flatten its resource, scope and record attributes and route it to a session by the engine's session attribute (`session.id` for Claude, `conversation.id` for Codex).
- **R17** — IF an OTLP record cannot be attributed to an engine or a session THEN the system SHALL count it in `/api/stats` and record a visible `ingest.error` per episode of unattributable records, instead of discarding them silently.
- **R18** — The Claude adapter SHALL map Claude Code OTel log events (`user_prompt`, `tool_result`, `tool_decision`, `api_request`), metrics (`claude_code.cost.usage`, `claude_code.token.usage`) and beta-trace hook spans to `CrowEvent`s with `source = "otel"`.
- **R19** — The Codex adapter SHALL map the Codex OTel events `codex.api_request`, `codex.sse_event`, `codex.tool_decision` and `codex.tool_result` to `CrowEvent`s with `source = "otel"`.

### Resiliencia del motor
- **R20** — WHILE crow is not running, an engine configured by `crow attach` SHALL keep working with no error surfaced to the user and at most the configured hook timeout (≤ 2 s) of added latency per hook.

### CLI: `crow attach | detach | doctor`
- **R21** — WHEN the user runs `crow attach <claude|codex>`, the system SHALL compute the change to that engine's user-level config (`$CLAUDE_CONFIG_DIR/settings.json` or `~/.claude/settings.json`; `$CODEX_HOME/config.toml` or `~/.codex/config.toml`), show it as a diff, and write nothing without the user's explicit confirmation.
- **R22** — WHEN the user confirms an attach, the system SHALL save a timestamped backup of the config file before writing it.
- **R23** — The system SHALL write attach changes only to the engine's user-level config, never to files of an observed repo.
- **R24** — The attach configuration SHALL NOT enable any prompt, tool-content or raw request/response logging flag documented for the engine's telemetry (for Claude Code, at least `OTEL_LOG_USER_PROMPTS` and `OTEL_LOG_TOOL_DETAILS`).
- **R25** — WHEN `crow attach` runs on a config that already has crow's entries, the system SHALL leave it unchanged.
- **R26** — WHEN the user runs `crow detach <claude|codex>` and confirms, the system SHALL remove the entries crow added that the user has not modified, preserve every other setting including changes the user made after the attach, keep and report any crow entry the user modified, and abort without writing if it cannot verify the result.
- **R27** — IF the engine's config file cannot be parsed THEN `attach` and `detach` SHALL abort with the reason and SHALL NOT write anything.
- **R28** — WHEN the user runs `crow doctor`, the system SHALL report per engine which lanes are active (files seen, hooks configured and last hook received, OTLP configured, port listening and last record received) and any OTLP port conflict.

### UI
- **R29** — The session timeline SHALL show `hook` events with hook name, phase, verdict and duration, and `permission` events with the request and its decision.
- **R30** — The session detail SHALL show a hooks panel with, per hook name, the number of runs, total and maximum duration, and the number of blocking verdicts.
- **R31** — WHEN a hook event reaches the server, it SHALL be delivered on `/api/stream` in under 1 s.

### Añadidos tras el challenge del design
- **R32** — The system SHALL provide an event kind `turn.end` for the end of an assistant turn, carrying whether it ended normally or with a failure and, for a failure, its category as reported by the engine.
- **R33** — The Claude adapter SHALL map the transcript's hook execution records (`hook_success` and the other hook outcomes the transcript carries) to `hook` events with hook name, phase and duration, keeping only allowlisted fields (never the hook's stdout or stderr) and excluding the hooks that crow itself installed.
- **R34** — The OTLP lane SHALL be disabled unless it is enabled explicitly (by a `crow up --otlp` flag or configuration), and `crow attach` SHALL enable it when it configures an engine's telemetry.
