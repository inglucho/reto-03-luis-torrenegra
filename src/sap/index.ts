import type { SapAdapter } from "./adapter";
import { SapMock } from "./mock";

/** Adaptador SAP en uso. Por defecto el simulado; los tests o un despliegue real pueden reemplazarlo. */
let fabrica: (dir: string) => SapAdapter = (dir) => new SapMock(dir);

export function usarSap(nueva: (dir: string) => SapAdapter): void {
  fabrica = nueva;
}

export function sap(dir: string): SapAdapter {
  return fabrica(dir);
}
