# Historia de sesiones

<!--
Entradas más recientes arriba. Formato sugerido (no obligatorio):

## YYYY-MM-DD HH:MM — <agente> — <resumen breve>
- Cambios: <archivos / áreas tocadas>
- Quality gate: ✅ (quality gate sin configurar — corre 'navori configure quality-gate') verde | ❌ <razón>
- Notas: <decisiones no obvias, blockers, deuda>
- Commit / PR: <hash / URL>
-->

## 2026-09-23 23:50 — orchestrator — F0 Bootstrap del monorepo
- Cambios: monorepo Bun workspaces (`packages/core`, `apps/server`, `apps/web`), TS strict, oxlint/oxfmt, CI en GitHub Actions, tipos `CrowEvent` y `projectKey()` con tests, `Bun.serve` en loopback con `/healthz` y estáticos (guard `isInside`), hello en Svelte 5 + Vite. Quality gate configurado en `navori.config.json` (`fast`: lint + typecheck, `full`: `bun run check`).
- Quality gate: ✅ `bun run check` verde (10 pass / 0 fail), Pass 2 del reviewer.
- Notas: deuda menor sin bloquear: la caché de `projectKey` usa el `cwd` crudo en vez de `realpath`.
- Commit / PR: feat/f0-bootstrap
