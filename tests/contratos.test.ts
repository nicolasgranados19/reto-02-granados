import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { alertas, extraer, leer_buzon, registrar, validar } from "../src/tools/contratos"

const raiz = join(import.meta.dir, "..")
const tmps: string[] = []
let dir = ""
let ctx = { directory: "", sessionId: "test" }

type Resp = { ok: boolean; data?: Record<string, unknown>; error?: string }
const j = (s: string) => JSON.parse(s) as Resp
const data = (r: Resp) => r.data as Record<string, unknown>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reto02-"))
  tmps.push(dir)
  cpSync(join(raiz, "fixtures"), join(dir, "fixtures"), { recursive: true })
  ctx = { directory: dir, sessionId: "test" }
})
afterAll(() => { for (const t of tmps) rmSync(t, { recursive: true, force: true }) })

const ext = async (id: string) => j(await extraer.execute({ mensaje_id: id }, ctx))
const val = async (id: string) => j(await validar.execute({ mensaje_id: id }, ctx))
const reg = async (id: string, extra: Record<string, unknown> = {}) => j(await registrar.execute({ mensaje_id: id, ...extra } as never, ctx))
const maestro = () => readFileSync(join(dir, "out/sharepoint/maestro-contratos.csv"), "utf8")

describe("leer_buzon", () => {
  test("lista 6 mensajes y marca la cotización sin contrato", async () => {
    const r = j(await leer_buzon.execute({}, ctx))
    const ms = data(r)["mensajes"] as { id: string; tiene_contrato: boolean; clasificacion?: string; motivo?: string }[]
    expect(ms.map((m) => m.id)).toEqual(["msg-001", "msg-002", "msg-003", "msg-004", "msg-005", "msg-006"])
    const m5 = ms.find((m) => m.id === "msg-005")
    expect(m5?.tiene_contrato).toBe(false)
    expect(m5?.clasificacion).toBe("rechazado")
    expect(m5?.motivo).toBeTruthy()
    expect(ms.filter((m) => m.tiene_contrato)).toHaveLength(5)
  })
  test("omite los ya procesados", async () => {
    await reg("msg-001")
    const ms = data(j(await leer_buzon.execute({}, ctx)))["mensajes"] as { id: string }[]
    expect(ms.map((m) => m.id)).not.toContain("msg-001")
  })
})

