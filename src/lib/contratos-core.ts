// Lógica de negocio del registro de contratos (extracción, validación, escritura). Sin dependencias del servidor.
import { z } from "zod"
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import {
  ErrorNegocio, MESES, MONEDAS, diasEntre, fechaDesdeTexto, jaccard, normalizarNit, parseCsv, parseNumero,
  parteFecha, razonSocial, sinTildes, slugCliente, sumarMeses, toCsv, esFechaIso,
} from "./parsers"

export type Ctx = { directory: string; sessionId: string }

export const UMBRAL_CONFIANZA = 0.8
export const UMBRAL_JACCARD = 0.9
export const NIT_PERIFERIA = "900123456"
export const FECHA_CORTE = "2026-05-30"
export const DIAS_ALERTA = 60

export const COLUMNAS = [
  "id_contrato", "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda", "fecha_inicio", "fecha_fin",
  "requiere_poliza", "tipo_poliza", "estado_poliza", "comercial", "ruta_sharepoint", "fecha_registro", "fuente",
] as const
export type Fila = Record<(typeof COLUMNAS)[number], string>

// ---------- Esquema del contrato ----------

const confianzaSchema = z.record(z.string(), z.number().min(0).max(1))

export const ContratoSchema = z.looseObject({
  id_contrato: z.string().nullable().optional().describe("Número del contrato tal como aparece en el documento"),
  cliente: z.string().nullable().optional().describe("Razón social de la contraparte (EL CONTRATANTE)"),
  nit_cliente: z.string().nullable().optional().describe("Identificador tributario sin puntos ni dígito de verificación"),
  pais: z.enum(["CO", "EC", "PE", "PA", "HN"]).nullable().optional().describe("País de la contraparte"),
  objeto: z.string().nullable().optional().describe("Objeto del contrato, máx. 200 caracteres"),
  valor: z.number().nullable().optional().describe("Valor sin separadores; 0 si es por demanda"),
  moneda: z.enum(MONEDAS).nullable().optional().describe("Moneda del contrato"),
  valor_indeterminado: z.boolean().optional().describe("true si el contrato es por demanda"),
  fecha_inicio: z.string().nullable().optional().describe("Fecha de inicio YYYY-MM-DD"),
  fecha_fin: z.string().nullable().optional().describe("Fecha de fin YYYY-MM-DD"),
  requiere_poliza: z.boolean().nullable().optional().describe("Si el contrato exige póliza"),
  tipo_poliza: z.string().nullable().optional().describe("Tipos de póliza separados por ;"),
  es_otrosi: z.boolean().optional().describe("true si el documento es un otrosí"),
  amplia_garantias: z.boolean().optional().describe("true si el otrosí exige ampliar las garantías"),
  confianza: confianzaSchema.optional().describe("Confianza [0,1] por campo"),
})
export type ContratoEntrada = z.infer<typeof ContratoSchema>

export type Contrato = {
  id_contrato: string | null
  cliente: string | null
  nit_cliente: string | null
  pais: "CO" | "EC" | "PE" | "PA" | "HN" | null
  objeto: string | null
  valor: number | null
  moneda: (typeof MONEDAS)[number] | null
  valor_indeterminado: boolean
  fecha_inicio: string | null
  fecha_fin: string | null
  requiere_poliza: boolean | null
  tipo_poliza: string | null
  es_otrosi: boolean
  amplia_garantias: boolean
  comercial: string | null
  comercial_conocido: boolean
  remitente: string
  fecha_correo: string
  adjunto: string
  confianza: Record<string, number>
}

const CAMPOS_CONTRATO = [
  "id_contrato", "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda", "valor_indeterminado",
  "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza", "es_otrosi", "amplia_garantias",
] as const

const CAMPOS_REVISION = [
  "id_contrato", "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda", "fecha_inicio", "fecha_fin",
  "requiere_poliza", "tipo_poliza",
] as const

// ---------- Rutas y E/S ----------

export function rutas(dir: string) {
  const fixtures = join(dir, "fixtures", "reto-02")
  const out = join(dir, "out")
  const sp = join(out, "sharepoint")
  return {
    fixtures, buzon: join(fixtures, "buzon"), maestroFx: join(fixtures, "maestro-contratos.csv"),
    comerciales: join(fixtures, "comerciales.json"), out, sp, maestro: join(sp, "maestro-contratos.csv"),
    historial: join(sp, "historial.jsonl"), procesados: join(out, "procesados.json"),
    log: join(out, "log.jsonl"), alertas: join(out, "alertas.md"),
  }
}

function asegurarDir(p: string) { mkdirSync(p, { recursive: true }) }

