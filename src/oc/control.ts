import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/** HU-5: cada intento de creación deja una fila en `out/control.csv`, que consume Auditoría. */
export interface FilaControl {
  solicitud_id: string;
  resultado: "creada" | "existente" | "bloqueada" | "pendiente_confirmacion" | "error";
  numero_oc: string | null;
  retroactiva: boolean;
  bloqueos: string[];
  confirmaciones: string[];
}

const COLUMNAS = ["solicitud_id", "resultado", "numero_oc", "retroactiva", "bloqueos", "confirmaciones", "ts"];

/** Escapa un valor según RFC 4180 (comillas si trae coma, comillas o salto de línea). */
function celda(valor: string): string {
  return /[",\n]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor;
}

export async function registrarControl(dir: string, fila: FilaControl): Promise<void> {
  const ruta = join(dir, "out", "control.csv");
  await mkdir(join(dir, "out"), { recursive: true });
  if (!(await Bun.file(ruta).exists())) await Bun.write(ruta, `${COLUMNAS.join(",")}\n`);
  const valores = [
    fila.solicitud_id,
    fila.resultado,
    fila.numero_oc ?? "",
    String(fila.retroactiva),
    fila.bloqueos.join("; "),
    fila.confirmaciones.join("; "),
    new Date().toISOString(),
  ];
  await appendFile(ruta, `${valores.map(celda).join(",")}\n`);
}
