// src/renderer/views/presupuesto.js
// Vista Presupuesto: distribución del ingreso por categorías con % editables
// que auto-ajustan a 100% para mantener consistencia. Compara % objetivo vs
// gasto real promedio del período. Helpers acompañantes para el ajuste de %.
//
// Dependencias del inline / módulos:
//   - obtenerIngresoBase() (helper inline)
//   - gastoPromedio() (helper inline)
//   - PRESUPUESTO_DEFAULTS (constante inline, usado por reset)
//   - state, saveState, toast (globals)
//   - clp, escapeHtml (window globals desde utils/)

(function () {
  'use strict';

  // Modelo MIXTO:
  //   Ingreso − Costos fijos (auto, de Gastos Periódicos) − Variable (% por
  //   categoría) = Utilidad proyectada.
  // Los fijos NO se estiman: se mensualizan los recurrentes activos. El
  // variable se compara contra gasto real EXCLUYENDO lo que vino de
  // recurrentes (para no doble-contar).
  function renderPresupuesto() {
    if (!state.config.presupuesto) state.config.presupuesto = { ...PRESUPUESTO_DEFAULTS };
    const cb = document.getElementById('autoAjustePct');
    if (cb) cb.checked = state.config._autoAjustePct !== false;

    const { monto: base, label } = obtenerIngresoBase();
    const sel = document.getElementById('presupuestoBase').value;
    const mesesParaGasto = sel === 'actual' ? 1 : (sel === 'avg6' ? 6 : (sel === 'avg12' ? 12 : 3));

    // ── Costos fijos: mensualizar recurrentes activos ──
    const hoyYM = new Date().toISOString().slice(0, 7);
    const mmr = window.montoMensualRecurrente || (r => Number(r.monto || 0));
    const recs = (state.config.recurrentes || []).filter(r => !r.hasta || String(r.hasta).slice(0, 7) >= hoyYM);
    const fijoMensual = recs.reduce((s, r) => s + mmr(r), 0);

    // ── Tope variable del mes (modo "lo máximo posible") ──
    const puedeGastar = Math.max(0, base - fijoMensual);

    // ── Gasto variable acumulado este mes (excluye fijos = recurring_id) ──
    const ymG = (typeof ymOf === 'function') ? ymOf : (x => String(x || '').slice(0, 7));
    const ymHoy = (typeof nuevoMesActualYM === 'function') ? nuevoMesActualYM() : hoyYM;
    let gastadoVar = 0;
    (state.gastos || []).forEach(g => {
      if (g.recurring_id) return;
      if (ymG(g.fecha) !== ymHoy) return;
      gastadoVar += Number(g.monto || 0);
    });

    // ── Días del mes ──
    const hoy = new Date();
    const diasMes = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).getDate();
    const diaHoy = hoy.getDate();
    const diasRest = Math.max(0, diasMes - diaHoy);

    // ── HERO ──
    const heroEl = document.getElementById('presPuedesGastar');
    if (heroEl) {
      heroEl.textContent = clp(puedeGastar);
      heroEl.style.color = (base > 0 && puedeGastar > 0) ? 'var(--primary)' : 'var(--danger)';
    }
    const heroSub = document.getElementById('presPuedesGastarSub');
    if (heroSub) {
      heroSub.innerHTML = base > 0
        ? `Ingreso ${escapeHtml(label)}: <strong>${clp(base)}</strong> &nbsp;−&nbsp; Costos fijos: <strong>${clp(fijoMensual)}</strong>`
        : 'Sin datos de ventas en el período. Elige otra base o ingresa un monto arriba.';
    }

    // ── TRACKER ──
    const pct = puedeGastar > 0 ? (gastadoVar / puedeGastar) * 100 : (gastadoVar > 0 ? 100 : 0);
    const restante = puedeGastar - gastadoVar;
    const bar = document.getElementById('presTrackBar');
    if (bar) {
      bar.style.width = Math.min(100, Math.max(0, pct)).toFixed(0) + '%';
      bar.style.background = pct >= 100 ? 'var(--danger)' : (pct >= 70 ? 'var(--warning)' : 'var(--success)');
    }
    const resEl = document.getElementById('presTrackResumen');
    if (resEl) {
      resEl.innerHTML = puedeGastar > 0
        ? `Llevas gastado <strong>${clp(gastadoVar)}</strong> de <strong>${clp(puedeGastar)}</strong> <span style="color:var(--text-muted); font-weight:400">(${pct.toFixed(0)}%)</span>`
        : 'No hay presupuesto variable disponible este mes.';
    }
    const restEl = document.getElementById('presTrackRestante');
    if (restEl) {
      restEl.textContent = clp(restante);
      restEl.style.color = restante < 0 ? 'var(--danger)' : 'var(--success)';
    }
    const diasEl = document.getElementById('presTrackDias');
    if (diasEl) diasEl.textContent = diasRest;
    const ritmoEl = document.getElementById('presTrackRitmo');
    if (ritmoEl) {
      if (puedeGastar <= 0) {
        ritmoEl.textContent = '';
      } else if (restante < 0) {
        ritmoEl.innerHTML = `<span style="color:var(--danger); font-weight:600">🚨 Te pasaste por ${clp(Math.abs(restante))}</span>`;
      } else {
        const proyFin = diaHoy > 0 ? gastadoVar / diaHoy * diasMes : 0;
        const porDia = diasRest > 0 ? restante / diasRest : restante;
        ritmoEl.innerHTML = proyFin > puedeGastar * 1.05
          ? `<span style="color:var(--warning); font-weight:600">⚠️ A este ritmo terminarías en ${clp(proyFin)}</span>`
          : `Puedes gastar ~<strong style="color:var(--text)">${clp(porDia)}</strong>/día y llegas bien`;
      }
    }

    // ── VENTA MÍNIMA ──
    const varTipico = gastoPromedio(mesesParaGasto, null, { excluirRecurrentes: true });
    const ventaFijos = fijoMensual;
    const ventaTotal = fijoMensual + varTipico;
    const vf = document.getElementById('presVentaFijos');  if (vf) vf.textContent = clp(ventaFijos);
    const vt = document.getElementById('presVentaTotal');  if (vt) vt.textContent = clp(ventaTotal);
    const vfd = document.getElementById('presVentaFijosDia'); if (vfd) vfd.textContent = diasMes ? `≈ ${clp(ventaFijos / diasMes)} por día` : '';
    const vtd = document.getElementById('presVentaTotalDia'); if (vtd) vtd.textContent = diasMes ? `≈ ${clp(ventaTotal / diasMes)} por día` : '';

    const ventasMes = (typeof ventasPorMes === 'function' ? (ventasPorMes()[ymHoy] || 0) : 0);
    const vEst = document.getElementById('presVentaEstado');
    if (vEst) {
      if (ventasMes <= 0) {
        vEst.innerHTML = '<span style="color:var(--text-muted)">Aún no hay ventas registradas este mes para proyectar.</span>';
      } else {
        const proyVenta = diaHoy > 0 ? ventasMes / diaHoy * diasMes : ventasMes;
        const cubreFijos = proyVenta >= ventaFijos;
        const cubreTodo = proyVenta >= ventaTotal;
        let icon, color, msg;
        if (cubreTodo) { icon = '✅'; color = 'var(--success)'; msg = 'vas a cubrir fijos y tu gasto variable típico. Mes sano.'; }
        else if (cubreFijos) { icon = '⚠️'; color = 'var(--warning)'; msg = 'cubres los fijos pero quedas justo para lo variable. Sin colchón.'; }
        else { icon = '🚨'; color = 'var(--danger)'; msg = `no alcanzas a cubrir los fijos: este mes pierdes plata. Te faltan ${clp(ventaFijos - proyVenta)} de venta.`; }
        vEst.innerHTML = `Este mes llevas vendido <strong>${clp(ventasMes)}</strong>. Proyectado a fin de mes: <strong>${clp(proyVenta)}</strong>.<br><span style="color:${color}; font-weight:600">${icon} A ese ritmo ${msg}</span>`;
      }
    }

    // ── Tabla costos fijos (read-only, mensualizado) ──
    const fwrap = document.getElementById('presFijosTabla');
    if (fwrap) {
      if (recs.length === 0) {
        fwrap.innerHTML = `<div class="empty" style="padding:18px"><h4>Sin costos fijos cargados</h4>Agrega arriendo, sueldos, contador… en <strong>Gastos → Periódicos</strong>. Aparecerán acá automáticamente y se descontarán del presupuesto.</div>`;
      } else {
        const freqLbl = (window.Gastos && window.Gastos.labelFrecuencia) ? window.Gastos.labelFrecuencia : (x => x || 'mes');
        const ordenF = recs.slice().sort((a, b) => mmr(b) - mmr(a));
        fwrap.innerHTML = `<table>
          <thead><tr><th>Concepto</th><th>Categoría</th><th>Cada cuánto</th><th class="num">Equivale /mes</th></tr></thead>
          <tbody>${ordenF.map(r => `<tr>
            <td><strong>${escapeHtml(r.descripcion || r.proveedor || '—')}</strong></td>
            <td><span class="badge">${escapeHtml(r.categoria || '—')}</span></td>
            <td style="color:var(--text-muted); font-size:12px">${escapeHtml(clp(r.monto))}/${escapeHtml(freqLbl(r.frecuencia))}</td>
            <td class="num num-neg">${clp(mmr(r))}</td>
          </tr>`).join('')}</tbody>
          <tfoot><tr style="font-weight:700; background:var(--surface-2)">
            <td colspan="3">Total fijo mensual</td><td class="num num-neg">${clp(fijoMensual)}</td>
          </tr></tfoot>
        </table>`;
      }
    }

    // ── Tabla % por categoría (avanzado, dentro de <details>) ──
    const tableEl = document.getElementById('tablaPresupuesto');
    if (tableEl) {
      const presup = state.config.presupuesto;
      const cats = state.config.categorias.slice();
      cats.forEach(c => { if (presup[c] === undefined) presup[c] = 0; });
      const totalPctVar = Object.values(presup).reduce((s, v) => s + Number(v || 0), 0);
      if (base <= 0) {
        tableEl.innerHTML = '<tbody><tr><td style="padding:14px; color:var(--text-muted)">Sin ingreso base para calcular targets por categoría.</td></tr></tbody>';
      } else {
        const ordenadas = cats.slice().sort((a, b) => (presup[b] || 0) - (presup[a] || 0));
        tableEl.innerHTML = `
          <thead><tr><th>Categoría</th><th class="num" style="width:120px">% objetivo</th><th class="num">Target /mes</th><th class="num">Gasto real</th><th class="num">Diferencia</th><th style="width:90px">Estado</th></tr></thead>
          <tbody>${ordenadas.map(cat => {
            const p = Number(presup[cat] || 0);
            const target = base * (p / 100);
            const real = gastoPromedio(mesesParaGasto, cat, { excluirRecurrentes: true });
            const diff = target - real;
            const ratio = target > 0 ? real / target : (real > 0 ? 99 : 0);
            let b = '';
            if (target === 0 && real === 0) b = '<span class="badge">—</span>';
            else if (ratio > 1.10) b = '<span class="badge danger">Sobre</span>';
            else if (ratio >= 0.85) b = '<span class="badge success">En meta</span>';
            else if (real > 0) b = '<span class="badge warning">Bajo</span>';
            else b = '<span class="badge">Sin gasto</span>';
            return `<tr>
              <td><strong>${escapeHtml(cat)}</strong></td>
              <td class="num"><input type="number" min="0" max="100" step="0.5" value="${p}" style="width:78px; text-align:right" onchange="actualizarPresupuestoPct('${escapeHtml(cat).replace(/'/g, "&#39;")}', this.value)" /> %</td>
              <td class="num">${clp(target)}</td>
              <td class="num ${real > target ? 'num-neg' : ''}">${clp(real)}</td>
              <td class="num ${diff < 0 ? 'num-neg' : 'num-pos'}">${diff >= 0 ? '+' : ''}${clp(diff)}</td>
              <td>${b}</td>
            </tr>`;
          }).join('')}</tbody>
          <tfoot><tr style="font-weight:600; background:var(--surface-2)">
            <td>Total variable</td>
            <td class="num">${totalPctVar.toFixed(1)} %</td>
            <td class="num">${clp(base * totalPctVar / 100)}</td>
            <td class="num">${clp(gastoPromedio(mesesParaGasto, null, { excluirRecurrentes: true }))}</td>
            <td></td><td></td>
          </tr></tfoot>`;
      }
    }

    if (typeof window.renderListaRecurrentes === 'function') window.renderListaRecurrentes();
  }
  // Cambiar el % de una categoría. Si auto-ajuste está activo, redistribuye
  // el delta proporcionalmente entre las otras categorías para mantener el
  // total cerca de 100%. Iterativo (hasta 5 pasos) para manejar topes en 0.
  function actualizarPresupuestoPct(cat, valor) {
    const real = cat.replace(/&#39;/g, "'");
    if (!state.config.presupuesto) state.config.presupuesto = {};
    const oldVal = Number(state.config.presupuesto[real] || 0);
    const newVal = Math.max(0, Math.min(100, Number(valor) || 0));
    const delta = newVal - oldVal;

    state.config.presupuesto[real] = newVal;

    const autoAjuste = document.getElementById('autoAjustePct')?.checked;
    if (autoAjuste && delta !== 0) {
      const otrasKeys = Object.keys(state.config.presupuesto).filter(k => k !== real);
      let sumaOtras = otrasKeys.reduce((s, k) => s + Number(state.config.presupuesto[k] || 0), 0);

      if (sumaOtras > 0) {
        let restante = -delta;
        for (let pass = 0; pass < 5 && Math.abs(restante) > 0.01; pass++) {
          const elegibles = otrasKeys.filter(k => state.config.presupuesto[k] > 0 || restante > 0);
          const sumaElegibles = elegibles.reduce((s, k) => s + Number(state.config.presupuesto[k] || 0), 0);
          if (sumaElegibles <= 0) break;
          let aplicado = 0;
          elegibles.forEach(k => {
            const peso = state.config.presupuesto[k] / sumaElegibles;
            const ajuste = restante * peso;
            const nuevo = Math.max(0, Math.min(100, state.config.presupuesto[k] + ajuste));
            aplicado += nuevo - state.config.presupuesto[k];
            state.config.presupuesto[k] = nuevo;
          });
          restante -= aplicado;
        }
      }
    }

    // Redondear a 1 decimal para mantener números limpios
    Object.keys(state.config.presupuesto).forEach(k => {
      state.config.presupuesto[k] = Math.round(state.config.presupuesto[k] * 10) / 10;
    });

    saveState();
    renderPresupuesto();
  }

  function guardarAutoAjuste() {
    state.config._autoAjustePct = document.getElementById('autoAjustePct').checked;
    saveState();
  }

  function resetearPresupuestoDefaults() {
    if (!confirm('¿Volver a los porcentajes recomendados de la industria? Se perderán tus ajustes personalizados.')) return;
    state.config.presupuesto = { ...PRESUPUESTO_DEFAULTS };
    saveState();
    renderPresupuesto();
    toast('Restaurados los porcentajes recomendados', 'success');
  }

  window.renderPresupuesto = renderPresupuesto;
  window.actualizarPresupuestoPct = actualizarPresupuestoPct;
  window.guardarAutoAjuste = guardarAutoAjuste;
  window.resetearPresupuestoDefaults = resetearPresupuestoDefaults;
})();
