import { beforeEach, describe, expect, test } from "bun:test";
import { Agente } from "../src/core/agente";
import { esConfirmacion } from "../src/core/confirmacion";
import type { Evento } from "../src/core/eventos";
import { registrar } from "../src/core/herramientas";
import type { Sesion } from "../src/core/sesiones";
import type { AdaptadorLLM, Mensaje, RespuestaLLM } from "../src/llm/adapter";
import * as ejemplo from "./apoyo/ejemplo";

const herramientas = registrar("ejemplo", ejemplo);
const uso = { entrada: 100, salida: 20, cacheLectura: 0, cacheEscritura: 0 };

const responde = (texto: string): RespuestaLLM => ({ texto, llamadas: [], fin: "fin", uso });
const llama = (id: string, nombre: string, args: unknown): RespuestaLLM => ({
  texto: "",
  llamadas: [{ id, nombre, args }],
  fin: "herramientas",
  uso,
});

/** Adaptador falso: devuelve respuestas guionizadas y guarda lo que recibe. */
function guionizado(respuestas: RespuestaLLM[]) {
  const recibidos: Mensaje[][] = [];
  const llm: AdaptadorLLM = {
    proveedor: "falso",
    modelo: "guion",
    async enviar(mensajes) {
      recibidos.push(structuredClone(mensajes));
      const siguiente = respuestas.shift();
      if (!siguiente) throw new Error("El guion se quedó sin respuestas");
      return siguiente;
    },
  };
  return { llm, recibidos };
}

function preparar(respuestas: RespuestaLLM[], opciones: { maxIteraciones?: number; maxTokensSesion?: number } = {}) {
  const { llm, recibidos } = guionizado(respuestas);
  const agente = new Agente({ sistema: "test", herramientas, llm, directorio: ".", ...opciones });
  const sesion: Sesion = { id: "s1", mensajes: [], confirmacionesPendientes: [], tokensUsados: 0 };
  const eventos: Evento[] = [];
  return { agente, sesion, eventos, emitir: (e: Evento) => eventos.push(e), recibidos };
}

/** Contenido del último resultado de herramienta que recibió el modelo. */
function ultimoResultado(recibidos: Mensaje[][]): { ok: boolean; error?: string; data?: unknown } {
  const mensajes = recibidos.at(-1) ?? [];
  const m = mensajes.findLast((x) => x.rol === "herramientas");
  if (!m || m.rol !== "herramientas") throw new Error("No hay resultados de herramientas");
  return JSON.parse(m.resultados.at(-1)?.contenido ?? "{}");
}

beforeEach(() => ejemplo.reiniciarRegistros());

describe("contrato de herramientas", () => {
  test("registra cada export como <archivo>_<export> y detecta las confirmables", () => {
    expect(herramientas.map((h) => [h.nombre, h.confirmable])).toEqual([
      ["ejemplo_aprobar", true],
      ["ejemplo_consultar", false],
      ["ejemplo_revisar", false],
    ]);
  });
});

describe("ciclo del agente", () => {
  test("ejecuta una herramienta y devuelve el resultado al modelo", async () => {
    const t = preparar([llama("t1", "ejemplo_consultar", { codigo: "R-001" }), responde("Está pendiente")]);
    await t.agente.turno(t.sesion, "¿cómo va R-001?", t.emitir);

    expect(t.eventos.map((e) => e.tipo)).toEqual(["llamada", "resultado", "fin_turno"]);
    expect(ultimoResultado(t.recibidos)).toMatchObject({ ok: true, data: { codigo: "R-001" } });
  });

  test("devuelve al modelo los argumentos inválidos como error, sin ejecutar", async () => {
    const t = preparar([llama("t1", "ejemplo_consultar", { codigo: 7 }), responde("Corrijo")]);
    await t.agente.turno(t.sesion, "consulta", t.emitir);

    const r = ultimoResultado(t.recibidos);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Argumentos inválidos");
  });

  test("informa herramientas desconocidas sin romper el turno", async () => {
    const t = preparar([llama("t1", "borrar_todo", {}), responde("No existe")]);
    await t.agente.turno(t.sesion, "borra", t.emitir);
    expect(ultimoResultado(t.recibidos).error).toContain("Herramienta desconocida");
  });

  test("CA1: al llegar al tope pide al modelo cerrar con lo que tiene", async () => {
    const t = preparar(
      [llama("a", "ejemplo_consultar", { codigo: "R-001" }), llama("b", "ejemplo_consultar", { codigo: "R-002" }), responde("Resumen")],
      { maxIteraciones: 2 },
    );
    await t.agente.turno(t.sesion, "consulta todo", t.emitir);

    const ultimo = t.recibidos.at(-1)?.at(-1);
    expect(ultimo?.rol === "herramientas" && ultimo.nota).toContain("tope");
  });

  test("CA5: un error del proveedor se informa y la sesión sigue usable", async () => {
    const t = preparar([]);
    await t.agente.turno(t.sesion, "hola", t.emitir);
    expect(t.eventos.map((e) => e.tipo)).toEqual(["error", "fin_turno"]);
  });

  test("detiene la sesión al superar el tope de tokens", async () => {
    const t = preparar([responde("uno"), responde("dos")], { maxTokensSesion: 100 });
    await t.agente.turno(t.sesion, "hola", t.emitir);
    await t.agente.turno(t.sesion, "otra vez", t.emitir);
    expect(t.recibidos).toHaveLength(1);
    expect(t.eventos.some((e) => e.tipo === "error" && e.mensaje.includes("tope"))).toBe(true);
  });
});

