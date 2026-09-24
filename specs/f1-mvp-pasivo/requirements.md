# F1 MVP pasivo — Requirements

## Context
navori-crow observa en vivo las sesiones de Claude Code y Codex CLI de cualquier repo local leyendo solo lo que los motores ya escriben en disco (carril A, PLAN.md §6.1), sin configurar nada en los motores ni en los repos. F1 entrega el caso de uso central: una rejilla multi-proyecto en vivo con detalle de sesión.

## Requirements (EARS)

### Store
- **R1** — The system SHALL persist events, projects, sessions, agents, ingest offsets and dedupe keys in a SQLite database at `~/.crow/crow.db` (overridable with `CROW_HOME`) in WAL mode, with the tables of PLAN.md §7.2.
- **R2** — WHEN the server starts against a database whose schema version is older than the current one, the system SHALL apply the pending migrations in order inside a transaction before accepting requests.
- **R3** — WHEN the system creates the database file or the `~/.crow` directory, the system SHALL set permissions `0600` on the file and `0700` on the directory.
- **R4** — WHEN an event is stored, the system SHALL update the session and agent totals (input, output, cacheRead, cacheCreation, weightedTokens, costUsd) in the same transaction as the event insert.

### Tailer (carril A)
- **R5** — The system SHALL watch each adapter's watch roots recursively and ingest new complete lines appended to matching files.
- **R6** — The system SHALL persist, per file, the inode and the byte offset of the last fully ingested line, and on restart SHALL resume from that offset without re-reading ingested lines.
- **R7** — IF a watched file's inode changes or its size drops below the persisted offset THEN the system SHALL treat it as a new file and ingest it from offset 0.
- **R8** — WHEN a read ends in a line without a trailing newline, the system SHALL buffer that partial line and not ingest it until its newline arrives.
- **R9** — WHEN the server starts, the system SHALL backfill files under the watch roots modified within a configurable recent window (default 24 h), so that a session started before crow was running is hydrated completely.
- **R10** — IF a line is not valid JSON or has a shape the adapter does not recognize THEN the system SHALL store an `ingest.error` event carrying the file path and line position, and SHALL continue with the next line.

### Adapters
- **R11** — The Claude adapter SHALL map main-session transcript lines under `~/.claude/projects/<slug>/<sessionId>.jsonl` to `CrowEvent`s of kinds `session.start`, `prompt`, `assistant.message`, `tool.pre`, `tool.post`, `tool.error` and `compact`.
- **R12** — The Claude adapter SHALL map subagent transcripts under `<sessionId>/subagents/agent-<id>.jsonl` (with their `.meta.json`) to events carrying the parent `sessionId`, the subagent's `agentId` and its `parentAgentId`, and SHALL emit `agent.start` / `agent.stop` for each subagent.
- **R13** — WHEN several transcript lines carry usage for the same `message.id`, the system SHALL count that usage once.
- **R14** — The Codex adapter SHALL map rollout JSONL files under `$CODEX_HOME/sessions` (default `~/.codex/sessions`) to `CrowEvent`s of kinds `session.start`, `prompt`, `assistant.message` (with usage when present), `tool.pre` and `tool.post`.
- **R15** — WHEN a session's first event with a `cwd` is ingested, the system SHALL assign the session to the project resolved from that `cwd` by the core `projectKey` resolver (worktrees and subdirectories of one repo map to one project), and SHALL keep that assignment for the whole session while storing each event's own `cwd`.
- **R16** — WHEN the same event identity — `(source, sessionId, sha1 of the source line bytes, index of the event within that line)` — is ingested more than once, the system SHALL store it once; `seq` stays as the informative byte offset.

### Sessions
- **R17** — WHEN a session receives an event, the system SHALL set its status to `live`.
- **R18** — WHILE a `live` session receives no events for a configurable idle window (default 5 min), the system SHALL set its status to `idle`.
- **R19** — WHEN a `session.end` event is ingested, the system SHALL set the session status to `ended`.

### Pricing
- **R20** — The system SHALL compute `costUsd` for each usage from a per-model price table, and IF the model is not in the table THEN SHALL leave `costUsd` unset and count the tokens anyway.
- **R21** — The system SHALL compute `weightedTokens` with the same arithmetic as navori-harness `report.ts` `weightedTokens`.

### API and real time
- **R22** — The system SHALL publish every stored event to an in-memory bus after its transaction commits.
- **R23** — WHEN a client connects to `GET /api/stream` (optionally filtered by `project` and `session`), the system SHALL stream matching events as SSE with `id` = `CrowEvent.id`, and SHALL send a heartbeat comment every 15 s.
- **R24** — WHEN a client connects to `GET /api/stream` with a `Last-Event-ID` header, the system SHALL first replay the stored matching events with a greater id, then continue live, without gaps or duplicates.
- **R25** — The system SHALL serve `GET /api/projects` with each project and its `live` and `idle` sessions and totals.
- **R26** — The system SHALL serve `GET /api/sessions` filtered by `project`, `status` and `since`, and `GET /api/sessions/:id` with its agent tree and totals.
- **R27** — The system SHALL serve `GET /api/sessions/:id/events` paginated by `after` (event id) and `limit`.
- **R28** — IF a request to `/api/*` carries a `Host` that is not a loopback host or an `Origin` that is not the crow origin THEN the system SHALL reject it with 403.
- **R29** — WHEN an event reaches the store, the time from the source line being written to the event being delivered on `/api/stream` SHALL be under 2 s.

### UI
- **R30** — The UI home SHALL show one card per project with name, engines, live sessions, current prompt, active agent, tokens and cost of the day, and last error, updated live from the stream.
- **R31** — The UI SHALL offer a split mode where the user selects 2–4 projects and sees their live feeds side by side.
- **R32** — The UI session detail SHALL show the event timeline filterable by kind, agent and tool, the agent tree with status, duration and tokens per agent, and a cost panel (input, output, cache, weightedTokens, USD, model).
- **R33** — WHEN a UI view opens, it SHALL backfill via REST and then subscribe to `/api/stream` from the last backfilled id.
