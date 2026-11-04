import type { Evento } from "../src/core/eventos";

const log = document.getElementById("log") as HTMLElement;
const vacio = document.getElementById("empty") as HTMLElement;
const meta = document.getElementById("meta") as HTMLElement;
const form = document.getElementById("composer") as HTMLFormElement;
const input = document.getElementById("input") as HTMLTextAreaElement;
const enviar = document.getElementById("send") as HTMLButtonElement;
const reiniciar = document.getElementById("reset") as HTMLButtonElement;

// Cada carga de la página abre una conversación nueva; el historial vive en el servidor.
let sessionId = crypto.randomUUID();
let ocupado = false;
let etiquetaModelo = "";
let textoActual: HTMLElement | null = null;
let ultimoAsistente: HTMLElement | null = null;
const tarjetas = new Map<string, HTMLDetailsElement>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, clase?: string, texto?: string) {
  const nodo = document.createElement(tag);
  if (clase) nodo.className = clase;
  if (texto !== undefined) nodo.textContent = texto;
  return nodo;
}

function agregar(nodo: HTMLElement) {
  vacio.hidden = true;
  log.append(nodo);
  log.scrollTop = log.scrollHeight;
}

function json(valor: unknown): string {
  return JSON.stringify(valor, null, 2);
}

function setOcupado(valor: boolean) {
  ocupado = valor;
  input.disabled = valor;
  enviar.disabled = valor;
  if (!valor) input.focus();
}

function tarjetaHerramienta(id: string, nombre: string, args: unknown) {
  const tarjeta = el("details", "tool");
  const resumen = el("summary");
  resumen.append(el("span", "name", nombre), el("span", "badge", "ejecutando…"));
  const cuerpo = el("div", "body");
  cuerpo.append(el("h4", undefined, "Argumentos"), el("pre", undefined, json(args)));
  tarjeta.append(resumen, cuerpo);
  tarjetas.set(id, tarjeta);
  agregar(tarjeta);
}

function marcarResultado(e: Extract<Evento, { tipo: "resultado" }>) {
  const tarjeta = tarjetas.get(e.id);
  if (!tarjeta) return;
  const insignia = tarjeta.querySelector(".badge") as HTMLElement;
  const [texto, clase] = e.pideConfirmacion ? ["requiere confirmación", "warn"] : e.ok ? ["ok", "ok"] : ["error", "error"];
  insignia.textContent = texto;
  insignia.className = `badge ${clase}`;
  if (e.pideConfirmacion) tarjeta.classList.add("awaiting");
  const cuerpo = tarjeta.querySelector(".body") as HTMLElement;
  cuerpo.append(
    el("h4", undefined, "Resultado"),
    el("p", "summary-line", e.resumen),
    el("pre", undefined, json(e.resultado)),
  );
}

/** CA3: el turno terminó con una pregunta de confirmación; se resalta y se ofrecen respuestas rápidas. */
function resaltarConfirmacion() {
  const panel = el("div", "confirm");
  panel.append(el("p", undefined, "⚠️ El agente necesita tu confirmación para continuar."));
  const acciones = el("div", "actions");
  const si = el("button", undefined, "Confirmo");
  const no = el("button", "reject", "No, cancela");
  si.type = no.type = "button";
  const responder = (texto: string) => {
    panel.querySelectorAll("button").forEach((b) => {
      b.disabled = true;
    });
    void enviarMensaje(texto);
  };
  si.onclick = () => responder("Confirmo.");
  no.onclick = () => responder("No, cancela esa acción.");
  acciones.append(si, no);
  panel.append(acciones);
  if (ultimoAsistente) ultimoAsistente.classList.add("awaiting");
  agregar(panel);
}

function manejar(e: Evento) {
  switch (e.tipo) {
    case "texto":
      if (!textoActual) {
        textoActual = el("div", "msg assistant");
        ultimoAsistente = textoActual;
        agregar(textoActual);
      }
      textoActual.textContent += e.delta;
      log.scrollTop = log.scrollHeight;
      break;
    case "llamada":
      textoActual = null;
      tarjetaHerramienta(e.id, e.nombre, e.args);
      break;
    case "resultado":
      marcarResultado(e);
      break;
    case "error":
      textoActual = null;
      agregar(el("div", "msg error", e.mensaje));
      break;
    case "fin_turno": {
      const u = e.uso;
      meta.textContent = `${etiquetaModelo} · último turno: ${u.llamadasModelo} llamadas al modelo, ${u.tokensEntrada + u.tokensCache} tokens de entrada (${u.tokensCache} en caché), ${u.tokensSalida} de salida · sesión: ${u.tokensSesion}`;
      if (e.necesitaConfirmacion) resaltarConfirmacion();
      break;
    }
  }
}

async function enviarMensaje(texto: string) {
  agregar(el("div", "msg user", texto));
  setOcupado(true);
  textoActual = null;
  ultimoAsistente = null;
  const pensando = el("div", "typing", "El agente está pensando…");
  agregar(pensando);
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message: texto }),
    });
    if (!res.ok || !res.body) {
      const datos = (await res.json().catch(() => ({}))) as { error?: string };
      manejar({ tipo: "error", mensaje: datos.error ?? `Error HTTP ${res.status}` });
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
          log.append(pensando);
        }
        corte = buffer.indexOf("\n\n");
      }
    }
  } catch (err) {
    manejar({ tipo: "error", mensaje: `Se perdió la conexión con el servidor: ${String(err)}` });
  } finally {
    pensando.remove();
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
  await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
  sessionId = crypto.randomUUID();
  tarjetas.clear();
  log.replaceChildren(vacio);
  vacio.hidden = false;
  setOcupado(false);
});

Promise.all([fetch("/api/health").then((r) => r.json()), fetch("/api/herramientas").then((r) => r.json())])
  .then(([salud, lista]: [{ provider: string; model: string }, { nombre: string }[]]) => {
    etiquetaModelo = `${salud.provider} · ${salud.model}`;
    meta.textContent = `${etiquetaModelo} · ${lista.length} herramientas: ${lista.map((h) => h.nombre).join(", ")}`;
  })
  .catch(() => {
    meta.textContent = "No se pudo cargar la información del agente";
  });