describe("CA3: confirmación humana", () => {
  test("la herramienta pide confirmación y el turno termina resaltado", async () => {
    const t = preparar([llama("t1", "ejemplo_aprobar", { codigo: "R-002" }), responde("¿Confirmas?")]);
    await t.agente.turno(t.sesion, "aprueba R-002", t.emitir);

    expect(t.eventos.at(-1)).toMatchObject({ tipo: "fin_turno", necesitaConfirmacion: true });
    expect(t.sesion.confirmacionesPendientes).toEqual(["ejemplo_aprobar"]);
  });

  test("tras la confirmación del usuario, `confirmado: true` se ejecuta", async () => {
    const t = preparar([
      llama("t1", "ejemplo_aprobar", { codigo: "R-002" }),
      responde("¿Confirmas?"),
      llama("t2", "ejemplo_aprobar", { codigo: "R-002", confirmado: true }),
      responde("Aprobado"),
    ]);
    await t.agente.turno(t.sesion, "aprueba R-002", t.emitir);
    await t.agente.turno(t.sesion, "Sí, confirmo", t.emitir);

    expect(ultimoResultado(t.recibidos)).toMatchObject({ ok: true, data: { estado: "aprobado" } });
    expect(t.sesion.confirmacionesPendientes).toEqual([]);
  });

  test("si en el mismo turno se confirma y se ejecuta bien, el turno ya no queda pendiente", async () => {
    const t = preparar([
      llama("t1", "ejemplo_aprobar", { codigo: "R-002" }),
      responde("¿Confirmas?"),
      llama("t2", "ejemplo_aprobar", { codigo: "R-002" }),
      llama("t3", "ejemplo_aprobar", { codigo: "R-002", confirmado: true }),
      responde("Aprobado"),
    ]);
    await t.agente.turno(t.sesion, "aprueba R-002", t.emitir);
    t.eventos.length = 0;
    await t.agente.turno(t.sesion, "Confirmo", t.emitir);
    expect(t.eventos.at(-1)).toMatchObject({ tipo: "fin_turno", necesitaConfirmacion: false });
  });

  test("el backend bloquea `confirmado: true` si el modelo lo usa sin que el usuario confirme", async () => {
    const t = preparar([llama("t1", "ejemplo_aprobar", { codigo: "R-002", confirmado: true }), responde("Ups")]);
    await t.agente.turno(t.sesion, "aprueba R-002", t.emitir);

    const r = ultimoResultado(t.recibidos);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("confirmado: true");
    const consulta = await ejemplo.consultar.execute({ codigo: "R-002" }, { directory: ".", sessionId: "x" });
    expect(JSON.parse(consulta).data.estado).toBe("pendiente");
  });

  test("un 'sí' a otra pregunta no autoriza una acción distinta (RN4)", async () => {
    const t = preparar([
      llama("t1", "ejemplo_revisar", { codigo: "R-002" }),
      responde("¿Confirmas la revisión?"),
      llama("t2", "ejemplo_aprobar", { codigo: "R-002", confirmado: true }),
      responde("Necesito tu confirmación para aprobar"),
    ]);
    await t.agente.turno(t.sesion, "revisa R-002", t.emitir);
    await t.agente.turno(t.sesion, "sí", t.emitir);
    expect(ultimoResultado(t.recibidos).error).toContain("confirmado: true");
    expect(t.sesion.confirmacionesPendientes).toEqual(["ejemplo_aprobar"]);
  });

  test("una herramienta puede habilitar otra acción con `accion` (p. ej. validar → crear)", async () => {
    const t = preparar([
      llama("t1", "ejemplo_revisar", { codigo: "R-002", habilitar_aprobacion: true }),
      responde("¿Apruebo?"),
      llama("t2", "ejemplo_aprobar", { codigo: "R-002", confirmado: true }),
      responde("Aprobado"),
    ]);
    await t.agente.turno(t.sesion, "revisa R-002", t.emitir);
    expect(t.sesion.confirmacionesPendientes).toEqual(["ejemplo_aprobar"]);
    await t.agente.turno(t.sesion, "confirmo", t.emitir);
    expect(ultimoResultado(t.recibidos)).toMatchObject({ ok: true, data: { estado: "aprobado" } });
  });

  test("una negativa del usuario no habilita la acción", async () => {
    const t = preparar([
      llama("t1", "ejemplo_aprobar", { codigo: "R-002" }),
      responde("¿Confirmas?"),
      llama("t2", "ejemplo_aprobar", { codigo: "R-002", confirmado: true }),
      responde("Entendido"),
    ]);
    await t.agente.turno(t.sesion, "aprueba R-002", t.emitir);
    await t.agente.turno(t.sesion, "No, todavía no", t.emitir);

    expect(ultimoResultado(t.recibidos).ok).toBe(false);
  });

  test("reconoce confirmaciones y negativas habituales", () => {
    for (const s of ["Confirmo", "sí, procede", "ok, créala", "confirmo el valor 0 y la fecha fin 2027-08-31"]) {
      expect(esConfirmacion(s)).toBe(true);
    }
    for (const s of ["no", "No, cancela", "espera, revisa el IVA", "¿qué pasó con R-001?"]) {
      expect(esConfirmacion(s)).toBe(false);
    }
  });
});
