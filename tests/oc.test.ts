import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { leerResultado } from "../src/core/herramientas";
import { aNumero, cargarMaestros, contieneAprobado, leerPaquete, normalizarNit, parsearCotizacion } from "../src/oc/fuentes";
import { construirPayload, inferirUnidad, MAX_DESCRIPCION, textoBreve } from "../src/oc/payload";
import { normalizarNombre, validar } from "../src/oc/reglas";
import type { Maestros, Paquete } from "../src/oc/tipos";
import { crear, leer_paquete, validar as validarTool } from "../src/tools/oc";

const RAIZ = join(import.meta.dir, "..");
/** Carpeta temporal dentro del proyecto (ignorada por git). */
const TEMPORAL = join(RAIZ, ".tmp-tests");

/** Cada test de herramientas trabaja sobre una copia de los fixtures, con su propio `out/`. */
let dir: string;
const ctx = () => ({ directory: dir, sessionId: "test" });
beforeEach(async () => {
  await mkdir(TEMPORAL, { recursive: true });
  dir = await mkdtemp(join(TEMPORAL, "caso-"));
  await cp(join(RAIZ, "fixtures"), join(dir, "fixtures"), { recursive: true });
  // Los fixtures originales son de solo lectura; la copia de prueba debe poder modificarse.
  await Bun.$`chmod -R u+w ${dir}`;
});
afterAll(async () => {
  await rm(TEMPORAL, { recursive: true, force: true });
});

let maestros: Maestros;
const paquete = async (caso: string) => (await leerPaquete(RAIZ, caso)).paquete;
const reglasDe = (lista: { regla: string }[]) => lista.map((h) => h.regla);

/** Variante de un paquete válido (sol-001) con cambios en la solicitud. */
async function variante(cambios: Partial<Paquete["solicitud"]>, resto: Partial<Paquete> = {}): Promise<Paquete> {
  const base = await paquete("sol-001");
  return { ...base, ...resto, solicitud: { ...base.solicitud, ...cambios } };
}

describe("parseo de fuentes", () => {
  test("lee montos colombianos y NIT con dígito de verificación", () => {
    expect(aNumero("COP 11.400.000")).toBe(11400000);
    expect(aNumero("sin número")).toBeNull();
    expect(normalizarNit("900.555.111-2")).toBe("900555111");
  });

  test("extrae referencia, NIT, total y validez de la cotización", async () => {
    const texto = await Bun.file(join(RAIZ, "fixtures/reto-03/solicitudes/sol-004/cotizacion.txt")).text();
    expect(parsearCotizacion(texto)).toMatchObject({
      referencia: "CA-2026-0310",
      nit: "901222333",
      total: 26500000,
      moneda: "COP",
      validez_hasta: "2026-09-14",
    });
  });

  test("reconoce 'Aprobado' y descarta negaciones", () => {
    expect(contieneAprobado("Aprobado por 25 millones")).toBe(true);
    expect(contieneAprobado("No aprobado, falta presupuesto")).toBe(false);
    expect(contieneAprobado("Revisemos la próxima semana")).toBe(false);
  });

  test("normaliza nombres de proveedor sin tildes ni sufijos societarios", () => {
    expect(normalizarNombre("TecnoSuministros S.A.S.")).toBe(normalizarNombre("tecnosuministros sas"));
    expect(normalizarNombre("Papelería Central Ltda.")).toBe("papeleria central");
  });
});