export function asegurarMaestro(dir: string): string {
  const r = rutas(dir)
  if (!existsSync(r.maestro)) {
    if (!existsSync(r.maestroFx)) throw new ErrorNegocio("No se encontró el maestro de contratos en fixtures/reto-02/.")
    asegurarDir(r.sp)
    copyFileSync(r.maestroFx, r.maestro)
  }
  return r.maestro
}

export function leerMaestro(dir: string): Fila[] {
  const filas = parseCsv(readFileSync(asegurarMaestro(dir), "utf8"))
  const encabezado = filas[0] ?? []
  return filas.slice(1).map((f) => {
    const fila = {} as Fila
    for (const c of COLUMNAS) fila[c] = f[encabezado.indexOf(c)] ?? ""
    return fila
  })
}

export function escribirMaestro(dir: string, filas: Fila[]) {
  const datos = [[...COLUMNAS] as string[], ...filas.map((f) => COLUMNAS.map((c) => f[c]))]
  writeFileSync(rutas(dir).maestro, toCsv(datos), "utf8")
}

type Procesado = { mensaje_id: string; accion: string; id_contrato: string | null; ts: string }

export function leerProcesados(dir: string): Procesado[] {
  const p = rutas(dir).procesados
  if (!existsSync(p)) return []
  try {
    const d: unknown = JSON.parse(readFileSync(p, "utf8"))
    return Array.isArray(d) ? (d as Procesado[]) : []
  } catch {
    return []
  }
}

function marcarProcesado(dir: string, mensaje_id: string, accion: string, id_contrato: string | null) {
  const lista = leerProcesados(dir).filter((x) => x.mensaje_id !== mensaje_id)
  lista.push({ mensaje_id, accion, id_contrato, ts: new Date().toISOString() })
  asegurarDir(rutas(dir).out)
  writeFileSync(rutas(dir).procesados, JSON.stringify(lista, null, 2), "utf8")
}

const ComercialSchema = z.array(z.object({ email: z.string(), nombre: z.string(), region: z.string().optional() }))

function leerComerciales(dir: string) {
  const p = rutas(dir).comerciales
  if (!existsSync(p)) return []
  const r = ComercialSchema.safeParse(JSON.parse(readFileSync(p, "utf8")))
  return r.success ? r.data : []
}

const CorreoSchema = z.object({
  id: z.string(), de: z.string(), para: z.string().optional(), asunto: z.string(),
  fecha: z.string(), cuerpo: z.string().default(""), adjuntos: z.array(z.string()).default([]),
})
export type Correo = z.infer<typeof CorreoSchema>

function idMensajeValido(id: string) {
  if (!/^[\w-]+$/.test(id)) throw new ErrorNegocio(`Identificador de mensaje inválido: "${id}".`)
}

export function leerCorreo(dir: string, id: string): Correo {
  idMensajeValido(id)
  const p = join(rutas(dir).buzon, id, "correo.json")
  if (!existsSync(p)) throw new ErrorNegocio(`No existe el mensaje "${id}" en el buzón.`)
  let datos: unknown
  try { datos = JSON.parse(readFileSync(p, "utf8")) } catch { throw new ErrorNegocio(`El correo "${id}" no es un JSON válido.`) }
  const r = CorreoSchema.safeParse(datos)
  if (!r.success) throw new ErrorNegocio(`El correo "${id}" tiene un formato inesperado.`)
  return r.data
}

export function listarIdsBuzon(dir: string): string[] {
  const b = rutas(dir).buzon
  if (!existsSync(b)) throw new ErrorNegocio("No existe la carpeta del buzón (fixtures/reto-02/buzon).")
  return readdirSync(b).filter((n) => statSync(join(b, n)).isDirectory()).sort()
}

function leerAdjunto(dir: string, id: string, nombre: string): string {
  const p = join(rutas(dir).buzon, id, basename(nombre))
  if (!existsSync(p)) return ""
  return readFileSync(p, "utf8")
}

export function esDocumentoContractual(texto: string): boolean {
  const primera = texto.split(/\r?\n/).find((l) => l.trim() !== "") ?? ""
  return /^(contrato|otrosi|convenio)\b/.test(sinTildes(primera.trim().toLowerCase()))
}

export type AdjuntoContrato = { nombre: string; texto: string }

/** Devuelve el adjunto contractual o el motivo de rechazo. */
export function buscarAdjuntoContrato(dir: string, correo: Correo): { adjunto: AdjuntoContrato | null; motivo?: string } {
  if (correo.adjuntos.length === 0) return { adjunto: null, motivo: "El correo no trae adjuntos." }
  for (const nombre of correo.adjuntos) {
    const texto = leerAdjunto(dir, correo.id, nombre)
    if (texto.trim() === "") continue
    if (esDocumentoContractual(texto)) return { adjunto: { nombre, texto } }
  }
  const nombres = correo.adjuntos.join(", ")
  const primera = (leerAdjunto(dir, correo.id, correo.adjuntos[0] ?? "").split(/\r?\n/).find((l) => l.trim() !== "") ?? "").trim()
  return { adjunto: null, motivo: `Ningún adjunto es un contrato u otrosí (adjuntos: ${nombres}${primera ? `; encabezado: "${primera}"` : ""}).` }
}

