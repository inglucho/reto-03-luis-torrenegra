import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface EntradaBitacora {
  sessionId: string;
  herramienta: string;
  args: unknown;
  ok: boolean;
  resumen: string;
  /** `false` si la llamada no llegó a la herramienta (desconocida, argumentos inválidos, bloqueada o fuera del tope). */
  ejecutada: boolean;
}

export interface OpcionesBitacora {
  /**
   * Para dominios cuyas herramientas ya escriben su propia línea al ejecutarse (reto 02, RN7):
   * el núcleo solo registra las llamadas que no llegaron a la herramienta, así no hay duplicados.
   */
  soloNoEjecutadas?: boolean;
  /** `rn7`: `{ ts, herramienta, mensaje_id, ok, resumen }`. `completo`: además sesión y argumentos. */
  formato?: "completo" | "rn7";
}

/** Regla CA4: toda llamada a herramienta queda en `out/log.jsonl`. */
export class Bitacora {
  private readonly ruta: string;

  constructor(
    directorio: string,
    private readonly opciones: OpcionesBitacora = {},
  ) {
    this.ruta = join(directorio, "out", "log.jsonl");
  }

  async registrar(entrada: EntradaBitacora): Promise<void> {
    if (this.opciones.soloNoEjecutadas && entrada.ejecutada) return;
    const args = typeof entrada.args === "object" && entrada.args !== null ? (entrada.args as Record<string, unknown>) : {};
    const linea =
      this.opciones.formato === "rn7"
        ? { herramienta: entrada.herramienta, mensaje_id: typeof args.mensaje_id === "string" ? args.mensaje_id : null, ok: entrada.ok, resumen: entrada.resumen }
        : { sessionId: entrada.sessionId, herramienta: entrada.herramienta, args: entrada.args, ok: entrada.ok, resumen: entrada.resumen, ejecutada: entrada.ejecutada };
    try {
      await mkdir(dirname(this.ruta), { recursive: true });
      await appendFile(this.ruta, `${JSON.stringify({ ts: new Date().toISOString(), ...linea })}\n`);
    } catch (err) {
      // Que falle el log no debe tumbar el turno del agente.
      console.error("No se pudo escribir en out/log.jsonl:", err instanceof Error ? err.message : err);
    }
  }
}
