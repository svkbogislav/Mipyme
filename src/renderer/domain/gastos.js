// src/renderer/domain/gastos.js
// Domain logic para gastos recurrentes: generación, actualización, eliminación
// y predicado "¿este recurrente dispara en esta fecha?".
//
// Módulo FUNCIONAL: recibe `state` por argumento. NO llama saveState ni toca
// localStorage (eso es responsabilidad del caller, vía Storage.*). Las
// funciones mutan `state.gastos` in-place y devuelven cuántos cambios hicieron;
// el caller persiste si corresponde.
//
// Dependencias (window globals cargados antes):
//   window.uid()   de src/renderer/utils/strings.js
//   window.ymdOf() de src/renderer/utils/dates.js
//
// Frecuencias soportadas: mensual / quincenal / semanal / diario / anual.

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Helpers internos
  // ---------------------------------------------------------------------------

  // Parsea 'YYYY-MM' o 'YYYY-MM-DD' a Date local a las 12:00 (evita drama de
  // timezone cuando el navegador asume UTC para 'YYYY-MM-DD').
  function _parseFecha(raw, fallback) {
    if (!raw) return fallback;
    const s = raw.length === 7 ? raw + '-01' : raw;
    return new Date(s + 'T12:00:00');
  }

  // Crea un gasto "hijo" de un recurrente con la fecha dada. Idempotente:
  // si ya existe un gasto con (recurring_id, fecha) iguales, no duplica.
  // Devuelve true si lo agregó, false si ya existía.
  function _pushGasto(state, rec, fecha) {
    const yaExiste = state.gastos.some(g => g.recurring_id === rec.id && g.fecha === fecha);
    if (yaExiste) return false;
    state.gastos.push({
      id: window.uid(),
      fecha,
      monto: Number(rec.monto),
      categoria: rec.categoria || 'Otros',
      proveedor: rec.proveedor || rec.descripcion,
      descripcion: rec.descripcion,
      metodo: rec.metodo || 'Tarjeta crédito',
      account_id: rec.account_id,
      recurring_id: rec.id
    });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Generador
  //
  // Recorre el calendario del recurrente desde `desde` hasta `hasta` (o hoy)
  // y crea gastos para cada disparo. Idempotente: corerla varias veces no
  // genera duplicados (los previos ya existen con el mismo recurring_id+fecha).
  //
  // Mutación in-place sobre state.gastos. Devuelve la cantidad de gastos
  // nuevos creados — el caller decide si persistir (típicamente sí cuando > 0).
  // ---------------------------------------------------------------------------
  function generarRecurrentes(state) {
    const recs = (state && state.config && state.config.recurrentes) || [];
    if (recs.length === 0) return 0;
    const hoy = new Date(); hoy.setHours(12, 0, 0, 0);
    const hoyStr = window.ymdOf(hoy.toISOString());
    let cambios = 0;

    const push = (rec, fecha) => {
      if (_pushGasto(state, rec, fecha)) cambios++;
    };

    recs.forEach(rec => {
      if (!rec.desde || !rec.monto) return;
      const frecuencia = rec.frecuencia || 'mensual';

      if (frecuencia === 'mensual') {
        // Iterar mes calendario, día dado por rec.dia (clamp 1..28).
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
        // Cada 14 días desde "desde". Útil para sueldos quincenales.
        const desdeD = _parseFecha(rec.desde);
        const hastaD = _parseFecha(rec.hasta, hoy);
        const cur = new Date(desdeD);
        while (cur <= hastaD) {
          push(rec, window.ymdOf(cur.toISOString()));
          cur.setDate(cur.getDate() + 14);
        }
      } else if (frecuencia === 'semanal') {
        // Cada 7 días desde el primer día de la semana ≥ "desde" que coincide
        // con rec.diaSemana (0=dom..6=sáb). Si no se especifica, usa el DOW de "desde".
        const desdeD = _parseFecha(rec.desde);
        const hastaD = _parseFecha(rec.hasta, hoy);
        const targetDOW = (rec.diaSemana !== undefined && rec.diaSemana !== null)
          ? Number(rec.diaSemana) : desdeD.getDay();
        const cur = new Date(desdeD);
        const offset = (targetDOW - cur.getDay() + 7) % 7;
        cur.setDate(cur.getDate() + offset);
        while (cur <= hastaD) {
          push(rec, window.ymdOf(cur.toISOString()));
          cur.setDate(cur.getDate() + 7);
        }
      } else if (frecuencia === 'diario') {
        const desdeD = _parseFecha(rec.desde);
        const hastaD = _parseFecha(rec.hasta, hoy);
        const cur = new Date(desdeD);
        while (cur <= hastaD) {
          push(rec, window.ymdOf(cur.toISOString()));
          cur.setDate(cur.getDate() + 1);
        }
      } else if (frecuencia === 'anual') {
        // Misma fecha (mes/día) cada año. Útil para patentes, seguros.
        const desdeD = _parseFecha(rec.desde);
        const hastaD = _parseFecha(rec.hasta, hoy);
        const cur = new Date(desdeD);
        while (cur <= hastaD) {
          push(rec, window.ymdOf(cur.toISOString()));
          cur.setFullYear(cur.getFullYear() + 1);
        }
      }
    });

    return cambios;
  }

  // ---------------------------------------------------------------------------
  // Sincronización de gastos existentes con cambios al recurrente
  //
  // Cuando el usuario edita el monto/categoría/etc de un recurrente, queremos
  // que todos sus gastos generados reflejen los nuevos valores. Mutación
  // in-place; el caller persiste.
  // ---------------------------------------------------------------------------
  function actualizarGastosDeRecurrente(state, rec) {
    if (!state || !rec) return 0;
    let cambios = 0;
    state.gastos.forEach(g => {
      if (g.recurring_id !== rec.id) return;
      g.monto = Number(rec.monto);
      g.categoria = rec.categoria;
      g.proveedor = rec.proveedor || rec.descripcion;
      g.descripcion = rec.descripcion;
      g.metodo = rec.metodo;
      cambios++;
    });
    return cambios;
  }

  function eliminarGastosDeRecurrente(state, recId) {
    if (!state) return 0;
    const antes = state.gastos.length;
    state.gastos = state.gastos.filter(g => g.recurring_id !== recId);
    return antes - state.gastos.length;
  }

  // ---------------------------------------------------------------------------
  // Predicado: ¿este recurrente dispara en esta fecha?
  //
  // Útil para forward-projections (calendario "próximos N días") sin tener
  // que pre-generar gastos futuros.
  // ---------------------------------------------------------------------------
  function recurrenteDisparaEn(rec, fechaD) {
    const fechaStr = window.ymdOf(fechaD.toISOString());
    const desdeStr = (rec.desde || '').length === 7 ? rec.desde + '-01' : rec.desde;
    if (!desdeStr || fechaStr < desdeStr) return false;
    if (rec.hasta) {
      const hastaStr = rec.hasta.length === 7 ? rec.hasta + '-28' : rec.hasta;
      if (fechaStr > hastaStr) return false;
    }
    const f = rec.frecuencia || 'mensual';
    if (f === 'mensual') {
      const diaCfg = Math.min(28, Math.max(1, Number(rec.dia) || 1));
      return fechaD.getDate() === diaCfg;
    }
    if (f === 'diario') return true;
    if (f === 'semanal') {
      const desdeD = new Date(desdeStr + 'T12:00:00');
      const targetDOW = (rec.diaSemana !== undefined && rec.diaSemana !== null)
        ? Number(rec.diaSemana) : desdeD.getDay();
      return fechaD.getDay() === targetDOW;
    }
    if (f === 'quincenal') {
      const desdeD = new Date(desdeStr + 'T12:00:00');
      const diff = Math.round((fechaD - desdeD) / (24 * 3600 * 1000));
      return diff >= 0 && diff % 14 === 0;
    }
    if (f === 'anual') {
      const desdeD = new Date(desdeStr + 'T12:00:00');
      return fechaD.getMonth() === desdeD.getMonth() && fechaD.getDate() === desdeD.getDate();
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Display helpers
  // ---------------------------------------------------------------------------

  // Sufijo corto para mostrar después de un monto: $50.000/mes, $25.000/quincena
  function labelFrecuencia(f) {
    return {
      mensual:   'mes',
      quincenal: 'quincena',
      semanal:   'semana',
      diario:    'día',
      anual:     'año'
    }[f] || 'mes';
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  window.Gastos = {
    generarRecurrentes,
    actualizarGastosDeRecurrente,
    eliminarGastosDeRecurrente,
    recurrenteDisparaEn,
    labelFrecuencia,
  };
})();
