import { z } from "zod";
import { type Contexto, fallo, ok } from "../core/herramientas";
import { registrarControl } from "../oc/control";
import { generarEvidencia, sha256, textoEvidencia } from "../oc/evidencia";
import { CasoSchema, cargarMaestros, ErrorFuente, leerAprobacion, leerPaquete, listarCasos } from "../oc/fuentes";
import { construirPayload, guardarTrazabilidad } from "../oc/payload";
import { validar as aplicarControles } from "../oc/reglas";
import { type OrdenCompra, OrdenCompraSchema, PaqueteSchema } from "../oc/tipos";
import type { SapAdapter } from "../sap/adapter";
import { SapMock } from "../sap/mock";

/**
 * Herramientas del reto 03. El modelo las ve como `oc_<export>`.
 * Todas devuelven `{ ok, data }` o `{ ok: false, error }` serializado y nunca lanzan.
 * Los valores siempre se recalculan desde los fixtures: si el modelo envía un paquete
 * o un payload, solo se usa para detectar diferencias, nunca como fuente.
 */

/** Adaptador SAP en uso. Se reemplaza en tests o por la implementación real. */
let sap: (dir: string) => SapAdapter = (dir) => new SapMock(dir);
export function usarSap(fabrica: (dir: string) => SapAdapter): void {
  sap = fabrica;
}

