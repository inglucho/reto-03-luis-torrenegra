/**
 * Límites de costo para un link público (sección 8 del PRD: "un usuario no puede gastar tu
 * clave sin límite"). El tope por sesión no basta, porque cualquiera puede abrir sesiones
 * nuevas; por eso hay además un tope diario global de tokens y un límite de mensajes por IP.
 */

/** Tope diario de tokens para todo el servidor. Se reinicia al cambiar el día (UTC). */
export class PresupuestoDiario {
  private dia = "";
  private usados = 0;

  constructor(private readonly maxTokensDia: number) {}

  private sincronizar() {
    const hoy = new Date().toISOString().slice(0, 10);
    if (hoy !== this.dia) {
      this.dia = hoy;
      this.usados = 0;
    }
  }

  agotado(): boolean {
    this.sincronizar();
    return this.usados >= this.maxTokensDia;
  }

  consumir(tokens: number): void {
    this.sincronizar();
    this.usados += tokens;
  }
}

/** Límite de mensajes por clave (la IP del cliente) en una ventana de tiempo deslizante. */
export class LimitePorClave {
  private readonly registros = new Map<string, number[]>();

  constructor(
    private readonly maxMensajes: number,
    private readonly ventanaMs: number,
  ) {}

  /** Registra un intento y dice si está permitido. */
  permitir(clave: string): boolean {
    const ahora = Date.now();
    const recientes = (this.registros.get(clave) ?? []).filter((t) => ahora - t < this.ventanaMs);
    if (recientes.length >= this.maxMensajes) {
      this.registros.set(clave, recientes);
      return false;
    }
    recientes.push(ahora);
    this.registros.set(clave, recientes);
    if (this.registros.size > 10_000) this.purgar(ahora);
    return true;
  }

  private purgar(ahora: number) {
    for (const [clave, tiempos] of this.registros) {
      if (tiempos.every((t) => ahora - t >= this.ventanaMs)) this.registros.delete(clave);
    }
  }
}