describe("reglas RC1–RC10 sobre los fixtures", () => {
  beforeEach(async () => {
    maestros ??= await cargarMaestros(RAIZ);
  });

  test.each([
    ["sol-001", [], []],
    ["sol-002", ["RC1"], []],
    ["sol-003", ["RC2"], []],
    ["sol-004", [], ["RC5"]],
    ["sol-005", [], ["RC8"]],
    ["sol-006", [], ["RC6"]],
  ])("%s → bloqueos %p, confirmaciones %p", async (caso, bloqueos, confirmaciones) => {
    const v = validar(await paquete(caso), maestros);
    expect(reglasDe(v.bloqueos)).toEqual(bloqueos);
    expect(reglasDe(v.confirmaciones)).toEqual(confirmaciones);
    expect(v.controles.map((c) => c.regla)).toEqual(["RC1", "RC2", "RC3", "RC4", "RC5", "RC6", "RC7", "RC8", "RC9", "RC10"]);
  });

  test("sol-005 queda marcada como retroactiva", async () => {
    expect(validar(await paquete("sol-005"), maestros).retroactiva).toBe(true);
  });

  test("sol-006 encuentra el proveedor por nombre y deriva IVA y condiciones de pago", async () => {
    const v = validar(await paquete("sol-006"), maestros);
    expect(v.contexto.proveedor?.codigo_sap).toBe("100234");
    expect(v.derivados).toMatchObject({ indicador_iva: { valor: "C1" }, condiciones_pago: { valor: "Z030" } });
  });

  test("RC1 bloquea un proveedor inactivo", async () => {
    const v = validar(await variante({ proveedor_nit: "901777888", proveedor_nombre: "Consultores Ágiles S.A.S." }), maestros);
    expect(v.bloqueos[0]?.detalle).toContain("inactivo");
  });

  test("RC3 bloquea un valor por encima del tope del aprobador", async () => {
    const v = validar(await variante({ cantidad: 600, valor_total: 57_000_000 }), maestros);
    expect(reglasDe(v.bloqueos)).toEqual(["RC3"]);
  });

  test("RC4 bloquea una subárea que no pertenece al centro", async () => {
    expect(reglasDe(validar(await variante({ subarea: "Marketing" }), maestros).bloqueos)).toEqual(["RC4"]);
  });

  test("RC5 pide confirmación si no hay cotización", async () => {
    const v = validar(await variante({}, { cotizacion: null }), maestros);
    expect(reglasDe(v.confirmaciones)).toEqual(["RC5"]);
  });

  test("RC9 pide confirmación si la aprobación es anterior a la solicitud", async () => {
    expect(reglasDe(validar(await variante({ fecha_solicitud: "2026-08-25" }), maestros).confirmaciones)).toEqual(["RC9"]);
  });

  test("RC10 bloquea si cantidad × valor unitario no da el total (con tolerancia de 1)", async () => {
    expect(reglasDe(validar(await variante({ valor_total: 11_400_001 }), maestros).bloqueos)).toEqual([]);
    expect(reglasDe(validar(await variante({ valor_total: 11_500_000 }), maestros).bloqueos)).toContain("RC10");
  });
});

describe("payload SAP", () => {
  test("texto breve: máximo 40 caracteres, cortado en palabra y sin conectores al final", () => {
    const t = textoBreve("Bolsa de 100 horas de arquitectura de nube para migración");
    expect(t).toBe("Bolsa de 100 horas de arquitectura");
    expect(t.length).toBeLessThanOrEqual(MAX_DESCRIPCION);
  });

  test("infiere la unidad de medida", () => {
    expect(inferirUnidad("Bolsa de 100 horas de arquitectura")).toBe("H");
    expect(inferirUnidad("Papelería y tóner")).toBe("UN");
  });

  test("todo valor del payload tiene una fuente en la trazabilidad", async () => {
    maestros ??= await cargarMaestros(RAIZ);
    const p = await paquete("sol-006");
    const { orden, trazabilidad } = construirPayload({ paquete: p, validacion: validar(p, maestros), evidenciaSha256: "a".repeat(64), confirmadoPor: null });
    expect(orden.posiciones[0]?.indicador_iva).toBe("C1");
    expect(trazabilidad["posiciones[0].indicador_iva"]?.fuente).toBe("derivado");
    expect(trazabilidad.proveedor?.fuente).toBe("maestro.proveedores");
  });
});

