# Agente Periferia (prueba técnica)

Agente conversacional en TypeScript + Bun para la prueba técnica de IA de Periferia IT Group. El PRD de cada reto (sección 6) fija la arquitectura: respetar nombres de archivo, contrato de herramientas y API.

## Comandos

- `bun run dev`: servidor con recarga en http://localhost:3000 (el chat requiere `LLM_API_KEY`)
- `bun run demo.ts`: verificación determinista de las herramientas, sin modelo
- `bun test`: ciclo del agente con adaptador LLM guionizado
- `bun run typecheck`: tipos

Antes de cada commit: `bun run typecheck && bun test && bun run demo.ts`.

## Estructura

- `agent/prompt.md`: comportamiento. `src/knowledge/*.md`: conocimiento del proceso. `src/tools/<dominio>.ts`: ejecución.
- `src/dominio.ts`: único archivo que conecta el dominio (import de herramientas + prefijo).
- `src/core/`: ciclo del agente, contrato de herramientas, confirmación, sesiones, bitácora. Sin dependencias de un proveedor LLM ni de un dominio.
- `src/llm/`: interfaz `AdaptadorLLM` con implementaciones de Gemini (por defecto, gratuita) y Anthropic. Leer los tipos del SDK instalado antes de usar su API.
- `web/`: chat en TypeScript sin framework, empaquetado por Bun.

## Contrato de herramientas (PRD 6.2)

- Cada export es `{ description, args, execute(args, ctx) }`; el modelo la ve como `<archivo>_<export>`.
- `args`: esquemas zod con `.describe()` en cada campo.
- `execute` devuelve un string JSON con `ok(data)`, `fallo(error)` o `pideConfirmacion(motivo)` y **nunca lanza**.
- Las acciones de escritura aceptan `confirmado?: boolean`; sin él devuelven `pideConfirmacion`.

## Convenciones

- Código, comentarios y mensajes en español. TypeScript sin `any`.
- Las reglas de negocio viven en las herramientas, no en el prompt: así son deterministas y `demo.ts` las verifica.
- El historial de la sesión solo crece; no reescribir mensajes anteriores.
- Ninguna clave en el código, el repo, el front ni los logs: solo `LLM_API_KEY` en el entorno.
- Nunca hacer commit en `main`: cada cambio va en una rama `feat/…`, `fix/…` o `docs/…` y entra por pull request.