// ---------- Extracción determinista ----------

const MES_RE = Object.keys(MESES).join("|")
const FECHA_PAREN = new RegExp(`\\((\\d{1,2})\\)\\s+de\\s+(${MES_RE})\\s+de\\s+(\\d{4})`, "gi")
const FECHA_PLANA = new RegExp(`\\b(\\d{1,2})\\s+de\\s+(${MES_RE})\\s+de\\s+(\\d{4})`, "gi")
const MONEDA_RE = /\b([A-Z]{3})\s*\$?\s*(\d[\d.,]*)/g

function parrafos(texto: string): string[] {
  return texto.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p !== "")
}

function parrafoClausula(ps: string[], nombre: string): string | undefined {
  const inicio = new RegExp(`^[A-ZÁÉÍÓÚ]+\\.\\s*${nombre}\\b`, "i")
  const otrosi = new RegExp(`\\(${nombre}\\)`, "i")
  return ps.find((p) => inicio.test(p) || otrosi.test(p))
}

function fechasEn(texto: string): { iso: string; idx: number }[] {
  const resultado: { iso: string; idx: number }[] = []
  for (const re of [FECHA_PAREN, FECHA_PLANA]) {
    re.lastIndex = 0
    for (const m of texto.matchAll(re)) {
      resultado.push({ iso: fechaDesdeTexto(m[1] ?? "", m[2] ?? "", m[3] ?? ""), idx: m.index ?? 0 })
    }
    if (resultado.length > 0) break
  }
  return resultado.sort((a, b) => a.idx - b.idx)
}

function detectarPais(dominio: string, id: string): { pais: Contrato["pais"]; conf: number } {
  const t = sinTildes(dominio.toLowerCase())
  if (/ecuador|quito|guayaquil|cuenca/.test(t)) return { pais: "EC", conf: 0.95 }
  if (/peru|lima|arequipa|cusco/.test(t)) return { pais: "PE", conf: 0.95 }
  if (/panama/.test(t)) return { pais: "PA", conf: 0.95 }
  if (/honduras|tegucigalpa|san pedro sula/.test(t)) return { pais: "HN", conf: 0.95 }
  if (/colombia|bogota|medellin|barranquilla|cali\b|cartagena|bucaramanga/.test(t)) return { pais: "CO", conf: 0.95 }
  if (/^\d{13}$/.test(id) && id.endsWith("001")) return { pais: "EC", conf: 0.6 }
  if (/^\d{11}$/.test(id) && /^(10|15|17|20)/.test(id)) return { pais: "PE", conf: 0.6 }
  if (/^\d{14}$/.test(id)) return { pais: "HN", conf: 0.6 }
  if (/^\d{9,10}$/.test(id)) return { pais: "CO", conf: 0.6 }
  return { pais: null, conf: 0 }
}

const MONEDA_POR_PAIS: Record<string, (typeof MONEDAS)[number]> = { CO: "COP", EC: "USD", PE: "PEN", PA: "PAB", HN: "HNL" }

const TIPOS_POLIZA: [RegExp, string][] = [
  [/cumplimiento/, "cumplimiento"], [/calidad/, "calidad"], [/responsabilidad civil/, "responsabilidad_civil"],
  [/salarios/, "salarios_prestaciones"], [/anticipo/, "buen_manejo_anticipo"], [/seriedad/, "seriedad_oferta"],
]

function secuenciaAuto(dir: string, anio: string): number {
  const prefijo = `AUTO-${anio}-`
  const n = leerMaestro(dir).filter((f) => f.id_contrato.startsWith(prefijo)).length
  return n + 1
}

