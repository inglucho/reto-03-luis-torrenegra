/**
 * Las mismas herramientas que usa la aplicación (no es una copia): cada export es
 * `{ description, args, execute(args, ctx) }` y se registra como `oc_<export>`.
 * Se importan sin el servidor; `ctx.directory` debe apuntar a la raíz con `fixtures/`.
 */
export * from "../../src/tools/oc";
