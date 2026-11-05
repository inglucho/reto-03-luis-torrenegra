import { describe, expect, test } from "bun:test";
import type { Mensaje } from "../src/llm/adapter";
import { AdaptadorGemini } from "../src/llm/gemini";

/**
 * Prueba el adaptador de Gemini sin red ni clave: un `fetch` falso captura la petición
 * que arma el SDK y responde con un stream SSE como el de la API real.
 */
function falsoFetch(trozos: unknown[], estado = 200) {
  const peticiones: { url: string; cuerpo: Record<string, unknown> }[] = [];
  const fetchFalso = (async (entrada: string | URL | Request, init?: RequestInit) => {
    peticiones.push({ url: String(entrada), cuerpo: JSON.parse(String(init?.body ?? "{}")) });
    if (estado !== 200) {
      return new Response(JSON.stringify({ error: { code: estado, message: "falla", status: "ERROR" } }), {
        status: estado,
        headers: { "Content-Type": "application/json" },
      });
    }
    const sse = trozos.map((t) => `data: ${JSON.stringify(t)}\r\n\r\n`).join("");
    return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;
  return { fetchFalso, peticiones };
}

const herramientas = [
  {
    nombre: "ejemplo_consultar",
    descripcion: "Consulta un registro",
    esquema: { type: "object", properties: { codigo: { type: "string" } }, required: ["codigo"] },
  },
];

describe("AdaptadorGemini", () => {
  test("traduce la respuesta con llamada a herramienta y conserva las firmas", async () => {
    const parteLlamada = { functionCall: { name: "ejemplo_consultar", args: { codigo: "R-001" } }, thoughtSignature: "firma123" };
    const { fetchFalso, peticiones } = falsoFetch([
      { candidates: [{ content: { role: "model", parts: [{ text: "Voy a " }] } }] },
      {
        candidates: [{ content: { role: "model", parts: [{ text: "consultar." }, parteLlamada] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 120, cachedContentTokenCount: 20, candidatesTokenCount: 15, thoughtsTokenCount: 5 },
      },
    ]);
    const adaptador = new AdaptadorGemini({ apiKey: "test", fetch: fetchFalso });
    const deltas: string[] = [];

    const r = await adaptador.enviar([{ rol: "usuario", texto: "consulta R-001" }], herramientas, {
      sistema: "Eres un asistente",
      onTexto: (d) => deltas.push(d),
    });

    expect(deltas.join("")).toBe("Voy a consultar.");
    expect(r.fin).toBe("herramientas");
    expect(r.llamadas).toEqual([{ id: "local-0", nombre: "ejemplo_consultar", args: { codigo: "R-001" } }]);
    expect(r.uso).toEqual({ entrada: 100, salida: 20, cacheLectura: 20, cacheEscritura: 0 });

    const cuerpo = peticiones[0]!.cuerpo;
    expect(peticiones[0]!.url).toContain(":streamGenerateContent");
    expect(JSON.stringify(cuerpo)).toContain("ejemplo_consultar");
    expect(JSON.stringify(cuerpo)).toContain("Eres un asistente");

    // En el siguiente turno, las partes originales (con la firma) vuelven tal cual.
    const historial: Mensaje[] = [
      { rol: "usuario", texto: "consulta R-001" },
      { rol: "asistente", texto: r.texto, llamadas: r.llamadas, nativo: r.nativo },
      { rol: "herramientas", resultados: [{ id: "local-0", nombre: "ejemplo_consultar", contenido: '{"ok":true,"data":{"estado":"pendiente"}}', error: false }] },
    ];
    const segundo = falsoFetch([{ candidates: [{ content: { role: "model", parts: [{ text: "Está pendiente." }] }, finishReason: "STOP" }] }]);
    const respuesta = await new AdaptadorGemini({ apiKey: "test", fetch: segundo.fetchFalso }).enviar(historial, herramientas, {
      sistema: "s",
    });

    const enviado = JSON.stringify(segundo.peticiones[0]!.cuerpo);
    expect(enviado).toContain("firma123");
    expect(enviado).toContain('"functionResponse"');
    expect(enviado).toContain('"estado":"pendiente"');
    expect(respuesta).toMatchObject({ texto: "Está pendiente.", fin: "fin" });
  });

  test("un bloqueo de seguridad se informa como rechazo", async () => {
    const { fetchFalso } = falsoFetch([{ candidates: [{ content: { role: "model", parts: [] }, finishReason: "SAFETY" }] }]);
    const r = await new AdaptadorGemini({ apiKey: "test", fetch: fetchFalso }).enviar([{ rol: "usuario", texto: "x" }], [], { sistema: "s" });
    expect(r.fin).toBe("rechazo");
  });

  test("si el modelo principal está saturado (503), responde el de respaldo", async () => {
    const modelos: string[] = [];
    const fetchFalso = (async (entrada: string | URL | Request) => {
      const url = String(entrada);
      modelos.push(url.includes("principal") ? "principal" : "respaldo");
      if (url.includes("principal")) {
        return new Response(JSON.stringify({ error: { code: 503, message: "high demand", status: "UNAVAILABLE" } }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      const trozo = { candidates: [{ content: { role: "model", parts: [{ text: "hola" }] }, finishReason: "STOP" }] };
      return new Response(`data: ${JSON.stringify(trozo)}\r\n\r\n`, { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;
    const adaptador = new AdaptadorGemini({ apiKey: "test", modelo: "principal", respaldo: ["respaldo"], fetch: fetchFalso });

    const r = await adaptador.enviar([{ rol: "usuario", texto: "x" }], [], { sistema: "s" });

    expect(r.texto).toBe("hola");
    expect(modelos[0]).toBe("principal");
    expect(modelos.at(-1)).toBe("respaldo");
  });

  test("el límite de la capa gratuita se traduce a un mensaje claro", async () => {
    const { fetchFalso } = falsoFetch([], 429);
    const adaptador = new AdaptadorGemini({ apiKey: "test", respaldo: [], fetch: fetchFalso });
    await expect(adaptador.enviar([{ rol: "usuario", texto: "x" }], [], { sistema: "s" })).rejects.toThrow("límite de uso gratuito");
  });

  test("sin clave falla con un mensaje explícito, sin llamar a la red", async () => {
    const { fetchFalso, peticiones } = falsoFetch([]);
    const adaptador = new AdaptadorGemini({ fetch: fetchFalso });
    await expect(adaptador.enviar([{ rol: "usuario", texto: "x" }], [], { sistema: "s" })).rejects.toThrow("LLM_API_KEY");
    expect(peticiones).toHaveLength(0);
  });
});
