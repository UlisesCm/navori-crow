<!-- navori:managed id="arranque-sesion" hash="10da4f68" version="0.10.0" source="@navori/core" -->
## Session startup

On Claude, a `SessionStart` hook injects the live context — branch, recent commits, and the previous session's `progress/current.md` — at the top of the session; read it to resume. Otherwise, read `progress/current.md` yourself. Then, before touching code:

1. **Healthy config**: run `navori doctor` if `navori.config.json` / `.claude/` look inconsistent, or to confirm the declared quality gates can actually run.
2. **Scoped task**: one **user** task at a time; decompose and parallelize per your orchestrator role.

**Audit mode on request**: if the user asks for it in any wording ("audit mode", "con auditoría", "navori audit"), run `navori audit --start <this session's id>` as the FIRST action of that turn — before loading skills or starting any pipeline — and confirm the log path it prints. The phrase never activates anything by itself (by design); the command is the only switch. If the injected context already says audit-mode is ACTIVE (armed via `navori audit --arm` — which also applies to a RUNNING session on its next message), it is running — do not start it again, and never tell the user to close and reopen the session for this.
<!-- /navori:managed id="arranque-sesion" -->
