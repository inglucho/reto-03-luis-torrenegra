import { z } from "zod";
import { type Contexto, fallo, ok, pideConfirmacion } from "../../src/core/herramientas";

/**
 * Herramientas mínimas para probar el núcleo del agente sin depender del dominio de
 * órdenes de compra. El modelo ve estas
 * herramientas como `ejemplo_consultar` y `ejemplo_aprobar`.
 */

interface Registro {
  codigo: string;
  descripcion: string;
  monto: number;
  estado: "pendiente" | "aprobado";
}

const registros = new Map<string, Registro>();

export function reiniciarRegistros(): void {
  registros.clear();
  registros.set("R-001", { codigo: "R-001", descripcion: "Licencias de software", monto: 1_200_000, estado: "pendiente" });
  registros.set("R-002", { codigo: "R-002", descripcion: "Mantenimiento de equipos", monto: 8_500_000, estado: "pendiente" });
}
reiniciarRegistros();

/** Por encima de este monto, aprobar exige confirmación humana. */
export const TOPE_SIN_CONFIRMACION = 5_000_000;

export const consultar = {
  description: "Consulta un registro por su código y devuelve su descripción, monto y estado.",
  args: {
    codigo: z.string().describe("Código del registro, p. ej. R-001"),
  },
  async execute(args: { codigo: string }, _ctx: Contexto): Promise<string> {
    const registro = registros.get(args.codigo.toUpperCase());
    return registro ? ok(registro) : fallo(`No existe el registro ${args.codigo}`);
  },
};

export const aprobar = {
  description: "Aprueba un registro; si el monto supera el tope, primero pide confirmación al usuario.",
  args: {
    codigo: z.string().describe("Código del registro a aprobar"),
    confirmado: z.boolean().optional().describe("true solo si el usuario confirmó explícitamente la aprobación"),
  },
  async execute(args: { codigo: string; confirmado?: boolean }, _ctx: Contexto): Promise<string> {
    const registro = registros.get(args.codigo.toUpperCase());
    if (!registro) return fallo(`No existe el registro ${args.codigo}`);
    if (registro.estado === "aprobado") return fallo(`El registro ${registro.codigo} ya estaba aprobado`);
    if (registro.monto > TOPE_SIN_CONFIRMACION && !args.confirmado) {
      return pideConfirmacion(`el monto ${registro.monto} supera el tope de ${TOPE_SIN_CONFIRMACION}`, registro);
    }
    registro.estado = "aprobado";
    return ok(registro);
  },
};

/** Revisión previa: pide confirmación y, si se indica, habilita `aprobar` para el siguiente turno. */
export const revisar = {
  description: "Revisa un registro antes de aprobarlo y pide confirmación a la persona usuaria.",
  args: {
    codigo: z.string().describe("Código del registro"),
    habilitar_aprobacion: z.boolean().optional().describe("true si la confirmación debe habilitar la aprobación"),
  },
  async execute(args: { codigo: string; habilitar_aprobacion?: boolean }, _ctx: Contexto): Promise<string> {
    const registro = registros.get(args.codigo.toUpperCase());
    if (!registro) return fallo(`No existe el registro ${args.codigo}`);
    const confirmacion = { motivo: `Revisar ${registro.codigo} antes de continuar`, ...(args.habilitar_aprobacion ? { accion: "aprobar" } : {}) };
    return JSON.stringify({ ok: true, data: registro, confirmacion });
  },
};
