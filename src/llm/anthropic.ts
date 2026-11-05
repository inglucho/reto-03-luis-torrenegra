import Anthropic from "@anthropic-ai/sdk";
import { type AdaptadorLLM, ErrorLLM, type HerramientaLLM, type Mensaje, type RespuestaLLM } from "./adapter";

type Bloque = Anthropic.Beta.BetaContentBlockParam;
type Effort = "low" | "medium" | "high" | "xhigh" | "max";

const PROVEEDOR = "anthropic";
export const MODELO_ANTHROPIC = "claude-opus-5-5";

export interface OpcionesAnthropic {
  modelo?: string;
  effort?: Effort;
  maxTokens?: number;
  timeoutMs?: number;
  apiKey?: string;
}

export class AdaptadorAnthropic implements AdaptadorLLM {
  readonly proveedor = PROVEEDOR;
  readonly modelo: string;
  private readonly client: Anthropic;
  private readonly effort: Effort;
  private readonly maxTokens: number;
  private readonly tieneClave: boolean;

  constructor(opciones: OpcionesAnthropic) {
    this.modelo = opciones.modelo ?? MODELO_ANTHROPIC;
    this.effort = opciones.effort ?? "medium";
    this.maxTokens = opciones.maxTokens ?? 32000;
    this.tieneClave = Boolean(opciones.apiKey);
    // La clave llega desde la variable de entorno; nunca se registra ni se devuelve en la API.
    this.client = new Anthropic({ apiKey: opciones.apiKey, timeout: opciones.timeoutMs ?? 120_000, maxRetries: 1 });
  }

  async enviar(
    mensajes: Mensaje[],
    herramientas: HerramientaLLM[],
    opciones: { sistema: string; onTexto?: (delta: string) => void },
  ): Promise<RespuestaLLM> {
    if (!this.tieneClave) {
      throw new ErrorLLM("El servidor no tiene configurada la clave del proveedor de IA (LLM_API_KEY).");
    }
    const stream = this.client.beta.messages.stream({
      model: this.modelo,
      max_tokens: this.maxTokens,
      system: opciones.sistema,
      tools: herramientas.map(aTool),
      messages: mensajes.map(aMensaje),
      output_config: { effort: this.effort },
      // Cachea el prefijo estable: herramientas, prompt e historial previo.
      cache_control: { type: "ephemeral" },
      // Si el modelo declina por política, la API reintenta con otro modelo en la misma llamada.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (opciones.onTexto) stream.on("text", opciones.onTexto);

    let respuesta: Anthropic.Beta.BetaMessage;
    try {
      respuesta = await stream.finalMessage();
    } catch (err) {
      throw traducirError(err);
    }
    return deRespuesta(respuesta);
  }
}

function aTool(h: HerramientaLLM): Anthropic.Beta.BetaTool {
  return {
    name: h.nombre,
    description: h.descripcion,
    input_schema: { type: "object", ...h.esquema },
  };
}

function aMensaje(m: Mensaje): Anthropic.Beta.BetaMessageParam {
  switch (m.rol) {
    case "usuario":
      return { role: "user", content: m.texto };
    case "asistente": {
      // Se devuelven los bloques originales para conservar el razonamiento del modelo.
      if (m.nativo?.proveedor === PROVEEDOR) {
        return { role: "assistant", content: m.nativo.contenido as Bloque[] };
      }
      const bloques: Bloque[] = [];
      if (m.texto) bloques.push({ type: "text", text: m.texto });
      for (const ll of m.llamadas) bloques.push({ type: "tool_use", id: ll.id, name: ll.nombre, input: ll.args });
      return { role: "assistant", content: bloques };
    }
    case "herramientas": {
      const bloques: Bloque[] = m.resultados.map((r) => ({
        type: "tool_result",
        tool_use_id: r.id,
        content: r.contenido,
        ...(r.error ? { is_error: true } : {}),
      }));
      if (m.nota) bloques.push({ type: "text", text: m.nota });
      return { role: "user", content: bloques };
    }
  }
}

function deRespuesta(r: Anthropic.Beta.BetaMessage): RespuestaLLM {
  let texto = "";
  const llamadas: RespuestaLLM["llamadas"] = [];
  for (const b of r.content) {
    if (b.type === "text") texto += b.text;
    else if (b.type === "tool_use") llamadas.push({ id: b.id, nombre: b.name, args: b.input });
  }
  const fin: RespuestaLLM["fin"] =
    r.stop_reason === "refusal"
      ? "rechazo"
      : r.stop_reason === "max_tokens"
        ? "limite"
        : llamadas.length > 0
          ? "herramientas"
          : "fin";
  return {
    texto,
    llamadas,
    fin,
    uso: {
      entrada: r.usage.input_tokens,
      salida: r.usage.output_tokens,
      cacheLectura: r.usage.cache_read_input_tokens ?? 0,
      cacheEscritura: r.usage.cache_creation_input_tokens ?? 0,
    },
    nativo: { proveedor: PROVEEDOR, contenido: r.content },
  };
}

function traducirError(err: unknown): ErrorLLM {
  const crear = (mensaje: string) => new ErrorLLM(mensaje, { cause: err });
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return crear("El modelo tardó demasiado en responder. Intenta de nuevo.");
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return crear("La clave del proveedor de IA no es válida o no está configurada.");
  }
  if (err instanceof Anthropic.RateLimitError) {
    return crear("Se alcanzó el límite de uso del proveedor de IA. Espera un momento y reintenta.");
  }
  if (err instanceof Anthropic.APIError) {
    return crear(`El proveedor de IA respondió con un error (${err.status ?? "sin código"}).`);
  }
  return crear("No se pudo contactar al proveedor de IA. Revisa la configuración del servidor.");
}
