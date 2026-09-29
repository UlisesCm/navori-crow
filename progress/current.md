# Sesión actual

**Estado:** done (PR del fix del id codificado a main)

## Resultado
La demo de F1 por API pasó los criterios 1, 3 y 4; el 2 (split) queda sin verificación visual. Encontró dos bugs: el 404 del detalle de sesión con id codificado (este PR) y la atribución de `ingest.error` (PR aparte).

## Siguiente paso
- Verificación visual del split y del detalle de sesión.
- Spec de F2a: segunda vuelta del design, tasks y lote B0 de capturas.
