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
  proveedor: process.env.LLM_PROVIDER ?? "gemini",
  /** Si no se define, cada adaptador usa su modelo por defecto. */
  modelo: process.env.LLM_MODEL || undefined,
  timeoutMs: entero("LLM_TIMEOUT_MS", 120_000),
  maxIteraciones: entero("MAX_ITERACIONES", 25),
  maxTokensSesion: entero("MAX_TOKENS_SESION", 500_000),
};
