// Herramientas del agente "Registro de Contratos". Cada export se registra como contratos_<export>.
// La lógica vive en src/lib/contratos-core.ts; aquí solo el contrato (description, args, execute).
import { z } from "zod"
import {
  ContratoSchema, buscarAdjuntoContrato, ejecutar, extraerContrato, generarAlertas, leerCorreo, leerProcesados,
  listarIdsBuzon, registrarMensaje, validarMensaje, type Ctx,
} from "../lib/contratos-core"
import { ErrorNegocio } from "../lib/parsers"

const mensajeId = z.string().describe("Identificador del mensaje del buzón, por ejemplo msg-001")
const contratoOpc = ContratoSchema.optional().describe(
  "Contrato con los datos extraídos (y los corregidos o confirmados por el usuario). Si se omite se extrae del mensaje.",
)

const argsLeerBuzon = {}
export const leer_buzon = {
  description: "Lista los mensajes pendientes del buzón de contratos con remitente, asunto, adjuntos y si traen un contrato.",
  args: argsLeerBuzon,
  async execute(_args: Record<string, never>, ctx: Ctx): Promise<string> {
    return ejecutar("contratos_leer_buzon", ctx, null, () => {
      const hechos = new Set(leerProcesados(ctx.directory).map((p) => p.mensaje_id))
      const mensajes = listarIdsBuzon(ctx.directory)
        .filter((id) => !hechos.has(id))
        .flatMap((id) => {
          try {
            const correo = leerCorreo(ctx.directory, id)
            const { adjunto, motivo } = buscarAdjuntoContrato(ctx.directory, correo)
            return [{
              id: correo.id, de: correo.de, asunto: correo.asunto, fecha: correo.fecha, adjuntos: correo.adjuntos,
              tiene_contrato: adjunto !== null,
              ...(adjunto ? {} : { clasificacion: "rechazado", motivo }),
            }]
          } catch (e) {
            const motivo = e instanceof ErrorNegocio ? e.message : "No se pudo leer el mensaje."
            return [{ id, de: "", asunto: "", fecha: "", adjuntos: [], tiene_contrato: false, clasificacion: "rechazado", motivo }]
          }
        })
      return { data: { mensajes }, resumen: `${mensajes.length} mensajes pendientes` }
    })
  },
}

const argsExtraer = { mensaje_id: mensajeId }
export const extraer = {
  description: "Extrae del adjunto del mensaje los datos estructurados del contrato (partes, valor, fechas, póliza) con confianza por campo.",
  args: argsExtraer,
  async execute(args: z.infer<z.ZodObject<typeof argsExtraer>>, ctx: Ctx): Promise<string> {
    return ejecutar("contratos_extraer", ctx, args.mensaje_id, () => {
      const correo = leerCorreo(ctx.directory, args.mensaje_id)
      const { adjunto, motivo } = buscarAdjuntoContrato(ctx.directory, correo)
      if (!adjunto) throw new ErrorNegocio(`El mensaje ${args.mensaje_id} no contiene un contrato adjunto. ${motivo ?? ""}`.trim())
      const c = extraerContrato(ctx.directory, correo, adjunto)
      return { data: c, resumen: `${c.id_contrato ?? "sin id"} ${c.cliente ?? "sin cliente"}${c.es_otrosi ? " (otrosí)" : ""}` }
    })
  },
}

const argsValidar = { mensaje_id: mensajeId, contrato: contratoOpc }
export const validar = {
  description: "Clasifica el mensaje como nuevo, actualización, duplicado o rechazado y lista los campos que requieren revisión humana.",
  args: argsValidar,
  async execute(args: z.infer<z.ZodObject<typeof argsValidar>>, ctx: Ctx): Promise<string> {
    return ejecutar("contratos_validar", ctx, args.mensaje_id, () => {
      const { validacion: v } = validarMensaje(ctx.directory, args.mensaje_id, args.contrato)
      const rev = v.requiere_revision.length > 0 ? ` revisión: ${v.requiere_revision.join(", ")}` : ""
      return { data: v, resumen: `${v.clasificacion}${rev}` }
    })
  },
}

const argsRegistrar = {
  mensaje_id: mensajeId,
  contrato: contratoOpc,
  confirmado: z.boolean().optional().describe("true solo si el usuario confirmó explícitamente los campos en revisión"),
}
export const registrar = {
  description: "Escribe o actualiza el contrato en el maestro y lo archiva; si hay campos en revisión exige confirmado=true.",
  args: argsRegistrar,
  async execute(args: z.infer<z.ZodObject<typeof argsRegistrar>>, ctx: Ctx): Promise<string> {
    return ejecutar("contratos_registrar", ctx, args.mensaje_id, () => {
      const r = registrarMensaje(ctx.directory, args.mensaje_id, args.contrato, args.confirmado === true)
      return { data: r, resumen: `${r.accion} ${r.id_contrato ?? ""}`.trim() }
    })
  },
}

const argsAlertas = { hoy: z.string().describe("Fecha de referencia en formato YYYY-MM-DD") }
export const alertas = {
  description: "Genera out/alertas.md con contratos que vencen en 60 días o menos, pólizas pendientes, registrados desde el corte y ya vencidos.",
  args: argsAlertas,
  async execute(args: z.infer<z.ZodObject<typeof argsAlertas>>, ctx: Ctx): Promise<string> {
    return ejecutar("contratos_alertas", ctx, null, () => {
      const r = generarAlertas(ctx.directory, args.hoy)
      return {
        data: r,
        resumen: `${r.vencen.length} vencen, ${r.polizas_pendientes.length} pólizas pendientes, ${r.registrados_desde_corte.length} desde el corte, ${r.ya_vencidos.length} ya vencidos`,
      }
    })
  },
}