describe("herramientas (contrato y errores, HU-6)", () => {
  test("un caso inexistente devuelve un error legible, sin lanzar", async () => {
    const r = leerResultado(await leer_paquete.execute({ caso: "sol-999" }, ctx()));
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toContain("No existe el caso");
  });

  test("un JSON malformado o un monto no numérico se informan sin romper", async () => {
    const carpeta = join(dir, "fixtures/reto-03/solicitudes/sol-001");
    await writeFile(join(carpeta, "solicitud.json"), "{ esto no es json");
    expect(leerResultado(await leer_paquete.execute({ caso: "sol-001" }, ctx()))).toMatchObject({ ok: false });

    const solicitud = JSON.parse(await Bun.file(join(RAIZ, "fixtures/reto-03/solicitudes/sol-001/solicitud.json")).text());
    await writeFile(join(carpeta, "solicitud.json"), JSON.stringify({ ...solicitud, valor_total: "once millones" }));
    const r = leerResultado(await validarTool.execute({ caso: "sol-001" }, ctx()));
    expect(!r.ok && r.error).toContain("valor_total");
  });

  test("un adjunto ausente se reporta como null y en faltantes", async () => {
    await rm(join(dir, "fixtures/reto-03/solicitudes/sol-001/cotizacion.txt"));
    const r = leerResultado(await leer_paquete.execute({ caso: "sol-001" }, ctx()));
    expect(r.ok && r.data).toMatchObject({ cotizacion: null, faltantes: ["cotizacion.pdf"] });
  });

  test("validar marca la confirmación pendiente para que el chat la resalte", async () => {
    const r = leerResultado(await validarTool.execute({ caso: "sol-004" }, ctx()));
    expect(r.ok).toBe(true);
    expect(r.confirmacion?.motivo).toContain("RC5");
  });

  test("crear: bloqueada, pendiente, confirmada e idempotente", async () => {
    const bloqueada = leerResultado(await crear.execute({ caso: "sol-002" }, ctx()));
    expect(!bloqueada.ok && bloqueada.error).toContain("RC1");

    const pendiente = leerResultado(await crear.execute({ caso: "sol-005" }, ctx()));
    expect(pendiente.ok).toBe(false);
    expect(pendiente.confirmacion).toBeDefined();

    const creada = leerResultado(await crear.execute({ caso: "sol-005", confirmado: true }, ctx()));
    expect(creada.ok && creada.data).toMatchObject({ numero_oc: "4500000001", retroactiva: true, idempotente: false });

    const otra = leerResultado(await crear.execute({ caso: "sol-005", confirmado: true }, ctx()));
    expect(otra.ok && otra.data).toMatchObject({ numero_oc: "4500000001", idempotente: true });

    const control = await Bun.file(join(dir, "out/control.csv")).text();
    expect(control).toContain("SOL-2026-005,creada,4500000001,true");
  });

  test("crear rechaza un payload alterado por el modelo", async () => {
    const r = leerResultado(await crear.execute({ caso: "sol-001" }, ctx()));
    expect(r.ok).toBe(true);
    await rm(join(dir, "out/sap"), { recursive: true });
    const orden = JSON.parse((await Bun.file(join(dir, "out/sol-001/trazabilidad.json")).text())) as Record<string, { valor: unknown }>;
    expect(orden.moneda?.valor).toBe("COP");

    const p = await leerPaquete(dir, "sol-001");
    maestros ??= await cargarMaestros(RAIZ);
    const { orden: real } = construirPayload({ paquete: p.paquete, validacion: validar(p.paquete, maestros), evidenciaSha256: "0".repeat(64), confirmadoPor: null });
    const alterada = { ...real, posiciones: real.posiciones.map((x) => ({ ...x, precio_unitario: 1 })) };
    const rechazo = leerResultado(await crear.execute({ caso: "sol-001", payload: alterada }, ctx()));
    expect(!rechazo.ok && rechazo.error).toContain("difiere");
  });
});
