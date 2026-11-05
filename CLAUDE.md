# Reto 03 — Órdenes de Compra SAP (prueba técnica Periferia)

Agente conversacional en TypeScript + Bun. El PRD está en `docs/PRD.md` (copia local, no versionada: es material de la prueba); su sección 6 fija la arquitectura (nombres de archivo, contrato de herramientas, API) y la 7 las reglas RC1–RC10. El PRD manda sobre cualquier suposición.

## Comandos

- `bun run dev`: servidor en http://localhost:3000 (el chat requiere `LLM_API_KEY` en `.env`)
- `bun run demo.ts`: los 6 casos sin modelo, con verificación del resultado esperado
- `bun test` · `bun run typecheck` · `bun run modulo` (regenera `modulo/`)

Antes de cada commit: `bun run typecheck && bun test && bun run demo.ts`.

## Dónde va cada cosa

- Comportamiento → `agent/prompt.md`. Conocimiento → `src/knowledge/ordenes-compra.md`. Ejecución → `src/tools/oc.ts`.
- Reglas de negocio → `src/oc/reglas.ts` (funciones puras). Nunca en el prompt ni en el servidor.
- Tras editar el prompt o el conocimiento, ejecutar `bun run modulo`; un test falla si `modulo/` queda desactualizado.
- `fixtures/` es de solo lectura; todo lo generado va a `out/`.

## Convenciones

- Herramientas: `{ description, args, execute(args, ctx) }`, devuelven string JSON y **nunca lanzan**. Recalculan todo desde los fixtures; lo que envía el modelo solo se compara.
- La confirmación la decide la herramienta (`confirmacion` en el resultado); el backend solo deja pasar `confirmado: true` tras una confirmación real del usuario.
- Código y mensajes en español, TypeScript sin `any`, funciones cortas.
- Ninguna clave en el repo: solo `LLM_API_KEY` en el entorno.
- Nunca hacer commit en `main`: ramas `feat/…`, `fix/…`, `docs/…` y pull request.
