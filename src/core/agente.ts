import { type AdaptadorLLM, ErrorLLM, type HerramientaLLM, type LlamadaHerramienta, type ResultadoHerramienta } from "../llm/adapter";
import type { Bitacora } from "./bitacora";
import { esConfirmacion, MENSAJE_SIN_CONFIRMACION } from "./confirmacion";
import type { Evento, UsoTurno } from "./eventos";
import { aHerramientaLLM, ejecutar, fallo, type HerramientaRegistrada, leerResultado } from "./herramientas";
import type { PresupuestoDiario } from "./presupuesto";
import type { Sesion } from "./sesiones";

export interface ConfigAgente {
  sistema: string;
  herramientas: HerramientaRegistrada[];
  llm: AdaptadorLLM;
  /** Raíz del proyecto, que reciben las herramientas en `ctx.directory`. */
  directorio: string;
  bitacora?: Bitacora;
  /** CA1: máximo de rondas herramienta → modelo por turno. */
  maxIteraciones?: number;
  /** Tope de tokens por sesión. */
  maxTokensSesion?: number;
  /** Tope diario de tokens para todo el servidor (link público). */
  presupuesto?: PresupuestoDiario;
}

export type Emitir = (evento: Evento) => void;

const NOTA_TOPE =
  "Se alcanzó el tope de llamadas a herramientas de este turno. No llames más herramientas: " +
  "responde con lo que ya tienes y explica qué falta.";

/** Lo hecho en el turno, para cerrar con un resumen si se agota el tope. */
interface Hecho {
  nombre: string;
  resumen: string;
}

export class Agente {
  private readonly porNombre: Map<string, HerramientaRegistrada>;
  private readonly herramientasLLM: HerramientaLLM[];
  private readonly maxIteraciones: number;
  private readonly maxTokensSesion: number;

  constructor(private readonly config: ConfigAgente) {
    this.porNombre = new Map(config.herramientas.map((h) => [h.nombre, h]));
    this.herramientasLLM = config.herramientas.map(aHerramientaLLM);
    this.maxIteraciones = config.maxIteraciones ?? 25;
    this.maxTokensSesion = config.maxTokensSesion ?? 500_000;
  }

  get llm(): AdaptadorLLM {
    return this.config.llm;
  }

  get herramientas(): HerramientaRegistrada[] {
    return this.config.herramientas;
  }

