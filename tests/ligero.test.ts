import { describe, expect, test } from "bun:test"
import { cpSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { limpiarObjeto } from "../src/lib/contratos-core"
import { extraer, leer_buzon } from "../src/tools/contratos"

const dir = mkdtempSync(join(tmpdir(), "reto02-ligero-"))
cpSync(join(import.meta.dir, "..", "fixtures"), join(dir, "fixtures"), { recursive: true })
const ctx = { directory: dir, sessionId: "t" }

describe("objeto sin preámbulo", () => {
  test("quita 'se obliga a' y 'prestará'", () => {
    expect(limpiarObjeto("EL CONTRATISTA se obliga a ejecutar la implementación del CRM.")).toBe("Ejecutar la implementación del CRM.")
    expect(limpiarObjeto("EL CONTRATISTA prestará servicios de fábrica de software.")).toBe("Servicios de fábrica de software.")
    expect(limpiarObjeto("Establecer las condiciones generales bajo las cuales EL CONTRATISTA prestará servicios de soporte.")).toBe("Servicios de soporte.")
  })
  test("extraer deja el objeto sin 'EL CONTRATISTA'", async () => {
    for (const id of ["msg-001", "msg-002", "msg-004", "msg-006"]) {
      const d = JSON.parse(await extraer.execute({ mensaje_id: id }, ctx)).data
      expect(d.objeto).not.toMatch(/EL CONTRATISTA/i)
      expect(d.objeto).not.toMatch(/se obliga a|prestará/i)
    }
  })
})

describe("resultados livianos", () => {
  test("leer_buzon devuelve solo metadatos", async () => {
    const d = JSON.parse(await leer_buzon.execute({}, ctx)).data
    expect(d.mensajes.length).toBe(6)
    for (const m of d.mensajes) expect(Object.keys(m).every((k) => ["id", "de", "asunto", "fecha", "adjuntos", "tiene_contrato", "clasificacion", "motivo"].includes(k))).toBe(true)
    expect(JSON.stringify(d)).not.toContain("PRIMERA")
  })
  test("extraer trae campos, confianza y requiere_revision, sin texto fuente", async () => {
    const r = JSON.parse(await extraer.execute({ mensaje_id: "msg-006" }, ctx)).data
    expect(r.confianza).toBeDefined()
    expect(r.requiere_revision).toContain("valor")
    expect(r.requiere_revision).toContain("fecha_fin")
    expect(JSON.stringify(r)).not.toContain("SEGUNDA")
    expect(JSON.stringify(r).length).toBeLessThan(2500)
  })
})
