/**
 * Eventos que el backend transmite por SSE al chat durante un turno.
 * Los importan tanto el servidor como el frontend.
 */
export type Evento =
  | { tipo: "texto"; delta: string }
  | { tipo: "llamada"; id: string; nombre: string; args: unknown }
  | { tipo: "resultado"; id: string; nombre: string; ok: boolean; resumen: string; resultado: unknown; pideConfirmacion: boolean }
  | { tipo: "error"; mensaje: string }
  | { tipo: "fin_turno"; necesitaConfirmacion: boolean; uso: UsoTurno };

export interface UsoTurno {
  llamadasModelo: number;
  tokensEntrada: number;
  tokensSalida: number;
  tokensCache: number;
  /** Tokens consumidos por la sesión completa, para el tope por sesión. */
  tokensSesion: number;
}
