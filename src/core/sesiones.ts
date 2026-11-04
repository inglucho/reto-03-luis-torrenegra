import type { Mensaje } from "../llm/adapter";

export interface Sesion {
  id: string;
  /** Historial que se envía al modelo. Solo crece: nunca se reescriben mensajes anteriores. */
  mensajes: Mensaje[];
  /** El último turno terminó con una pregunta de confirmación pendiente. */
  esperandoConfirmacion: boolean;
  tokensUsados: number;
}

interface Entrada {
  sesion: Sesion;
  ocupada: boolean;
  ultimoUso: number;
}

const TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Sesiones en memoria (el PRD lo permite). En producción irían en Redis o en archivo
 * para sobrevivir reinicios y escalar a varias instancias.
 */
export class AlmacenSesiones {
  private readonly entradas = new Map<string, Entrada>();

  obtener(id: string): Sesion | undefined {
    return this.entradas.get(id)?.sesion;
  }

  /** Reserva la sesión para un turno. Devuelve `null` si ya hay un turno en curso. */
  reservar(id: string): Sesion | null {
    this.purgarVencidas();
    let entrada = this.entradas.get(id);
    if (!entrada) {
      const sesion: Sesion = { id, mensajes: [], esperandoConfirmacion: false, tokensUsados: 0 };
      entrada = { sesion, ocupada: false, ultimoUso: Date.now() };
      this.entradas.set(id, entrada);
    }
    if (entrada.ocupada) return null;
    entrada.ocupada = true;
    entrada.ultimoUso = Date.now();
    return entrada.sesion;
  }

  liberar(id: string): void {
    const entrada = this.entradas.get(id);
    if (entrada) entrada.ocupada = false;
  }

  eliminar(id: string): void {
    this.entradas.delete(id);
  }

  private purgarVencidas(): void {
    const ahora = Date.now();
    for (const [id, e] of this.entradas) {
      if (!e.ocupada && ahora - e.ultimoUso > TTL_MS) this.entradas.delete(id);
    }
  }
}