  /** Procesa un mensaje del usuario: llama al modelo y ejecuta herramientas hasta obtener una respuesta. */
  async turno(sesion: Sesion, texto: string, emitir: Emitir): Promise<void> {
    // CA3/RN4: `confirmado: true` solo vale para las acciones (herramienta + caso) que pidieron
    // confirmación en el turno anterior, y solo si este mensaje las confirma.
    const autorizadas: ReadonlySet<string> = new Set(esConfirmacion(texto) ? sesion.confirmacionesPendientes : []);
    sesion.confirmacionesPendientes = [];
    sesion.mensajes.push({ rol: "usuario", texto });

    const uso: UsoTurno = { llamadasModelo: 0, tokensEntrada: 0, tokensSalida: 0, tokensCache: 0, tokensSesion: 0 };
    // Estado final por acción: si pidió confirmación y luego se ejecutó bien en el mismo turno, ya no está pendiente.
    const pendientes = new Map<string, boolean>();
    const hechos: Hecho[] = [];

    for (let iteracion = 1; ; iteracion++) {
      const tope = this.topeAlcanzado(sesion);
      if (tope) {
        emitir({ tipo: "error", mensaje: tope });
        break;
      }

      let respuesta: Awaited<ReturnType<AdaptadorLLM["enviar"]>>;
      try {
        respuesta = await this.config.llm.enviar(sesion.mensajes, this.herramientasLLM, {
          sistema: this.config.sistema,
          onTexto: (delta) => emitir({ tipo: "texto", delta }),
        });
      } catch (err) {
        // CA5: el error se muestra en lenguaje claro y la sesión sigue viva.
        registrarErrorProveedor(err);
        emitir({ tipo: "error", mensaje: err instanceof ErrorLLM ? err.message : "Ocurrió un error inesperado al consultar el modelo." });
        break;
      }

      const tokens = respuesta.uso.entrada + respuesta.uso.salida + respuesta.uso.cacheLectura + respuesta.uso.cacheEscritura;
      uso.llamadasModelo++;
      uso.tokensEntrada += respuesta.uso.entrada;
      uso.tokensSalida += respuesta.uso.salida;
      uso.tokensCache += respuesta.uso.cacheLectura + respuesta.uso.cacheEscritura;
      sesion.tokensUsados += tokens;
      this.config.presupuesto?.consumir(tokens);

      if (respuesta.fin === "rechazo") {
        emitir({ tipo: "error", mensaje: "El modelo declinó responder esta solicitud." });
        break;
      }

      sesion.mensajes.push({ rol: "asistente", texto: respuesta.texto, llamadas: respuesta.llamadas, nativo: respuesta.nativo });
      if (respuesta.llamadas.length === 0) break;

      // Una respuesta truncada puede traer argumentos incompletos, y pasado el tope no se ejecuta nada más.
      if (respuesta.fin === "limite" || iteracion > this.maxIteraciones) {
        const motivo = respuesta.fin === "limite" ? "la respuesta del modelo se cortó por longitud" : "se alcanzó el tope de pasos del turno";
        const resultados = [];
        for (const llamada of respuesta.llamadas) resultados.push(await this.noEjecutar(sesion, llamada, motivo, emitir));
        sesion.mensajes.push({ rol: "herramientas", resultados });
        this.cerrarSinTerminar(sesion, motivo, hechos, respuesta.llamadas, emitir);
        break;
      }

      const resultados: ResultadoHerramienta[] = [];
      for (const llamada of respuesta.llamadas) {
        const { resultado, autoriza, resumen } = await this.ejecutarLlamada(sesion, llamada, autorizadas, emitir);
        resultados.push(resultado);
        if (autoriza) pendientes.set(autoriza, true);
        else if (!resultado.error) pendientes.set(claveAccion(llamada.nombre, llamada.args), false);
        if (!resultado.error) hechos.push({ nombre: llamada.nombre, resumen });
      }
      sesion.mensajes.push({ rol: "herramientas", resultados, nota: iteracion === this.maxIteraciones ? NOTA_TOPE : undefined });
    }

    sesion.confirmacionesPendientes = [...pendientes].filter(([, pendiente]) => pendiente).map(([accion]) => accion);
    const necesitaConfirmacion = sesion.confirmacionesPendientes.length > 0;
    uso.tokensSesion = sesion.tokensUsados;
    emitir({ tipo: "fin_turno", necesitaConfirmacion, uso });
  }

  private topeAlcanzado(sesion: Sesion): string | null {
    if (sesion.tokensUsados >= this.maxTokensSesion) return "Esta conversación alcanzó su tope de uso. Inicia una conversación nueva.";
    if (this.config.presupuesto?.agotado()) return "Se alcanzó el tope diario de uso del agente. Vuelve a intentarlo mañana.";
    return null;
  }

  /** CA1: si el modelo sigue pidiendo herramientas pasado el tope, el turno cierra con lo hecho y lo que falta. */
  private cerrarSinTerminar(sesion: Sesion, motivo: string, hechos: Hecho[], faltan: LlamadaHerramienta[], emitir: Emitir) {
    const lineas = [
      `El turno se detuvo porque ${motivo}.`,
      "",
      hechos.length > 0 ? "**Lo que alcancé a hacer:**" : "No alcancé a completar ningún paso.",
      ...hechos.map((h) => `- ${h.nombre}: ${h.resumen}`),
      "",
      "**Lo que falta:**",
      ...faltan.map((ll) => `- ${ll.nombre}`),
      "",
      "Escribe “continúa” para seguir desde aquí.",
    ];
    const texto = lineas.join("\n");
    emitir({ tipo: "texto", delta: texto });
    sesion.mensajes.push({ rol: "asistente", texto, llamadas: [] });
  }

  private async noEjecutar(sesion: Sesion, llamada: LlamadaHerramienta, motivo: string, emitir: Emitir): Promise<ResultadoHerramienta> {
    emitir({ tipo: "llamada", id: llamada.id, nombre: llamada.nombre, args: llamada.args });
    const contenido = fallo(`No se ejecutó: ${motivo}.`);
    await this.informar(sesion, llamada, contenido, false, emitir);
    return { id: llamada.id, nombre: llamada.nombre, contenido, error: true };
  }

