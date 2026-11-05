import type { Presentacion } from "./core/presentacion";

/**
 * Lo que el chat le explica a quien lo usa: qué hace el agente, ejemplos con lo que se
 * puede esperar, los datos de prueba y cómo funcionan las confirmaciones. Los resultados
 * esperados son los que verifica `demo.ts`.
 */
export const presentacion: Presentacion = {
  reto: "Reto 03",
  titulo: "Órdenes de Compra SAP",
  descripcion:
    "Lee cada solicitud de compra (solicitud, cotización, aprobación del líder y factura), la valida contra los maestros con los controles RC1–RC10 y crea la orden de compra en SAP. Las excepciones las decides tú.",
  placeholder: 'Escribe una instrucción, por ejemplo: Procesa la solicitud "sol-001"',
  queHace: [
    "Lee el paquete de cada solicitud: el correo, la solicitud (Excel), la cotización del proveedor, la aprobación del líder y, si llega, la factura.",
    "Valida 10 controles: proveedor activo, aprobador autorizado y con tope suficiente, subárea, diferencia con la cotización, IVA, condiciones de pago, fechas y aritmética.",
    "Arma la orden de compra exactamente como quedaría en SAP y guarda de dónde salió cada dato.",
    "Genera la evidencia de aprobación (TXT y PDF con su huella sha256) y crea la OC en un SAP simulado, sin duplicarla nunca.",
    "Marca las compras retroactivas (factura anterior a la solicitud) para que la dirección pueda medirlas.",
  ],
  sugerencias: [
    {
      titulo: "Procesar una solicitud limpia",
      texto: 'Procesa la solicitud "sol-001" y créala si todo está en orden.',
      espera: "Valida los 10 controles y crea la OC sin pedirte confirmación, porque no hay excepciones.",
    },
    {
      titulo: "Revisar antes de crear",
      texto:
        'Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.',
      espera: "Muestra la OC y la tabla de controles. La cotización es 6 % mayor que la solicitud, así que te pide confirmar antes de crear.",
    },
    {
      titulo: "Entender un bloqueo",
      texto: 'Valida la solicitud "sol-003" y dime qué hay que hacer para desbloquearla.',
      espera: "Explica que quien aprobó no es aprobador del centro de costo y a quién hay que pedirle la aprobación.",
    },
    {
      titulo: "Detectar una OC retroactiva",
      texto: 'Valida la solicitud "sol-005" y explícame por qué es retroactiva.',
      espera: "Explica que la factura llegó antes que la solicitud. Crearla requiere tu confirmación y queda marcada en el control.",
    },
    {
      titulo: "Procesar todo",
      texto: "Procesa todas las solicitudes y dame un resumen por caso.",
      espera: "Crea las limpias, explica los bloqueos y deja pendientes las que requieren tu confirmación. Toma más tiempo.",
    },
  ],
  casos: [
    { id: "sol-001", descripcion: "Licencias de antivirus · TecnoSuministros · $11,4 M", resultado: "Se crea sin intervención", tono: "ok", instruccion: 'Procesa la solicitud "sol-001".' },
    { id: "sol-002", descripcion: "Licencia de pruebas automatizadas · $8,5 M", resultado: "Bloqueada: el proveedor no existe (RC1)", tono: "bloqueo", instruccion: 'Procesa la solicitud "sol-002".' },
    { id: "sol-003", descripcion: "Mobiliario para la nueva sede · $74 M", resultado: "Bloqueada: aprobador sin autoridad (RC2)", tono: "bloqueo", instruccion: 'Procesa la solicitud "sol-003".' },
    { id: "sol-004", descripcion: "Horas de arquitectura de nube · $25 M", resultado: "Pide confirmar: cotización 6 % mayor (RC5)", tono: "confirmar", instruccion: 'Procesa la solicitud "sol-004".' },
    { id: "sol-005", descripcion: "Papelería y tóner del trimestre · $3,2 M", resultado: "Pide confirmar: compra retroactiva (RC8)", tono: "confirmar", instruccion: 'Procesa la solicitud "sol-005".' },
    { id: "sol-006", descripcion: "Diademas para la mesa de soporte · $5,4 M", resultado: "Pide confirmar el IVA derivado (RC6)", tono: "confirmar", instruccion: 'Procesa la solicitud "sol-006".' },
  ],
  confirmaciones:
    "El agente nunca crea una OC con excepciones por su cuenta. Cuando algo requiere tu decisión (diferencia con la cotización, IVA derivado, compra retroactiva o aprobación anterior a la solicitud), te lo explica y se detiene. Para continuar, responde «Confirmo» o usa el botón. La confirmación solo vale para esa solicitud: si respondes otra cosa, no se crea nada.",
  resultados: [
    { ruta: "out/sap/ordenes.jsonl", descripcion: "Órdenes creadas en el SAP simulado (numeradas desde 4500000001)." },
    { ruta: "out/control.csv", descripcion: "Cada intento de creación, para Auditoría, con la marca de retroactiva." },
    { ruta: "out/<caso>/trazabilidad.json", descripcion: "De dónde salió cada dato de la OC." },
    { ruta: "out/<caso>/aprobacion.txt y .pdf", descripcion: "Evidencia de la aprobación, con su sha256." },
    { ruta: "out/log.jsonl", descripcion: "Cada llamada a herramienta, con su resultado." },
  ],
};
