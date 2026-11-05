import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type OrdenCompra, OrdenCompraSchema, type Paquete, type Validacion } from "./tipos";

/** Límite de SAP para el texto breve de una posición. */
export const MAX_DESCRIPCION = 40;

/** Origen de cada valor del payload (HU-3: todo valor es trazable). */
/** Las fuentes que admite el PRD (HU-3); el detalle va en `nota`. */
export type Fuente = "solicitud" | "cotizacion" | "derivado" | `maestro.${string}`;

export interface Trazabilidad {
  [campo: string]: { valor: unknown; fuente: Fuente; nota?: string };
}

/** Texto breve de SAP: se corta en un límite de palabra y nunca supera 40 caracteres. */
export function textoBreve(descripcion: string): string {
  const limpio = descripcion.replace(/\s+/g, " ").trim();
  if (limpio.length <= MAX_DESCRIPCION) return limpio;
  const corte = limpio.slice(0, MAX_DESCRIPCION + 1).lastIndexOf(" ");
  return limpio
    .slice(0, corte > 20 ? corte : MAX_DESCRIPCION)
    .replace(/[\s,.:;-]+$/, "")
    .replace(/(\s+(de|del|la|las|el|los|para|con|y|en|a|por))+$/i, "");
}

/** Unidad de medida a partir de la descripción: horas → H, mensualidades → MES, resto → UN. */
export function inferirUnidad(descripcion: string): "UN" | "H" | "MES" {
  const d = descripcion.toLowerCase();
  if (/\bhoras?\b/.test(d)) return "H";
  if (/\b(mensualidad(es)?|meses de servicio|suscripci[oó]n mensual)\b/.test(d)) return "MES";
  return "UN";
}

export interface EntradaPayload {
  paquete: Paquete;
  validacion: Validacion;
  evidenciaSha256: string;
  /** Quién confirmó las excepciones; `null` mientras no se hayan confirmado. */
  confirmadoPor: string | null;
}

/** HU-3: arma la OC de la sección 7.4. Requiere un paquete apto (sin bloqueos). */
export function construirPayload(e: EntradaPayload): { orden: OrdenCompra; trazabilidad: Trazabilidad } {
  const { paquete: p, validacion: v } = e;
  const proveedor = v.contexto.proveedor;
  const aprobacion = p.aprobacion;
  if (!v.apta || !proveedor || !aprobacion) {
    throw new Error("La solicitud tiene bloqueos; no se puede construir el payload.");
  }
  const s = p.solicitud;
  const iva = s.indicador_iva ?? v.derivados.indicador_iva?.valor;
  const pago = s.condiciones_pago ?? v.derivados.condiciones_pago?.valor;
  if (!iva || !pago) throw new Error("Falta el indicador de IVA o las condiciones de pago y no se pudieron derivar.");

  const orden = OrdenCompraSchema.parse({
    referencia: { solicitud_id: s.solicitud_id, correo_id: p.correo.id, cotizacion_ref: p.cotizacion?.referencia ?? null },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: { codigo_sap: proveedor.codigo_sap, nit: proveedor.nit, nombre: proveedor.nombre },
    moneda: s.moneda,
    condiciones_pago: pago,
    aprobador: { email: aprobacion.de, fecha_aprobacion: aprobacion.fecha, evidencia_sha256: e.evidenciaSha256 },
    posiciones: [
      {
        numero: 10,
        descripcion: textoBreve(s.descripcion),
        cantidad: s.cantidad,
        unidad: inferirUnidad(s.descripcion),
        precio_unitario: s.valor_unitario,
        centro_costo: s.centro_costo,
        subarea: s.subarea,
        indicador_iva: iva,
      },
    ],
    excepciones: v.confirmaciones.map((c) => ({ codigo: c.regla, detalle: c.detalle, confirmado_por: e.confirmadoPor })),
  });

  const deriv = (campo: "indicador_iva" | "condiciones_pago") =>
    s[campo] ? ({ fuente: "solicitud" } as const) : ({ fuente: "derivado", nota: v.derivados[campo]?.detalle } as const);

  const trazabilidad: Trazabilidad = {
    "referencia.solicitud_id": { valor: s.solicitud_id, fuente: "solicitud" },
    "referencia.correo_id": { valor: p.correo.id, fuente: "solicitud", nota: "Identificador del correo con que llegó la solicitud" },
    "referencia.cotizacion_ref": { valor: orden.referencia.cotizacion_ref, fuente: "cotizacion" },
    sociedad: { valor: "1000", fuente: "derivado", nota: "Constante de configuración: sociedad única de Periferia en SAP" },
    organizacion_compras: { valor: "1000", fuente: "derivado", nota: "Constante de configuración" },
    proveedor: { valor: orden.proveedor, fuente: "maestro.proveedores" },
    moneda: { valor: s.moneda, fuente: "solicitud" },
    condiciones_pago: { valor: pago, ...deriv("condiciones_pago") },
    "aprobador.email": { valor: aprobacion.de, fuente: "maestro.centros-costo", nota: "Remitente del correo de aprobación, verificado como aprobador del centro (RC2)" },
    "aprobador.fecha_aprobacion": { valor: aprobacion.fecha, fuente: "solicitud", nota: "Fecha del correo de aprobación adjunto a la solicitud" },
    "aprobador.evidencia_sha256": { valor: e.evidenciaSha256, fuente: "derivado", nota: "sha256 de out/<caso>/aprobacion.txt" },
    "posiciones[0].descripcion": { valor: orden.posiciones[0]?.descripcion, fuente: "solicitud", nota: `Texto breve SAP (máx. ${MAX_DESCRIPCION})` },
    "posiciones[0].cantidad": { valor: s.cantidad, fuente: "solicitud" },
    "posiciones[0].unidad": { valor: orden.posiciones[0]?.unidad, fuente: "derivado", nota: "Inferida de la descripción" },
    "posiciones[0].precio_unitario": { valor: s.valor_unitario, fuente: "solicitud" },
    "posiciones[0].centro_costo": { valor: s.centro_costo, fuente: "solicitud" },
    "posiciones[0].subarea": { valor: s.subarea, fuente: "solicitud" },
    "posiciones[0].indicador_iva": { valor: iva, ...deriv("indicador_iva") },
    excepciones: { valor: orden.excepciones, fuente: "derivado", nota: "Confirmaciones de la validación (RC5, RC6, RC8, RC9)" },
  };
  return { orden, trazabilidad };
}

export async function guardarTrazabilidad(dir: string, caso: string, t: Trazabilidad): Promise<string> {
  const carpeta = join(dir, "out", caso);
  await mkdir(carpeta, { recursive: true });
  await Bun.write(join(carpeta, "trazabilidad.json"), `${JSON.stringify(t, null, 2)}\n`);
  return join("out", caso, "trazabilidad.json");
}
