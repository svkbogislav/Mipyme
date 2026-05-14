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

  function renderPresupuesto() {
    if (!state.config.presupuesto) state.config.presupuesto = { ...PRESUPUESTO_DEFAULTS };

    // Restaurar el toggle de auto-ajuste desde state (default: true)
    const cb = document.getElementById('autoAjustePct');
    if (cb) cb.checked = state.config._autoAjustePct !== false;

    const { monto: base, label } = obtenerIngresoBase();
    const sel = document.getElementById('presupuestoBase').value;
    const mesesParaGasto = sel === 'actual' ? 1 : (sel === 'avg12' ? 12 : (sel === 'avg6' ? 6 : (sel === 'avg3' ? 3 : 12)));

    const presup = state.config.presupuesto;
    const cats = state.config.categorias.slice();
    cats.forEach(c => { if (presup[c] === undefined) presup[c] = 0; });

    const totalPct = Object.values(presup).reduce((s, v) => s + Number(v || 0), 0);
    const totalAsignado = base * (totalPct / 100);
    const utilidadPct = Math.max(0, 100 - totalPct);
    const utilidadEsperada = base * (utilidadPct / 100);

    const gastoRealTotal = gastoPromedio(mesesParaGasto);

    // KPIs
    document.getElementById('presBase').textContent = clp(base);
    document.getElementById('presBaseSub').textContent = label;
    document.getElementById('presAsignado').textContent = clp(totalAsignado);
    document.getElementById('presAsignadoPct').innerHTML = `<span style="color:var(--text-muted)">${totalPct.toFixed(0)}% del ingreso</span>`;
    document.getElementById('presUtilidad').textContent = clp(utilidadEsperada);
    document.getElementById('presUtilidadPct').innerHTML = utilidadPct >= 10
      ? `<span class="up">${utilidadPct.toFixed(0)}% — saludable</span>`
      : utilidadPct > 0
        ? `<span style="color:var(--warning)">${utilidadPct.toFixed(0)}% — bajo</span>`
        : `<span class="down">Sin margen — pasaste 100%</span>`;
    document.getElementById('presGastoReal').textContent = clp(gastoRealTotal);
    const ratioGasto = base > 0 ? gastoRealTotal / base : 0;
    document.getElementById('presEstadoGeneral').innerHTML = base > 0
      ? (ratioGasto > (totalPct / 100) + 0.05
          ? `<span class="down">Sobre presupuesto (${(ratioGasto * 100).toFixed(0)}% del ingreso)</span>`
          : ratioGasto > 0
            ? `<span class="up">Dentro de presupuesto (${(ratioGasto * 100).toFixed(0)}% del ingreso)</span>`
            : '<span style="color:var(--text-muted)">Sin gastos en el período</span>')
      : '';

    // Tabla por categoría
    const t = document.getElementById('tablaPresupuesto');
    if (base <= 0) {
      t.outerHTML = '<table id="tablaPresupuesto"></table>';
      document.getElementById('tablaPresupuesto').outerHTML = '<div class="empty"><h4>Sin ingreso base</h4>No hay datos de ventas en el período seleccionado. Cambia la base o ingresa un monto personalizado.</div>';
      return;
    }
    let tableEl = document.getElementById('tablaPresupuesto');
    if (!tableEl) {
      const wrap = document.querySelector('#view-presupuesto .table-wrap');
      wrap.innerHTML = '<table id="tablaPresupuesto"></table>';
      tableEl = document.getElementById('tablaPresupuesto');
    }

    const ordenadas = cats.slice().sort((a, b) => (presup[b] || 0) - (presup[a] || 0));

    tableEl.innerHTML = `
      <thead><tr>
        <th>Categoría</th>
        <th class="num" style="width:120px">% Recom.</th>
        <th class="num">Target mensual</th>
        <th class="num">Gasto real</th>
        <th class="num">Diferencia</th>
        <th style="width:90px">Estado</th>
      </tr></thead>
      <tbody>
        ${ordenadas.map(cat => {
          const pct = Number(presup[cat] || 0);
          const target = base * (pct / 100);
          const real = gastoPromedio(mesesParaGasto, cat);
          const diff = target - real;
          const ratio = target > 0 ? real / target : (real > 0 ? 99 : 0);
          let estadoBadge = '';
          if (target === 0 && real === 0) estadoBadge = '<span class="badge">—</span>';
          else if (ratio > 1.10) estadoBadge = '<span class="badge danger">Sobre</span>';
          else if (ratio >= 0.85) estadoBadge = '<span class="badge success">En meta</span>';
          else if (real > 0) estadoBadge = '<span class="badge warning">Bajo meta</span>';
          else estadoBadge = '<span class="badge">Sin gasto</span>';

          return `<tr>
            <td><strong>${escapeHtml(cat)}</strong></td>
            <td class="num"><input type="number" min="0" max="100" step="0.5" value="${pct}" style="width:80px; text-align:right" onchange="actualizarPresupuestoPct('${escapeHtml(cat).replace(/'/g, "&#39;")}', this.value)" /> %</td>
            <td class="num">${clp(target)}</td>
            <td class="num ${real > target ? 'num-neg' : ''}">${clp(real)}</td>
            <td class="num ${diff < 0 ? 'num-neg' : 'num-pos'}">${diff >= 0 ? '+' : ''}${clp(diff)}</td>
            <td>${estadoBadge}</td>
          </tr>`;
        }).join('')}
      </tbody>
      <tfoot>
        <tr style="font-weight:600; background:var(--surface-2)">
          <td>Total asignado</td>
          <td class="num">${totalPct.toFixed(1)} %</td>
          <td class="num">${clp(totalAsignado)}</td>
          <td class="num">${clp(gastoRealTotal)}</td>
          <td class="num ${(totalAsignado - gastoRealTotal) < 0 ? 'num-neg' : 'num-pos'}">${(totalAsignado - gastoRealTotal) >= 0 ? '+' : ''}${clp(totalAsignado - gastoRealTotal)}</td>
          <td>—</td>
        </tr>
        <tr style="background:var(--primary-soft); color:var(--primary)">
          <td><strong>Utilidad esperada (residual)</strong></td>
          <td class="num"><strong>${utilidadPct.toFixed(1)} %</strong></td>
          <td class="num"><strong>${clp(utilidadEsperada)}</strong></td>
          <td class="num"><strong>${clp(base - gastoRealTotal)}</strong></td>
          <td class="num"><strong>${(base - gastoRealTotal) >= utilidadEsperada ? '+' : ''}${clp((base - gastoRealTotal) - utilidadEsperada)}</strong></td>
          <td>${(base - gastoRealTotal) >= utilidadEsperada ? '<span class="badge success">En meta</span>' : '<span class="badge danger">Bajo meta</span>'}</td>
        </tr>
      </tfoot>
    `;

    // Pintar la lista de gastos fijos mensuales (la card vive en esta vista
    // desde que se movió de Configuración).
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
