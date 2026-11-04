import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import * as herramientasApp from "../src/tools/oc";
import * as herramientasModulo from "../modulo/tools/oc";
import { contenidoModulo } from "../scripts/generar-modulo";

describe("modulo/ (bonus 9.4)", () => {
  test("agent.md y SKILL.md están sincronizados con el prompt y el conocimiento de la app", async () => {
    for (const [ruta, esperado] of Object.entries(await contenidoModulo())) {
      expect(await Bun.file(join(import.meta.dir, "..", ruta)).text()).toBe(esperado);
    }
  });

  test("las herramientas del módulo son exactamente las de la aplicación", () => {
    expect(Object.keys(herramientasModulo).sort()).toEqual(Object.keys(herramientasApp).sort());
    expect(herramientasModulo.crear).toBe(herramientasApp.crear);
  });
});
