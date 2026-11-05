import { join } from "node:path";
import { z } from "zod";
import {
  AprobacionArchivoSchema,
  CentroCostoSchema,
  CondicionPagoSchema,
  CorreoSchema,
  IndicadorIvaSchema,
  type Maestros,
  type Paquete,
  ProveedorSchema,
  SolicitudSchema,
} from "./tipos";

/** Los fixtures son de solo lectura; todo lo que se escribe va a `out/`. */
export const rutaFixtures = (dir: string) => join(dir, "fixtures", "reto-03");
export const rutaCaso = (dir: string, caso: string) => join(rutaFixtures(dir), "solicitudes", caso);

/** Nombre de carpeta seguro: evita rutas como `../../etc` desde un argumento del modelo. */
export const CasoSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "El caso debe ser el nombre de una carpeta, p. ej. sol-001")
  .describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/, p. ej. sol-001");

export class ErrorFuente extends Error {
  override name = "ErrorFuente";
}

async function leerJson<S extends z.ZodType>(ruta: string, esquema: S, nombre: string): Promise<z.output<S> | null> {
  const archivo = Bun.file(ruta);
  if (!(await archivo.exists())) return null;
  let crudo: unknown;
  try {
    crudo = JSON.parse(await archivo.text());
  } catch {
    throw new ErrorFuente(`${nombre} no es un JSON válido. Pide al solicitante que reenvíe el documento.`);
  }
  const r = esquema.safeParse(crudo);
  if (!r.success) throw new ErrorFuente(`${nombre} tiene datos inválidos (${z.prettifyError(r.error)}). Pide al solicitante que lo corrija.`);
  return r.data;
}

async function leerTexto(ruta: string): Promise<string | null> {
  const archivo = Bun.file(ruta);
  return (await archivo.exists()) ? archivo.text() : null;
}

export async function cargarMaestros(dir: string): Promise<Maestros> {
  const base = join(rutaFixtures(dir), "maestros");
  const leer = async <S extends z.ZodType>(archivo: string, esquema: S) => {
    const datos = await leerJson(join(base, archivo), z.array(esquema), `El maestro ${archivo}`);
    if (!datos) throw new ErrorFuente(`Falta el maestro ${archivo}.`);
    return datos;
  };
  return {
    proveedores: await leer("proveedores.json", ProveedorSchema),
    centrosCosto: await leer("centros-costo.json", CentroCostoSchema),
    indicadoresIva: await leer("indicadores-iva.json", IndicadorIvaSchema),
    condicionesPago: await leer("condiciones-pago.json", CondicionPagoSchema),
  };
}

export async function listarCasos(dir: string): Promise<string[]> {
  const glob = new Bun.Glob("*/solicitud.json");
  const casos: string[] = [];
  for await (const ruta of glob.scan(join(rutaFixtures(dir), "solicitudes"))) casos.push(ruta.split("/")[0] ?? ruta);
  return casos.sort();
}

export interface LecturaPaquete {
  paquete: Paquete;
  /** Adjuntos que no llegaron (HU-1: se reportan, no se lanza excepción). */
  faltantes: string[];
}

