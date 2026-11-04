import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface EntradaBitacora {
  sessionId: string;
  herramienta: string;
  args: unknown;
  ok: boolean;
  resumen: string;
}

/** Regla CA4: toda llamada a herramienta queda en `out/log.jsonl`. */
export class Bitacora {
  private readonly ruta: string;

  constructor(directorio: string) {
    this.ruta = join(directorio, "out", "log.jsonl");
  }

  async registrar(entrada: EntradaBitacora): Promise<void> {
    try {
      await mkdir(dirname(this.ruta), { recursive: true });
      await appendFile(this.ruta, `${JSON.stringify({ ts: new Date().toISOString(), ...entrada })}\n`);
    } catch (err) {
      // Que falle el log no debe tumbar el turno del agente.
      console.error("No se pudo escribir en out/log.jsonl:", err);
    }
  }
}
