# navori-crow

Observador **local y en tiempo real** para agentes de código: Claude Code, Codex CLI, OpenCode/DeepSeek, Gemini CLI y otros.

Levanta un puerto local con una UI web para ver, **solo en lectura**, qué hace cada agente y su harness: prompts, herramientas, subagentes, hooks, tokens y costo, archivos tocados y errores. Junto a eso muestra señales de auditoría. Puedes observar **varios proyectos al mismo tiempo** en una sola pantalla.

> **Estado:** F0 (bootstrap) — monorepo, tipos base y `/healthz` levantados. Sin ingesta todavía.

## Por qué

- **Agnóstico de motor:** un modelo de eventos neutral y un adaptador por cada CLI.
- **Pasivo primero:** lee lo que los motores ya escriben en disco, así que no hay que instalar nada en tus repos. Los hooks y OpenTelemetry son opcionales, para tener más detalle.
- **Local-first:** escucha solo en `127.0.0.1` y no manda nada a la nube.
- **Independiente:** nace como la extracción de `navori audit` de [navori-harness](https://github.com/UlisesCm/navori-harness), pero no depende de él.

## Stack

- **Servidor:** TypeScript + Bun (`Bun.serve`, `bun:sqlite`, SSE)
- **Frontend:** Svelte 5 + Vite
- **Ingesta:** tail de transcripts, hooks por HTTP, receptor OTLP y SSE de `opencode serve`

## Documentación

- [PLAN.md](./PLAN.md): visión, arquitectura, modelo de datos, contrato de adaptadores y roadmap por fases.

## Licencia

Por definir.
