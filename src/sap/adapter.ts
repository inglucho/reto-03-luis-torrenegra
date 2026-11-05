import type { OrdenCompra } from "../oc/tipos";

/**
 * Contrato con SAP (sección 7.4 del PRD). La implementación simulada (`mock.ts`) escribe
 * en archivos; la real usaría OData `API_PURCHASEORDER_PROCESS_SRV` (ver SOLUCION.md).
 */
export interface SapAdapter {
  consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null>;
  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }>;
  /** `fecha` es una extensión opcional (compatible con el contrato del PRD) para informar cuándo se creó. */
  buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string; fecha?: string } | null>;
}
