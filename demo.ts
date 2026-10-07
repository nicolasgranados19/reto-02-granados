// Demo sin modelo ni claves: procesa el buzón llamando directamente a las herramientas.
import { rmSync } from "node:fs"
import { join } from "node:path"
import { alertas, extraer, leer_buzon, registrar, validar } from "./src/tools/contratos"

const directory = import.meta.dir
const ctx = { directory, sessionId: "demo" }
const HOY = "2026-09-03"

type Resp = { ok: boolean; data?: Record<string, unknown>; error?: string }
const llamar = async (s: Promise<string>): Promise<Resp> => JSON.parse(await s) as Resp
const lista = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : [])

rmSync(join(directory, "out"), { recursive: true, force: true })

const buzon = await llamar(leer_buzon.execute({}, ctx))
const mensajes = (buzon.data?.["mensajes"] ?? []) as { id: string; tiene_contrato: boolean }[]
console.log(`Buzón: ${mensajes.length} mensajes pendientes\n`)

const filas: string[][] = [["mensaje", "clasificación", "en revisión", "acción"]]
for (const m of mensajes) {
  const ex = await llamar(extraer.execute({ mensaje_id: m.id }, ctx))
  const va = await llamar(validar.execute({ mensaje_id: m.id, contrato: ex.ok ? (ex.data as never) : undefined }, ctx))
  const reg = await llamar(registrar.execute({ mensaje_id: m.id, contrato: ex.ok ? (ex.data as never) : undefined }, ctx))
  const rev = lista(va.data?.["requiere_revision"])
  const accion = reg.ok ? `${reg.data?.["accion"]} ${reg.data?.["id_contrato"] ?? ""}`.trim() : `NO registrado (${reg.error})`
  filas.push([m.id, String(va.data?.["clasificacion"] ?? va.error), rev.join(", ") || "-", accion])
  for (const adv of lista(va.data?.["advertencias"])) console.log(`  [${m.id}] aviso: ${adv}`)
}

const ancho = (i: number) => Math.max(...filas.map((f) => (f[i] ?? "").length))
for (const [n, f] of filas.entries()) {
  console.log(f.map((c, i) => c.padEnd(ancho(i))).join(" | ").trimEnd())
  if (n === 0) console.log(filas[0]?.map((_, i) => "-".repeat(ancho(i))).join("-+-"))
}

console.log("\nSegunda llamada msg-006 con confirmado:true (valor 0, fecha_fin 2027-08-31)")
const ex6 = await llamar(extraer.execute({ mensaje_id: "msg-006" }, ctx))
const confirmado = await llamar(
  registrar.execute({ mensaje_id: "msg-006", contrato: { ...(ex6.data as object), valor: 0, fecha_fin: "2027-08-31" } as never, confirmado: true }, ctx),
)
console.log(confirmado.ok ? `  -> ${confirmado.data?.["accion"]} ${confirmado.data?.["id_contrato"]} en ${confirmado.data?.["ruta_archivo"]}` : `  -> error: ${confirmado.error}`)

const al = await llamar(alertas.execute({ hoy: HOY }, ctx))
const ids = (k: string) => ((al.data?.[k] ?? []) as { id_contrato: string }[]).map((i) => i.id_contrato).join(", ") || "-"
console.log(`\nAlertas con hoy=${HOY} -> ${al.data?.["ruta"]}`)
console.log(`  vencen en <=60 días : ${ids("vencen")}`)
console.log(`  pólizas pendientes  : ${ids("polizas_pendientes")}`)
console.log(`  desde el corte      : ${ids("registrados_desde_corte")}`)
console.log(`  ya vencidos         : ${ids("ya_vencidos")}`)

const resto = await llamar(leer_buzon.execute({}, ctx))
console.log(`\nMensajes pendientes tras la corrida: ${((resto.data?.["mensajes"] ?? []) as unknown[]).length}`)
