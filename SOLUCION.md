# SOLUCION — Reto 02: Agente de Registro de Contratos Vigentes

## 1. Problema en una frase

El registro maestro de contratos está congelado desde el 2026-05-30 porque solo llegan a administración los contratos con póliza; le duele a la analista administrativa (no sabe qué está vigente) y a la gerencia (no ve vencimientos ni pólizas en riesgo).

## 2. Arquitectura

```
 Front (web/index.html, HTML+JS plano)
        |  POST /api/chat
        v
 Backend Hono (src/server.ts, Bun.serve)
   |-- Ciclo del agente (src/agent/loop.ts) ---> LlmAdapter (src/llm/adapter.ts)
   |        |                                      \-> openai-compatible.ts (Groq/Gemini)
   |        v
   |-- Registry (src/agent/registry.ts: zod, nunca lanza)
   |        v
   |   Herramientas contratos_* (src/tools/contratos.ts) -> src/lib/ (lógica)
   |        |                       |
   |        v                       v
   |   fixtures/ (solo lectura)   out/ (sharepoint/, procesados.json, log.jsonl, alertas.md, sessions/)
```

- **Comportamiento**: `agent/prompt.md`.
- **Conocimiento**: `src/knowledge/registro-contratos.md`.
- **Ejecución**: `src/tools/contratos.ts` y `src/lib/`.
El prompt y el conocimiento se leen de disco al arrancar y forman el system prompt.

## 3. Ciclo del agente

Bucle modelo → herramientas → modelo, con tope `MAX_ITERATIONS` (25 por defecto); al alcanzarlo responde con lo que tiene y lo que falta. Tope de tokens por sesión `MAX_TOKENS_SESSION` (200000). Los errores o timeouts del proveedor (`LLM_TIMEOUT_MS`, `AbortController`) se muestran en el chat sin matar la sesión.

**Confirmación humana impuesta por diseño**: si el modelo llama una herramienta con `confirmado: true`, el loop solo lo permite cuando el último mensaje del usuario coincide con una expresión de confirmación (sí, confirmo, procede, adelante, ok...). Si no, fuerza `confirmado: false` y lo registra. Además `contratos_registrar` rechaza por sí misma los campos en revisión sin `confirmado`. `needsConfirmation` se activa cuando una herramienta devuelve revisión pendiente; el front lo resalta con un banner amarillo. Cada llamada queda en la sesión y en `out/log.jsonl`.

## 4. Elección del modelo

Proveedor OpenAI-compatible (Groq o Gemini) mediante el SDK `openai`, configurado solo por variables de entorno; cambiar de proveedor no toca el loop. Se eligen modelos con tool calling y free tier, porque la lógica de negocio vive en herramientas deterministas y el modelo solo orquesta y redacta.

Costo estimado por caso (los precios deben verificarse antes de producción):

| Escenario | Tokens aprox. por mensaje procesado | Costo |
|---|---|---|
| Free tier (Groq/Gemini) | ~6k entrada + ~1k salida | USD 0 |
| Modelo de pago pequeño (precio a verificar) | idem | precio por millón de tokens a verificar x ~7k tokens, centavos de dólar por caso |

Un lote de 6 mensajes más alertas ronda 40-60k tokens, muy por debajo del tope de sesión.

## 5. Estrategia de extracción

- **Determinista (P0)**: regex y heurísticas sobre `contrato.txt` (`src/lib/parsers.ts`):
  - Partes: etiquetas de contratante/contratista y razón social; NIT sin puntos ni dígito de verificación; país inferido del identificador y del texto.
  - Valor y moneda: cifras con separadores locales normalizadas a número; "por demanda" produce valor 0 con `valor_indeterminado`.
  - Plazo: fechas explícitas o plazo en meses, del que se deriva `fecha_fin`.
  - Póliza: se buscan cláusulas de garantía/póliza y sus tipos.
- **Confianza por campo** en [0, 1]: alta cuando el patrón es explícito y único; media cuando hay ambigüedad o valor derivado (fecha_fin desde meses, valor por demanda); 0 y `null` cuando el campo no está. Los campos con confianza menor a 0.8 pasan a `requiere_revision`.
- **Dónde entra el modelo**: orquesta el flujo, explica los campos dudosos, formula la pregunta de confirmación y recibe del usuario los valores corregidos. **Dónde no**: no extrae ni decide clasificaciones; el valor registrado siempre sale de `contratos_validar`/`contratos_registrar`.

## 6. Regla de gobierno (propuesta de una página)

