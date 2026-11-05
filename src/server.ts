import { rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import index from "../web/index.html";
import { config } from "./config";
import { Agente } from "./core/agente";
import { Bitacora } from "./core/bitacora";
import type { Evento } from "./core/eventos";
import { LimitePorClave, PresupuestoDiario } from "./core/presupuesto";
import { AlmacenSesiones } from "./core/sesiones";
import { cargarSistema, herramientas, opcionesBitacora, presentacion } from "./dominio";
import { crearAdaptador } from "./llm";

const agente = new Agente({
  sistema: await cargarSistema(config.directorio),
  herramientas,
  llm: crearAdaptador(config),
  directorio: config.directorio,
  bitacora: new Bitacora(config.directorio, opcionesBitacora),
  maxIteraciones: config.maxIteraciones,
  maxTokensSesion: config.maxTokensSesion,
  presupuesto: new PresupuestoDiario(config.maxTokensDia),
});
const sesiones = new AlmacenSesiones();
const limite = new LimitePorClave(config.maxMensajesPorIp, config.ventanaMinutos * 60_000);

const CuerpoChat = z.object({
  sessionId: z.string().min(1).max(100),
  message: z.string().trim().min(1).max(10_000),
});

/** IP del cliente: la del proxy de la plataforma de despliegue si existe; si no, la de la conexión. */
function ipDelCliente(req: Request): string {
  const reenviada = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return reenviada || servidor.requestIP(req)?.address || "desconocida";
}

/** POST /api/chat: ejecuta un turno y transmite sus eventos por SSE. */
async function chat(req: Request): Promise<Response> {
  const cuerpo = CuerpoChat.safeParse(await req.json().catch(() => null));
  if (!cuerpo.success) return Response.json({ error: "Se espera { sessionId, message }." }, { status: 400 });
  const { sessionId, message } = cuerpo.data;

  if (!limite.permitir(ipDelCliente(req))) {
    return Response.json(
      { error: `Demasiados mensajes seguidos. Espera unos minutos (máximo ${config.maxMensajesPorIp} cada ${config.ventanaMinutos} minutos).` },
      { status: 429 },
    );
  }

  const sesion = sesiones.reservar(sessionId);
  if (!sesion) return Response.json({ error: "Esta conversación ya está procesando un mensaje." }, { status: 409 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emitir = (e: Evento) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      // Mantiene viva la conexión mientras el modelo razona sin emitir texto.
      const latido = setInterval(() => controller.enqueue(encoder.encode(": ping\n\n")), 15_000);
      try {
        await agente.turno(sesion, message, emitir);
      } finally {
        clearInterval(latido);
        sesiones.liberar(sessionId);
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}

/**
 * POST /api/datos/restablecer: borra solo `out/` (lo generado) para que los casos de prueba
 * vuelvan a su estado inicial. Los fixtures no se tocan. Útil en la demo pública, porque
 * crear una OC o procesar un mensaje "gasta" el caso (idempotencia y duplicados).
 */
async function restablecerDatos(req: Request): Promise<Response> {
  if (!limite.permitir(ipDelCliente(req))) {
    return Response.json({ error: "Demasiadas solicitudes seguidas. Espera unos minutos." }, { status: 429 });
  }
  await rm(join(config.directorio, "out"), { recursive: true, force: true });
  return Response.json({ ok: true });
}

/** GET /api/sessions/:id: historial de la sesión, sin la respuesta cruda del proveedor. */
function historial(id: string): Response {
  const sesion = sesiones.obtener(id);
  if (!sesion) return Response.json({ error: "Sesión no encontrada." }, { status: 404 });
  const mensajes = sesion.mensajes.map((m) => (m.rol === "asistente" ? { ...m, nativo: undefined } : m));
  return Response.json({
    id: sesion.id,
    confirmacionesPendientes: sesion.confirmacionesPendientes,
    tokensUsados: sesion.tokensUsados,
    mensajes,
  });
}

const servidor = Bun.serve({
  port: config.puerto,
  idleTimeout: 255,
  development: process.env.NODE_ENV !== "production",
  routes: {
    "/": index,
    "/api/health": () => Response.json({ ok: true, provider: agente.llm.proveedor, model: agente.llm.modelo }),
    "/api/info": () =>
      Response.json({ ...presentacion, proveedor: agente.llm.proveedor, modelo: agente.llm.modelo, fechaReferencia: config.fechaReferencia }),
    "/api/herramientas": () =>
      Response.json(agente.herramientas.map((h) => ({ nombre: h.nombre, descripcion: h.herramienta.description }))),
    "/api/chat": { POST: chat },
    "/api/datos/restablecer": { POST: restablecerDatos },
    "/api/sessions/:id": {
      GET: (req) => historial(req.params.id),
      DELETE: (req) => {
        sesiones.eliminar(req.params.id);
        return Response.json({ ok: true });
      },
    },
  },
});

console.log(`Agente en ${servidor.url} · ${agente.llm.proveedor} ${agente.llm.modelo}`);
if (!process.env.LLM_API_KEY) {
  console.warn("Aviso: falta LLM_API_KEY; el chat no podrá responder (ver .env.example). demo.ts no la necesita.");
}