  private async ejecutarLlamada(
    sesion: Sesion,
    llamada: LlamadaHerramienta,
    autorizadas: ReadonlySet<string>,
    emitir: Emitir,
  ): Promise<{ resultado: ResultadoHerramienta; autoriza: string | null; resumen: string }> {
    emitir({ tipo: "llamada", id: llamada.id, nombre: llamada.nombre, args: llamada.args });

    const h = this.porNombre.get(llamada.nombre);
    let contenido: string;
    let ejecutada = false;
    if (!h) {
      contenido = fallo(`Herramienta desconocida: ${llamada.nombre}`);
    } else if (!h.esquema.safeParse(llamada.args ?? {}).success) {
      contenido = await ejecutar(h, llamada.args, this.contexto(sesion)); // devuelve el error de validación sin ejecutar
    } else if (h.confirmable && pideConfirmado(llamada.args) && !autorizadas.has(claveAccion(h.nombre, llamada.args))) {
      contenido = JSON.stringify({
        ok: false,
        error: MENSAJE_SIN_CONFIRMACION,
        confirmacion: { motivo: "Falta la confirmación explícita del usuario para esta acción." },
      });
    } else {
      contenido = await ejecutar(h, llamada.args, this.contexto(sesion));
      ejecutada = true;
    }

    const { autoriza, resumen } = await this.informar(sesion, llamada, contenido, ejecutada, emitir);
    return { resultado: { id: llamada.id, nombre: llamada.nombre, contenido, error: !leerResultado(contenido).ok }, autoriza, resumen };
  }

  /** Emite el resultado al chat y lo deja en la bitácora (CA4), se haya ejecutado o no. */
  private async informar(sesion: Sesion, llamada: LlamadaHerramienta, contenido: string, ejecutada: boolean, emitir: Emitir) {
    const leido = leerResultado(contenido);
    const autoriza = leido.confirmacion ? claveAccion(accionAutorizada(llamada.nombre, leido.confirmacion.accion), llamada.args) : null;
    const resumen = resumir(leido);
    emitir({ tipo: "resultado", id: llamada.id, nombre: llamada.nombre, ok: leido.ok, resumen, resultado: leido, pideConfirmacion: autoriza !== null });
    await this.config.bitacora?.registrar({ sessionId: sesion.id, herramienta: llamada.nombre, args: llamada.args, ok: leido.ok, resumen, ejecutada });
    return { autoriza, resumen };
  }

  private contexto(sesion: Sesion) {
    return { directory: this.config.directorio, sessionId: sesion.id };
  }
}

/** Acción que habilita una confirmación: la indicada (`<prefijo>_<accion>`) o la propia herramienta. */
function accionAutorizada(nombre: string, accion?: string): string {
  if (!accion) return nombre;
  const corte = nombre.indexOf("_");
  return corte > 0 ? `${nombre.slice(0, corte)}_${accion}` : accion;
}

/**
 * Una confirmación vale para una herramienta sobre un caso concreto: confirmar sol-004 no
 * autoriza crear sol-005. El caso se toma del argumento `caso` o `mensaje_id`, si existe.
 */
function claveAccion(nombre: string, args: unknown): string {
  const a = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const objeto = a.caso ?? a.mensaje_id;
  return typeof objeto === "string" ? `${nombre}#${objeto}` : nombre;
}

function pideConfirmado(args: unknown): boolean {
  return typeof args === "object" && args !== null && (args as Record<string, unknown>).confirmado === true;
}

/** Deja en el log del servidor qué falló, sin volcar el objeto de error completo del SDK. */
function registrarErrorProveedor(err: unknown) {
  const causa = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message.slice(0, 300)})` : "";
  console.error(`Error del proveedor de IA: ${err instanceof Error ? err.message : String(err)}${causa}`);
}

/** Resumen de una línea para el chat y la bitácora. */
function resumir(r: ReturnType<typeof leerResultado>): string {
  if (r.resumen) return r.resumen;
  if (r.confirmacion) return `Requiere confirmación: ${r.confirmacion.motivo}`;
  if (!r.ok) return r.error.slice(0, 240);
  return resumenGenerico(r.data);
}

/** Si la herramienta no da un resumen: los primeros campos simples del resultado, sin volcar JSON. */
function resumenGenerico(data: unknown): string {
  if (data === null || typeof data !== "object") return String(data ?? "Listo");
  const partes = Object.entries(data as Record<string, unknown>)
    .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))
    .slice(0, 4)
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${String(v)}`);
  return partes.length > 0 ? partes.join(" · ") : "Listo";
}
