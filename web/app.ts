import type { Evento } from "../src/core/eventos";
import type { Presentacion } from "../src/core/presentacion";
import { markdown } from "./markdown";

type Info = Presentacion & { proveedor: string; modelo: string; fechaReferencia: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const hilo = $<HTMLElement>("log");
const bienvenida = $<HTMLElement>("empty");
const form = $<HTMLFormElement>("composer");
const input = $<HTMLTextAreaElement>("input");
const enviar = $<HTMLButtonElement>("send");
const reiniciar = $<HTMLButtonElement>("reset");
const uso = $<HTMLElement>("uso");
const guia = $<HTMLElement>("guia");
const velo = $<HTMLElement>("velo");

const ICONOS = {
  listo: '<svg viewBox="0 0 20 20"><path d="M5 10.5l3 3 7-7"/></svg>',
  confirmar: '<svg viewBox="0 0 20 20"><path d="M10 5.5v5.5M10 14.5h.01"/></svg>',
  fallo: '<svg viewBox="0 0 20 20"><path d="M6.5 6.5l7 7M13.5 6.5l-7 7"/></svg>',
  alerta: '<svg viewBox="0 0 20 20"><path d="M10 2.5l8 14H2z"/><path d="M10 8v3.5M10 14h.01"/></svg>',
  escudo: '<svg viewBox="0 0 20 20"><path d="M10 2l6 3v5c0 4-3 6.5-6 8-3-1.5-6-4-6-8V5z"/><path d="M10 7v3.5M10 13h.01"/></svg>',
};

// Cada carga de la página abre una conversación nueva; el historial vive en el servidor.
let sessionId = crypto.randomUUID();
let ocupado = false;
/** Contenedor de la respuesta del turno en curso (pasos y texto del agente). */
let turno: HTMLElement | null = null;
let textoCrudo = "";
const pasos = new Map<string, HTMLDetailsElement>();
let info: Info | null = null;
/** Instrucciones ya enviadas, para no volver a sugerirlas. */
const enviados = new Set<string>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, clase?: string, texto?: string) {
  const nodo = document.createElement(tag);
  if (clase) nodo.className = clase;
  if (texto !== undefined) nodo.textContent = texto;
  return nodo;
}

function bajar() {
  hilo.scrollTop = hilo.scrollHeight;
}

function agregar(nodo: HTMLElement) {
  bienvenida.hidden = true;
  hilo.append(nodo);
  bajar();
}

function setOcupado(valor: boolean) {
  ocupado = valor;
  input.disabled = valor;
  enviar.disabled = valor;
  if (!valor) input.focus();
}