export function extraerContrato(dir: string, correo: Correo, adjunto: AdjuntoContrato): Contrato {
  const texto = adjunto.texto
  if (texto.trim() === "") throw new ErrorNegocio(`El adjunto "${adjunto.nombre}" está vacío.`)
  const ps = parrafos(texto)
  const conf: Record<string, number> = {}
  const fechaCorreo = parteFecha(correo.fecha)
  const esOtrosi = sinTildes(texto.trim().toLowerCase()).startsWith("otrosi")

  const comerciales = leerComerciales(dir)
  const com = comerciales.find((c) => c.email.toLowerCase() === correo.de.trim().toLowerCase())

  const c: Contrato = {
    id_contrato: null, cliente: null, nit_cliente: null, pais: null, objeto: null, valor: null, moneda: null,
    valor_indeterminado: false, fecha_inicio: null, fecha_fin: null, requiere_poliza: null, tipo_poliza: null,
    es_otrosi: esOtrosi, amplia_garantias: false, comercial: com?.nombre ?? null, comercial_conocido: com !== undefined,
    remitente: correo.de, fecha_correo: fechaCorreo, adjunto: adjunto.nombre, confianza: conf,
  }
  for (const k of CAMPOS_REVISION) conf[k] = 0
  conf["comercial"] = com ? 0.95 : 0

  // Identificador del contrato (primera línea; si no, cualquier parte del texto)
  const idRe = /\bNo\.?\s*([A-Z0-9]+(?:-[A-Z0-9]+)+)/
  const primeraLinea = texto.split(/\r?\n/).find((l) => l.trim() !== "") ?? ""
  const idMatch = idRe.exec(primeraLinea) ?? idRe.exec(texto)

  // Contraparte: el identificador de EL CONTRATANTE, nunca el de Periferia
  const idsRe = /\b(NIT|RUC|RTN|RUT)\s*(?:No\.?\s*)?(\d[\d.\-]*\d)/gi
  const ids = [...texto.matchAll(idsRe)]
    .map((m) => ({ idx: m.index ?? 0, fin: (m.index ?? 0) + m[0].length, norm: normalizarNit(m[2] ?? "") }))
    .filter((m) => m.norm !== NIT_PERIFERIA)
  const esContratante = (m: { fin: number }) => {
    const cola = texto.slice(m.fin, m.fin + 400)
    const a = cola.search(/CONTRATANTE/)
    const b = cola.search(/CONTRATISTA/)
    return a >= 0 && (b < 0 || a < b)
  }
  const elegido = ids.find(esContratante) ?? ids[0]
  let dominio = ""
  if (elegido) {
    c.nit_cliente = elegido.norm
    conf["nit_cliente"] = esContratante(elegido) ? 0.95 : 0.6
    const cola = texto.slice(elegido.fin, elegido.fin + 300)
    dominio = cola.split(/representad/i)[0] ?? cola
    const antes = texto.slice(Math.max(0, elegido.idx - 300), elegido.idx)
    const nombre = /(?:Entre(?:\s+los\s+suscritos,)?)\s+([^,]+?),\s*(?:identificad[ao]\s+con\s+)?$/i.exec(antes)
    if (nombre?.[1]) {
      c.cliente = razonSocial(nombre[1])
      conf["cliente"] = 0.95
    }
    const p = detectarPais(dominio, elegido.norm)
    c.pais = p.pais
    conf["pais"] = p.conf
  }

  // Id
  if (idMatch?.[1]) {
    c.id_contrato = idMatch[1]
    conf["id_contrato"] = 0.95
  }

  // Objeto
  if (!esOtrosi) {
    const o = ps.map((p) => /^[A-ZÁÉÍÓÚ]+\.\s*OBJETO\.\s*([\s\S]+)$/i.exec(p)).find((m) => m !== null)
    if (o?.[1]) {
      c.objeto = o[1].replace(/\s+/g, " ").trim().slice(0, 200)
      conf["objeto"] = 0.95
    }
  }

  // Valor y moneda
  const pv = parrafoClausula(ps, "VALOR")
  if (pv) {
    let hallado = false
    for (const m of pv.matchAll(MONEDA_RE)) {
      const codigo = m[1] ?? ""
      if (!(MONEDAS as readonly string[]).includes(codigo)) {
        throw new ErrorNegocio(`Moneda desconocida en el contrato: "${codigo}". Monedas válidas: ${MONEDAS.join(", ")}.`)
      }
      c.moneda = codigo as Contrato["moneda"]
      c.valor = parseNumero(m[2] ?? "", codigo)
      conf["moneda"] = 0.95
      conf["valor"] = 0.95
      hallado = true
      break
    }
    if (!hallado && /no tiene un valor determinado|valor indeterminado|por demanda|cuant[ií]a indeterminada|valor no determinado/i.test(pv)) {
      c.valor = 0
      c.valor_indeterminado = true
      conf["valor"] = 0.6
    }
  }
  if (c.moneda === null && (c.valor !== null || c.valor_indeterminado)) {
    const otra = [...texto.matchAll(MONEDA_RE)].map((m) => m[1] ?? "").find((k) => (MONEDAS as readonly string[]).includes(k))
    if (otra) { c.moneda = otra as Contrato["moneda"]; conf["moneda"] = 0.6 }
    else if (c.pais) { c.moneda = MONEDA_POR_PAIS[c.pais] ?? null; conf["moneda"] = 0.6 }
  }

  // Fechas
  const pp = parrafoClausula(ps, "PLAZO")
  const fechas = pp ? fechasEn(pp) : []
  const mm = pp ? /\((\d{1,3})\)\s+(mes(?:es)?|a[ñn]os?)\b/i.exec(pp) : null
  const meses = mm ? Number(mm[1]) * (/^a/i.test(mm[2] ?? "") ? 12 : 1) : null
  if (esOtrosi) {
    const f = fechas[fechas.length - 1]
    if (f) { c.fecha_fin = f.iso; conf["fecha_fin"] = 0.95 }
  } else if (fechas.length >= 2) {
    c.fecha_inicio = fechas[0]?.iso ?? null
    c.fecha_fin = fechas[1]?.iso ?? null
    conf["fecha_inicio"] = 0.95
    conf["fecha_fin"] = 0.95
  } else if (fechas.length === 1 && pp) {
    const f = fechas[0]
    if (f && /hasta/i.test(pp.slice(0, f.idx))) { c.fecha_fin = f.iso; conf["fecha_fin"] = 0.95 }
    else if (f) { c.fecha_inicio = f.iso; conf["fecha_inicio"] = 0.95 }
  }
  if (!esOtrosi) {
    if (c.fecha_inicio === null && meses !== null) {
      const firmaDia = new RegExp(`a los\\s+[^.]*?\\((\\d{1,2})\\)\\s+d[ií]as\\s+del\\s+mes\\s+de\\s+(${MES_RE})\\s+de\\s+(\\d{4})`, "i").exec(texto)
      if (firmaDia) {
        c.fecha_inicio = fechaDesdeTexto(firmaDia[1] ?? "", firmaDia[2] ?? "", firmaDia[3] ?? "")
        conf["fecha_inicio"] = 0.6
      } else {
        // Firma sin día ("en el mes de agosto de 2026"): la única referencia con día es la fecha del correo.
        c.fecha_inicio = fechaCorreo
        conf["fecha_inicio"] = 0.5
      }
    }
    if (c.fecha_fin === null && c.fecha_inicio !== null && meses !== null) {
      c.fecha_fin = sumarMeses(c.fecha_inicio, meses)
      conf["fecha_fin"] = 0.6
    }
  }

  // Póliza
  if (esOtrosi) {
    c.amplia_garantias = /deber[áa]n?\s+ampliarse|ampliaci[óo]n de (?:las )?garant[íi]as/i.test(texto)
  } else {
    const clausula = ps.find((p) => /^[A-ZÁÉÍÓÚ]+\.\s*GARANT[ÍI]AS/i.test(p) || /constituir[áa][^.]*p[óo]liza/i.test(p))
    if (clausula) {
      c.requiere_poliza = true
      const condicional = /cuyo valor|superen?\b|en caso de|siempre que|cuando\b|[óo]rdenes? de servicio/i.test(clausula)
      conf["requiere_poliza"] = condicional ? 0.6 : 0.95
      const t = sinTildes(clausula.toLowerCase())
      const tipos = TIPOS_POLIZA.filter(([re]) => re.test(t)).map(([, n]) => n)
      if (tipos.length > 0) { c.tipo_poliza = tipos.join(";"); conf["tipo_poliza"] = condicional ? 0.6 : 0.95 }
    } else {
      c.requiere_poliza = false
      conf["requiere_poliza"] = 0.9
    }
  }

  // Id automático si el documento no lo trae
  if (c.id_contrato === null && !esOtrosi) {
    const anio = (c.fecha_inicio ?? fechaCorreo).slice(0, 4)
    c.id_contrato = `AUTO-${anio}-${String(secuenciaAuto(dir, anio)).padStart(3, "0")}`
    conf["id_contrato"] = 0.6
  }
  return c
}

