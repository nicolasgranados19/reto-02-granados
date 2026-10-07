# Conocimiento: registro de contratos vigentes

## Flujo del proceso

Los comerciales envían contratos a un buzón único. El agente lista los mensajes pendientes (`contratos_leer_buzon`), extrae los datos del adjunto (`contratos_extraer`), clasifica y detecta campos dudosos (`contratos_validar`), registra en el maestro y archiva el documento (`contratos_registrar`) y produce el reporte de riesgos (`contratos_alertas`). El maestro es un CSV y SharePoint es una carpeta local en `out/sharepoint/`; los fixtures nunca se modifican.

## Clasificación

- **nuevo**: no hay coincidencia en el maestro; se inserta una fila.
- **actualizacion**: mismo número de contrato (o mismo NIT y objeto muy similar, similitud >= 0.9) con algún campo distinto, o el documento es un otrosí; se modifica la fila y se anota el cambio en `historial.jsonl`.
- **duplicado**: mismo número de contrato y mismos valor, moneda y fechas; no se escribe nada, se reporta.
- **rechazado**: sin adjunto de contrato o texto sin partes ni objeto identificables; se reporta con motivo.

## Reglas de negocio

| Regla | Descripción |
|---|---|
| RN1 | Duplicado: mismo `id_contrato` y mismos valor, fecha_inicio y fecha_fin. No se escribe nada. |
| RN2 | Actualización: mismo `id_contrato` (o NIT + objeto con similitud >= 0.9) con algún campo distinto, u otrosí. Se actualiza la fila y se registra el cambio en el historial. |
| RN3 | Nuevo: sin coincidencia, se inserta. |
| RN4 | Rechazado: sin contrato adjunto o sin partes/objeto identificables. |
| RN5 | Campos con confianza menor a 0.8 van a `requiere_revision`; `contratos_registrar` sin `confirmado = true` los rechaza. |
| RN6 | El maestro del fixture es de solo lectura; la primera ejecución lo copia a `out/sharepoint/`. |
| RN7 | Toda llamada a herramienta queda en `out/log.jsonl` con ts, herramienta, mensaje_id, ok y resumen. |

## Confianza y revisión

Cada campo extraído trae una confianza entre 0 y 1. Un campo ausente en el texto es `null` con confianza 0 (nunca inventado). Los campos con confianza menor a 0.8, los conflictos con el maestro y los valores derivados (por ejemplo `fecha_fin` calculada desde un plazo en meses, o valor por demanda) aparecen en `requiere_revision`. Mientras `requiere_revision` no esté vacío, el registro solo procede con `confirmado: true`, y esa confirmación solo la da el usuario de forma explícita en su último mensaje.

## Datos de registro

- `id_contrato` es el número tal como aparece en el documento; si no existe se genera `AUTO-<año>-<secuencia>`.
- Contratos por demanda: `valor = 0` con `valor_indeterminado`.
- Póliza: nuevo registro con póliza queda `estado_poliza = pendiente`; sin póliza, `no_aplica`.
- El comercial se resuelve contra `comerciales.json`; un remitente desconocido se reporta pero no bloquea (se guarda su correo).
- El documento se archiva en `out/sharepoint/Contratos/<año_inicio>/<cliente-slug>/<id_contrato>.<ext>`.
- Cada mensaje tratado (registrado, rechazado o duplicado) se marca en `out/procesados.json` y no vuelve a listarse.

## Alertas

`contratos_alertas` recibe `hoy` (YYYY-MM-DD) y genera `out/alertas.md` con: contratos que vencen en 60 días o menos, contratos con póliza requerida y estado distinto de vigente, contratos registrados desde el corte del 2026-05-30 y contratos ya vencidos.

## Errores

Texto vacío, fecha inválida o moneda desconocida devuelven `{ ok: false, error }` legible. El lote continúa con el siguiente mensaje.