describe("extraer", () => {
  test("msg-001: solo el NIT del contratante, valor COP y fechas en texto", async () => {
    const d = data(await ext("msg-001"))
    expect(d["nit_cliente"]).toBe("890900111")
    expect(d["cliente"]).toBe("Industrias Delta S.A.S.")
    expect(d["id_contrato"]).toBe("CT-2026-015")
    expect(d["valor"]).toBe(265000000)
    expect(d["moneda"]).toBe("COP")
    expect(d["fecha_inicio"]).toBe("2026-08-01")
    expect(d["fecha_fin"]).toBe("2027-07-31")
    expect(d["requiere_poliza"]).toBe(true)
    expect(d["tipo_poliza"]).toBe("cumplimiento")
    expect(d["pais"]).toBe("CO")
    expect((d["confianza"] as Record<string, number>)["valor"]).toBe(0.95)
  })
  test("msg-002: USD con coma de miles, RUC ecuatoriano, sin póliza", async () => {
    const d = data(await ext("msg-002"))
    expect(d["valor"]).toBe(120000)
    expect(d["moneda"]).toBe("USD")
    expect(d["nit_cliente"]).toBe("1790012345001")
    expect(d["pais"]).toBe("EC")
    expect(d["requiere_poliza"]).toBe(false)
    expect(d["fecha_fin"]).toBe("2027-08-14")
  })
  test("msg-003: otrosí con fecha_fin y valor, amplía garantías", async () => {
    const d = data(await ext("msg-003"))
    expect(d["es_otrosi"]).toBe(true)
    expect(d["id_contrato"]).toBe("CT-2026-011")
    expect(d["fecha_fin"]).toBe("2027-11-01")
    expect(d["valor"]).toBe(520000)
    expect(d["moneda"]).toBe("PEN")
    expect(d["amplia_garantias"]).toBe(true)
    expect(d["fecha_inicio"]).toBeNull()
  })
  test("msg-006: valor por demanda, fechas derivadas con baja confianza, remitente desconocido", async () => {
    const d = data(await ext("msg-006"))
    const conf = d["confianza"] as Record<string, number>
    expect(d["valor"]).toBe(0)
    expect(d["valor_indeterminado"]).toBe(true)
    expect(d["fecha_inicio"]).toBe("2026-08-31")
    expect(conf["fecha_inicio"]).toBe(0.5)
    expect(d["fecha_fin"]).toBe("2027-08-31")
    expect(conf["fecha_fin"]).toBe(0.6)
    expect(d["requiere_poliza"]).toBe(true)
    expect(conf["requiere_poliza"]).toBeLessThan(0.8)
    expect(d["comercial"]).toBeNull()
    expect(d["comercial_conocido"]).toBe(false)
  })
  test("msg-005: sin contrato devuelve error legible", async () => {
    const r = await ext("msg-005")
    expect(r.ok).toBe(false)
    expect(r.error).toContain("no contiene un contrato")
  })
  test("mensaje inexistente o id inválido no lanza", async () => {
    expect((await ext("msg-999")).ok).toBe(false)
    expect((await ext("../etc")).ok).toBe(false)
  })
  test("texto vacío y moneda desconocida devuelven ok:false", async () => {
    const base = join(dir, "fixtures/reto-02/buzon")
    mkdirSync(join(base, "msg-100"))
    writeFileSync(join(base, "msg-100/correo.json"), JSON.stringify({ id: "msg-100", de: "x@y.com", asunto: "a", fecha: "2026-09-01T10:00:00-05:00", cuerpo: "", adjuntos: ["c.txt"] }))
    writeFileSync(join(base, "msg-100/c.txt"), "   ")
    const vacio = await ext("msg-100")
    expect(vacio.ok).toBe(false)
    writeFileSync(join(base, "msg-100/c.txt"), "CONTRATO No. X-1\n\nEntre A S.A.S., NIT 800.1-2, (EL CONTRATANTE)\n\nSEGUNDA. VALOR. El valor es XYZ 100.")
    const moneda = await ext("msg-100")
    expect(moneda.ok).toBe(false)
    expect(moneda.error).toContain("Moneda desconocida")
    writeFileSync(join(base, "msg-100/c.txt"), "CONTRATO No. X-1\n\nEntre A S.A.S., NIT 800.1-2, (EL CONTRATANTE)\n\nTERCERA. PLAZO. Desde el treinta y uno (31) de febrero de 2026 hasta el (1) de marzo de 2027.")
    const fecha = await ext("msg-100")
    expect(fecha.ok).toBe(false)
    expect(fecha.error).toContain("Fecha inválida")
  })
})

describe("validar", () => {
  test("msg-001 y msg-002 comparten NIT con contratos existentes pero son nuevos", async () => {
    for (const id of ["msg-001", "msg-002"]) {
      const d = data(await val(id))
      expect(d["clasificacion"]).toBe("nuevo")
      expect(d["requiere_revision"]).toEqual([])
      expect((d["advertencias"] as string[]).join(" ")).toContain("NIT")
    }
  })
  test("msg-003 es actualización de CT-2026-011 con diferencias y estado de póliza", async () => {
    const d = data(await val("msg-003"))
    expect(d["clasificacion"]).toBe("actualizacion")
    expect(d["id_contrato_existente"]).toBe("CT-2026-011")
    const dif = d["diferencias"] as Record<string, { antes: unknown; despues: unknown }>
    expect(dif["fecha_fin"]).toEqual({ antes: "2027-05-01", despues: "2027-11-01" })
    expect(dif["valor"]).toEqual({ antes: 350000, despues: 520000 })
    expect(dif["estado_poliza"]?.despues).toBe("pendiente")
    expect(d["requiere_revision"]).toEqual([])
  })
  test("msg-004 es duplicado", async () => {
    const d = data(await val("msg-004"))
    expect(d["clasificacion"]).toBe("duplicado")
    expect(d["id_contrato_existente"]).toBe("CT-2026-012")
  })
  test("msg-005 es rechazado con motivo", async () => {
    const d = data(await val("msg-005"))
    expect(d["clasificacion"]).toBe("rechazado")
    expect(d["motivo"]).toBeTruthy()
  })
  test("msg-006 es nuevo con revisión de valor y fecha_fin y remitente reportado", async () => {
    const d = data(await val("msg-006"))
    expect(d["clasificacion"]).toBe("nuevo")
    const rev = d["requiere_revision"] as string[]
    expect(rev).toContain("valor")
    expect(rev).toContain("fecha_fin")
    expect(d["comercial_conocido"]).toBe(false)
    expect((d["advertencias"] as string[]).join(" ")).toContain("jperez@")
  })
  test("similitud de objeto >= 0.9 con el mismo NIT es actualización aunque cambie el id", async () => {
    const base = join(dir, "fixtures/reto-02/buzon")
    mkdirSync(join(base, "msg-101"))
    writeFileSync(join(base, "msg-101/correo.json"), JSON.stringify({ id: "msg-101", de: "lgomez@periferia-ficticia.com", asunto: "a", fecha: "2026-09-01T10:00:00-05:00", cuerpo: "", adjuntos: ["c.txt"] }))
    writeFileSync(join(base, "msg-101/c.txt"), [
      "CONTRATO No. CT-2026-099",
      "Entre INDUSTRIAS DELTA S.A.S., identificada con NIT 890.900.111-4, con domicilio en Bogotá, representada por X (EL CONTRATANTE), y PERIFERIA IT GROUP S.A.S., NIT 900.123.456-7 (EL CONTRATISTA)",
      "PRIMERA. OBJETO. Soporte y mantenimiento plataforma SAP",
      "SEGUNDA. VALOR. COP $500.000.000",
      "TERCERA. PLAZO. Desde el primero (1) de julio de 2026 hasta el treinta (30) de junio de 2027.",
    ].join("\n\n"))
    const d = data(await val("msg-101"))
    expect(d["clasificacion"]).toBe("actualizacion")
    expect(d["id_contrato_existente"]).toBe("CT-2025-018")
  })
})

