// Utilidades puras (sin disco) para el registro de contratos.

export class ErrorNegocio extends Error {}

export const MONEDAS = ["COP", "USD", "PEN", "PAB", "HNL"] as const
export type Moneda = (typeof MONEDAS)[number]

export const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
}

export function sinTildes(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "")
}

/** Convierte un número escrito según la convención de la moneda. COP: punto = miles, coma = decimal. Resto: coma = miles, punto = decimal. */
export function parseNumero(raw: string, moneda: string): number {
  const s = raw.trim().replace(/[.,]+$/, "")
  if (!/^\d[\d.,]*$/.test(s)) throw new ErrorNegocio(`Valor numérico ilegible: "${raw}".`)
  let limpio: string
  if (moneda === "COP") {
    if ((s.match(/,/g) ?? []).length > 1) throw new ErrorNegocio(`Valor numérico ambiguo: "${raw}".`)
    limpio = s.replace(/\./g, "").replace(",", ".")
  } else {
    if ((s.match(/\./g) ?? []).length > 1) throw new ErrorNegocio(`Valor numérico ambiguo: "${raw}".`)
    limpio = s.replace(/,/g, "")
  }
  const n = Number(limpio)
  if (!Number.isFinite(n)) throw new ErrorNegocio(`Valor numérico ilegible: "${raw}".`)
  return n
}

export function fechaIso(anio: number, mes: number, dia: number): string {
  const d = new Date(Date.UTC(anio, mes - 1, dia))
  if (d.getUTCFullYear() !== anio || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) {
    throw new ErrorNegocio(`Fecha inválida: ${dia}/${mes}/${anio}.`)
  }
  return d.toISOString().slice(0, 10)
}

/** Fecha en texto: día numérico (el de los paréntesis), mes en español y año. */
export function fechaDesdeTexto(dia: string, mes: string, anio: string): string {
  const m = MESES[sinTildes(mes.toLowerCase())]
  if (!m) throw new ErrorNegocio(`Mes desconocido en una fecha: "${mes}".`)
  return fechaIso(Number(anio), m, Number(dia))
}

export function esFechaIso(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  try {
    fechaIso(Number(s.slice(0, 4)), Number(s.slice(5, 7)), Number(s.slice(8, 10)))
    return true
  } catch {
    return false
  }
}

/** Parte YYYY-MM-DD local de un timestamp ISO (ignora la zona). */
export function parteFecha(ts: string): string {
  const f = ts.slice(0, 10)
  if (!esFechaIso(f)) throw new ErrorNegocio(`Fecha inválida: "${ts}".`)
  return f
}

export function sumarMeses(iso: string, meses: number): string {
  const y = Number(iso.slice(0, 4))
  const m = Number(iso.slice(5, 7)) - 1 + meses
  const anio = y + Math.floor(m / 12)
  const mes = ((m % 12) + 12) % 12
  const ultimo = new Date(Date.UTC(anio, mes + 1, 0)).getUTCDate()
  const dia = Math.min(Number(iso.slice(8, 10)), ultimo)
  return fechaIso(anio, mes + 1, dia)
}

export function diasEntre(desde: string, hasta: string): number {
  const t = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)))
  return Math.round((t(hasta) - t(desde)) / 86400000)
}

/** Identificador tributario sin puntos, espacios, guiones ni dígito de verificación. */
export function normalizarNit(raw: string): string {
  const sinPuntos = raw.trim().replace(/[.\s]/g, "")
  const sinDv = sinPuntos.replace(/^(\d{6,})-\d$/, "$1")
  return sinDv.replace(/-/g, "")
}

function tokens(s: string): Set<string> {
  return new Set(sinTildes(s.toLowerCase()).split(/[^a-z0-9]+/).filter((t) => t.length > 0))
}

export function jaccard(a: string, b: string): number {
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let comunes = 0
  for (const t of ta) if (tb.has(t)) comunes++
  return comunes / (ta.size + tb.size - comunes)
}

const SUFIJO_SOCIEDAD = /\s*\b(?:S\.\s*A\.\s*S\.?|S\.\s*A\.\s*C\.?|S\.\s*A\.?|S\.\s*de\s*R\.\s*L\.?|S\.\s*R\.\s*L\.?|LTDA\.?)\s*$/i

export function slugCliente(cliente: string): string {
  const base = cliente.replace(SUFIJO_SOCIEDAD, "")
  return sinTildes(base.toLowerCase()).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "sin-cliente"
}

const MINUSCULAS = new Set(["de", "del", "y", "e"])

/** "CORPORACIÓN ANDINA DE SERVICIOS S.A." -> "Corporación Andina de Servicios S.A." */
export function razonSocial(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((p, i) => {
      if (/^(?:[a-z]{1,2}\.)+$/i.test(p) || /^ltda\.?$/i.test(p)) return p.toUpperCase().replace(/^LTDA/, "Ltda")
      const l = p.toLowerCase()
      if (i > 0 && MINUSCULAS.has(l)) return l
      return l.charAt(0).toUpperCase() + l.slice(1)
    })
    .join(" ")
}

export function parseCsv(texto: string): string[][] {
  const filas: string[][] = []
  let fila: string[] = []
  let campo = ""
  let comillas = false
  const t = texto.replace(/^﻿/, "")
  for (let i = 0; i < t.length; i++) {
    const c = t.charAt(i)
    if (comillas) {
      if (c === '"' && t.charAt(i + 1) === '"') { campo += '"'; i++ }
      else if (c === '"') comillas = false
      else campo += c
    } else if (c === '"') comillas = true
    else if (c === ",") { fila.push(campo); campo = "" }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t.charAt(i + 1) === "\n") i++
      fila.push(campo); campo = ""
      filas.push(fila); fila = []
    } else campo += c
  }
  if (campo !== "" || fila.length > 0) { fila.push(campo); filas.push(fila) }
  return filas.filter((f) => !(f.length === 1 && f[0] === ""))
}

export function toCsv(filas: string[][]): string {
  const esc = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  return filas.map((f) => f.map(esc).join(",")).join("\n") + "\n"
}
