# Sesión actual

**Estado:** done (PR de B5.T1 a main; B7.T1 se publica aparte)

## Resultado
F1 lote B5.T1 completado: `startApp`, `guard.ts`, `adapters.ts` con Claude y modo dev. Cubre R2 y R28.

## Siguiente paso
B5.T2: REST (`/api/projects`, `/api/sessions`, `/api/sessions/:id`, `/api/sessions/:id/events`, `/api/events`, `/api/stats`, 409 `unknown-cursor`) y `sse.ts` según D13, ruteando con `isApiPath` de `server.ts`.
