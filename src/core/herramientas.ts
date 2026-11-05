import { z } from "zod";
import type { HerramientaLLM } from "../llm/adapter";

/** Contexto que recibe cada herramienta (contrato de la sección 6.2 del PRD). */
export interface Contexto {
  /** Raíz del proyecto; las rutas se resuelven desde aquí, nunca absolutas. */
  directory: string;
  sessionId: string;
}

/**
 * Contrato de herramienta del PRD: una descripción de una frase, los argumentos como
 * esquemas zod con `.describe()`, y `execute`, que devuelve un JSON serializado
 * `{ ok: true, data }` o `{ ok: false, error }` y nunca lanza.
 */
export interface Herramienta<A extends z.ZodRawShape = z.ZodRawShape> {
  description: string;
  args: A;
  execute(args: z.output<z.ZodObject<A>>, ctx: Contexto): Promise<string>;
}

/**
 * `confirmacion` marca que hay algo que el usuario debe confirmar antes de seguir:
 * con `ok: false`, la acción no se ejecutó por falta de confirmación; con `ok: true`,
 * los datos están listos pero la siguiente acción la necesitará. El chat resalta el turno.
 */
export interface Confirmacion {
  motivo: string;
  detalles?: unknown;
  /**
   * Acción que esta confirmación habilita: el nombre de un export del mismo archivo
   * (p. ej. una validación habilita `crear`). Si se omite, la propia herramienta.
   */
  accion?: string;
}

/** `resumen`: una frase legible para el chat; si falta, el chat muestra un resumen genérico. */
export type Resultado<T> =
  | { ok: true; data: T; confirmacion?: Confirmacion; resumen?: string }
  | { ok: false; error: string; confirmacion?: Confirmacion; resumen?: string };

export const ok = <T>(data: T, resumen?: string): string =>
  JSON.stringify({ ok: true, data, ...(resumen ? { resumen } : {}) } satisfies Resultado<T>);

export const fallo = (error: string): string => JSON.stringify({ ok: false, error } satisfies Resultado<never>);

/** Respuesta estándar de una acción que exige confirmación humana antes de ejecutarse. */
export const pideConfirmacion = (motivo: string, detalles?: unknown): string =>
  JSON.stringify({
    ok: false,
    error: `Requiere confirmación del usuario: ${motivo}`,
    confirmacion: { motivo, detalles },
  } satisfies Resultado<never>);

/** Envuelve el cuerpo de una herramienta para que cualquier excepción se convierta en `{ ok: false }`. */
export async function seguro<T>(cuerpo: () => T | Promise<T>): Promise<string> {
  try {
    return ok(await cuerpo());
  } catch (err) {
    return fallo(err instanceof Error ? err.message : String(err));
  }
}

/** Herramienta ya registrada con el nombre que ve el modelo: `<archivo>_<export>`. */
export interface HerramientaRegistrada {
  nombre: string;
  herramienta: Herramienta;
  esquema: z.ZodObject<z.ZodRawShape>;
  /** Si acepta `confirmado`, el backend vigila que solo se use tras una confirmación real. */
  confirmable: boolean;
}

function esHerramienta(valor: unknown): valor is Herramienta {
  if (typeof valor !== "object" || valor === null) return false;
  const v = valor as Record<string, unknown>;
  return typeof v.description === "string" && typeof v.execute === "function" && typeof v.args === "object";
}

/** Registra cada export de un módulo de herramientas como `<prefijo>_<export>`. */
export function registrar(prefijo: string, modulo: Record<string, unknown>): HerramientaRegistrada[] {
  return Object.entries(modulo)
    .filter((entrada): entrada is [string, Herramienta] => esHerramienta(entrada[1]))
    .map(([nombre, herramienta]) => ({
      nombre: `${prefijo}_${nombre}`,
      herramienta,
      esquema: z.object(herramienta.args).strict(),
      confirmable: "confirmado" in herramienta.args,
    }));
}

export function aHerramientaLLM(h: HerramientaRegistrada): HerramientaLLM {
  const { $schema: _omitido, ...esquema } = z.toJSONSchema(h.esquema, { io: "input" }) as Record<string, unknown>;
  return { nombre: h.nombre, descripcion: h.herramienta.description, esquema };
}

/** Valida los argumentos con zod y ejecuta. Nunca lanza: todo error vuelve como `{ ok: false }`. */
export async function ejecutar(h: HerramientaRegistrada, args: unknown, ctx: Contexto): Promise<string> {
  const parsed = h.esquema.safeParse(args ?? {});
  if (!parsed.success) return fallo(`Argumentos inválidos para ${h.nombre}: ${z.prettifyError(parsed.error)}`);
  try {
    return await h.herramienta.execute(parsed.data, ctx);
  } catch (err) {
    // Defensa adicional: el contrato prohíbe lanzar, pero un error no debe tumbar la sesión.
    return fallo(`Error interno en ${h.nombre}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Lee el resultado serializado de una herramienta sin lanzar si no es JSON válido. */
export function leerResultado(contenido: string): Resultado<unknown> {
  try {
    const valor = JSON.parse(contenido) as Resultado<unknown>;
    if (typeof valor === "object" && valor !== null && "ok" in valor) return valor;
  } catch {}
  return { ok: false, error: "La herramienta devolvió un resultado que no es JSON válido." };
}
