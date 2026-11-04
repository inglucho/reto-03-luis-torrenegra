import { type AdaptadorLLM, ErrorLLM, type HerramientaLLM, type LlamadaHerramienta, type ResultadoHerramienta } from "../llm/adapter";
import type { Bitacora } from "./bitacora";
import { esConfirmacion, MENSAJE_SIN_CONFIRMACION } from "./confirmacion";
import type { Evento, UsoTurno } from "./eventos";
import { aHerramientaLLM, ejecutar, type HerramientaRegistrada, leerResultado } from "./herramientas";
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
  /** Tope de tokens por sesión, para que nadie gaste la clave sin límite. */
  maxTokensSesion?: number;
}

export type Emitir = (evento: Evento) => void;

const NOTA_TOPE =
  "Se alcanzó el tope de llamadas a herramientas de este turno. No llames más herramientas: " +
  "responde con lo que ya tienes y explica qué falta.";

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
    // CA3/RN4: `confirmado: true` solo vale para las acciones que pidieron confirmación en el turno
    // anterior, y solo si este mensaje las confirma. Un "sí" a otra pregunta no autoriza nada más.
    const autorizadas: ReadonlySet<string> = new Set(esConfirmacion(texto) ? sesion.confirmacionesPendientes : []);
    sesion.confirmacionesPendientes = [];
    sesion.mensajes.push({ rol: "usuario", texto });

    const uso: UsoTurno = { llamadasModelo: 0, tokensEntrada: 0, tokensSalida: 0, tokensCache: 0, tokensSesion: 0 };
    // Estado final por acción: si pidió confirmación y luego se ejecutó bien en el mismo turno, ya no está pendiente.
    const pendientes = new Map<string, boolean>();

    for (let iteracion = 1; ; iteracion++) {
      if (sesion.tokensUsados >= this.maxTokensSesion) {
        emitir({ tipo: "error", mensaje: "Esta conversación alcanzó su tope de uso. Inicia una conversación nueva." });
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
        console.error(err);
        emitir({ tipo: "error", mensaje: err instanceof ErrorLLM ? err.message : "Ocurrió un error inesperado al consultar el modelo." });
        break;
      }

      uso.llamadasModelo++;
      uso.tokensEntrada += respuesta.uso.entrada;
      uso.tokensSalida += respuesta.uso.salida;
      uso.tokensCache += respuesta.uso.cacheLectura + respuesta.uso.cacheEscritura;
      sesion.tokensUsados +=
        respuesta.uso.entrada + respuesta.uso.salida + respuesta.uso.cacheLectura + respuesta.uso.cacheEscritura;

      if (respuesta.fin === "rechazo") {
        emitir({ tipo: "error", mensaje: "El modelo declinó responder esta solicitud." });
        break;
      }

      sesion.mensajes.push({
        rol: "asistente",
        texto: respuesta.texto,
        llamadas: respuesta.llamadas,
        nativo: respuesta.nativo,
      });
      if (respuesta.llamadas.length === 0) break;

      // Una respuesta truncada puede traer argumentos incompletos, y pasado el tope no se ejecuta nada más.
      if (respuesta.fin === "limite" || iteracion > this.maxIteraciones) {
        const motivo = respuesta.fin === "limite" ? "la respuesta del modelo se cortó por longitud" : "se superó el tope de iteraciones";
        sesion.mensajes.push({ rol: "herramientas", resultados: respuesta.llamadas.map((ll) => noEjecutada(ll, motivo)) });
        emitir({ tipo: "error", mensaje: `El turno se detuvo porque ${motivo}.` });
        break;
      }

      const resultados: ResultadoHerramienta[] = [];
      for (const llamada of respuesta.llamadas) {
        const { resultado, autoriza } = await this.ejecutarLlamada(sesion, llamada, autorizadas, emitir);
        resultados.push(resultado);
        if (autoriza) pendientes.set(autoriza, true);
        else if (!resultado.error) pendientes.set(llamada.nombre, false);
      }
      sesion.mensajes.push({
        rol: "herramientas",
        resultados,
        nota: iteracion === this.maxIteraciones ? NOTA_TOPE : undefined,
      });
    }

    sesion.confirmacionesPendientes = [...pendientes].filter(([, pendiente]) => pendiente).map(([accion]) => accion);
    const necesitaConfirmacion = sesion.confirmacionesPendientes.length > 0;
    uso.tokensSesion = sesion.tokensUsados;
    emitir({ tipo: "fin_turno", necesitaConfirmacion, uso });
  }

  private async ejecutarLlamada(
    sesion: Sesion,
    llamada: LlamadaHerramienta,
    autorizadas: ReadonlySet<string>,
    emitir: Emitir,
  ): Promise<{ resultado: ResultadoHerramienta; autoriza: string | null }> {
    emitir({ tipo: "llamada", id: llamada.id, nombre: llamada.nombre, args: llamada.args });

    const h = this.porNombre.get(llamada.nombre);
    let contenido: string;
    if (!h) {
      contenido = JSON.stringify({ ok: false, error: `Herramienta desconocida: ${llamada.nombre}` });
    } else if (h.confirmable && pideConfirmado(llamada.args) && !autorizadas.has(h.nombre)) {
      contenido = JSON.stringify({
        ok: false,
        error: MENSAJE_SIN_CONFIRMACION,
        confirmacion: { motivo: "Falta la confirmación explícita del usuario para esta acción." },
      });
    } else {
      contenido = await ejecutar(h, llamada.args, { directory: this.config.directorio, sessionId: sesion.id });
    }

    const leido = leerResultado(contenido);
    const autoriza = leido.confirmacion ? accionAutorizada(llamada.nombre, leido.confirmacion.accion) : null;
    const pideConfirmacion = autoriza !== null;
    const resumen = resumir(leido);
    emitir({
      tipo: "resultado",
      id: llamada.id,
      nombre: llamada.nombre,
      ok: leido.ok,
      resumen,
      resultado: leido,
      pideConfirmacion,
    });
    await this.config.bitacora?.registrar({
      sessionId: sesion.id,
      herramienta: llamada.nombre,
      args: llamada.args,
      ok: leido.ok,
      resumen,
    });

    return {
      resultado: { id: llamada.id, nombre: llamada.nombre, contenido, error: !leido.ok },
      autoriza,
    };
  }
}

/** Acción que habilita una confirmación: la indicada (`<prefijo>_<accion>`) o la propia herramienta. */
function accionAutorizada(nombre: string, accion?: string): string {
  if (!accion) return nombre;
  const corte = nombre.indexOf("_");
  return corte > 0 ? `${nombre.slice(0, corte)}_${accion}` : accion;
}

function pideConfirmado(args: unknown): boolean {
  return typeof args === "object" && args !== null && (args as Record<string, unknown>).confirmado === true;
}

function noEjecutada(llamada: LlamadaHerramienta, motivo: string): ResultadoHerramienta {
  return {
    id: llamada.id,
    nombre: llamada.nombre,
    contenido: JSON.stringify({ ok: false, error: `No se ejecutó: ${motivo}.` }),
    error: true,
  };
}

/** Resumen de una línea para el chat y la bitácora. */
function resumir(r: ReturnType<typeof leerResultado>): string {
  if (r.confirmacion) return `Requiere confirmación: ${r.confirmacion.motivo}`;
  if (!r.ok) return r.error.slice(0, 200);
  const texto = JSON.stringify(r.data) ?? "sin datos";
  return texto.length > 200 ? `${texto.slice(0, 197)}…` : texto;
}
