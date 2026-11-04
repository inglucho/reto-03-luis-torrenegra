import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { AprobacionArchivo } from "./tipos";

/**
 * HU-4: evidencia de aprobación. El texto es determinista (solo depende del correo),
 * así que su sha256 se puede calcular al armar el payload antes de escribir el archivo.
 */
export function textoEvidencia(caso: string, a: AprobacionArchivo): string {
  return [
    "EVIDENCIA DE APROBACIÓN DE COMPRA",
    `Caso: ${caso}`,
    "",
    `De: ${a.de}`,
    `Para: ${a.para}`,
    `Fecha: ${a.fecha}`,
    `Asunto: ${a.asunto}`,
    "",
    a.cuerpo,
    "",
  ].join("\n");
}

export function sha256(texto: string): string {
  return new Bun.CryptoHasher("sha256").update(texto).digest("hex");
}

/** Escribe `aprobacion.txt` (P0) y `aprobacion.pdf` (P1) en `out/<caso>/`. */
export async function generarEvidencia(dir: string, caso: string, a: AprobacionArchivo) {
  const texto = textoEvidencia(caso, a);
  const hash = sha256(texto);
  const carpeta = join(dir, "out", caso);
  await mkdir(carpeta, { recursive: true });

  const rutaTxt = join(carpeta, "aprobacion.txt");
  await Bun.write(rutaTxt, `${texto}\nsha256 del contenido: ${hash}\n`);

  const rutaPdf = join(carpeta, "aprobacion.pdf");
  await Bun.write(rutaPdf, await pdfEvidencia(texto, hash));

  return { ruta: join("out", caso, "aprobacion.txt"), ruta_pdf: join("out", caso, "aprobacion.pdf"), sha256: hash };
}

async function pdfEvidencia(texto: string, hash: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  // Fecha fija: así el PDF de un mismo correo es idéntico entre ejecuciones (determinismo).
  pdf.setCreationDate(new Date("2026-01-01T00:00:00Z"));
  pdf.setModificationDate(new Date("2026-01-01T00:00:00Z"));
  const fuente = await pdf.embedFont(StandardFonts.Helvetica);
  const pagina = pdf.addPage([595, 842]);
  let y = 800;
  for (const linea of [...envolver(texto, 90), "", `sha256 del contenido: ${hash}`]) {
    pagina.drawText(aWinAnsi(linea), { x: 50, y, size: 10, font: fuente });
    y -= 14;
  }
  return pdf.save();
}

function envolver(texto: string, ancho: number): string[] {
  return texto.split("\n").flatMap((linea) => {
    if (linea.length <= ancho) return [linea];
    const partes: string[] = [];
    for (let i = 0; i < linea.length; i += ancho) partes.push(linea.slice(i, i + ancho));
    return partes;
  });
}

/** Las fuentes estándar del PDF usan WinAnsi: tildes y ñ sí, otros símbolos se sustituyen. */
function aWinAnsi(linea: string): string {
  return linea.replace(/[^\x20-\x7E -ÿ]/g, "?");
}