// ---------- Validación ----------

export type Diferencia = { antes: string | number | boolean | null; despues: string | number | boolean | null }
export type Clasificacion = "nuevo" | "actualizacion" | "duplicado" | "rechazado"

export type Validacion = {
  clasificacion: Clasificacion
  id_contrato_existente?: string
  requiere_revision: string[]
  diferencias?: Record<string, Diferencia>
  motivo?: string
  advertencias: string[]
  comercial: string | null
  comercial_conocido: boolean
}

function fusionar(base: Contrato, entrada?: ContratoEntrada): Contrato {
  if (!entrada) return base
  const r: Record<string, unknown> = { ...base }
  for (const k of CAMPOS_CONTRATO) {
    const v = entrada[k]
    if (v !== undefined) r[k] = v
  }
  r["confianza"] = { ...base.confianza, ...(entrada.confianza ?? {}) }
  return r as unknown as Contrato
}

function validarFormatoFechas(c: Contrato) {
  for (const k of ["fecha_inicio", "fecha_fin"] as const) {
    const v = c[k]
    if (v !== null && !esFechaIso(v)) throw new ErrorNegocio(`Fecha inválida en ${k}: "${v}". Use el formato YYYY-MM-DD.`)
  }
}

const CAMPOS_COMPARABLES = ["valor", "moneda", "fecha_inicio", "fecha_fin"] as const

