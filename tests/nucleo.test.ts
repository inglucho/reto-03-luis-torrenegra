import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { Agente } from "../src/core/agente";
import { Bitacora } from "../src/core/bitacora";
import { esConfirmacion } from "../src/core/confirmacion";
import type { Evento } from "../src/core/eventos";
import { ok, pideConfirmacion, registrar } from "../src/core/herramientas";
import { LimitePorClave, PresupuestoDiario } from "../src/core/presupuesto";
import type { Sesion } from "../src/core/sesiones";
import type { AdaptadorLLM, Mensaje, RespuestaLLM } from "../src/llm/adapter";

/** Pruebas del núcleo con herramientas propias, independientes del dominio de cada reto. */
const creadas: string[] = [];
const herramientas = registrar("prueba", {
  validar: {
    description: "Valida un caso.",
    args: { caso: z.string().describe("caso") },
    async execute(a: { caso: string }) {
      return JSON.stringify({ ok: true, data: { caso: a.caso }, confirmacion: { motivo: "revisar", accion: "crear" } });
    },
  },
  crear: {
    description: "Crea un caso.",
    args: { caso: z.string().describe("caso"), confirmado: z.boolean().optional().describe("confirmación") },
    async execute(a: { caso: string; confirmado?: boolean }) {
      if (!a.confirmado) return pideConfirmacion("crear requiere confirmación");
      creadas.push(a.caso);
      return ok({ creado: a.caso }, `Creado ${a.caso}`);
    },
  },
});

const uso = { entrada: 10, salida: 5, cacheLectura: 0, cacheEscritura: 0 };
const llama = (id: string, nombre: string, args: unknown): RespuestaLLM => ({ texto: "", llamadas: [{ id, nombre, args }], fin: "herramientas", uso });
const responde = (texto: string): RespuestaLLM => ({ texto, llamadas: [], fin: "fin", uso });

const TEMPORAL = join(import.meta.dir, "..", ".tmp-tests");
afterAll(async () => {
  await rm(TEMPORAL, { recursive: true, force: true });
});

async function preparar(respuestas: RespuestaLLM[], extra: { maxIteraciones?: number; presupuesto?: PresupuestoDiario } = {}) {
  await mkdir(TEMPORAL, { recursive: true });
  const dir = await mkdtemp(join(TEMPORAL, "nucleo-"));
  const llm: AdaptadorLLM = {
    proveedor: "falso",
    modelo: "guion",
    async enviar(_m: Mensaje[]) {
      const r = respuestas.shift();
      if (!r) throw new Error("sin respuestas");
      return r;
    },
  };
  const agente = new Agente({ sistema: "s", herramientas, llm, directorio: dir, bitacora: new Bitacora(dir), ...extra });
  const sesion: Sesion = { id: "s", mensajes: [], confirmacionesPendientes: [], tokensUsados: 0 };
  const eventos: Evento[] = [];
  return { agente, sesion, eventos, emitir: (e: Evento) => eventos.push(e), dir };
}

describe("detección de confirmación (CA3)", () => {
  test.each(["sí", "Sí", "Sí, procede", "confirmo", "Confirmo.", "confirmo, no hay más cambios", "ok, créala", "dale", "confirmo el valor 0 y la fecha fin 2027-08-31"])(
    "%p confirma",
    (t) => expect(esConfirmacion(t)).toBe(true),
  );
  test.each(["no", "No, cancela esa acción.", "todavía no", "espera, revisa el IVA", "no la crees todavía", "No envíes nada todavía", "¿qué pasó con sol-001?"])(
    "%p no confirma",
    (t) => expect(esConfirmacion(t)).toBe(false),
  );
});

describe("confirmación ligada a la acción y al caso (RN4)", () => {
  test("confirmar sol-004 habilita crear sol-004, pero no sol-005", async () => {
    creadas.length = 0;
    const t = await preparar([
      llama("1", "prueba_validar", { caso: "sol-004" }),
      responde("¿Confirmas?"),
      llama("2", "prueba_crear", { caso: "sol-005", confirmado: true }),
      llama("3", "prueba_crear", { caso: "sol-004", confirmado: true }),
      responde("Listo"),
    ]);
    await t.agente.turno(t.sesion, "valida sol-004", t.emitir);
    expect(t.sesion.confirmacionesPendientes).toEqual(["prueba_crear#sol-004"]);
    await t.agente.turno(t.sesion, "sí", t.emitir);
    expect(creadas).toEqual(["sol-004"]);
  });
});

describe("bitácora y tope (CA4, CA1)", () => {
  test("las llamadas que no se ejecutan también quedan en out/log.jsonl", async () => {
    const t = await preparar([llama("1", "prueba_inexistente", {}), llama("2", "prueba_validar", { caso: 7 }), responde("ok")]);
    await t.agente.turno(t.sesion, "hola", t.emitir);
    const lineas = (await Bun.file(join(t.dir, "out/log.jsonl")).text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lineas.map((l) => [l.herramienta, l.ejecutada])).toEqual([
      ["prueba_inexistente", false],
      ["prueba_validar", false],
    ]);
  });

  test("pasado el tope, el turno cierra con lo hecho y lo que falta", async () => {
    const t = await preparar([llama("1", "prueba_validar", { caso: "a" }), llama("2", "prueba_validar", { caso: "b" })], { maxIteraciones: 1 });
    await t.agente.turno(t.sesion, "valida todo", t.emitir);
    const texto = t.eventos.filter((e) => e.tipo === "texto").map((e) => (e.tipo === "texto" ? e.delta : "")).join("");
    expect(texto).toContain("Lo que alcancé a hacer");
    expect(texto).toContain("Lo que falta");
    expect(t.eventos.filter((e) => e.tipo === "resultado")).toHaveLength(2);
  });
});

describe("límites de costo (sección 8)", () => {
  test("el presupuesto diario detiene el turno al agotarse", async () => {
    const presupuesto = new PresupuestoDiario(10);
    presupuesto.consumir(10);
    const t = await preparar([responde("no debería llamarse")], { presupuesto });
    await t.agente.turno(t.sesion, "hola", t.emitir);
    expect(t.eventos[0]).toMatchObject({ tipo: "error" });
  });

  test("el límite por IP corta al superar el máximo de la ventana", () => {
    const limite = new LimitePorClave(2, 60_000);
    expect([limite.permitir("ip"), limite.permitir("ip"), limite.permitir("ip"), limite.permitir("otra")]).toEqual([true, true, false, true]);
  });
});
