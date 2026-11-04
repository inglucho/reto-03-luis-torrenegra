import { ApiError, type Content, FinishReason, type FunctionCall, GoogleGenAI, type Part } from "@google/genai";
import { type AdaptadorLLM, ErrorLLM, type HerramientaLLM, type Mensaje, type RespuestaLLM } from "./adapter";

const PROVEEDOR = "gemini";
/** Modelo principal; se cambia con LLM_MODEL. */
export const MODELO_GEMINI = "gemini-3.5-flash";
/**
 * Respaldo, en orden, cuando el modelo anterior está saturado (503) o agotó su cuota gratuita (429).
 * En la capa gratuita cada modelo tiene su propia cuota, así que encadenarlos multiplica la capacidad.
 */
export const RESPALDO_GEMINI = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];
const REINTENTABLES = new Set([429, 503]);
/** Prefijo de los ids que genera el adaptador cuando Gemini no asigna uno a la llamada. */
const ID_LOCAL = "local-";

const RECHAZOS = new Set<FinishReason>([
  FinishReason.SAFETY,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.BLOCKLIST,
  FinishReason.SPII,
  FinishReason.RECITATION,
]);

export interface OpcionesGemini {
  modelo?: string;
  respaldo?: string[];
  apiKey?: string;
  timeoutMs?: number;
  maxTokens?: number;
  /** Solo para tests: reemplaza el `fetch` del SDK y así se prueba sin red ni clave. */
  fetch?: typeof fetch;
}

export class AdaptadorGemini implements AdaptadorLLM {
  readonly proveedor = PROVEEDOR;
  readonly modelo: string;
  private readonly respaldo: string[];
  private readonly cliente: GoogleGenAI;
  private readonly tieneClave: boolean;
  private readonly maxTokens: number;

  constructor(opciones: OpcionesGemini) {
    this.modelo = opciones.modelo ?? MODELO_GEMINI;
    this.respaldo = (opciones.respaldo ?? RESPALDO_GEMINI).filter((m) => m !== this.modelo);
    this.tieneClave = Boolean(opciones.apiKey);
    this.maxTokens = opciones.maxTokens ?? 16000;
    // La clave llega desde la variable de entorno; nunca se registra ni se devuelve en la API.
    this.cliente = new GoogleGenAI({
      apiKey: opciones.apiKey,
      httpOptions: { timeout: opciones.timeoutMs ?? 120_000, ...(opciones.fetch ? { fetch: opciones.fetch } : {}) },
    });
  }

  async enviar(
    mensajes: Mensaje[],
    herramientas: HerramientaLLM[],
    opciones: { sistema: string; onTexto?: (delta: string) => void },
  ): Promise<RespuestaLLM> {
    if (!this.tieneClave) {
      throw new ErrorLLM("El servidor no tiene configurada la clave del proveedor de IA (LLM_API_KEY).");
    }

    let ultimoError: unknown;
    for (const modelo of [this.modelo, ...this.respaldo]) {
      let emitioTexto = false;
      const onTexto = (delta: string) => {
        emitioTexto = true;
        opciones.onTexto?.(delta);
      };
      try {
        return await this.generar(modelo, mensajes, herramientas, { sistema: opciones.sistema, onTexto });
      } catch (err) {
        if (err instanceof ErrorLLM) throw err;
        // Se pasa al siguiente modelo solo ante saturación o cuota, y si aún no se mostró texto al usuario.
        if (emitioTexto || !(err instanceof ApiError) || !REINTENTABLES.has(err.status)) throw traducirError(err);
        console.warn(`Gemini ${modelo} respondió ${err.status}; se intenta con el modelo de respaldo.`);
        ultimoError = err;
      }
    }
    throw traducirError(ultimoError);
  }

