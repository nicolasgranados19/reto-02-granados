# Reto 02 — Agente de Registro de Contratos Vigentes

Agente conversacional que actúa como punto único de recepción de contratos: lee el buzón, extrae datos con confianza, valida (nuevo / actualización / duplicado / rechazado), registra en el maestro y genera alertas.

Link de prueba: PENDIENTE_URL

## Levantar en local

```bash
bun install
cp .env.example .env   # completa las variables LLM_*
bun run dev            # http://localhost:3000
```

Con Docker: `docker build -t reto02 . && docker run -p 3000:3000 --env-file .env reto02`.

## Variables de entorno

| Variable | Descripción |
|---|---|
| `LLM_PROVIDER` | Nombre del proveedor (informativo), por ejemplo groq o gemini. |
| `LLM_BASE_URL` | Endpoint OpenAI-compatible. |
| `LLM_API_KEY` | Clave del proveedor (solo backend, nunca se expone). |
| `LLM_MODEL` | Modelo a usar. |
| `LLM_TIMEOUT_MS` | Timeout por llamada al modelo (default 30000). |
| `MAX_ITERATIONS` | Tope de iteraciones herramienta-modelo por turno (default 25). |
| `MAX_TOKENS_SESSION` | Tope de tokens por sesión (default 200000). |
| `PORT` | Puerto HTTP (default 3000). |

## Demo sin modelo

```bash
bun run demo.ts
```

Procesa los 6 mensajes llamando directamente a las herramientas, sin claves. Limpia `out/` al inicio y es determinista (fecha fija).

## Tests

```bash
bun test
```

## API

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/chat` | `{ sessionId, message }` devuelve `{ reply, toolCalls, needsConfirmation }` |
| GET | `/api/sessions/:id` | Historial completo de la sesión |
| GET | `/api/health` | `{ ok: true, provider, model }` (sin clave) |
| POST | `/api/reset` | Borra `out/` |

## Estructura

`agent/prompt.md` (comportamiento), `src/knowledge/registro-contratos.md` (conocimiento), `src/tools/contratos.ts` y `src/lib/` (ejecución). Ver `SOLUCION.md`.
