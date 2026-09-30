# fixtures/otlp/codex

OTLP logs emitted by Codex **0.158.0** (`service.name = codex_exec`), captured 2026-09-29 with
`codex exec --json` against a local receiver (B0.T2/T3, `specs/f2a-ingesta-activa`). They hold no
content: every value went through the allowlist anonymizer `scripts/anonymize/otlp.ts` (known
`codex.*` event names and enumerated attributes stay; identity, prompts, tool arguments/output,
agent-to-agent content, endpoints and child agent names are `«str:n»` markers; ids are pseudonyms
shared with `fixtures/codex/hooks` and `fixtures/codex/0.158.0`; instants are shifted to a fixed epoch;
numeric/bool values and OTLP value types are untouched).

- `logs.json`: OTLP/JSON, one record per event name (plus the unnamed metrics-client debug log).
  `codex_exec` sends only logs in B0 (no metrics/traces).
- `logs.bin`: protobuf re-encoded from the JSON with the `protobufjs` oracle
  (`bun scripts/encode-otlp-fixture.ts fixtures/otlp/codex`); a test keeps it in sync. Codex itself
  sends `application/x-protobuf` when `protocol = "binary"`: compared against a real protobuf capture
  (decoded with `@crow/otlp`), every event has the same attribute keys and value types, and the same
  resource attributes. The only difference is that the first `codex.sse_event` of the fixture has no
  `ttft_ms`/`model_reasoning_effort` (Codex sends them from the second one on).
- `turn_id` does not travel in OTLP; `call_id` is the same string as the hook's `tool_use_id`
  (`exec-<id>` for shell commands) and as the rollout's `call_id`/`item.id`.

Regenerate from raw captures (never committed) with `scripts/anonymize-b0.ts otlp --engine codex`.