  private async generar(
    modelo: string,
    mensajes: Mensaje[],
    herramientas: HerramientaLLM[],
    opciones: { sistema: string; onTexto: (delta: string) => void },
  ): Promise<RespuestaLLM> {
    // Se acumulan todas las partes tal como llegan: Gemini exige recibir de vuelta sus
    // firmas de razonamiento (`thoughtSignature`) en las mismas partes en que las envió.
    const partes: Part[] = [];
    let finalizacion: FinishReason | undefined;
    let bloqueado = false;
    let uso = { prompt: 0, cache: 0, salida: 0 };

    const stream = await this.cliente.models.generateContentStream({
      model: modelo,
      contents: mensajes.map(aContenido),
      config: {
        systemInstruction: opciones.sistema,
        maxOutputTokens: this.maxTokens,
        tools: [
          {
            functionDeclarations: herramientas.map((h) => ({
              name: h.nombre,
              description: h.descripcion,
              parametersJsonSchema: h.esquema,
            })),
          },
        ],
        // El ciclo del agente ejecuta las herramientas; el SDK no debe hacerlo por su cuenta.
        automaticFunctionCalling: { disable: true },
      },
    });

    for await (const trozo of stream) {
      if (trozo.promptFeedback?.blockReason) bloqueado = true;
      const candidato = trozo.candidates?.[0];
      for (const parte of candidato?.content?.parts ?? []) {
        partes.push(parte);
        if (parte.text && !parte.thought) opciones.onTexto(parte.text);
      }
      if (candidato?.finishReason) finalizacion = candidato.finishReason;
      const u = trozo.usageMetadata;
      if (u) {
        uso = {
          prompt: u.promptTokenCount ?? 0,
          cache: u.cachedContentTokenCount ?? 0,
          salida: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
        };
      }
    }

    if (finalizacion === FinishReason.MALFORMED_FUNCTION_CALL) {
      throw new ErrorLLM("El modelo generó una llamada a herramienta inválida. Intenta reformular la solicitud.");
    }

    const texto = partes
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join("");
    const llamadas = partes
      .map((p) => p.functionCall)
      .filter((fc): fc is FunctionCall => Boolean(fc?.name))
      .map((fc, i) => ({ id: fc.id ?? `${ID_LOCAL}${i}`, nombre: fc.name ?? "", args: fc.args ?? {} }));

    const fin: RespuestaLLM["fin"] =
      bloqueado || (finalizacion !== undefined && RECHAZOS.has(finalizacion))
        ? "rechazo"
        : finalizacion === FinishReason.MAX_TOKENS
          ? "limite"
          : llamadas.length > 0
            ? "herramientas"
            : "fin";

    return {
      texto,
      llamadas,
      fin,
      uso: { entrada: uso.prompt - uso.cache, salida: uso.salida, cacheLectura: uso.cache, cacheEscritura: 0 },
      nativo: { proveedor: PROVEEDOR, contenido: partes },
    };
  }
}

function aContenido(m: Mensaje): Content {
  switch (m.rol) {
    case "usuario":
      return { role: "user", parts: [{ text: m.texto }] };
    case "asistente": {
      // Se devuelven las partes originales para conservar las firmas de razonamiento.
      if (m.nativo?.proveedor === PROVEEDOR) return { role: "model", parts: m.nativo.contenido as Part[] };
      const partes: Part[] = [];
      if (m.texto) partes.push({ text: m.texto });
      for (const ll of m.llamadas) {
        partes.push({ functionCall: { ...idGemini(ll.id), name: ll.nombre, args: aObjeto(ll.args) } });
      }
      return { role: "model", parts: partes };
    }
    case "herramientas": {
      const partes: Part[] = m.resultados.map((r) => ({
        functionResponse: { ...idGemini(r.id), name: r.nombre, response: aRespuesta(r.contenido) },
      }));
      if (m.nota) partes.push({ text: m.nota });
      return { role: "user", parts: partes };
    }
  }
}

/** Solo se reenvía el id si lo asignó Gemini; los generados localmente no los conoce. */
function idGemini(id: string): { id?: string } {
  return id.startsWith(ID_LOCAL) ? {} : { id };
}

function aObjeto(valor: unknown): Record<string, unknown> {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor) ? (valor as Record<string, unknown>) : {};
}

/** Gemini espera un objeto como respuesta de la función; el contrato produce JSON serializado. */
function aRespuesta(contenido: string): Record<string, unknown> {
  try {
    const valor: unknown = JSON.parse(contenido);
    return typeof valor === "object" && valor !== null && !Array.isArray(valor)
      ? (valor as Record<string, unknown>)
      : { resultado: valor };
  } catch {
    return { resultado: contenido };
  }
}

function traducirError(err: unknown): ErrorLLM {
  const crear = (mensaje: string) => new ErrorLLM(mensaje, { cause: err });
  if (err instanceof ApiError) {
    if (err.status === 400 || err.status === 401 || err.status === 403) {
      return crear(`El proveedor de IA rechazó la solicitud (${err.status}). Revisa la clave y el modelo configurados.`);
    }
    if (err.status === 404) return crear("El modelo configurado no existe en el proveedor de IA. Revisa LLM_MODEL.");
    if (err.status === 429) {
      return crear("Se alcanzó el límite de uso gratuito del proveedor de IA. Espera un minuto y vuelve a intentar.");
    }
    return crear(`El proveedor de IA respondió con un error (${err.status}). Intenta de nuevo.`);
  }
  return crear("No se obtuvo respuesta del proveedor de IA (tiempo de espera agotado o sin conexión).");
}
