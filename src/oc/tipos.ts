import { z } from "zod";

/** Solicitud de compra (Excel normalizado a JSON). Sección 7.1 del PRD. */
export const SolicitudSchema = z.object({
  solicitud_id: z.string().min(1),
  solicitante: z.string().min(1),
  proveedor_nombre: z.string().min(1),
  proveedor_nit: z.string().min(1).optional(),
  descripcion: z.string().min(1),
  centro_costo: z.string().min(1),
  subarea: z.string().min(1),
  cantidad: z.number().positive(),
  valor_unitario: z.number().nonnegative(),
  valor_total: z.number().positive(),
  moneda: z.enum(["COP", "USD"]),
  indicador_iva: z.string().min(1).optional(),
  condiciones_pago: z.string().min(1).optional(),
  fecha_solicitud: z.iso.date(),
});
export type Solicitud = z.infer<typeof SolicitudSchema>;

export const CorreoSchema = z.object({
  id: z.string(),
  de: z.string(),
  asunto: z.string(),
  fecha: z.string(),
});

export const AprobacionArchivoSchema = z.object({
  de: z.string(),
  para: z.string(),
  fecha: z.string(),
  asunto: z.string(),
  cuerpo: z.string(),
});
export type AprobacionArchivo = z.infer<typeof AprobacionArchivoSchema>;

/** Paquete normalizado. Sección 7.2 del PRD. */
export const PaqueteSchema = z.object({
  correo: CorreoSchema,
  solicitud: SolicitudSchema,
  cotizacion: z
    .object({
      referencia: z.string().nullable(),
      proveedor: z.string(),
      nit: z.string().nullable(),
      total: z.number(),
      moneda: z.string(),
      validez_hasta: z.string().nullable(),
      texto: z.string(),
    })
    .nullable(),
  aprobacion: z
    .object({
      de: z.string(),
      fecha: z.string(),
      aprobado: z.boolean(),
      texto: z.string(),
    })
    .nullable(),
  factura: z.object({ numero: z.string(), fecha: z.string(), total: z.number() }).nullable(),
});
export type Paquete = z.infer<typeof PaqueteSchema>;

export const ProveedorSchema = z.object({
  codigo_sap: z.string(),
  nit: z.string(),
  nombre: z.string(),
  condiciones_pago_default: z.string(),
  indicador_iva_default: z.string(),
  activo: z.boolean(),
});
export type Proveedor = z.infer<typeof ProveedorSchema>;

export const CentroCostoSchema = z.object({
  centro_costo: z.string(),
  nombre: z.string(),
  subareas: z.array(z.string()),
  aprobadores: z.array(z.object({ email: z.string(), nombre: z.string(), tope: z.number() })),
});
export type CentroCosto = z.infer<typeof CentroCostoSchema>;

export const IndicadorIvaSchema = z.object({ codigo: z.string(), descripcion: z.string(), tasa: z.number() });
export const CondicionPagoSchema = z.object({ codigo: z.string(), descripcion: z.string(), dias: z.number() });

export interface Maestros {
  proveedores: Proveedor[];
  centrosCosto: CentroCosto[];
  indicadoresIva: z.infer<typeof IndicadorIvaSchema>[];
  condicionesPago: z.infer<typeof CondicionPagoSchema>[];
}

/** Orden de compra, inspirada en la API de órdenes de SAP. Sección 7.4 del PRD. */
export const OrdenCompraSchema = z.object({
  referencia: z.object({
    solicitud_id: z.string(),
    correo_id: z.string(),
    cotizacion_ref: z.string().nullable(),
  }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({ codigo_sap: z.string(), nit: z.string(), nombre: z.string() }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string(),
  aprobador: z.object({ email: z.string(), fecha_aprobacion: z.string(), evidencia_sha256: z.string().length(64) }),
  posiciones: z
    .array(
      z.object({
        numero: z.number().int().positive(),
        descripcion: z.string().max(40),
        cantidad: z.number().positive(),
        unidad: z.enum(["UN", "H", "MES"]),
        precio_unitario: z.number().nonnegative(),
        centro_costo: z.string(),
        subarea: z.string(),
        indicador_iva: z.string(),
      }),
    )
    .min(1),
  excepciones: z.array(z.object({ codigo: z.string(), detalle: z.string(), confirmado_por: z.string().nullable() })),
});
export type OrdenCompra = z.infer<typeof OrdenCompraSchema>;

/** Resultado de un control. `bloqueo` impide crear; `confirmacion` exige `confirmado = true`. */
export interface Hallazgo {
  regla: string;
  detalle: string;
  accion_sugerida?: string;
  valores?: Record<string, unknown>;
}

export interface Derivado {
  valor: string;
  fuente: string;
  detalle: string;
}

export interface Validacion {
  apta: boolean;
  bloqueos: Hallazgo[];
  confirmaciones: Hallazgo[];
  derivados: { indicador_iva?: Derivado; condiciones_pago?: Derivado };
  retroactiva: boolean;
  /** Estado de cada regla RC1–RC10, para mostrar qué pasó y qué no. */
  controles: { regla: string; estado: "ok" | "bloqueo" | "confirmacion" | "derivado" | "no_aplica"; detalle: string }[];
  /** Datos resueltos desde maestros que necesitan el payload y la evidencia. */
  contexto: { proveedor: Proveedor | null; aprobador: { email: string; nombre: string; tope: number } | null };
}