1. **Canal único**: buzón `contratos@periferia.example` (dirección ilustrativa), administrado por la analista administrativa, con un suplente nombrado para que el proceso sobreviva a la rotación. El agente es el único lector automático.
2. **Obligación del comercial**: enviar al buzón todo contrato firmado (con o sin póliza), cada otrosí y cada acta de terminación, en PDF firmado, dentro de los 3 días hábiles siguientes a la firma. Asunto: `[CONTRATO|OTROSI|TERMINACION] <NIT cliente> - <número de contrato>`.
3. **Acuse automático**: el agente responde al comercial en menos de 1 hora hábil con el estado (registrado, en revisión, duplicado o rechazado) y el motivo.
4. **Excepciones y escalamiento**: contrato sin firmar, sin valor o con campos dudosos queda en revisión; la analista consulta al comercial y, si no hay respuesta en 3 días hábiles, escala a la gerencia comercial. Nada con baja confianza entra al maestro sin confirmación humana.
5. **Cierre del gap**: una campaña única de dos semanas para junio–agosto de 2026: cada comercial reenvía sus contratos firmados en ese período al buzón; el agente los procesa en lote y la analista confirma los casos en revisión; se cruza contra facturación para detectar faltantes.
6. **Indicador mensual**: porcentaje de contratos facturados en el mes que existen en el maestro (meta 100 %), más el número de contratos en revisión con más de 5 días.

## 7. Decisiones y trade-offs

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| Extracción determinista (regex) en herramientas, modelo solo orquesta | Extraer con el LLM | El LLM puede redondear valores o inferir fechas; lo determinista es auditable, testeable, reproducible en la demo y no cuesta tokens. |
| Confirmación impuesta en el loop (regex sobre el último mensaje del usuario) además del prompt | Confiar solo en el prompt | Un prompt puede ser ignorado; el control en código garantiza que nada dudoso se escribe sin un "sí" humano. |
| Front en HTML + JS plano servido por Hono | React/Next.js con build | Sin build step, arranque rápido y menos superficie; el PRD lo permite. |
| Maestro CSV y SharePoint como carpeta local | Base de datos | El PRD lo pide; la copia en `out/` mantiene el fixture intacto y es fácil de inspeccionar. |
| SDK `openai` con endpoint configurable | Vercel AI SDK o SDK por proveedor | Un adaptador propio de una interfaz pequeña evita acoplarse; cambiar de proveedor es solo configuración. |

## 8. Supuestos

- Los contratos llegan con texto ya extraído (`contrato.txt`); no hay OCR.
- En `msg-006` se marcan en revisión, además de valor y fecha_fin, otros campos de baja confianza que se derivan del texto.
- Si el contrato no menciona póliza explícitamente pero hay indicios, `requiere_poliza = true` con confianza 0.6 (a revisión); la ausencia total de cláusula de póliza implica `false` con confianza 0.9.
- El otrosí (`msg-003`) se archiva como `CT-...-otrosi-msg-003.txt` junto al contrato, sin sobrescribir el original.
- Duplicado (RN1) compara valor, moneda y fechas inicio/fin.
- Mensajes rechazados y duplicados se marcan procesados en `out/procesados.json` sin escribir en el maestro.
- Un comercial desconocido no bloquea: en `comercial` se guarda su correo.
- El argumento `contrato` es opcional en validar y registrar; si se omite se extrae del mensaje.
- Sin número de contrato se genera `AUTO-<año>-<NNN>`.
- `procesados.json` en `out/` define qué mensajes siguen pendientes.
- Las alertas incluyen una sección adicional "ya vencidos" y la fecha `hoy` es un argumento.
- La dirección del buzón de la regla de gobierno es ilustrativa.

## 9. Cobertura

| Historia | Estado | Qué falta para producción |
|---|---|---|
| HU-1 Leer buzón | Hecho | Conexión real a Exchange. |
| HU-2 Extraer | Hecho | OCR y PDF nativo (`contratos_leer_pdf` no incluido); más variedad de plantillas. |
| HU-3 Validar y clasificar | Hecho | Afinar similitud de objeto con datos reales. |
| HU-4 Registrar y archivar | Hecho | SharePoint real y control de concurrencia sobre el CSV. |
| HU-5 Alertar | Hecho | Envío programado por correo a gerencia. |
| HU-6 Manejo de errores | Hecho | Observabilidad centralizada. |
| Bonus `modulo/` | No hecho (recorte por tiempo) | Generar `modulo/` con `scripts/build-modulo.ts`. |

## 10. Uso de IA

- **Claude (claude.ai)**: análisis del PRD y planeación del reto.
- **Claude Code**: orquestador y subagentes que construyeron herramientas, loop, tests y documentación; todo verificado con `bun test` y `demo.ts`.
- **Descartado**: Vercel AI SDK (acopla el loop a un SDK externo), Next.js (build y complejidad innecesarios) y hosting en Vercel (se prefirió un despliegue con Docker en un servidor de procesos persistente con disco para `out/`).

## 11. Riesgos

| Riesgo | Mitigación |
|---|---|
| Falsos duplicados o actualizaciones por variaciones del nombre | Dedupe por `nit_cliente` e id de contrato antes que por nombre. |
| El modelo inventa o redondea valores | Los valores salen solo de herramientas; confirmación impuesta en el loop. |
| Contratos escaneados o plantillas nuevas | OCR y pruebas con muestras reales; baja confianza va a revisión humana. |
| Concurrencia sobre el CSV y `out/` efímero en contenedores | Base de datos o almacenamiento real y volumen persistente. |
| Consumo abusivo de la clave | Topes de iteraciones y tokens por sesión, límites de tasa en el proveedor. |
| El comercial no cumple la regla de gobierno | Indicador mensual contra facturación y escalamiento a gerencia. |
