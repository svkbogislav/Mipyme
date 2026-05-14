// src/renderer/domain/cobros.js
// Cuentas por cobrar (CxC). Espejo de Deudas pero con sentido invertido —
// el cliente nos debe a nosotros. Estructura: { id, deudor, monto_total,
// fecha_vencimiento, pagos: [...] } donde "pagos" son los cobros recibidos.

(function () {
  'use strict';

  function montoCobrado(c) {
    return ((c && c.pagos) || []).reduce((s, p) => s + Number(p.monto || 0), 0);
  }

  function saldoPendiente(c) {
    return Math.max(0, Number((c && c.monto_total) || 0) - montoCobrado(c));
  }

  // 'cobrado' → ya entró todo; 'vencido' → pasó la fecha sin cobrar; 'pendiente' → ok
  function estado(c, hoyStr) {
    const pendiente = saldoPendiente(c);
    if (pendiente <= 0) return 'cobrado';
    if (c && c.fecha_vencimiento && c.fecha_vencimiento < hoyStr) return 'vencido';
    return 'pendiente';
  }

  function diasParaVencer(c, hoyStr) {
    if (!c || !c.fecha_vencimiento) return null;
    const a = new Date(c.fecha_vencimiento + 'T12:00:00');
    const b = new Date(hoyStr + 'T12:00:00');
    return Math.round((a - b) / (24 * 3600 * 1000));
  }

  // ─── Ley 21.131 (pago a 30 días con intereses automáticos) ─────────────
  // La ley chilena 21.131 obliga al deudor a pagar en 30 días desde
  // recepción de la factura. Si se atrasa, devenga intereses automáticos.
  // Usamos tasa de interés corriente mensual (~2%/mes — el usuario puede
  // override vía state.config.intereses_mora_mensual_pct).
  // El interés se devenga solo sobre el SALDO VENCIDO desde fecha_vencimiento.
  function interesesMora(c, hoyStr, tasaMensualPct) {
    if (!c || !c.fecha_vencimiento) return 0;
    const saldo = saldoPendiente(c);
    if (saldo <= 0) return 0;
    const dias = diasParaVencer(c, hoyStr);
    if (dias === null || dias >= 0) return 0; // no vencida aún
    const diasMora = -dias;
    const tasaMensual = (Number(tasaMensualPct) || 2.0) / 100;
    const tasaDiaria = tasaMensual / 30;
    return Math.round(saldo * tasaDiaria * diasMora);
  }

  // ─── Aging AR: distribución por antigüedad de la deuda ─────────────────
  // Devuelve { al_dia, 1_30, 31_60, 61_90, mas_90 } con la suma de saldos
  // pendientes en cada bucket. "Al día" incluye cobros sin fecha de venc.
  // Cubre solo cobros con saldo > 0.
  function aging(cobros, hoyStr) {
    const buckets = { al_dia: 0, b1_30: 0, b31_60: 0, b61_90: 0, mas_90: 0 };
    (cobros || []).forEach(c => {
      const saldo = saldoPendiente(c);
      if (saldo <= 0) return;
      const dias = diasParaVencer(c, hoyStr);
      if (dias === null || dias >= 0) {
        buckets.al_dia += saldo;
        return;
      }
      const mora = -dias;
      if (mora <= 30) buckets.b1_30 += saldo;
      else if (mora <= 60) buckets.b31_60 += saldo;
      else if (mora <= 90) buckets.b61_90 += saldo;
      else buckets.mas_90 += saldo;
    });
    return buckets;
  }

  // ─── Cobros recurrentes (suscripciones, mensualidades) ────────────────
  // Espejo del patrón de gastos.recurrentes pero invertido: cada disparo
  // crea una cuenta-por-cobrar nueva con su propio venc. (típicamente
  // emisión + 30 días, plazo legal de la Ley 21.131).
  //
  // Estructura del recurrente en state.config.cobros_recurrentes:
  //   { id, deudor, monto, descripcion, frecuencia, dia, desde, hasta,
  //     dias_vencimiento (default 30) }

  function _parseFechaC(raw, fallback) {
    if (!raw) return fallback;
    const s = raw.length === 7 ? raw + '-01' : raw;
    return new Date(s + 'T12:00:00');
  }

  function _pushCobro(state, rec, fechaEmision) {
    const yaExiste = (state.cobros || []).some(c =>
      c.recurring_id === rec.id && c.fecha_emision === fechaEmision
    );
    if (yaExiste) return false;
    const dV = Number(rec.dias_vencimiento) || 30;
    const emisionD = new Date(fechaEmision + 'T12:00:00');
    const vencD = new Date(emisionD); vencD.setDate(vencD.getDate() + dV);
    const fechaVenc = vencD.toISOString().slice(0, 10);
    if (!state.cobros) state.cobros = [];
    state.cobros.push({
      id: window.uid(),
      deudor: rec.deudor,
      monto_total: Number(rec.monto),
      descripcion: rec.descripcion || '',
      fecha_emision: fechaEmision,
      fecha_vencimiento: fechaVenc,
      pagos: [],
      recurring_id: rec.id,
      created_at: new Date().toISOString()
    });
    return true;
  }

  function generarCobrosRecurrentes(state) {
    const recs = (state && state.config && state.config.cobros_recurrentes) || [];
    if (recs.length === 0) return 0;
    const hoy = new Date(); hoy.setHours(12, 0, 0, 0);
    const hoyStr = window.ymdOf(hoy.toISOString());
    let cambios = 0;

    const push = (rec, fecha) => {
      if (_pushCobro(state, rec, fecha)) cambios++;
    };

    recs.forEach(rec => {
      if (!rec.desde || !rec.monto || !rec.deudor) return;
      const frecuencia = rec.frecuencia || 'mensual';
      if (frecuencia === 'mensual') {
        const desdeMes = rec.desde.slice(0, 7);
        const hastaMes = (rec.hasta || hoyStr).slice(0, 7);
        let [yA, mA] = desdeMes.split('-').map(Number);
        const [yB, mB] = hastaMes.split('-').map(Number);
        while (yA < yB || (yA === yB && mA <= mB)) {
          const ym = `${yA}-${String(mA).padStart(2, '0')}`;
          const dia = Math.min(28, Math.max(1, Number(rec.dia) || 1));
          push(rec, `${ym}-${String(dia).padStart(2, '0')}`);
          mA++; if (mA > 12) { mA = 1; yA++; }
        }
      } else if (frecuencia === 'quincenal') {
        const desdeD = _parseFechaC(rec.desde);
        const hastaD = _parseFechaC(rec.hasta, hoy);
        const cur = new Date(desdeD);
        while (cur <= hastaD) {
          push(rec, window.ymdOf(cur.toISOString()));
          cur.setDate(cur.getDate() + 14);
        }
      } else if (frecuencia === 'anual') {
        const desdeD = _parseFechaC(rec.desde);
        const hastaD = _parseFechaC(rec.hasta, hoy);
        const cur = new Date(desdeD);
        while (cur <= hastaD) {
          push(rec, window.ymdOf(cur.toISOString()));
          cur.setFullYear(cur.getFullYear() + 1);
        }
      }
    });

    return cambios;
  }

  function actualizarCobrosDeRecurrente(state, rec) {
    if (!state || !rec) return 0;
    let cambios = 0;
    (state.cobros || []).forEach(c => {
      if (c.recurring_id !== rec.id) return;
      // No tocar cobros con pagos parciales — el monto ya está consolidado.
      if ((c.pagos || []).length > 0) return;
      c.deudor = rec.deudor;
      c.monto_total = Number(rec.monto);
      c.descripcion = rec.descripcion || '';
      cambios++;
    });
    return cambios;
  }

  function eliminarCobrosDeRecurrente(state, recId, soloPendientes) {
    if (!state) return 0;
    const antes = (state.cobros || []).length;
    if (soloPendientes) {
      state.cobros = (state.cobros || []).filter(c =>
        c.recurring_id !== recId || (c.pagos || []).length > 0
      );
    } else {
      state.cobros = (state.cobros || []).filter(c => c.recurring_id !== recId);
    }
    return antes - state.cobros.length;
  }

  function labelFrecuenciaCobro(f) {
    return { mensual: 'mes', quincenal: 'quincena', anual: 'año' }[f] || 'mes';
  }

  window.Cobros = {
    montoCobrado,
    saldoPendiente,
    estado,
    diasParaVencer,
    interesesMora,
    aging,
    generarCobrosRecurrentes,
    actualizarCobrosDeRecurrente,
    eliminarCobrosDeRecurrente,
    labelFrecuenciaCobro,
  };
})();