/** "oc_construir_payload" → "Construir payload". */
function nombreLegible(nombre: string): string {
  const sinPrefijo = nombre.includes("_") ? nombre.slice(nombre.indexOf("_") + 1) : nombre;
  const texto = sinPrefijo.replace(/_/g, " ");
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

function argumentosBreves(args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  return Object.entries(args as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && (typeof v !== "object" || v === null))
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${String(v)}`)
    .join(" · ");
}

/** Bloque de respuesta del agente para el turno actual (se crea al primer evento). */
function cuerpoDelTurno(): HTMLElement {
  if (!turno) {
    const respuesta = el("div", "respuesta");
    const avatar = el("div", "avatar", "P");
    avatar.setAttribute("aria-hidden", "true");
    turno = el("div", "respuesta-cuerpo");
    respuesta.append(avatar, turno);
    agregar(respuesta);
  }
  return turno;
}

function ultimo(clase: string): HTMLElement | null {
  const final = cuerpoDelTurno().lastElementChild as HTMLElement | null;
  return final?.classList.contains(clase) ? final : null;
}

function agregarTexto(delta: string) {
  let bloque = ultimo("contenido-md");
  if (!bloque) {
    bloque = el("div", "contenido-md");
    textoCrudo = "";
    cuerpoDelTurno().append(bloque);
  }
  textoCrudo += delta;
  // markdown() escapa todo el HTML antes de dar formato.
  bloque.innerHTML = markdown(textoCrudo);
  bajar();
}

function agregarPaso(id: string, nombre: string, args: unknown) {
  let grupo = ultimo("pasos");
  if (!grupo) {
    grupo = el("div", "pasos");
    cuerpoDelTurno().append(grupo);
  }
  const paso = el("details", "paso ejecutando");
  const resumen = el("summary");
  const icono = el("span", "paso-icono");
  icono.append(el("span", "girando"));
  const titulo = el("span", "paso-titulo");
  titulo.append(el("span", "paso-nombre", nombreLegible(nombre)), el("span", "paso-args", argumentosBreves(args)));
  resumen.append(icono, titulo, el("span", "paso-detalle-btn", "Detalle"), el("span", "paso-resumen"));
  const cuerpo = el("div", "paso-cuerpo");
  cuerpo.append(el("h4", undefined, `Herramienta · ${nombre}`), el("h4", undefined, "Argumentos"), el("pre", undefined, JSON.stringify(args, null, 2)));
  paso.append(resumen, cuerpo);
  grupo.append(paso);
  pasos.set(id, paso);
  bajar();
}

function marcarPaso(e: Extract<Evento, { tipo: "resultado" }>) {
  const paso = pasos.get(e.id);
  if (!paso) return;
  const estado = e.pideConfirmacion ? "confirmar" : e.ok ? "listo" : "fallo";
  paso.className = `paso ${estado}`;
  (paso.querySelector(".paso-icono") as HTMLElement).innerHTML = ICONOS[estado];
  (paso.querySelector(".paso-resumen") as HTMLElement).textContent = e.resumen;
  (paso.querySelector(".paso-cuerpo") as HTMLElement).append(el("h4", undefined, "Resultado"), el("pre", undefined, JSON.stringify(e.resultado, null, 2)));
}

function mostrarError(mensaje: string) {
  const aviso = el("div", "aviso-error");
  aviso.innerHTML = ICONOS.alerta;
  aviso.append(el("span", undefined, mensaje));
  cuerpoDelTurno().append(aviso);
  bajar();
}

/** CA3: el turno terminó con una pregunta de confirmación. Se destaca y se ofrecen respuestas rápidas. */
function pedirConfirmacion() {
  const tarjeta = el("div", "confirmacion");
  tarjeta.innerHTML = ICONOS.escudo;
  const texto = el("div");
  texto.append(
    el("h3", undefined, "Necesita tu confirmación"),
    el("p", undefined, "Revisa la información de arriba. El agente no continuará hasta que respondas."),
  );
  const acciones = el("div", "acciones");
  const si = el("button", "btn btn-primario", "Confirmar");
  const no = el("button", "btn btn-secundario", "Cancelar");
  si.type = no.type = "button";
  const responder = (mensaje: string) => {
    tarjeta.classList.add("resuelta");
    for (const b of [si, no]) b.disabled = true;
    void enviarMensaje(mensaje);
  };
  si.onclick = () => responder("Confirmo.");
  no.onclick = () => responder("No, cancela esa acción.");
  acciones.append(si, no);
  texto.append(acciones);
  tarjeta.append(texto);
  agregar(tarjeta);
}

function manejar(e: Evento) {
  switch (e.tipo) {
    case "texto":
      agregarTexto(e.delta);
      break;
    case "llamada":
      agregarPaso(e.id, e.nombre, e.args);
      break;
    case "resultado":
      marcarPaso(e);
      break;
    case "error":
      mostrarError(e.mensaje);
      break;
    case "fin_turno": {
      const u = e.uso;
      const tokens = (u.tokensEntrada + u.tokensCache + u.tokensSalida).toLocaleString("es-CO");
      uso.textContent = u.llamadasModelo > 0 ? `Último turno: ${u.llamadasModelo} llamadas al modelo · ${tokens} tokens` : "";
      if (e.necesitaConfirmacion) pedirConfirmacion();
      else sugerirContinuacion();
      break;
    }
  }
}

function indicadorTrabajando(): HTMLElement {
  const nodo = el("div", "trabajando");
  const puntos = el("span", "puntos");
  puntos.append(el("i"), el("i"), el("i"));
  nodo.append(puntos, el("span", undefined, "El agente está trabajando…"));
  return nodo;
}

/** Después de cada respuesta, propone instrucciones que todavía no se han probado. */
function sugerirContinuacion() {
  const opciones = (info?.sugerencias ?? []).filter((s) => !enviados.has(s.texto)).slice(0, 3);
  if (opciones.length === 0) return;
  const bloque = el("div", "continuar");
  bloque.append(el("span", undefined, "Puedes seguir con:"));
  for (const s of opciones) {
    const chip = el("button", "chip", s.titulo);
    chip.type = "button";
    chip.title = s.texto;
    chip.onclick = () => {
      bloque.remove();
      if (!ocupado) void enviarMensaje(s.texto);
    };
    bloque.append(chip);
  }
  agregar(bloque);
}

async function enviarMensaje(texto: string) {
  enviados.add(texto);
  for (const b of hilo.querySelectorAll(".continuar")) b.remove();
  const burbuja = el("div", "mensaje-usuario");
  burbuja.append(el("div", undefined, texto));
  agregar(burbuja);
  setOcupado(true);
  turno = null;
  const trabajando = indicadorTrabajando();
  agregar(trabajando);
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message: texto }),
    });
    if (!res.ok || !res.body) {
      const datos = (await res.json().catch(() => ({}))) as { error?: string };
      mostrarError(datos.error ?? `El servidor respondió con un error (${res.status}).`);
      return;
    }
    const lector = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    while (true) {
      const { value, done } = await lector.read();
      if (done) break;
      buffer += value;
      let corte = buffer.indexOf("\n\n");
      while (corte !== -1) {
        const trama = buffer.slice(0, corte);
        buffer = buffer.slice(corte + 2);
        if (trama.startsWith("data: ")) {
          manejar(JSON.parse(trama.slice(6)) as Evento);
          hilo.append(trabajando);
          bajar();
        }
        corte = buffer.indexOf("\n\n");
      }
    }
  } catch {
    mostrarError("Se perdió la conexión con el servidor. Revisa tu conexión y vuelve a intentarlo.");
  } finally {
    trabajando.remove();
    turno = null;
    setOcupado(false);
  }
}

form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const texto = input.value.trim();
  if (!texto || ocupado) return;
  input.value = "";
  input.style.height = "";
  void enviarMensaje(texto);
});

input.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    form.requestSubmit();
  }
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
});

reiniciar.addEventListener("click", async () => {
  if (ocupado) return;
  await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => undefined);
  sessionId = crypto.randomUUID();
  pasos.clear();
  enviados.clear();
  turno = null;
  hilo.replaceChildren(bienvenida);
  bienvenida.hidden = false;
  uso.textContent = "";
  input.focus();
});

/** "Qué esperar" de una instrucción, con la etiqueta destacada. */
function queEsperar(texto: string): HTMLElement {
  const nodo = el("span", "espera");
  nodo.append(el("b", undefined, "Qué esperar:"), el("span", undefined, texto));
  return nodo;
}

function pintarSugerencias(i: Info) {
  $<HTMLElement>("sugerencias").replaceChildren(
    ...i.sugerencias.slice(0, 4).map((s) => {
      const boton = el("button", "sugerencia");
      boton.type = "button";
      boton.append(el("strong", undefined, s.titulo), el("span", undefined, s.texto), queEsperar(s.espera));
      boton.onclick = () => {
        if (!ocupado) void enviarMensaje(s.texto);
      };
      return boton;
    }),
  );
}

/** Escribe la instrucción en la caja para que la persona la revise o la edite antes de enviarla. */
function prepararInstruccion(texto: string) {
  input.value = texto;
  input.dispatchEvent(new Event("input"));
  input.focus();
  input.setSelectionRange(texto.length, texto.length);
}

function pintarCasos(i: Info) {
  $<HTMLElement>("casos").replaceChildren(
    ...i.casos.map((c) => {
      const fila = el("button", "caso");
      fila.type = "button";
      fila.title = `Escribir: ${c.instruccion}`;
      fila.append(el("code", undefined, c.id), el("span", "desc", c.descripcion), el("span", `etiqueta ${c.tono}`, c.resultado));
      fila.onclick = () => prepararInstruccion(c.instruccion);
      return fila;
    }),
  );
}

function seccion(titulo: string, ...contenido: HTMLElement[]): HTMLElement {
  const s = el("section");
  s.append(el("h3", undefined, titulo), ...contenido);
  return s;
}

function lista(items: string[]): HTMLElement {
  const ul = el("ul");
  ul.append(...items.map((t) => el("li", undefined, t)));
  return ul;
}

/** El manual lateral: todo lo que una persona nueva necesita para usar el agente. */
function pintarGuia(i: Info) {
  $<HTMLElement>("guia-titulo").textContent = i.titulo;
  const ejemplos = el("div");
  for (const s of i.sugerencias) {
    const caja = el("div", "guia-ejemplo");
    const probar = el("button", "chip", "Probar este ejemplo");
    probar.type = "button";
    probar.onclick = () => {
      cerrarGuia();
      if (!ocupado) void enviarMensaje(s.texto);
    };
    const espera = el("div", "espera");
    espera.append(el("b", undefined, "Qué esperar: "), el("span", undefined, s.espera));
    caja.append(el("strong", undefined, s.titulo), el("q", undefined, s.texto), espera, probar);
    ejemplos.append(caja);
  }

  const casos = el("div", "casos");
  for (const c of i.casos) {
    const fila = el("button", "caso");
    fila.type = "button";
    fila.append(el("code", undefined, c.id), el("span", "desc", c.descripcion), el("span", `etiqueta ${c.tono}`, c.resultado));
    fila.onclick = () => {
      cerrarGuia();
      prepararInstruccion(c.instruccion);
    };
    casos.append(fila);
  }

  const leyenda = el("ul", "leyenda");
  const fila = (clase: string, icono: string, texto: string) => {
    const li = el("li");
    const ic = el("span", `paso-icono ${clase}`);
    if (icono === "girando") ic.append(el("span", "girando"));
    else ic.innerHTML = icono;
    li.append(ic, el("span", undefined, texto));
    return li;
  };
  leyenda.append(
    fila("", "girando", "El agente está ejecutando ese paso."),
    fila("i-listo", ICONOS.listo, "Paso completado. Debajo ves su resultado resumido."),
    fila("i-confirmar", ICONOS.confirmar, "Hay algo que requiere tu decisión antes de continuar."),
    fila("i-fallo", ICONOS.fallo, "El paso no se pudo completar; el agente explica por qué."),
  );

  const rutas = el("dl", "rutas");
  for (const r of i.resultados) rutas.append(el("dt", undefined, r.ruta), el("dd", undefined, r.descripcion));

  $<HTMLElement>("guia-cuerpo").replaceChildren(
    seccion("Qué hace este agente", el("p", undefined, i.descripcion), lista(i.queHace)),
    seccion(
      "Cómo pedirle las cosas",
      lista([
        "Escribe en lenguaje natural, como le hablarías a una persona. Menciona el caso con su identificador.",
        "Si quieres revisar antes de actuar, dilo: «muéstrame cómo quedaría y no lo hagas todavía».",
        "Pide explicaciones cuando quieras: «¿por qué está bloqueado?», «¿qué falta?», «¿de dónde salió ese dato?».",
        "Puedes pedir varios casos a la vez: «procesa todos y dame un resumen». Tardará más.",
        "Cuando el agente te pregunte algo, responde «Confirmo» o «No» (o usa los botones).",
      ]),
    ),
    seccion("Ejemplos y qué esperar", ejemplos),
    seccion("Datos de prueba", el("p", undefined, "Haz clic en uno para escribir la instrucción en la caja de mensaje."), casos),
    seccion("Confirmaciones: tú decides", el("p", undefined, i.confirmaciones)),
    seccion(
      "Cómo leer la pantalla",
      el("p", undefined, "Cada respuesta muestra primero los pasos que dio el agente. Haz clic en «Detalle» para ver qué datos usó y qué devolvió cada paso."),
      leyenda,
    ),
    seccion("Dónde quedan los resultados", el("p", undefined, "Los archivos se generan en la carpeta out/ del servidor:"), rutas),
    seccion(
      "Empezar de cero",
      el("p", undefined, "Al procesar un caso, sus resultados quedan guardados: si lo procesas otra vez, el agente lo reconoce y no lo duplica. Para volver a ver los casos como nuevos, restablece los datos de prueba."),
      botonRestablecer(),
    ),
    seccion(
      "Límites",
      lista([
        `Fecha de referencia: ${i.fechaReferencia}. Se usa para vigencias, vencimientos y fechas de registro.`,
        "Los datos son ficticios: son los de la prueba técnica.",
        "Usa la capa gratuita de Gemini: con mucha demanda puede tardar o pedirte esperar un minuto.",
        "Cada conversación tiene un tope de uso; «Nueva conversación» empieza de cero. Al recargar la página también.",
      ]),
    ),
  );
}

function botonRestablecer(): HTMLElement {
  const contenedor = el("div", "restablecer");
  const boton = el("button", "btn btn-secundario", "Restablecer datos de prueba");
  boton.type = "button";
  const estado = el("span", "restablecer-estado");
  boton.onclick = async () => {
    if (!confirm("Se borrarán los resultados generados (órdenes, registros, archivos) y los casos volverán a su estado inicial. ¿Continuar?")) return;
    boton.disabled = true;
    estado.textContent = "Restableciendo…";
    const r = await fetch("/api/datos/restablecer", { method: "POST" }).catch(() => null);
    boton.disabled = false;
    estado.textContent = r?.ok ? "Listo: los casos están como nuevos." : "No se pudo restablecer. Intenta de nuevo en unos minutos.";
  };
  contenedor.append(boton, estado);
  return contenedor;
}

function abrirGuia() {
  velo.hidden = false;
  guia.classList.add("abierta");
  guia.setAttribute("aria-hidden", "false");
  guia.focus();
}

function cerrarGuia() {
  velo.hidden = true;
  guia.classList.remove("abierta");
  guia.setAttribute("aria-hidden", "true");
}

for (const id of ["abrir-guia", "ver-guia", "ayuda-guia"]) $<HTMLButtonElement>(id).addEventListener("click", abrirGuia);
$<HTMLButtonElement>("cerrar-guia").addEventListener("click", cerrarGuia);
velo.addEventListener("click", cerrarGuia);
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && guia.classList.contains("abierta")) cerrarGuia();
});

fetch("/api/info")
  .then((r) => r.json() as Promise<Info>)
  .then((datos) => {
    info = datos;
    document.title = `${datos.titulo} · ${datos.reto}`;
    $<HTMLElement>("reto").textContent = `${datos.reto} · Periferia IT Group`;
    $<HTMLElement>("titulo").textContent = datos.titulo;
    $<HTMLElement>("descripcion").textContent = datos.descripcion;
    input.placeholder = datos.placeholder;
    const proveedor = datos.proveedor.charAt(0).toUpperCase() + datos.proveedor.slice(1);
    $<HTMLElement>("estado-texto").textContent = `${proveedor} · ${datos.modelo}`;
    $<HTMLElement>("estado").classList.add("ok");
    pintarSugerencias(datos);
    pintarCasos(datos);
    pintarGuia(datos);
  })
  .catch(() => {
    $<HTMLElement>("estado-texto").textContent = "Sin conexión con el servidor";
    $<HTMLElement>("estado").classList.add("error");
  });

input.focus();
