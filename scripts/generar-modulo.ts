/**
 * Genera `modulo/` (bonus 9.4 del PRD) desde las mismas fuentes que usa la aplicación:
 * el prompt (`agent/prompt.md`) y el conocimiento (`src/knowledge/ordenes-compra.md`).
 * Las herramientas no se copian: `modulo/tools/oc.ts` reexporta `src/tools/oc.ts`.
 *
 *   bun run modulo            # regenera los archivos
 *   bun run modulo --check    # falla si están desactualizados (lo usa el test)
 */
import { join } from "node:path";

const raiz = join(import.meta.dir, "..");

export async function contenidoModulo(): Promise<Record<string, string>> {
  const prompt = (await Bun.file(join(raiz, "agent", "prompt.md")).text()).trim();
  const conocimiento = (await Bun.file(join(raiz, "src", "knowledge", "ordenes-compra.md")).text()).trim();
  return {
    "modulo/agent.md": `---
description: Prepara, valida y crea órdenes de compra en SAP a partir del paquete de cada solicitud (solicitud, cotización, aprobación y factura), con confirmación humana de las excepciones.
mode: primary
permission:
  edit: deny
  bash: deny
---

${prompt}
`,
    "modulo/skill/ordenes-compra/SKILL.md": `---
name: ordenes-compra
description: Conocimiento del proceso de órdenes de compra de Periferia — controles RC1–RC10, OC retroactivas, numeración y datos de referencia de SAP. Úsalo al validar o crear una OC.
---

${conocimiento}
`,
    "modulo/tools/oc.ts": `/**
 * Las mismas herramientas que usa la aplicación (no es una copia): cada export es
 * \`{ description, args, execute(args, ctx) }\` y se registra como \`oc_<export>\`.
 * Se importan sin el servidor; \`ctx.directory\` debe apuntar a la raíz con \`fixtures/\`.
 */
export * from "../../src/tools/oc";
`,
  };
}

if (import.meta.main) {
  const verificar = process.argv.includes("--check");
  const desactualizados: string[] = [];
  for (const [ruta, contenido] of Object.entries(await contenidoModulo())) {
    const archivo = Bun.file(join(raiz, ruta));
    const actual = (await archivo.exists()) ? await archivo.text() : null;
    if (actual === contenido) continue;
    if (verificar) desactualizados.push(ruta);
    else await Bun.write(join(raiz, ruta), contenido);
  }
  if (desactualizados.length > 0) {
    console.error(`modulo/ desactualizado: ${desactualizados.join(", ")}. Ejecuta \`bun run modulo\`.`);
    process.exit(1);
  }
  console.log(verificar ? "modulo/ sincronizado" : "modulo/ generado");
}
