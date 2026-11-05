import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cargarMaestros, normalizarNit } from "../oc/fuentes";
import { type OrdenCompra, OrdenCompraSchema } from "../oc/tipos";
import type { SapAdapter } from "./adapter";

/** Primer número de OC que asigna el SAP simulado. */
export const PRIMER_NUMERO_OC = 4500000001;

interface OrdenRegistrada {
  numero_oc: string;
  fecha: string;
  orden: OrdenCompra;
}

/** SAP simulado: proveedores desde el maestro y órdenes en `out/sap/ordenes.jsonl`. */
export class SapMock implements SapAdapter {
  private readonly ruta: string;
  /** Serializa las escrituras para que dos creaciones simultáneas no repitan número. */
  private cola: Promise<unknown> = Promise.resolve();

  constructor(private readonly directorio: string) {
    this.ruta = join(directorio, "out", "sap", "ordenes.jsonl");
  }

  async consultarProveedor(nit: string) {
    const { proveedores } = await cargarMaestros(this.directorio);
    const p = proveedores.find((x) => x.nit === normalizarNit(nit));
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null;
  }

  async buscarOrdenPorReferencia(solicitud_id: string) {
    const existente = (await this.leer()).find((o) => o.orden.referencia.solicitud_id === solicitud_id);
    return existente ? { numero_oc: existente.numero_oc, fecha: existente.fecha } : null;
  }

  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    const tarea = this.cola.then(() => this.escribir(orden));
    this.cola = tarea.catch(() => undefined);
    return tarea;
  }

  private async escribir(orden: OrdenCompra) {
    // SAP rechaza un payload mal formado; el simulador también.
    const valida = OrdenCompraSchema.parse(orden);
    const ordenes = await this.leer();
    const repetida = ordenes.find((o) => o.orden.referencia.solicitud_id === valida.referencia.solicitud_id);
    if (repetida) return { numero_oc: repetida.numero_oc, fecha: repetida.fecha };

    const registro: OrdenRegistrada = {
      numero_oc: String(PRIMER_NUMERO_OC + ordenes.length),
      fecha: new Date().toISOString(),
      orden: valida,
    };
    await mkdir(dirname(this.ruta), { recursive: true });
    await appendFile(this.ruta, `${JSON.stringify(registro)}\n`);
    return { numero_oc: registro.numero_oc, fecha: registro.fecha };
  }

  private async leer(): Promise<OrdenRegistrada[]> {
    const archivo = Bun.file(this.ruta);
    if (!(await archivo.exists())) return [];
    return (await archivo.text())
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as OrdenRegistrada);
  }
}
