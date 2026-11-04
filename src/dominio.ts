import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { registrar } from "./core/herramientas";
import * as oc from "./tools/oc";

/**
 * Único punto donde se conecta el dominio del reto: cada export de `src/tools/oc.ts`
 * se registra como `oc_<export>`. El prompt y el conocimiento son archivos.
 */
export const herramientas = registrar("oc", oc);

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
