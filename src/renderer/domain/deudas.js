// src/renderer/domain/deudas.js
// Cuentas por pagar (CxP). Funciones puras que operan sobre un objeto deuda
// individual: { id, acreedor, monto_total, fecha_vencimiento, pagos: [...] }
// El módulo no necesita acceso a state — todos los datos vienen en la deuda.

(function () {
  'use strict';

  // Suma de todos los pagos parciales ya realizados.
  function montoPagado(d) {
    return ((d && d.pagos) || []).reduce((s, p) => s + Number(p.monto || 0), 0);
  }

  // Lo que aún queda por pagar (no puede ser negativo).
  function saldoPendiente(d) {
    return Math.max(0, Number((d && d.monto_total) || 0) - montoPagado(d));
  }

  // Estado de la deuda comparado contra una fecha de referencia ('YYYY-MM-DD').
  //   'pagado'    → ya no queda saldo
  //   'vencido'   → tiene fecha de vencimiento pasada y queda saldo
  //   'pendiente' → queda saldo y aún no venció (o no tiene fecha)
  function estado(d, hoyStr) {
    const pendiente = saldoPendiente(d);
    if (pendiente <= 0) return 'pagado';
    if (d && d.fecha_vencimiento && d.fecha_vencimiento < hoyStr) return 'vencido';
    return 'pendiente';
  }

  // Días que faltan para que venza (negativo si ya venció).
  // Devuelve null si la deuda no tiene fecha de vencimiento.
  function diasParaVencer(d, hoyStr) {
    if (!d || !d.fecha_vencimiento) return null;
    const a = new Date(d.fecha_vencimiento + 'T12:00:00');
    const b = new Date(hoyStr + 'T12:00:00');
    return Math.round((a - b) / (24 * 3600 * 1000));
  }

  window.Deudas = {
    montoPagado,
    saldoPendiente,
    estado,
    diasParaVencer,
  };
})();
