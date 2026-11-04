## Proceso de órdenes de compra en Periferia

Cada compra llega a administración por correo con tres piezas: la solicitud (Excel), la cotización del proveedor (PDF) y el correo de aprobación del líder. A veces llega también la factura. Con eso se crea la orden de compra (OC) en SAP y se adjunta la aprobación como evidencia.

**Actores.** El solicitante pide la compra; el líder aprueba por correo respondiendo "Aprobado"; la analista administrativa crea la OC y confirma las excepciones; Contabilidad y Auditoría consumen el log de control (`out/control.csv`).

## Controles (RC1–RC10)

| Regla | Qué verifica | Si no se cumple |
|---|---|---|
| RC1 | El proveedor existe en el maestro (por NIT; sin NIT, por nombre) y está activo | Bloqueo: pedir la creación o reactivación del proveedor |
| RC2 | Hay aprobación, dice "Aprobado" y viene de un aprobador del centro de costo | Bloqueo: pedir aprobación a un aprobador autorizado |
| RC3 | El valor total no supera el tope del aprobador en ese centro | Bloqueo: escalar a un aprobador con tope suficiente |
| RC4 | La subárea pertenece al centro de costo | Bloqueo: corregir con el solicitante |
| RC5 | La cotización no difiere más del 2 % de la solicitud (o no hay cotización) | Confirmación, mostrando ambos valores |
| RC6 | Falta el indicador de IVA | Se deriva del proveedor y se pide confirmación |
| RC7 | Faltan las condiciones de pago | Se derivan del proveedor; solo se informa |
| RC8 | Hay factura con fecha anterior a la solicitud | OC **retroactiva**: confirmación y marca en el control |
| RC9 | La aprobación es anterior a la solicitud | Confirmación |
| RC10 | Cantidad × valor unitario ≠ valor total (± 1) | Bloqueo: corregir la solicitud |

Un **bloqueo** impide crear la OC. Una **confirmación** la permite solo si la analista lo confirma explícitamente.

## OC retroactivas

Una OC es retroactiva cuando la factura del proveedor llegó antes que la solicitud: la compra ya se hizo y la OC se crea después, sin pasar por la cotización. Es un desvío del proceso que la dirección quiere medir. No se rechaza: se crea con confirmación y queda marcada `retroactiva = true` en `out/control.csv`.

## Datos de referencia

- **Sociedad y organización de compras:** siempre `1000`.
- **Numeración de OC:** SAP asigna números secuenciales desde `4500000001`. Una misma solicitud nunca genera dos OC.
- **Texto breve de la posición:** máximo 40 caracteres (límite de SAP).
- **Unidades:** `UN` (unidades), `H` (horas), `MES` (mensualidades).
- **Indicadores de IVA:** `C0` excluido, `C1` IVA 19 %, `C2` IVA 5 %.
- **Condiciones de pago:** `Z000` inmediato, `Z015`, `Z030` y `Z060` días fecha factura.
