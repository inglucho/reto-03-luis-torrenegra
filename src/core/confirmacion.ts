/**
 * Regla CA3: una acción que requiere confirmación solo procede si el mensaje del usuario
 * inmediatamente posterior a la pregunta la confirma. El prompt se lo pide al modelo,
 * y este módulo lo garantiza en el backend aunque el modelo se equivoque.
 */

const NEGACION = /\b(no|cancela\w*|rechaz\w*|det[eé]n\w*|espera|todav[ií]a no|a[uú]n no)\b/i;
const AFIRMACION = /\b(s[ií]|confirm\w*|apruebo|aprobad[oa]|autoriz\w*|proced\w*|adelante|dale|de acuerdo|ok|okay|hazlo|cr[eé]ala|reg[ií]stra\w*|env[ií]a\w*)\b/i;

/** ¿El texto del usuario es una confirmación explícita? Ante cualquier negación, no. */
export function esConfirmacion(texto: string): boolean {
  return !NEGACION.test(texto) && AFIRMACION.test(texto);
}

export const MENSAJE_SIN_CONFIRMACION =
  "No se ejecutó: `confirmado: true` solo es válido si el usuario confirmó explícitamente en su último mensaje, " +
  "respondiendo a una pregunta de confirmación. Presenta lo que requiere confirmación y termina el turno con una pregunta.";
