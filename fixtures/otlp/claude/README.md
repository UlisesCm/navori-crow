# fixtures/otlp/claude

OTLP bodies emitted by Claude Code **2.1.285**, captured 2026-09-29 in `-p` (headless) mode against a
local receiver (B0.T2/T3, `specs/f2a-ingesta-activa`). They hold no content: every value went through
the allowlist anonymizer `scripts/anonymize/otlp.ts` (known event/metric/span names and enumerated
attributes stay; identity, prompts, responses, argv and paths are `«str:n»` markers; ids are
pseudonyms shared with `fixtures/claude/hooks` and `fixtures/claude/cc-2.1.285`; instants are shifted
to a fixed epoch; numeric/bool values and OTLP value types are untouched).

- `logs.json`, `metrics.json`, `traces.json`: OTLP/JSON, one record per event/metric/span name
  (traces are the beta `/v1/traces` variant).
- `*.bin`: protobuf re-encoded from the JSON above with the `protobufjs` oracle
  (`bun scripts/encode-otlp-fixture.ts fixtures/otlp/claude`); a test keeps them in sync.

Regenerate from raw captures (never committed) with `scripts/anonymize-b0.ts otlp`.