/** Convierte errores esperados en `{ ok: false }` legibles; el contrato prohíbe lanzar. */
async function protegido(cuerpo: () => Promise<string>): Promise<string> {
  try {
    return await cuerpo();
  } catch (err) {
    if (err instanceof ErrorFuente) return fallo(`${err.message} Pide al solicitante que reenvíe el paquete completo.`);
    return fallo(`Error inesperado: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Lee el paquete, los maestros y aplica los controles: la base de casi todas las herramientas. */
async function prepararCaso(ctx: Contexto, caso: string) {
  const [lectura, maestros] = await Promise.all([leerPaquete(ctx.directory, caso), cargarMaestros(ctx.directory)]);
  return { ...lectura, validacion: aplicarControles(lectura.paquete, maestros) };
}

async function shaEvidencia(ctx: Contexto, caso: string): Promise<string> {
  const aprobacion = await leerAprobacion(ctx.directory, caso);
  if (!aprobacion) throw new ErrorFuente("Falta el correo de aprobación (aprobacion.eml).");
  return sha256(textoEvidencia(caso, aprobacion));
}

/** Avisa si lo que envió el modelo difiere de la fuente (no se usa, pero se informa). */
function diferencias(enviado: unknown, fuente: unknown, prefijo = ""): string[] {
  if (enviado === undefined) return [];
  if (typeof fuente !== "object" || fuente === null || typeof enviado !== "object" || enviado === null) {
    return JSON.stringify(enviado) === JSON.stringify(fuente) ? [] : [prefijo || "(raíz)"];
  }
  const claves = new Set([...Object.keys(fuente), ...Object.keys(enviado)]);
  return [...claves].flatMap((k) =>
    diferencias((enviado as Record<string, unknown>)[k], (fuente as Record<string, unknown>)[k], prefijo ? `${prefijo}.${k}` : k),
  );
}

const argPaquete = PaqueteSchema.optional().describe(
  "Opcional. Paquete devuelto por oc_leer_paquete; la herramienta lo recalcula desde la fuente y avisa si difiere.",
);

export const listar_solicitudes = {
  description: "Lista los casos de solicitud de compra disponibles para procesar.",
  args: {},
  async execute(_args: Record<string, never>, ctx: Contexto): Promise<string> {
    return protegido(async () => ok({ casos: await listarCasos(ctx.directory) }));
  },
};

export const leer_paquete = {
  description: "Lee y normaliza el correo, la solicitud, la cotización, la aprobación y la factura de un caso.",
  args: { caso: CasoSchema },
  async execute(args: { caso: string }, ctx: Contexto): Promise<string> {
    return protegido(async () => {
      const { paquete, faltantes } = await leerPaquete(ctx.directory, args.caso);
      return ok({ ...paquete, faltantes });
    });
  },
};

export const validar = {
  description: "Aplica los controles RC1–RC10 al caso y devuelve si es apta, sus bloqueos, confirmaciones y valores derivados.",
  args: { caso: CasoSchema, paquete: argPaquete },
  async execute(args: { caso: string; paquete?: unknown }, ctx: Contexto): Promise<string> {
    return protegido(async () => {
      const { paquete, validacion } = await prepararCaso(ctx, args.caso);
      const { contexto: _interno, ...publico } = validacion;
      const data = { ...publico, advertencias: avisoDiferencias(args.paquete, paquete) };
      if (validacion.apta && validacion.confirmaciones.length > 0) {
        return JSON.stringify({
          ok: true,
          data,
          // La confirmación de la validación habilita `oc_crear` en el siguiente turno.
          confirmacion: { motivo: `Antes de crear la OC hay que confirmar: ${resumenReglas(validacion.confirmaciones)}.`, accion: "crear" },
        });
      }
      return ok(data);
    });
  },
};

export const construir_payload = {
  description: "Construye la orden de compra exactamente como quedaría en SAP y guarda su trazabilidad.",
  args: {
    caso: CasoSchema,
    paquete: argPaquete,
    derivados: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Opcional. Derivados devueltos por oc_validar; se recalculan y se avisa si difieren."),
  },
  async execute(args: { caso: string; paquete?: unknown; derivados?: Record<string, unknown> }, ctx: Contexto): Promise<string> {
    return protegido(async () => {
      const { paquete, validacion } = await prepararCaso(ctx, args.caso);
      if (!validacion.apta) return falloBloqueos(validacion.bloqueos);
      const { orden, trazabilidad } = construirPayload({
        paquete,
        validacion,
        evidenciaSha256: await shaEvidencia(ctx, args.caso),
        confirmadoPor: null,
      });
      const ruta_trazabilidad = await guardarTrazabilidad(ctx.directory, args.caso, trazabilidad);
      const advertencias = [
        ...avisoDiferencias(args.paquete, paquete),
        ...diferencias(args.derivados, validacion.derivados, "derivados").map((c) => `Se ignoró ${c}: se usó el valor del maestro.`),
      ];
      return ok({ orden, ruta_trazabilidad, confirmaciones_pendientes: validacion.confirmaciones, advertencias });
    });
  },
};

export const generar_evidencia = {
  description: "Genera la evidencia de aprobación (aprobacion.txt y aprobacion.pdf) con su sha256 en out/<caso>/.",
  args: { caso: CasoSchema },
  async execute(args: { caso: string }, ctx: Contexto): Promise<string> {
    return protegido(async () => {
      const aprobacion = await leerAprobacion(ctx.directory, args.caso);
      if (!aprobacion) return fallo("El caso no tiene correo de aprobación; no hay evidencia que generar.");
      return ok(await generarEvidencia(ctx.directory, args.caso, aprobacion));
    });
  },
};

export const crear = {
  description:
    "Crea la orden de compra en SAP si el caso es apto; si hay confirmaciones pendientes, exige confirmado = true.",
  args: {
    caso: CasoSchema,
    payload: OrdenCompraSchema.optional().describe(
      "Opcional. Orden devuelta por oc_construir_payload; se rechaza si difiere de la calculada desde la fuente.",
    ),
    confirmado: z.boolean().optional().describe("true solo si el usuario confirmó explícitamente las excepciones"),
  },
  async execute(args: { caso: string; payload?: OrdenCompra; confirmado?: boolean }, ctx: Contexto): Promise<string> {
    return protegido(() => crearOrden(args, ctx));
  },
};

async function crearOrden(args: { caso: string; payload?: OrdenCompra; confirmado?: boolean }, ctx: Contexto): Promise<string> {
  const { paquete, validacion } = await prepararCaso(ctx, args.caso);
  const s = paquete.solicitud;
  const base = {
    solicitud_id: s.solicitud_id,
    retroactiva: validacion.retroactiva,
    bloqueos: validacion.bloqueos.map((b) => b.regla),
    confirmaciones: validacion.confirmaciones.map((c) => c.regla),
  };
  const adaptador = sap(ctx.directory);

  // Idempotencia: una solicitud ya creada devuelve su número, nunca una segunda OC.
  const existente = await adaptador.buscarOrdenPorReferencia(s.solicitud_id);
  if (existente) {
    await registrarControl(ctx.directory, { ...base, resultado: "existente", numero_oc: existente.numero_oc });
    return ok({ numero_oc: existente.numero_oc, fecha: null, idempotente: true });
  }

  if (!validacion.apta) {
    await registrarControl(ctx.directory, { ...base, resultado: "bloqueada", numero_oc: null });
    return falloBloqueos(validacion.bloqueos);
  }

  if (validacion.confirmaciones.length > 0 && !args.confirmado) {
    await registrarControl(ctx.directory, { ...base, resultado: "pendiente_confirmacion", numero_oc: null });
    return JSON.stringify({
      ok: false,
      error: "La OC no se creó: requiere confirmación del usuario.",
      confirmacion: { motivo: resumenReglas(validacion.confirmaciones), detalles: validacion.confirmaciones },
    });
  }

  const aprobacion = await leerAprobacion(ctx.directory, args.caso);
  if (!aprobacion) return fallo("Falta el correo de aprobación.");
  const evidencia = await generarEvidencia(ctx.directory, args.caso, aprobacion);
  const confirmadoPor = validacion.confirmaciones.length > 0 ? `analista vía chat (sesión ${ctx.sessionId})` : null;
  const { orden, trazabilidad } = construirPayload({ paquete, validacion, evidenciaSha256: evidencia.sha256, confirmadoPor });

  if (args.payload) {
    const distintos = diferencias(sinConfirmador(args.payload), sinConfirmador(orden));
    if (distintos.length > 0) {
      return fallo(`El payload recibido difiere del calculado desde la fuente en: ${distintos.join(", ")}. No se creó la OC.`);
    }
  }

  await guardarTrazabilidad(ctx.directory, args.caso, trazabilidad);
  const { numero_oc, fecha } = await adaptador.crearOrden(orden);
  await registrarControl(ctx.directory, { ...base, resultado: "creada", numero_oc });
  return ok({ numero_oc, fecha, idempotente: false, retroactiva: validacion.retroactiva, evidencia: evidencia.ruta });
}

function sinConfirmador(o: OrdenCompra): OrdenCompra {
  return { ...o, excepciones: o.excepciones.map((x) => ({ ...x, confirmado_por: null })) };
}

function falloBloqueos(bloqueos: { regla: string; detalle: string; accion_sugerida?: string }[]): string {
  const detalle = bloqueos.map((b) => `${b.regla}: ${b.detalle} Acción sugerida: ${b.accion_sugerida ?? "revisar"}`).join(" | ");
  return fallo(`La solicitud está bloqueada y no se puede crear la OC. ${detalle}`);
}

function resumenReglas(hallazgos: { regla: string; detalle: string }[]): string {
  return hallazgos.map((h) => `${h.regla} (${h.detalle})`).join("; ");
}

function avisoDiferencias(enviado: unknown, fuente: unknown): string[] {
  return diferencias(enviado, fuente, "paquete").map((c) => `Se ignoró ${c}: se usó el valor de la fuente.`);
}
