import { describe, expect, test } from "bun:test"
import {
  ErrorNegocio, diasEntre, fechaDesdeTexto, jaccard, normalizarNit, parseCsv, parseNumero, razonSocial, slugCliente,
  sumarMeses, toCsv,
} from "../src/lib/parsers"

describe("parseNumero por moneda", () => {
  test("COP usa punto de miles", () => {
    expect(parseNumero("265.000.000", "COP")).toBe(265000000)
    expect(parseNumero("32.000.000,50", "COP")).toBe(32000000.5)
    expect(parseNumero("265.000.000.", "COP")).toBe(265000000)
  })
  test("USD y PEN usan coma de miles y punto decimal", () => {
    expect(parseNumero("120,000.00", "USD")).toBe(120000)
    expect(parseNumero("520,000.00", "PEN")).toBe(520000)
  })
  test("entradas ilegibles lanzan ErrorNegocio", () => {
    expect(() => parseNumero("abc", "COP")).toThrow(ErrorNegocio)
    expect(() => parseNumero("1.2.3", "USD")).toThrow(ErrorNegocio)
  })
})

describe("fechas", () => {
  test("día entre paréntesis y mes en español", () => {
    expect(fechaDesdeTexto("1", "agosto", "2026")).toBe("2026-08-01")
    expect(fechaDesdeTexto("31", "Julio", "2027")).toBe("2027-07-31")
  })
  test("fecha inexistente o mes desconocido", () => {
    expect(() => fechaDesdeTexto("31", "febrero", "2026")).toThrow(ErrorNegocio)
    expect(() => fechaDesdeTexto("1", "agostoo", "2026")).toThrow(ErrorNegocio)
  })
  test("sumarMeses conserva el día y recorta a fin de mes", () => {
    expect(sumarMeses("2026-08-31", 12)).toBe("2027-08-31")
    expect(sumarMeses("2026-01-31", 1)).toBe("2026-02-28")
  })
  test("diasEntre", () => {
    expect(diasEntre("2026-09-03", "2026-09-30")).toBe(27)
    expect(diasEntre("2026-09-03", "2026-07-09")).toBe(-56)
  })
})

describe("identificadores y nombres", () => {
  test("NIT sin puntos ni dígito de verificación", () => {
    expect(normalizarNit("890.900.111-4")).toBe("890900111")
    expect(normalizarNit("1790012345001")).toBe("1790012345001")
    expect(normalizarNit("0801-9995-123456")).toBe("08019995123456")
  })
  test("slug del cliente sin sufijo societario", () => {
    expect(slugCliente("Industrias Delta S.A.S.")).toBe("industrias-delta")
    expect(slugCliente("Logística del Istmo S.A.")).toBe("logistica-del-istmo")
    expect(slugCliente("Agroexport Sula S. de R.L.")).toBe("agroexport-sula")
  })
  test("razón social con formato legible", () => {
    expect(razonSocial("CORPORACIÓN ANDINA DE SERVICIOS S.A.")).toBe("Corporación Andina de Servicios S.A.")
    expect(razonSocial("MINERA LOS ANDES S.A.C.")).toBe("Minera Los Andes S.A.C.")
  })
})

describe("jaccard", () => {
  test("idéntico = 1, disjunto = 0, tildes y mayúsculas no cuentan", () => {
    expect(jaccard("Soporte de plataforma", "soporte DE plataforma")).toBe(1)
    expect(jaccard("Fábrica de software", "fabrica de software")).toBe(1)
    expect(jaccard("uno dos", "tres cuatro")).toBe(0)
  })
  test("objetos distintos con el mismo cliente quedan por debajo de 0.9", () => {
    expect(jaccard("Soporte y mantenimiento plataforma SAP", "ejecutar la implementación, parametrización y soporte de la plataforma CRM")).toBeLessThan(0.9)
  })
})

describe("csv", () => {
  test("ida y vuelta con comas y comillas", () => {
    const filas = [["a", "b,c", 'd"e'], ["1", "", "x"]]
    expect(parseCsv(toCsv(filas))).toEqual(filas)
  })
})
