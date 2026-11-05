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
  // Próximo pago: si la deuda tiene día de pago (crédito en cuotas), la
  // próxima fecha con ese día; si la cuota de este mes ya se registró, la del
  // mes siguiente. Sin día de pago, la fecha de vencimiento.
  function proximoPago(d, hoyStr) {
    if (!d) return null;
    const dia = Number(d.dia_pago || 0);
    if (dia >= 1 && dia <= 31 && saldoPendiente(d) > 0 && hoyStr) {
      const enMes = (yy, mm) => { const ult = new Date(yy, mm + 1, 0).getDate(); return `${yy}-${String(mm + 1).padStart(2, '0')}-${String(Math.min(dia, ult)).padStart(2, '0')}`; };
      const dias = (x, y) => Math.round((new Date(y + 'T12:00:00') - new Date(x + 'T12:00:00')) / 86400000);
      const pagos = (d.pagos || []).map(p => String(p.fecha || '').slice(0, 10)).filter(Boolean);
      // Una cuota cuenta como pagada si hay un pago hasta 10 días antes o después (fin de mes, feriados).
      const cubierta = (f) => pagos.some(p => Math.abs(dias(f, p)) <= 10);
      const creada = String(d.fecha_emision || d.created_at || '').slice(0, 10);
      // Desde la cuota del mes anterior: la primera no pagada (posterior a cuando se registró el crédito).
      let y = Number(hoyStr.slice(0, 4)), m = Number(hoyStr.slice(5, 7)) - 2;
      if (m < 0) { m += 12; y -= 1; }
      for (let k = 0; k < 4; k++) {
        const f = enMes(y, m);
        if ((!creada || f > creada) && !cubierta(f)) return f;
        m += 1; if (m > 11) { m = 0; y += 1; }
      }
      return enMes(y, m);
    }
    return d.fecha_vencimiento || null;
  }

  function estado(d, hoyStr) {
    const pendiente = saldoPendiente(d);
    if (pendiente <= 0) return 'pagado';
    const ref = proximoPago(d, hoyStr);
    if (ref && d && d.dia_pago) {
      // Cuota mensual: atrasada si pasaron más de 3 días sin registrarse (el banco puede demorar).
      const a = new Date(ref + 'T12:00:00'), b = new Date(hoyStr + 'T12:00:00');
      return (b - a) / 86400000 > 3 ? 'vencido' : 'pendiente';
    }
    if (ref && ref < hoyStr) return 'vencido';
    return 'pendiente';
  }

  // Días que faltan para que venza (negativo si ya venció).
  // Devuelve null si la deuda no tiene fecha de vencimiento.
  function diasParaVencer(d, hoyStr) {
    const ref = proximoPago(d, hoyStr);
    if (!ref) return null;
    const a = new Date(ref + 'T12:00:00');
    const b = new Date(hoyStr + 'T12:00:00');
    return Math.round((a - b) / (24 * 3600 * 1000));
  }

  window.Deudas = {
    montoPagado,
    saldoPendiente,
    estado,
    diasParaVencer,
    proximoPago,
  };
})();
