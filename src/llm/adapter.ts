/**
 * Interfaz neutral del proveedor de lenguaje. El ciclo del agente solo conoce estos
 * tipos; cada proveedor (Anthropic, OpenAI, …) los traduce a su propio formato.
 */

export interface LlamadaHerramienta {
  id: string;
  nombre: string;
  args: unknown;
}

export interface ResultadoHerramienta {
  id: string;
  nombre: string;
  /** Lo que devolvió `execute`: un JSON serializado `{ ok, data }` o `{ ok: false, error }`. */
  contenido: string;
  error: boolean;
}

export type Mensaje =
  | { rol: "usuario"; texto: string }
  | {
      rol: "asistente";
      texto: string;
      llamadas: LlamadaHerramienta[];
      /**
       * Respuesta original del proveedor. Algunos modelos exigen recibir de vuelta sus
       * bloques tal cual (p. ej. el razonamiento firmado de Claude); el adaptador la usa
       * si el mensaje salió de él mismo y la ignora en otro caso.
       */
      nativo?: { proveedor: string; contenido: unknown };
    }
  | {
      rol: "herramientas";
      resultados: ResultadoHerramienta[];
      /** Indicación del sistema que acompaña a los resultados (p. ej. tope alcanzado). */
      nota?: string;
    };

export interface HerramientaLLM {
  nombre: string;
  descripcion: string;
  /** JSON Schema de los argumentos. */
  esquema: Record<string, unknown>;
}

export interface Uso {
  entrada: number;
  salida: number;
  cacheLectura: number;
  cacheEscritura: number;
}

export interface RespuestaLLM {
  texto: string;
  llamadas: LlamadaHerramienta[];
  /** `herramientas`: pidió ejecutar llamadas · `limite`: se cortó por longitud · `rechazo`: declinó responder. */
  fin: "fin" | "herramientas" | "limite" | "rechazo";
  uso: Uso;
  nativo?: { proveedor: string; contenido: unknown };
}

export interface OpcionesEnvio {
  sistema: string;
  /** Recibe el texto a medida que el modelo lo genera. */
  onTexto?: (delta: string) => void;
}

export interface AdaptadorLLM {
  readonly proveedor: string;
  readonly modelo: string;
  enviar(mensajes: Mensaje[], herramientas: HerramientaLLM[], opciones: OpcionesEnvio): Promise<RespuestaLLM>;
}

/** Error del proveedor ya traducido a un mensaje que se puede mostrar al usuario. */
export class ErrorLLM extends Error {
  override name = "ErrorLLM";
}
