<!-- navori:managed id="agentes-disponibles" hash="94fe5dc5" version="0.10.0" source="@navori/core" -->
## Agentes disponibles

Subagentes que puedes lanzar con la herramienta `Agent` (tú eres el orquestador; ve "## Role: orchestrator"). La investigación y la revisión son de solo lectura → paraleliza sin miedo.

- `implementer` — Escribe código y tests para UNA tarea bien acotada. Úsalo proactivamente cuando el cambio toque 4+ archivos o 2+ no triviales.
- `reviewer` — Valida un diff (APPROVED / CHANGES_REQUESTED). Úsalo tras cada implementer y antes de cualquier commit, push o PR con código.
- `scout` — Reconocimiento de solo lectura: mapea un área o responde una pregunta acotada, con evidencia citada. Úsalo cuando una sub-pregunta convenga correr en paralelo, o una lectura convenga aislar del contexto de quien coordina.
- `auditor` — Auditoría de solo lectura con veredicto: área (seguridad, rendimiento, SOLID), ticket complejo o challenge de una propuesta, sin veredicto en el challenge. Úsalo cuando toque auditar un área o un ticket crítico, o antes de refactorizar sin ticket.
- `publisher` — Escribe commits Conventional y abre el PR. Úsalo tras la aprobación del reviewer.
- `scribe` — Serializa evidencia estructurada en artefactos Markdown de handoff. Úsalo después de que un productor termine y antes de que su consumidor lea el artefacto.
- `architect` — Propone qué construir y por qué, aplicando `solution-design`; no emite veredicto ni descompone. Úsalo cuando se dispare la fila arquitectónica, antes de descomponer en tareas.
<!-- /navori:managed id="agentes-disponibles" -->
