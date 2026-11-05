/**
 * Verificación sin modelo de lenguaje (sección 6.6 del PRD): procesa los 6 casos
 * llamando directamente a las herramientas, muestra la idempotencia con sol-001 y una
 * confirmación explícita con sol-004. Compara cada caso con el resultado esperado y
 * sale con código 1 si algo no coincide.
 *
 *   bun install && bun run demo.ts
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./src/config";
import { leerResultado } from "./src/core/herramientas";
import type { Validacion } from "./src/oc/tipos";
import { crear, generar_evidencia, listar_solicitudes, validar } from "./src/tools/oc";

const ctx = { directory: config.directorio, sessionId: "demo" };

interface Esperado {
  apta: boolean;
  bloqueos: string[];
  confirmaciones: string[];
  retroactiva: boolean;
  /** Resultado del primer intento de creación, sin confirmar. */
  creacion: "creada" | "bloqueada" | "pendiente";
}

/** Resultados esperados según los objetivos O1–O4 del PRD. */
const ESPERADO: Record<string, Esperado> = {
  "sol-001": { apta: true, bloqueos: [], confirmaciones: [], retroactiva: false, creacion: "creada" },
  "sol-002": { apta: false, bloqueos: ["RC1"], confirmaciones: [], retroactiva: false, creacion: "bloqueada" },
  "sol-003": { apta: false, bloqueos: ["RC2"], confirmaciones: [], retroactiva: false, creacion: "bloqueada" },
  "sol-004": { apta: true, bloqueos: [], confirmaciones: ["RC5"], retroactiva: false, creacion: "pendiente" },
  "sol-005": { apta: true, bloqueos: [], confirmaciones: ["RC8"], retroactiva: true, creacion: "pendiente" },
  "sol-006": { apta: true, bloqueos: [], confirmaciones: ["RC6"], retroactiva: false, creacion: "pendiente" },
};

type Datos = Record<string, unknown>;
let fallos = 0;

function verificar(condicion: boolean, mensaje: string) {
  if (!condicion) {
    fallos++;
    console.log(`   ✘ ${mensaje}`);
  }
}

async function ejecutar(promesa: Promise<string>) {
  const r = leerResultado(await promesa);
  return { ...r, datos: (r.ok ? r.data : {}) as Datos };
}

const reglas = (lista: { regla: string }[]) => lista.map((h) => h.regla);
const iguales = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);

async function procesarCaso(caso: string) {
  const esperado = ESPERADO[caso];
  const v = await ejecutar(validar.execute({ caso }, ctx));
  if (!v.ok) {
    fallos++;
    console.log(`\n■ ${caso}  ✘ error al validar: ${v.error}`);
    return;
  }
  const val = v.datos as unknown as Validacion;
  console.log(`\n■ ${caso}`);
  console.log(`   apta: ${val.apta} · retroactiva: ${val.retroactiva}`);
  if (val.bloqueos.length === 0) console.log("   bloqueos: ninguno");
  for (const b of val.bloqueos) console.log(`   ⛔ ${b.regla}: ${b.detalle}\n      → ${b.accion_sugerida}`);
  if (val.confirmaciones.length === 0) console.log("   confirmaciones: ninguna");
  for (const c of val.confirmaciones) console.log(`   ⚠️  ${c.regla}: ${c.detalle}`);
  for (const [campo, d] of Object.entries(val.derivados)) console.log(`   ↳ derivado ${campo} = ${d?.valor} (${d?.fuente})`);

  const intento = await ejecutar(crear.execute({ caso }, ctx));
  const creacion = intento.ok ? "creada" : intento.confirmacion ? "pendiente" : "bloqueada";
  if (intento.ok) console.log(`   ✅ OC ${intento.datos.numero_oc} creada`);
  else if (intento.confirmacion) console.log(`   ⏸  OC no creada: requiere confirmación (${reglas(val.confirmaciones).join(", ")})`);
  else console.log(`   ⛔ OC no creada: ${reglas(val.bloqueos).join(", ")}`);

  if (!esperado) return verificar(false, `caso sin resultado esperado definido: ${caso}`);
  verificar(val.apta === esperado.apta, `apta: esperado ${esperado.apta}`);
  verificar(iguales(reglas(val.bloqueos), esperado.bloqueos), `bloqueos: esperado ${esperado.bloqueos.join(",") || "ninguno"}`);
  verificar(iguales(reglas(val.confirmaciones), esperado.confirmaciones), `confirmaciones: esperado ${esperado.confirmaciones.join(",") || "ninguna"}`);
  verificar(val.retroactiva === esperado.retroactiva, `retroactiva: esperado ${esperado.retroactiva}`);
  verificar(creacion === esperado.creacion, `creación: esperado ${esperado.creacion}, obtenido ${creacion}`);
}