/** HU-1: lee y normaliza el paquete del caso. Lanza `ErrorFuente` solo si falta lo indispensable. */
export async function leerPaquete(dir: string, caso: string): Promise<LecturaPaquete> {
  const carpeta = rutaCaso(dir, caso);
  if (!(await Bun.file(join(carpeta, "solicitud.json")).exists()) && !(await Bun.file(join(carpeta, "correo.json")).exists())) {
    throw new ErrorFuente(`No existe el caso "${caso}". Revisa el nombre con oc_listar_solicitudes.`);
  }
  const correo = await leerJson(join(carpeta, "correo.json"), CorreoSchema, "correo.json");
  const solicitud = await leerJson(join(carpeta, "solicitud.json"), SolicitudSchema, "solicitud.json");
  if (!correo) throw new ErrorFuente("Falta correo.json: no se puede identificar el correo de origen. Pide al solicitante que reenvíe el paquete completo.");
  if (!solicitud) throw new ErrorFuente("Falta solicitud.json: pide al solicitante el Excel de la solicitud.");

  const aprobacion = await leerJson(join(carpeta, "aprobacion.json"), AprobacionArchivoSchema, "aprobacion.json");
  const cotizacionTxt = await leerTexto(join(carpeta, "cotizacion.txt"));
  const facturaTxt = await leerTexto(join(carpeta, "factura.txt"));

  const faltantes: string[] = [];
  if (!cotizacionTxt) faltantes.push("cotizacion.pdf");
  if (!aprobacion) faltantes.push("aprobacion.eml");

  return {
    paquete: {
      correo: { id: correo.id, de: correo.de, asunto: correo.asunto, fecha: correo.fecha },
      solicitud,
      cotizacion: cotizacionTxt ? parsearCotizacion(cotizacionTxt) : null,
      aprobacion: aprobacion
        ? { de: aprobacion.de, fecha: aprobacion.fecha, aprobado: contieneAprobado(aprobacion.cuerpo), texto: aprobacion.cuerpo }
        : null,
      factura: facturaTxt ? parsearFactura(facturaTxt) : null,
    },
    faltantes,
  };
}

/** Archivo de aprobación completo (encabezados + cuerpo), base de la evidencia. */
export async function leerAprobacion(dir: string, caso: string) {
  return leerJson(join(rutaCaso(dir, caso), "aprobacion.json"), AprobacionArchivoSchema, "aprobacion.json");
}

/** RC2: el cuerpo debe decir "Aprobado", sin negación delante. */
export function contieneAprobado(cuerpo: string): boolean {
  return /\baprobad[oa]\b/i.test(cuerpo) && !/\bno\s+(est[aá]\s+)?aprobad[oa]\b/i.test(cuerpo);
}

/** "COP 11.400.000" → 11400000. Formato colombiano: punto de miles, coma decimal. */
export function aNumero(texto: string): number | null {
  const limpio = texto.replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
  const n = Number(limpio);
  return limpio !== "" && Number.isFinite(n) ? n : null;
}

/** NIT sin puntos ni dígito de verificación: "900.555.111-2" → "900555111". */
export function normalizarNit(nit: string): string {
  return (nit.split("-")[0] ?? nit).replace(/\D/g, "");
}

const campo = (texto: string, etiqueta: RegExp): string | null => texto.match(etiqueta)?.[1]?.trim() ?? null;

function sumarDias(fechaIso: string, dias: number): string {
  const d = new Date(`${fechaIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

export function parsearCotizacion(texto: string): NonNullable<Paquete["cotizacion"]> {
  const totalTxt = campo(texto, /^TOTAL[^:\n]*:\s*(.+)$/im);
  const fecha = campo(texto, /^Fecha:\s*(\d{4}-\d{2}-\d{2})/im);
  const dias = Number(campo(texto, /^Validez[^:\n]*:\s*(\d+)\s*d[ií]as/im));
  const nit = campo(texto, /^NIT:\s*([\d.\-]+)/im);
  return {
    referencia: campo(texto, /^COTIZACI[ÓO]N\s+(\S+)/im),
    proveedor: campo(texto, /^Proveedor:\s*(.+)$/im) ?? "",
    nit: nit ? normalizarNit(nit) : null,
    total: totalTxt ? aNumero(totalTxt) : null,
    moneda: totalTxt?.match(/\b(COP|USD)\b/)?.[1] ?? "COP",
    validez_hasta: fecha && dias > 0 ? sumarDias(fecha, dias) : null,
    texto,
  };
}

export function parsearFactura(texto: string): NonNullable<Paquete["factura"]> {
  const totalTxt = campo(texto, /^TOTAL:\s*(.+)$/im);
  return {
    numero: campo(texto, /No\.\s*(\S+)/i) ?? "sin número",
    fecha: campo(texto, /Fecha de emisi[óo]n:\s*(\d{4}-\d{2}-\d{2})/i) ?? "",
    total: totalTxt ? aNumero(totalTxt) : null,
  };
}
