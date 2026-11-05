import { fileURLToPath } from "node:url";

function entero(nombre: string, porDefecto: number): number {
  const valor = Number(process.env[nombre]);
  return Number.isInteger(valor) && valor > 0 ? valor : porDefecto;
}

/** Configuración leída de variables de entorno (ver `.env.example`). Las claves nunca se leen aquí. */
export const config = {
  /** Raíz del proyecto: desde aquí se resuelven `agent/`, `fixtures/` y `out/`. */
  directorio: fileURLToPath(new URL("..", import.meta.url)),
  puerto: entero("PORT", 3000),
  proveedor: process.env.LLM_PROVIDER || "gemini",
  /** Si no se define, cada adaptador usa su modelo por defecto. */
  modelo: process.env.LLM_MODEL || undefined,
  timeoutMs: entero("LLM_TIMEOUT_MS", 120_000),
  maxIteraciones: entero("MAX_ITERACIONES", 25),
  maxTokensSesion: entero("MAX_TOKENS_SESION", 500_000),
  /** Tope diario de tokens para todo el servidor: el link es público. */
  maxTokensDia: entero("MAX_TOKENS_DIA", 3_000_000),
  /** Mensajes permitidos por IP en cada ventana de tiempo. */
  maxMensajesPorIp: entero("MAX_MENSAJES_POR_IP", 30),
  ventanaMinutos: entero("VENTANA_MINUTOS", 10),
  /**
   * Fecha de referencia del negocio (p. ej. para vigencias). Vacía = hoy. Los retos usan
   * 2026-09-03, la fecha de los PRD, para reproducir el escenario de la prueba.
   */
  fechaReferencia: /^\d{4}-\d{2}-\d{2}$/.test(process.env.FECHA_REFERENCIA ?? "")
    ? (process.env.FECHA_REFERENCIA as string)
    : new Date().toISOString().slice(0, 10),
};