describe("registrar", () => {
  test("msg-001 se registra, archiva, deja historial y marca procesado", async () => {
    const r = await reg("msg-001")
    expect(r.ok).toBe(true)
    expect(data(r)["accion"]).toBe("nuevo")
    expect(data(r)["ruta_archivo"]).toBe("out/sharepoint/Contratos/2026/industrias-delta/CT-2026-015.txt")
    expect(existsSync(join(dir, "out/sharepoint/Contratos/2026/industrias-delta/CT-2026-015.txt"))).toBe(true)
    expect(maestro()).toContain("CT-2026-015,Industrias Delta S.A.S.,890900111,CO")
    expect(maestro()).toContain(",pendiente,Laura Gómez Restrepo,Contratos/2026/industrias-delta/CT-2026-015.txt,2026-08-04,buzon")
    expect(readFileSync(join(dir, "out/sharepoint/historial.jsonl"), "utf8")).toContain('"mensaje_id":"msg-001"')
    expect(readFileSync(join(dir, "out/procesados.json"), "utf8")).toContain("msg-001")
  })
  test("msg-002 queda no_aplica", async () => {
    await reg("msg-002")
    expect(maestro()).toContain(",false,,no_aplica,Carlos Ruiz Medina,")
  })
  test("msg-003 modifica la fila, conserva el resto y escribe historial", async () => {
    const r = await reg("msg-003")
    expect(data(r)["accion"]).toBe("actualizacion")
    const fila = maestro().split("\n").find((l) => l.startsWith("CT-2026-011"))
    expect(fila).toBe("CT-2026-011,Minera Los Andes S.A.C.,20512345678,PE,Célula ágil de desarrollo para sistema de operaciones,520000,PEN,2026-05-02,2027-11-01,true,cumplimiento;responsabilidad_civil,pendiente,Carlos Ruiz Medina,Contratos/2026/minera-los-andes/CT-2026-011.pdf,2026-05-05,buzon")
    const h = JSON.parse(readFileSync(join(dir, "out/sharepoint/historial.jsonl"), "utf8").trim()) as { cambios: Record<string, unknown>; accion: string }
    expect(h.accion).toBe("actualizacion")
    expect(Object.keys(h.cambios).sort()).toEqual(["estado_poliza", "fecha_fin", "valor"])
    expect(maestro().split("\n").filter((l) => l.startsWith("CT-2026-011"))).toHaveLength(1)
  })
  test("msg-004 duplicado no escribe en el maestro ni en el historial", async () => {
    const antes = readFileSync(join(raiz, "fixtures/reto-02/maestro-contratos.csv"), "utf8")
    const r = await reg("msg-004")
    expect(data(r)["accion"]).toBe("duplicado")
    expect(maestro()).toBe(antes)
    expect(existsSync(join(dir, "out/sharepoint/historial.jsonl"))).toBe(false)
  })
  test("msg-005 rechazado no escribe y se marca procesado", async () => {
    const r = await reg("msg-005")
    expect(data(r)["accion"]).toBe("rechazado")
    expect(existsSync(join(dir, "out/sharepoint/historial.jsonl"))).toBe(false)
    expect(readFileSync(join(dir, "out/procesados.json"), "utf8")).toContain("msg-005")
  })
  test("msg-006 sin confirmar falla con 'requiere revisión' y no escribe", async () => {
    const r = await reg("msg-006")
    expect(r.ok).toBe(false)
    expect(r.error).toContain("requiere revisión:")
    expect(r.error).toContain("valor")
    expect(r.error).toContain("fecha_fin")
    expect(maestro()).not.toContain("CM-2026-03")
  })
  test("msg-006 con confirmado:true y valores confirmados queda registrado", async () => {
    const e = await ext("msg-006")
    const r = await reg("msg-006", { contrato: { ...data(e), valor: 0, fecha_fin: "2027-08-31" }, confirmado: true })
    expect(r.ok).toBe(true)
    expect(maestro()).toContain("CM-2026-03,Distribuidora Caribe S.A.S.,800222333,CO,")
    expect(maestro()).toContain(",0,COP,2026-08-31,2027-08-31,true,cumplimiento,pendiente,")
    expect(existsSync(join(dir, "out/sharepoint/Contratos/2026/distribuidora-caribe/CM-2026-03.txt"))).toBe(true)
  })
  test("registrar dos veces el mismo contrato no duplica la fila", async () => {
    await reg("msg-001")
    const r2 = await reg("msg-001")
    expect(data(r2)["accion"]).toBe("duplicado")
    expect(maestro().split("\n").filter((l) => l.startsWith("CT-2026-015"))).toHaveLength(1)
  })
  test("el fixture del maestro nunca se modifica", async () => {
    const antes = readFileSync(join(dir, "fixtures/reto-02/maestro-contratos.csv"), "utf8")
    await reg("msg-001")
    expect(readFileSync(join(dir, "fixtures/reto-02/maestro-contratos.csv"), "utf8")).toBe(antes)
  })
  test("deja out/log.jsonl con ts, herramienta, mensaje_id, ok y resumen", async () => {
    await reg("msg-001")
    await reg("msg-006")
    const lineas = readFileSync(join(dir, "out/log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lineas).toHaveLength(2)
    for (const l of lineas) for (const k of ["ts", "herramienta", "mensaje_id", "ok", "resumen"]) expect(k in l).toBe(true)
    expect(lineas[1]?.["ok"]).toBe(false)
  })
})

describe("alertas", () => {
  test("hoy=2026-09-03 sobre el maestro original", async () => {
    const r = j(await alertas.execute({ hoy: "2026-09-03" }, ctx))
    const ids = (k: string) => ((data(r)[k] ?? []) as { id_contrato: string }[]).map((i) => i.id_contrato)
    expect(ids("vencen")).toEqual(["CT-2026-009", "CT-2026-004"])
    expect(ids("ya_vencidos")).toEqual(["CT-2025-018", "CT-2026-002"])
    expect(ids("polizas_pendientes")).toEqual(["CT-2026-004"])
    expect(ids("registrados_desde_corte")).toEqual([])
    const md = readFileSync(join(dir, "out/alertas.md"), "utf8")
    expect(md).toContain("Ya vencidos")
    expect(data(r)["ruta"]).toBe("out/alertas.md")
  })
  test("tras registrar el lote incluye pólizas nuevas y registrados desde el corte", async () => {
    for (const id of ["msg-001", "msg-002", "msg-003"]) await reg(id)
    const r = j(await alertas.execute({ hoy: "2026-09-03" }, ctx))
    const ids = (k: string) => ((data(r)[k] ?? []) as { id_contrato: string }[]).map((i) => i.id_contrato)
    expect(ids("polizas_pendientes")).toEqual(["CT-2026-004", "CT-2026-015", "CT-2026-011"])
    expect(ids("registrados_desde_corte")).toEqual(["CT-2026-015", "CT-2026-016"])
  })
  test("fecha inválida devuelve ok:false", async () => {
    const r = j(await alertas.execute({ hoy: "03/09/2026" }, ctx))
    expect(r.ok).toBe(false)
    expect(r.error).toContain("inválida")
  })
})