function camposEnRevision(c: Contrato): string[] {
  const r: string[] = []
  for (const k of CAMPOS_REVISION) {
    if (k === "tipo_poliza" && c.requiere_poliza !== true) continue
    const v = c[k]
    const cf = c.confianza[k] ?? 0
    if (c.es_otrosi && (v === null || v === undefined)) continue
    if (cf < UMBRAL_CONFIANZA) r.push(k)
  }
  return r
}

export type ResultadoValidacion = { validacion: Validacion; contrato: Contrato | null; existente?: Fila; correo: Correo; adjunto: AdjuntoContrato | null }

export function validarMensaje(dir: string, mensajeId: string, entrada?: ContratoEntrada): ResultadoValidacion {
  const correo = leerCorreo(dir, mensajeId)
  const { adjunto, motivo } = buscarAdjuntoContrato(dir, correo)
  const base: Validacion = { clasificacion: "rechazado", requiere_revision: [], advertencias: [], comercial: null, comercial_conocido: false }
  if (!adjunto) return { validacion: { ...base, motivo }, contrato: null, correo, adjunto: null }

  const c = fusionar(extraerContrato(dir, correo, adjunto), entrada)
  validarFormatoFechas(c)
  base.comercial = c.comercial
  base.comercial_conocido = c.comercial_conocido
  if (!c.comercial_conocido) base.advertencias.push(`Remitente no registrado en comerciales.json: ${correo.de}. No bloquea el registro.`)
  if (!c.cliente && !c.objeto) {
    return { validacion: { ...base, motivo: "El texto no contiene partes ni objeto identificables." }, contrato: c, correo, adjunto }
  }

  const maestro = leerMaestro(dir)
  const porId = c.id_contrato ? maestro.find((f) => f.id_contrato.toLowerCase() === c.id_contrato?.toLowerCase()) : undefined
  const porSimilitud = porId || !c.nit_cliente || !c.objeto
    ? undefined
    : maestro.find((f) => f.nit_cliente === c.nit_cliente && jaccard(f.objeto, c.objeto ?? "") >= UMBRAL_JACCARD)
  const existente = porId ?? porSimilitud
  const revision = camposEnRevision(c)

  const mismoNit = maestro.filter((f) => f.nit_cliente === c.nit_cliente && f !== existente)
  if (!existente && mismoNit.length > 0) {
    base.advertencias.push(`El NIT ${c.nit_cliente} ya existe en el maestro (${mismoNit.map((f) => f.id_contrato).join(", ")}) con otro id u objeto: se trata como contrato distinto.`)
  }

  if (!existente) {
    if (c.es_otrosi) revision.push("contrato_referencia")
    return { validacion: { ...base, clasificacion: "nuevo", requiere_revision: revision }, contrato: c, correo, adjunto }
  }

  if (c.nit_cliente && existente.nit_cliente !== c.nit_cliente) revision.push("nit_cliente")
  const dif: Record<string, Diferencia> = {}
  for (const k of CAMPOS_COMPARABLES) {
    const nuevo = c[k]
    if (nuevo === null || nuevo === undefined) continue
    const antes = k === "valor" ? Number(existente[k]) : existente[k]
    if (antes !== nuevo) dif[k] = { antes, despues: nuevo }
  }
  if (c.es_otrosi && c.amplia_garantias && existente.estado_poliza !== "pendiente") {
    dif["estado_poliza"] = { antes: existente.estado_poliza, despues: "pendiente" }
  }
  const hayCambios = Object.keys(dif).length > 0
  const clasificacion: Clasificacion = c.es_otrosi || hayCambios ? "actualizacion" : "duplicado"
  const out: Validacion = {
    ...base, clasificacion, id_contrato_existente: existente.id_contrato, requiere_revision: [...new Set(revision)],
  }
  if (clasificacion === "actualizacion") out.diferencias = dif
  if (clasificacion === "duplicado") out.motivo = `Mismo ${existente.id_contrato} con mismos valor y fechas: no se escribe nada.`
  return { validacion: out, contrato: c, existente, correo, adjunto }
}

// ---------- Registro ----------

function ext(nombre: string): string {
  const e = nombre.includes(".") ? nombre.slice(nombre.lastIndexOf(".") + 1) : "txt"
  return e.toLowerCase()
}

function agregarHistorial(dir: string, linea: Record<string, unknown>) {
  asegurarDir(rutas(dir).sp)
  appendFileSync(rutas(dir).historial, JSON.stringify(linea) + "\n", "utf8")
}

function archivar(dir: string, ruta: string, texto: string) {
  const destino = join(rutas(dir).sp, ruta)
  asegurarDir(dirname(destino))
  writeFileSync(destino, texto, "utf8")
}

export type ResultadoRegistro = {
  id_contrato: string | null
  accion: "nuevo" | "actualizacion" | "duplicado" | "rechazado"
  ruta_archivo: string | null
  cambios?: Record<string, Diferencia>
  motivo?: string
}

