/**
 * Markdown mínimo y seguro para las respuestas del agente: títulos, negritas, cursivas,
 * código, listas, tablas, citas y separadores. Todo el texto se escapa antes de dar formato,
 * así que nada de lo que escriba el modelo (o un documento citado) puede inyectar HTML.
 */

const escapar = (t: string) =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Formato en línea sobre texto ya escapado. */
function enLinea(texto: string): string {
  return escapar(texto)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

const esFilaTabla = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const esSeparadorTabla = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const celdas = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

function tabla(lineas: string[]): string {
  const [encabezado, , ...filas] = lineas;
  const th = celdas(encabezado ?? "").map((c) => `<th>${enLinea(c)}</th>`).join("");
  const tr = filas.map((f) => `<tr>${celdas(f).map((c) => `<td>${enLinea(c)}</td>`).join("")}</tr>`).join("");
  return `<div class="tabla"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
}

export function markdown(fuente: string): string {
  const lineas = fuente.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let i = 0;
  while (i < lineas.length) {
    const linea = lineas[i] ?? "";

    if (/^\s*```/.test(linea)) {
      const codigo: string[] = [];
      for (i++; i < lineas.length && !/^\s*```/.test(lineas[i] ?? ""); i++) codigo.push(lineas[i] ?? "");
      html.push(`<pre><code>${escapar(codigo.join("\n"))}</code></pre>`);
      i++;
      continue;
    }
    if (esFilaTabla(linea) && esSeparadorTabla(lineas[i + 1] ?? "")) {
      const bloque: string[] = [];
      while (i < lineas.length && esFilaTabla(lineas[i] ?? "")) bloque.push(lineas[i++] ?? "");
      html.push(tabla(bloque));
      continue;
    }
    const titulo = linea.match(/^\s*(#{1,4})\s+(.*)$/);
    if (titulo) {
      const nivel = Math.min((titulo[1] ?? "#").length + 2, 6);
      html.push(`<h${nivel}>${enLinea(titulo[2] ?? "")}</h${nivel}>`);
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(linea)) {
      html.push("<hr>");
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(linea)) {
      const ordenada = /^\s*\d+\./.test(linea);
      const items: string[] = [];
      while (i < lineas.length && /^\s*([-*]|\d+\.)\s+/.test(lineas[i] ?? "")) {
        items.push(`<li>${enLinea((lineas[i] ?? "").replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>`);
        i++;
      }
      html.push(ordenada ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^\s*>/.test(linea)) {
      const cita: string[] = [];
      while (i < lineas.length && /^\s*>/.test(lineas[i] ?? "")) cita.push((lineas[i++] ?? "").replace(/^\s*>\s?/, ""));
      html.push(`<blockquote>${enLinea(cita.join(" "))}</blockquote>`);
      continue;
    }
    if (!linea.trim()) {
      i++;
      continue;
    }
    const parrafo: string[] = [];
    while (i < lineas.length && (lineas[i] ?? "").trim() && !/^\s*(#{1,4}\s|```|>|([-*]|\d+\.)\s|\|)/.test(lineas[i] ?? "")) parrafo.push(lineas[i++] ?? "");
    if (parrafo.length === 0) parrafo.push(lineas[i++] ?? "");
    html.push(`<p>${parrafo.map(enLinea).join("<br>")}</p>`);
  }
  return html.join("");
}
