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
    const mesesParaGasto = sel === 'actual' ? 1 : (sel === 'avg12' ? 12 : (sel === 'avg6' ? 6 : (sel === 'avg3' ? 3 : 12)));

    // ── Costos fijos: mensualizar recurrentes activos ──
    const hoyYM = new Date().toISOString().slice(0, 7);
    const recs = (state.config.recurrentes || []).filter(r => {
      // activo si no tiene "hasta" o el hasta es >= mes actual
      if (!r.hasta) return true;
      return String(r.hasta).slice(0, 7) >= hoyYM;
    });
    const mmr = window.montoMensualRecurrente || (r => Number(r.monto || 0));
    const fijoMensual = recs.reduce((s, r) => s + mmr(r), 0);
    const fijoPct = base > 0 ? (fijoMensual / base) * 100 : 0;

    // ── Variable: % por categoría ──
    const presup = state.config.presupuesto;
    const cats = state.config.categorias.slice();
    cats.forEach(c => { if (presup[c] === undefined) presup[c] = 0; });
    const totalPctVar = Object.values(presup).reduce((s, v) => s + Number(v || 0), 0);
    const varTarget = base * (totalPctVar / 100);
    const varReal = gastoPromedio(mesesParaGasto, null, { excluirRecurrentes: true });

    // ── Utilidad ──
    const utilProyectada = base - fijoMensual - varTarget;
    const utilReal = base - fijoMensual - varReal;
    const utilProyPct = base > 0 ? (utilProyectada / base) * 100 : 0;

    // ── KPIs ──
    document.getElementById('presBase').textContent = clp(base);
    document.getElementById('presBaseSub').textContent = label;
    document.getElementById('presFijos').textContent = clp(fijoMensual);
    document.getElementById('presFijosPct').textContent = base > 0 ? `${fijoPct.toFixed(0)}% del ingreso` : `${recs.length} periódico${recs.length === 1 ? '' : 's'}`;
    document.getElementById('presVar').textContent = clp(varTarget);
    document.getElementById('presVarPct').textContent = base > 0 ? `${totalPctVar.toFixed(0)}% del ingreso` : 'define los %';
    const utilEl = document.getElementById('presUtilidad');
    utilEl.textContent = clp(utilProyectada);
    utilEl.className = 'kpi-value ' + (utilProyectada >= 0 ? 'num-pos' : 'num-neg');
    document.getElementById('presUtilidadPct').innerHTML = utilProyPct >= 15
      ? `<span class="up">${utilProyPct.toFixed(0)}% — saludable</span>`
      : utilProyPct >= 5
        ? `<span style="color:var(--warning)">${utilProyPct.toFixed(0)}% — justo</span>`
        : `<span class="down">${utilProyPct.toFixed(0)}% — en riesgo</span>`;

    // ── Veredicto en lenguaje simple ──
    const vBox = document.getElementById('presVeredicto');
    if (vBox) {
      if (base <= 0) {
        vBox.style.display = 'none';
      } else {
        vBox.style.display = '';
        let icon, color, titulo, detalle;
        if (utilProyPct >= 15) {
          icon = '✅'; color = 'var(--success)';
          titulo = 'Plan saludable';
          detalle = `Después de cubrir fijos (${clp(fijoMensual)}) y tu presupuesto variable (${clp(varTarget)}), te quedan <strong>${clp(utilProyectada)}</strong> de utilidad (${utilProyPct.toFixed(0)}%). Vas bien — apunta a mantenerlo sobre 15%.`;
        } else if (utilProyPct >= 5) {
          icon = '⚠️'; color = 'var(--warning)';
          titulo = 'Margen justo';
          detalle = `Te queda ${clp(utilProyectada)} (${utilProyPct.toFixed(0)}%) de utilidad — está al filo. Un mes flojo de ventas te deja en cero. Considera bajar algún % variable o un costo fijo.`;
        } else {
          icon = '🚨'; color = 'var(--danger)';
          titulo = utilProyectada < 0 ? 'Plan en pérdida' : 'Sin colchón';
          detalle = utilProyectada < 0
            ? `Tu plan da <strong>pérdida de ${clp(Math.abs(utilProyectada))}</strong>: los fijos (${clp(fijoMensual)}) + variable (${clp(varTarget)}) superan el ingreso (${clp(base)}). Tienes que subir ventas, recortar un fijo, o bajar % variable.`
            : `Casi no queda utilidad (${clp(utilProyectada)}). Cualquier imprevisto te hace perder. Revisa qué fijo puedes renegociar o qué % variable recortar.`;
        }
        vBox.innerHTML = `<div style="display:flex; gap:12px; align-items:flex-start">
          <span style="font-size:22px; flex-shrink:0">${icon}</span>
          <div><strong style="font-size:15px; color:${color}">${titulo}</strong>
          <div style="font-size:13px; color:var(--text); line-height:1.55; margin-top:4px">${detalle}</div></div>
        </div>`;
      }
    }

    // ── Tabla 1: Costos fijos (read-only, mensualizado) ──
    const fwrap = document.getElementById('presFijosTabla');
    if (fwrap) {
      if (recs.length === 0) {
        fwrap.innerHTML = `<div class="empty" style="padding:18px"><h4>Sin gastos fijos cargados</h4>Agrega tus costos comprometidos (arriendo, sueldos, contador…) en <strong>Gastos → Periódicos</strong>. Aparecerán acá automáticamente y se descontarán del presupuesto.</div>`;
      } else {
        const freqLbl = (window.Gastos && window.Gastos.labelFrecuencia) ? window.Gastos.labelFrecuencia : (f => f || 'mes');
        const ordenF = recs.slice().sort((a, b) => mmr(b) - mmr(a));
        fwrap.innerHTML = `<table>
          <thead><tr><th>Concepto</th><th>Categoría</th><th>Frecuencia</th><th class="num">Equivale /mes</th><th class="num">% ingreso</th></tr></thead>
          <tbody>
            ${ordenF.map(r => {
              const mm = mmr(r);
              const p = base > 0 ? (mm / base) * 100 : 0;
              return `<tr>
                <td><strong>${escapeHtml(r.descripcion || r.proveedor || '—')}</strong></td>
                <td><span class="badge">${escapeHtml(r.categoria || '—')}</span></td>
                <td style="color:var(--text-muted); font-size:12px">${escapeHtml(clp(r.monto))}/${freqLbl(r.frecuencia)}</td>
                <td class="num num-neg">${clp(mm)}</td>
                <td class="num" style="color:var(--text-muted)">${base > 0 ? p.toFixed(1) + '%' : '—'}</td>
              </tr>`;
            }).join('')}
          </tbody>
          <tfoot><tr style="font-weight:700; background:var(--surface-2)">
            <td colspan="3">Total fijo mensual</td>
            <td class="num num-neg">${clp(fijoMensual)}</td>
            <td class="num">${base > 0 ? fijoPct.toFixed(1) + '%' : '—'}</td>
          </tr></tfoot>
        </table>`;
      }
    }

    // ── Tabla 2: Variable por categoría (% editable) ──
    if (base <= 0) {
      const w = document.querySelector('#view-presupuesto .table-wrap:has(#tablaPresupuesto)') ||
                (document.getElementById('tablaPresupuesto') && document.getElementById('tablaPresupuesto').parentElement);
      if (w) w.innerHTML = '<div class="empty"><h4>Sin ingreso base</h4>No hay datos de ventas en el período. Cambia la base arriba o ingresa un monto personalizado para calcular tu presupuesto.</div>';
      if (typeof window.renderListaRecurrentes === 'function') window.renderListaRecurrentes();
      return;
    }
    let tableEl = document.getElementById('tablaPresupuesto');
    if (!tableEl) {
      const w = document.querySelector('#view-presupuesto .table-wrap');
      if (w) { w.innerHTML = '<table id="tablaPresupuesto"></table>'; tableEl = document.getElementById('tablaPresupuesto'); }
    }
    if (!tableEl) return;

    const ordenadas = cats.slice().sort((a, b) => (presup[b] || 0) - (presup[a] || 0));
    tableEl.innerHTML = `
      <thead><tr>
        <th>Categoría</th>
        <th class="num" style="width:120px">% objetivo</th>
        <th class="num">Target /mes</th>
        <th class="num">Gasto real</th>
        <th class="num">Diferencia</th>
        <th style="width:90px">Estado</th>
      </tr></thead>
      <tbody>
        ${ordenadas.map(cat => {
          const pct = Number(presup[cat] || 0);
          const target = base * (pct / 100);
          const real = gastoPromedio(mesesParaGasto, cat, { excluirRecurrentes: true });
          const diff = target - real;
          const ratio = target > 0 ? real / target : (real > 0 ? 99 : 0);
          let estadoBadge = '';
          if (target === 0 && real === 0) estadoBadge = '<span class="badge">—</span>';
          else if (ratio > 1.10) estadoBadge = '<span class="badge danger">Sobre</span>';
          else if (ratio >= 0.85) estadoBadge = '<span class="badge success">En meta</span>';
          else if (real > 0) estadoBadge = '<span class="badge warning">Bajo</span>';
          else estadoBadge = '<span class="badge">Sin gasto</span>';
          return `<tr>
            <td><strong>${escapeHtml(cat)}</strong></td>
            <td class="num"><input type="number" min="0" max="100" step="0.5" value="${pct}" style="width:78px; text-align:right" onchange="actualizarPresupuestoPct('${escapeHtml(cat).replace(/'/g, "&#39;")}', this.value)" /> %</td>
            <td class="num">${clp(target)}</td>
            <td class="num ${real > target ? 'num-neg' : ''}">${clp(real)}</td>
            <td class="num ${diff < 0 ? 'num-neg' : 'num-pos'}">${diff >= 0 ? '+' : ''}${clp(diff)}</td>
            <td>${estadoBadge}</td>
          </tr>`;
        }).join('')}
      </tbody>
      <tfoot>
        <tr style="font-weight:600; background:var(--surface-2)">
          <td>Total variable</td>
          <td class="num">${totalPctVar.toFixed(1)} %</td>
          <td class="num">${clp(varTarget)}</td>
          <td class="num">${clp(varReal)}</td>
          <td class="num ${(varTarget - varReal) < 0 ? 'num-neg' : 'num-pos'}">${(varTarget - varReal) >= 0 ? '+' : ''}${clp(varTarget - varReal)}</td>
          <td>—</td>
        </tr>
        <tr style="background:var(--primary-soft)">
          <td><strong>Utilidad proyectada</strong><br><span style="font-size:11px; color:var(--text-muted)">Ingreso − Fijos − Variable</span></td>
          <td class="num"><strong>${utilProyPct.toFixed(1)} %</strong></td>
          <td class="num"><strong>${clp(utilProyectada)}</strong></td>
          <td class="num"><strong>${clp(utilReal)}</strong><br><span style="font-size:11px; color:var(--text-muted)">real</span></td>
          <td class="num"><strong>${(utilReal - utilProyectada) >= 0 ? '+' : ''}${clp(utilReal - utilProyectada)}</strong></td>
          <td>${utilProyectada >= 0 ? '<span class="badge success">+</span>' : '<span class="badge danger">−</span>'}</td>
        </tr>
      </tfoot>
    `;

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
