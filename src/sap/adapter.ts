import type { OrdenCompra } from "../oc/tipos";

/**
 * Contrato con SAP (sección 7.4 del PRD). La implementación simulada (`mock.ts`) escribe
 * en archivos; la real usaría OData `API_PURCHASEORDER_PROCESS_SRV` (ver SOLUCION.md).
 */
export interface SapAdapter {
  consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null>;
  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }>;
  buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null>;
}
