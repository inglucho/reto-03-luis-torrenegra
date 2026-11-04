# Agente Periferia — núcleo

Núcleo común de los agentes conversacionales de la prueba técnica de Periferia IT Group: ciclo del agente, adaptador de proveedor LLM, contrato de herramientas con zod, confirmación humana y chat web. Cada reto lo usa con su prompt, su conocimiento y sus herramientas.

## Puesta en marcha

```bash
bun install
cp .env.example .env    # completa LLM_API_KEY (gratis en https://aistudio.google.com/apikey)
bun run dev             # http://localhost:3000
```

Sin clave de ningún proveedor:

```bash
bun run demo.ts         # ejecuta las herramientas directamente y verifica los resultados
bun test                # ciclo del agente con un adaptador LLM guionizado
```

## Variables de entorno

| Variable | Uso | Por defecto |
|---|---|---|
| `LLM_PROVIDER` | Proveedor de lenguaje: `gemini` o `anthropic` | `gemini` |
| `LLM_MODEL` | Modelo; vacío = el predeterminado del proveedor | `gemini-3.5-flash` (respaldo automático a `gemini-3.5-flash-lite` si está saturado) / `claude-opus-5-5` |
| `LLM_API_KEY` | Clave del proveedor. Solo vive en el entorno del backend: nunca en el repositorio, el front, los logs ni la API | — |
| `LLM_TIMEOUT_MS` | Tiempo máximo de espera al proveedor | `120000` |
| `MAX_ITERACIONES` | Rondas herramienta → modelo por turno | `25` |
| `MAX_TOKENS_SESION` | Tope de tokens por conversación | `500000` |
| `PORT` | Puerto HTTP | `3000` |

## API

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → stream SSE de eventos: `texto`, `llamada`, `resultado`, `error`, `fin_turno` (con `necesitaConfirmacion`) |
| `GET` | `/api/sessions/:id` | Historial de la sesión |
| `DELETE` | `/api/sessions/:id` | Descarta la sesión |
| `GET` | `/api/health` | `{ ok, provider, model }` sin exponer claves |
| `GET` | `/api/herramientas` | Herramientas registradas |

## Arquitectura

```
web/ (chat)  ──POST /api/chat──▶  src/server.ts ──▶ core/agente.ts ──▶ llm/adapter.ts ──▶ llm/gemini.ts · llm/anthropic.ts
     ▲                                                   │
     └──────────── SSE: texto · llamada · resultado ─────┤
                                                         ▼
                              tools/<dominio>.ts (zod) ──▶ fixtures/ (lectura) · out/ (escritura)
```

| Pieza | Dónde | Qué contiene |
|---|---|---|
| Comportamiento | `agent/prompt.md` | System prompt |
| Conocimiento | `src/knowledge/*.md` | Reglas del proceso; se anexan al prompt |
| Ejecución | `src/tools/<dominio>.ts` | Herramientas `{ description, args, execute }`; el modelo las ve como `<archivo>_<export>` |
| Ciclo del agente | `src/core/agente.ts` | Bucle con tope de iteraciones y de tokens, confirmación y bitácora |
| Proveedor LLM | `src/llm/` | Interfaz `enviar(mensajes, herramientas)` con dos implementaciones: Gemini (por defecto, capa gratuita) y Anthropic. Se cambia con `LLM_PROVIDER` sin tocar el ciclo |

**Confirmación humana (CA3).** Las herramientas de escritura aceptan `confirmado`. Sin él, responden con una solicitud de confirmación; el agente cierra el turno con una pregunta y el chat lo resalta. El backend solo deja pasar `confirmado: true` si el mensaje inmediatamente posterior del usuario es una confirmación explícita, aunque el modelo intente usarlo por su cuenta.

Cada llamada a herramienta queda en `out/log.jsonl`.

## Despliegue

```bash
docker build -t agente-periferia .
docker run -p 3000:3000 --env-file .env agente-periferia
```

En la plataforma de despliegue, `LLM_API_KEY` se configura como secreto del servicio.