async function idempotencia() {
  console.log("\n■ Idempotencia: sol-001 por segunda vez");
  const r = await ejecutar(crear.execute({ caso: "sol-001" }, ctx));
  console.log(`   → OC ${r.datos.numero_oc}, idempotente: ${r.datos.idempotente}`);
  verificar(r.ok && r.datos.idempotente === true && r.datos.numero_oc === "4500000001", "debe devolver la OC existente 4500000001");
}

async function confirmacionExplicita() {
  console.log("\n■ Confirmación explícita: sol-004 con confirmado = true");
  const r = await ejecutar(crear.execute({ caso: "sol-004", confirmado: true }, ctx));
  console.log(r.ok ? `   ✅ OC ${r.datos.numero_oc} creada tras confirmar · evidencia: ${r.datos.evidencia}` : `   ✘ ${r.error}`);
  verificar(r.ok && r.datos.numero_oc === "4500000002", "debe crear la OC 4500000002");
}

async function retroactivaConfirmada() {
  console.log("\n■ O4: sol-005 (retroactiva) con confirmado = true");
  const r = await ejecutar(crear.execute({ caso: "sol-005", confirmado: true }, ctx));
  const control = await Bun.file(join(config.directorio, "out", "control.csv")).text();
  const fila = control.split("\n").find((l) => l.startsWith("SOL-2026-005,creada"));
  console.log(r.ok ? `   ✅ OC ${r.datos.numero_oc} creada · en out/control.csv: ${fila?.split(",").slice(0, 4).join(",")}` : `   ✘ ${r.error}`);
  verificar(r.ok && r.datos.retroactiva === true && Boolean(fila?.includes(",true,")), "sol-005 debe quedar creada con retroactiva = true en control.csv");
}

async function evidencia() {
  const r = await ejecutar(generar_evidencia.execute({ caso: "sol-001" }, ctx));
  console.log(`\n■ Evidencia de sol-001: ${r.datos.ruta} y ${r.datos.ruta_pdf} · sha256 ${String(r.datos.sha256).slice(0, 16)}…`);
  verificar(r.ok, "debe generar la evidencia");
}

// Determinismo: cada ejecución parte de `out/` vacío.
await rm(join(config.directorio, "out"), { recursive: true, force: true });
console.log("Demo reto 03 · Órdenes de compra SAP (sin modelo de lenguaje)");

const listado = await ejecutar(listar_solicitudes.execute({}, ctx));
const casos = (listado.datos.casos as string[] | undefined) ?? [];
for (const caso of casos) await procesarCaso(caso);
await idempotencia();
await confirmacionExplicita();
await retroactivaConfirmada();
await evidencia();

console.log("\nArchivos generados: out/sap/ordenes.jsonl · out/control.csv · out/<caso>/trazabilidad.json · out/<caso>/aprobacion.{txt,pdf}");
console.log(fallos === 0 ? `\n✔ ${casos.length} casos con el resultado esperado` : `\n✘ ${fallos} verificaciones fallaron`);
process.exit(fallos === 0 ? 0 : 1);
