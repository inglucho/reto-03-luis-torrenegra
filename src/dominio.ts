import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { OpcionesBitacora } from "./core/bitacora";
import { registrar } from "./core/herramientas";
import * as oc from "./tools/oc";

/**
 * Único punto donde se conecta el dominio del reto: cada export de `src/tools/oc.ts`
 * se registra como `oc_<export>`. El prompt y el conocimiento son archivos.
 */
export const herramientas = registrar("oc", oc);

/** Las herramientas no escriben su propio log: el núcleo registra todas las llamadas (CA4). */
export const opcionesBitacora: OpcionesBitacora = {};

/** Cómo se presenta el agente en el chat: título, descripción y sugerencias para empezar. */
export const presentacion = {
  reto: "Reto 03",
  titulo: "Órdenes de Compra SAP",
  descripcion:
    "Lee cada solicitud de compra (solicitud, cotización, aprobación y factura), la valida contra los maestros con los controles RC1–RC10 y crea la orden de compra en SAP. Las excepciones las decides tú.",
  sugerencias: [
    { titulo: "Procesar una solicitud limpia", texto: 'Procesa la solicitud "sol-001" y créala si todo está en orden.' },
    { titulo: "Revisar antes de crear", texto: 'Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.' },
    { titulo: "Detectar una OC retroactiva", texto: 'Valida la solicitud "sol-005" y explícame por qué es retroactiva.' },
    { titulo: "Procesar todo", texto: "Procesa todas las solicitudes y dame un resumen por caso." },
  ],
};

/**
 * System prompt = comportamiento (`agent/prompt.md`) + conocimiento del proceso
 * (`src/knowledge/*.md`). Se mantienen en archivos separados, como pide el PRD.
 */
export async function cargarSistema(directorio: string): Promise<string> {
  const prompt = await Bun.file(join(directorio, "agent", "prompt.md")).text();
  const carpeta = join(directorio, "src", "knowledge");
  const archivos = (await readdir(carpeta)).filter((f) => f.endsWith(".md")).sort();
  const conocimiento = await Promise.all(archivos.map((f) => Bun.file(join(carpeta, f)).text()));
  return [prompt.trim(), "# Conocimiento del proceso", ...conocimiento.map((c) => c.trim())].join("\n\n");
}
