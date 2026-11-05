/**
 * Regla CA3/RN4: una acción que requiere confirmación solo procede si el mensaje del usuario
 * inmediatamente posterior a la pregunta la confirma. El prompt se lo pide al modelo,
 * y este módulo lo garantiza en el backend aunque el modelo se equivoque.
 *
 * Los límites de palabra usan `\p{L}` con el modo Unicode: `\b` no reconoce la "í" de "sí".
 */

const LETRA = "\\p{L}";
const palabra = (patron: string) => new RegExp(`(?<!${LETRA})(?:${patron})(?!${LETRA})`, "iu");

/** El mensaje empieza negando o pidiendo esperar: "no", "cancela", "espera", "todavía no"… */
const NEGACION_INICIAL = /^[\s¡¿"'(]*(no|nop|negativo|mejor no|cancel\p{L}*|det[eé]n\p{L}*|espera|todav[ií]a no|a[uú]n no)(?!\p{L})/iu;

/** Niega una acción concreta en cualquier parte: "no la crees", "no envíes", "no confirmo"… */
const NEGACION_DE_ACCION = palabra(
  "no\\s+(?:lo\\s+|la\\s+|los\\s+|las\\s+|me\\s+)?(?:confirm\\p{L}*|aprue\\p{L}*|autoriz\\p{L}*|proced\\p{L}*|env[ií]\\p{L}*|registr\\p{L}*|cre\\p{L}*|hag\\p{L}*|sig\\p{L}*)",
);

const AFIRMACION = palabra(
  "s[ií]|claro|confirm\\p{L}*|apruebo|aprobad[oa]|autoriz\\p{L}*|proced\\p{L}*|adelante|dale|de acuerdo|ok|okay|vale|hazlo|cr[eé]ala|reg[ií]stra\\p{L}*|env[ií]a\\p{L}*|correcto|perfecto",
);

/** ¿El texto del usuario es una confirmación explícita? Una negación siempre gana. */
export function esConfirmacion(texto: string): boolean {
  return !NEGACION_INICIAL.test(texto) && !NEGACION_DE_ACCION.test(texto) && AFIRMACION.test(texto);
}

export const MENSAJE_SIN_CONFIRMACION =
  "No se ejecutó: `confirmado: true` solo es válido si el usuario confirmó explícitamente en su último mensaje, " +
  "respondiendo a una pregunta de confirmación sobre esta misma acción. Presenta lo que requiere confirmación y termina el turno con una pregunta.";