export function registrarMensaje(dir: string, mensajeId: string, entrada: ContratoEntrada | undefined, confirmado: boolean): ResultadoRegistro {
  const { validacion: v, contrato: c, existente, correo, adjunto } = validarMensaje(dir, mensajeId, entrada)
  if (v.clasificacion === "rechazado") {
    marcarProcesado(dir, mensajeId, "rechazado", null)
    return { id_contrato: null, accion: "rechazado", ruta_archivo: null, motivo: v.motivo }
  }
  if (!c || !adjunto) throw new ErrorNegocio("No se pudo leer el contrato del mensaje.")
  if (v.clasificacion === "duplicado") {
    marcarProcesado(dir, mensajeId, "duplicado", existente?.id_contrato ?? c.id_contrato)
    return { id_contrato: existente?.id_contrato ?? c.id_contrato, accion: "duplicado", ruta_archivo: null, motivo: v.motivo }
  }
  if (v.requiere_revision.length > 0 && !confirmado) {
    throw new ErrorNegocio(`requiere revisión: ${v.requiere_revision.join(", ")}`)
  }

  const maestro = leerMaestro(dir)
  const ts = new Date().toISOString()

  if (v.clasificacion === "nuevo") {
    const faltan = (["id_contrato", "cliente", "nit_cliente", "pais", "valor", "moneda", "fecha_inicio", "fecha_fin"] as const).filter((k) => c[k] === null || c[k] === undefined)
    if (faltan.length > 0) throw new ErrorNegocio(`No se puede registrar: faltan datos obligatorios (${faltan.join(", ")}). Corríjalos en el contrato y confirme.`)
    const id = c.id_contrato as string
    const cliente = c.cliente as string
    const anio = (c.fecha_inicio as string).slice(0, 4)
    const ruta = `Contratos/${anio}/${slugCliente(cliente)}/${id}.${ext(adjunto.nombre)}`
    const fila: Fila = {
      id_contrato: id, cliente, nit_cliente: c.nit_cliente as string, pais: c.pais as string,
      objeto: c.objeto ?? "", valor: String(c.valor), moneda: c.moneda as string,
      fecha_inicio: c.fecha_inicio as string, fecha_fin: c.fecha_fin as string,
      requiere_poliza: String(c.requiere_poliza === true), tipo_poliza: c.requiere_poliza === true ? c.tipo_poliza ?? "" : "",
      estado_poliza: c.requiere_poliza === true ? "pendiente" : "no_aplica",
      comercial: c.comercial ?? correo.de, ruta_sharepoint: ruta, fecha_registro: parteFecha(correo.fecha), fuente: "buzon",
    }
    maestro.push(fila)
    escribirMaestro(dir, maestro)
    archivar(dir, ruta, adjunto.texto)
    agregarHistorial(dir, { ts, id_contrato: id, accion: "nuevo", cambios: {}, mensaje_id: mensajeId })
    marcarProcesado(dir, mensajeId, "nuevo", id)
    return { id_contrato: id, accion: "nuevo", ruta_archivo: `out/sharepoint/${ruta}` }
  }

  // actualizacion
  const ex = existente
  if (!ex) throw new ErrorNegocio("No se encontró la fila a actualizar en el maestro.")
  const cambios = v.diferencias ?? {}
  const fila = maestro.find((f) => f.id_contrato === ex.id_contrato)
  if (!fila) throw new ErrorNegocio("No se encontró la fila a actualizar en el maestro.")
  for (const [k, d] of Object.entries(cambios)) {
    if (k in fila) (fila as Record<string, string>)[k] = String(d.despues)
  }
  if (cambios["estado_poliza"]) fila.requiere_poliza = "true"
  const anio = fila.fecha_inicio.slice(0, 4)
  const carpeta = `Contratos/${anio}/${slugCliente(fila.cliente)}`
  let ruta: string
  if (c.es_otrosi) {
    ruta = `${carpeta}/${fila.id_contrato}-otrosi-${mensajeId}.${ext(adjunto.nombre)}`
  } else {
    ruta = `${carpeta}/${fila.id_contrato}.${ext(adjunto.nombre)}`
    fila.ruta_sharepoint = ruta
  }
  escribirMaestro(dir, maestro)
  archivar(dir, ruta, adjunto.texto)
  agregarHistorial(dir, { ts, id_contrato: fila.id_contrato, accion: "actualizacion", cambios, mensaje_id: mensajeId })
  marcarProcesado(dir, mensajeId, "actualizacion", fila.id_contrato)
  return { id_contrato: fila.id_contrato, accion: "actualizacion", ruta_archivo: `out/sharepoint/${ruta}`, cambios }
}

// ---------- Alertas ----------

