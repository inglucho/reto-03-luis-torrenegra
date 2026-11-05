import { normalizarNit } from "./fuentes";
import type { CentroCosto, Derivado, Hallazgo, Maestros, Paquete, Proveedor, Validacion } from "./tipos";

/** RC5: diferencia máxima admitida entre cotización y solicitud. */
export const TOLERANCIA_COTIZACION = 0.02;
/** RC10: diferencia máxima entre cantidad × valor unitario y valor total. */
export const TOLERANCIA_TOTAL = 1;

type Control = Validacion["controles"][number];

/** Nombre comparable: sin tildes, mayúsculas, puntuación ni sufijos societarios. */
export function normalizarNombre(nombre: string): string {
  return nombre
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(s ?a ?s|s ?a|ltda|limitada|sas)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Fecha calendario (YYYY-MM-DD) de una marca ISO, en la zona horaria en que se escribió. */
const dia = (fecha: string) => fecha.slice(0, 10);

const cop = (n: number) => `${n.toLocaleString("es-CO")}`;

/** Acumula hallazgos y el estado de cada regla. */
class Informe {
  readonly bloqueos: Hallazgo[] = [];
  readonly confirmaciones: Hallazgo[] = [];
  readonly controles: Control[] = [];

  ok(regla: string, detalle: string) {
    this.controles.push({ regla, estado: "ok", detalle });
  }
  noAplica(regla: string, detalle: string) {
    this.controles.push({ regla, estado: "no_aplica", detalle });
  }
  derivado(regla: string, detalle: string) {
    this.controles.push({ regla, estado: "derivado", detalle });
  }
  bloqueo(h: Hallazgo) {
    this.bloqueos.push(h);
    this.controles.push({ regla: h.regla, estado: "bloqueo", detalle: h.detalle });
  }
  confirmacion(h: Hallazgo) {
    this.confirmaciones.push(h);
    this.controles.push({ regla: h.regla, estado: "confirmacion", detalle: h.detalle });
  }
}

/** RC1: el proveedor existe (por NIT; si no hay NIT, por nombre normalizado) y está activo. */
function rc1Proveedor(p: Paquete, m: Maestros, inf: Informe): Proveedor | null {
  const { proveedor_nit, proveedor_nombre } = p.solicitud;
  const proveedor = proveedor_nit
    ? m.proveedores.find((x) => x.nit === normalizarNit(proveedor_nit))
    : m.proveedores.find((x) => normalizarNombre(x.nombre) === normalizarNombre(proveedor_nombre));
  const criterio = proveedor_nit ? `NIT ${proveedor_nit}` : `nombre "${proveedor_nombre}" (la solicitud no trae NIT)`;
  if (!proveedor) {
    inf.bloqueo({
      regla: "RC1",
      detalle: `El proveedor con ${criterio} no existe en el maestro de proveedores.`,
      accion_sugerida: "Solicitar la creación del proveedor en SAP (RUT, certificación bancaria) antes de emitir la OC.",
    });
    return null;
  }
  if (!proveedor.activo) {
    inf.bloqueo({
      regla: "RC1",
      detalle: `El proveedor ${proveedor.nombre} (${proveedor.codigo_sap}) está inactivo en el maestro.`,
      accion_sugerida: "Pedir a Compras que reactive el proveedor o cotizar con uno activo.",
    });
    return null;
  }
  inf.ok("RC1", `Proveedor ${proveedor.nombre} (código SAP ${proveedor.codigo_sap}) encontrado por ${criterio}, activo.`);
  return proveedor;
}

/** RC2: hay aprobación, dice "Aprobado" y viene de un aprobador del centro de costo. */
function rc2Aprobacion(p: Paquete, centro: CentroCosto | undefined, inf: Informe) {
  const accion = "Solicitar la aprobación a un aprobador autorizado del centro de costo.";
  if (!p.aprobacion) {
    inf.bloqueo({ regla: "RC2", detalle: "No llegó el correo de aprobación del líder.", accion_sugerida: accion });
    return null;
  }
  if (!p.aprobacion.aprobado) {
    inf.bloqueo({ regla: "RC2", detalle: `El correo de ${p.aprobacion.de} no contiene "Aprobado".`, accion_sugerida: accion });
    return null;
  }
  if (!centro) {
    inf.bloqueo({ regla: "RC2", detalle: `El centro de costo ${p.solicitud.centro_costo} no existe; no se puede verificar al aprobador.`, accion_sugerida: "Corregir el centro de costo en la solicitud." });
    return null;
  }
  const aprobador = centro.aprobadores.find((a) => a.email.toLowerCase() === p.aprobacion?.de.toLowerCase());
  if (!aprobador) {
    const validos = centro.aprobadores.map((a) => `${a.nombre} (${a.email})`).join(", ");
    inf.bloqueo({
      regla: "RC2",
      detalle: `${p.aprobacion.de} no es aprobador del centro ${centro.centro_costo} (${centro.nombre}). Aprobadores válidos: ${validos}.`,
      accion_sugerida: accion,
    });
    return null;
  }
  inf.ok("RC2", `Aprobado por ${aprobador.nombre}, aprobador del centro ${centro.centro_costo}.`);
  return aprobador;
}

/** RC3: el valor total no supera el tope del aprobador en ese centro. */
function rc3Tope(p: Paquete, aprobador: { nombre: string; tope: number } | null, inf: Informe) {
  if (!aprobador) return inf.noAplica("RC3", "No evaluable: no hay un aprobador válido (ver RC2).");
  if (p.solicitud.valor_total > aprobador.tope) {
    return inf.bloqueo({
      regla: "RC3",
      detalle: `El valor ${cop(p.solicitud.valor_total)} supera el tope de ${aprobador.nombre} (${cop(aprobador.tope)}).`,
      accion_sugerida: "Escalar la aprobación a un aprobador con tope suficiente.",
      valores: { valor_total: p.solicitud.valor_total, tope: aprobador.tope },
    });
  }
  inf.ok("RC3", `${cop(p.solicitud.valor_total)} dentro del tope de ${aprobador.nombre} (${cop(aprobador.tope)}).`);
}

/** RC4: la subárea pertenece al centro de costo. */
function rc4Subarea(p: Paquete, centro: CentroCosto | undefined, inf: Informe) {
  const { centro_costo, subarea } = p.solicitud;
  if (!centro) {
    return inf.bloqueo({ regla: "RC4", detalle: `El centro de costo ${centro_costo} no existe.`, accion_sugerida: "Corregir el centro de costo en la solicitud." });
  }
  if (!centro.subareas.includes(subarea)) {
    return inf.bloqueo({
      regla: "RC4",
      detalle: `La subárea "${subarea}" no pertenece a ${centro_costo}. Subáreas válidas: ${centro.subareas.join(", ")}.`,
      accion_sugerida: "Corregir la subárea con el solicitante.",
    });
  }
  inf.ok("RC4", `Subárea ${subarea} pertenece a ${centro_costo}.`);
}

/** RC5: la cotización no difiere más del 2 % de la solicitud. */
function rc5Cotizacion(p: Paquete, inf: Informe) {
  const { valor_total } = p.solicitud;
  const total = p.cotizacion?.total ?? null;
  if (!p.cotizacion || total === null || !Number.isFinite(total)) {
    return inf.confirmacion({
      regla: "RC5",
      detalle: p.cotizacion ? "No se pudo leer el total de la cotización." : "La solicitud llegó sin cotización del proveedor.",
      accion_sugerida: "Confirmar que se acepta crear la OC sin contrastar con la cotización.",
    });
  }
  const diferencia = Math.abs(total - valor_total) / valor_total;
  const pct = `${(diferencia * 100).toFixed(2)} %`;
  if (diferencia > TOLERANCIA_COTIZACION) {
    return inf.confirmacion({
      regla: "RC5",
      detalle: `La cotización (${cop(total)}) difiere ${pct} (${cop(Math.abs(total - valor_total))}) de la solicitud (${cop(valor_total)}); el máximo es 2 %.`,
      accion_sugerida: "Confirmar el valor de la solicitud o pedir una solicitud corregida.",
      valores: {
        solicitud: valor_total,
        cotizacion: total,
        diferencia_valor: total - valor_total,
        diferencia_pct: Number((diferencia * 100).toFixed(2)),
      },
    });
  }
  inf.ok("RC5", `Cotización ${cop(total)} vs. solicitud ${cop(valor_total)}: diferencia ${pct}.`);
}

/** RC6 y RC7: indicador de IVA y condiciones de pago; si faltan, se derivan del proveedor. */
function rc6rc7Derivados(p: Paquete, proveedor: Proveedor | null, inf: Informe) {
  const derivados: Validacion["derivados"] = {};
  const { indicador_iva, condiciones_pago } = p.solicitud;

  if (indicador_iva) inf.ok("RC6", `Indicador de IVA informado en la solicitud: ${indicador_iva}.`);
  else if (!proveedor) inf.noAplica("RC6", "IVA no informado y no se puede derivar sin proveedor válido.");
  else {
    derivados.indicador_iva = derivar(proveedor.indicador_iva_default, "IVA");
    inf.confirmacion({
      regla: "RC6",
      detalle: `La solicitud no informa indicador de IVA; se propone ${proveedor.indicador_iva_default}, el predeterminado del proveedor (${proveedor.nombre}).`,
      accion_sugerida: "Confirmar el indicador de IVA derivado.",
      valores: { indicador_iva_propuesto: proveedor.indicador_iva_default },
    });
  }

  if (condiciones_pago) inf.ok("RC7", `Condiciones de pago informadas en la solicitud: ${condiciones_pago}.`);
  else if (!proveedor) inf.noAplica("RC7", "Condiciones de pago no informadas y sin proveedor válido para derivarlas.");
  else {
    derivados.condiciones_pago = derivar(proveedor.condiciones_pago_default, "condiciones de pago");
    inf.derivado("RC7", `Condiciones de pago derivadas del proveedor: ${proveedor.condiciones_pago_default}.`);
  }
  return derivados;

  function derivar(valor: string, que: string): Derivado {
    return { valor, fuente: "maestro.proveedores", detalle: `${que} predeterminado de ${proveedor?.nombre}` };
  }
}

/** RC8: una factura anterior a la solicitud indica una compra retroactiva. */
function rc8Retroactiva(p: Paquete, inf: Informe): boolean {
  if (!p.factura) {
    inf.noAplica("RC8", "No llegó factura con la solicitud.");
    return false;
  }
  if (p.factura.fecha && p.factura.fecha < p.solicitud.fecha_solicitud) {
    inf.confirmacion({
      regla: "RC8",
      detalle: `OC retroactiva: la factura ${p.factura.numero} es del ${p.factura.fecha}, anterior a la solicitud del ${p.solicitud.fecha_solicitud}.`,
      accion_sugerida: "Confirmar la creación; quedará marcada retroactiva = true en el log de control.",
      valores: { fecha_factura: p.factura.fecha, fecha_solicitud: p.solicitud.fecha_solicitud },
    });
    return true;
  }
  inf.ok("RC8", `La factura ${p.factura.numero} (${p.factura.fecha}) no es anterior a la solicitud.`);
  return false;
}

/** RC9: la aprobación no puede ser anterior a la solicitud. */
function rc9FechaAprobacion(p: Paquete, inf: Informe) {
  if (!p.aprobacion) return inf.noAplica("RC9", "Sin aprobación (ver RC2).");
  const fecha = dia(p.aprobacion.fecha);
  if (fecha < p.solicitud.fecha_solicitud) {
    return inf.confirmacion({
      regla: "RC9",
      detalle: `La aprobación (${fecha}) es anterior a la solicitud (${p.solicitud.fecha_solicitud}).`,
      accion_sugerida: "Confirmar que la aprobación corresponde a esta solicitud.",
      valores: { fecha_aprobacion: fecha, fecha_solicitud: p.solicitud.fecha_solicitud },
    });
  }
  inf.ok("RC9", `Aprobación del ${fecha}, posterior o igual a la solicitud (${p.solicitud.fecha_solicitud}).`);
}

/** RC10: cantidad × valor unitario cuadra con el valor total (± 1). */
function rc10Aritmetica(p: Paquete, inf: Informe) {
  const { cantidad, valor_unitario, valor_total } = p.solicitud;
  const calculado = cantidad * valor_unitario;
  if (Math.abs(calculado - valor_total) > TOLERANCIA_TOTAL) {
    return inf.bloqueo({
      regla: "RC10",
      detalle: `${cantidad} × ${cop(valor_unitario)} = ${cop(calculado)}, distinto del valor total ${cop(valor_total)}.`,
      accion_sugerida: "Pedir al solicitante que corrija la cantidad, el valor unitario o el total.",
      valores: { calculado, valor_total },
    });
  }
  inf.ok("RC10", `${cantidad} × ${cop(valor_unitario)} = ${cop(valor_total)}.`);
}

/** HU-2: aplica RC1–RC10 al paquete. Función pura: mismo paquete y maestros, mismo resultado. */
export function validar(p: Paquete, m: Maestros): Validacion {
  const inf = new Informe();
  const centro = m.centrosCosto.find((c) => c.centro_costo === p.solicitud.centro_costo);

  const proveedor = rc1Proveedor(p, m, inf);
  const aprobador = rc2Aprobacion(p, centro, inf);
  rc3Tope(p, aprobador, inf);
  rc4Subarea(p, centro, inf);
  rc5Cotizacion(p, inf);
  const derivados = rc6rc7Derivados(p, proveedor, inf);
  const retroactiva = rc8Retroactiva(p, inf);
  rc9FechaAprobacion(p, inf);
  rc10Aritmetica(p, inf);

  return {
    apta: inf.bloqueos.length === 0,
    bloqueos: inf.bloqueos,
    confirmaciones: inf.confirmaciones,
    derivados,
    retroactiva,
    controles: inf.controles,
    contexto: { proveedor, aprobador },
  };
}
