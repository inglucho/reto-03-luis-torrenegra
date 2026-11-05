/** Contenido de la guía de uso que muestra el chat. Cada reto define el suyo en `src/presentacion.ts`. */
export interface Presentacion {
  reto: string;
  titulo: string;
  descripcion: string;
  /** Texto de ejemplo en la caja de mensaje. */
  placeholder: string;
  /** Qué puede hacer el agente, en frases cortas. */
  queHace: string[];
  /** Instrucciones de ejemplo y lo que se puede esperar de cada una. */
  sugerencias: { titulo: string; texto: string; espera: string }[];
  /** Datos de prueba disponibles y su resultado esperado. */
  casos: { id: string; descripcion: string; resultado: string; tono: "ok" | "confirmar" | "bloqueo" | "info"; instruccion: string }[];
  /** Cuándo y cómo pide confirmación el agente. */
  confirmaciones: string;
  /** Dónde quedan los resultados. */
  resultados: { ruta: string; descripcion: string }[];
}