export type ItemAlerta = {
  id_contrato: string; cliente: string; fecha_fin: string; dias_restantes: number
  requiere_poliza: boolean; estado_poliza: string; fecha_registro: string; comercial: string
}

export function generarAlertas(dir: string, hoy: string) {
  if (!esFechaIso(hoy)) throw new ErrorNegocio(`Fecha de referencia inválida: "${hoy}". Use YYYY-MM-DD.`)
  const filas = leerMaestro(dir)
  const item = (f: Fila): ItemAlerta => ({
    id_contrato: f.id_contrato, cliente: f.cliente, fecha_fin: f.fecha_fin, dias_restantes: diasEntre(hoy, f.fecha_fin),
    requiere_poliza: f.requiere_poliza === "true", estado_poliza: f.estado_poliza, fecha_registro: f.fecha_registro, comercial: f.comercial,
  })
  const porFin = (a: ItemAlerta, b: ItemAlerta) => a.fecha_fin.localeCompare(b.fecha_fin) || a.id_contrato.localeCompare(b.id_contrato)
  const todos = filas.map(item)
  const vencen = todos.filter((i) => i.dias_restantes >= 0 && i.dias_restantes <= DIAS_ALERTA).sort(porFin)
  const ya_vencidos = todos.filter((i) => i.dias_restantes < 0).sort(porFin)
  const polizas_pendientes = todos.filter((i) => i.requiere_poliza && i.estado_poliza !== "vigente").sort(porFin)
  const registrados_desde_corte = todos
    .filter((i) => i.fecha_registro >= FECHA_CORTE)
    .sort((a, b) => a.fecha_registro.localeCompare(b.fecha_registro) || a.id_contrato.localeCompare(b.id_contrato))

  const tabla = (items: ItemAlerta[], cols: [string, (i: ItemAlerta) => string][]) =>
    items.length === 0
      ? "_Sin registros._\n"
      : [`| ${cols.map(([h]) => h).join(" | ")} |`, `|${cols.map(() => "---").join("|")}|`, ...items.map((i) => `| ${cols.map(([, f]) => f(i)).join(" | ")} |`)].join("\n") + "\n"
  const base: [string, (i: ItemAlerta) => string][] = [["Contrato", (i) => i.id_contrato], ["Cliente", (i) => i.cliente]]
  const md = [
    `# Alertas de contratos`,
    ``,
    `Fecha de referencia: ${hoy}`,
    ``,
    `## 1. Vencen en ${DIAS_ALERTA} días o menos`,
    tabla(vencen, [...base, ["Fecha fin", (i) => i.fecha_fin], ["Días", (i) => String(i.dias_restantes)]]),
    `## 2. Pólizas pendientes (requieren póliza y no está vigente)`,
    tabla(polizas_pendientes, [...base, ["Estado póliza", (i) => i.estado_poliza], ["Fecha fin", (i) => i.fecha_fin]]),
    `## 3. Registrados desde ${FECHA_CORTE} (gap cubierto)`,
    tabla(registrados_desde_corte, [...base, ["Fecha registro", (i) => i.fecha_registro], ["Comercial", (i) => i.comercial]]),
    `## 4. Ya vencidos (fecha fin anterior a la referencia)`,
    tabla(ya_vencidos, [...base, ["Fecha fin", (i) => i.fecha_fin], ["Días de vencido", (i) => String(-i.dias_restantes)]]),
  ].join("\n")
  asegurarDir(rutas(dir).out)
  writeFileSync(rutas(dir).alertas, md, "utf8")
  return { ruta: "out/alertas.md", hoy, vencen, polizas_pendientes, registrados_desde_corte, ya_vencidos }
}

// ---------- Log ----------

export function registrarLog(ctx: Ctx, herramienta: string, mensajeId: string | null, ok: boolean, resumen: string) {
  try {
    asegurarDir(rutas(ctx.directory).out)
    const linea = { ts: new Date().toISOString(), sessionId: ctx.sessionId, herramienta, mensaje_id: mensajeId, ok, resumen }
    appendFileSync(rutas(ctx.directory).log, JSON.stringify(linea) + "\n", "utf8")
  } catch {
    // el log nunca debe romper la herramienta
  }
}

export async function ejecutar(
  nombre: string, ctx: Ctx, mensajeId: string | null, fn: () => { data: unknown; resumen: string },
): Promise<string> {
  try {
    const r = fn()
    registrarLog(ctx, nombre, mensajeId, true, r.resumen)
    return JSON.stringify({ ok: true, data: r.data })
  } catch (e) {
    const error = e instanceof ErrorNegocio ? e.message : `No se pudo completar la operación: ${e instanceof Error ? e.message : "error desconocido"}`
    registrarLog(ctx, nombre, mensajeId, false, error)
    return JSON.stringify({ ok: false, error })
  }
}
