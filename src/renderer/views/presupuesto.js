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

    // ── Presupuesto por categoría (asignable en $ o en %) ──
    const modo = state.config._presupModo === 'pct' ? 'pct' : 'clp';
    const presup = state.config.presupuesto || (state.config.presupuesto = {});
    const presClp = state.config.presupuestoCLP || (state.config.presupuestoCLP = {});
    const cats = state.config.categorias.slice();
    cats.forEach(c => {
      if (presup[c] === undefined) presup[c] = 0;
      if (presClp[c] === undefined) presClp[c] = base > 0 ? Math.round(base * Number(presup[c] || 0) / 100) : 0;
    });

    // Toggle visual del switch $ / % + auto-ajuste solo aplica en modo %
    const bClp = document.getElementById('presModoClp');
    const bPct = document.getElementById('presModoPct');
    if (bClp && bPct) {
      const on = el => { el.style.background = 'var(--primary)'; el.style.color = '#fff'; };
      const off = el => { el.style.background = ''; el.style.color = ''; };
      (modo === 'clp' ? on : off)(bClp);
      (modo === 'pct' ? on : off)(bPct);
    }
    const aaWrap = document.getElementById('presAutoAjusteWrap');
    if (aaWrap) aaWrap.style.display = modo === 'pct' ? 'inline-flex' : 'none';

    const totalRealVar = gastoPromedio(mesesParaGasto, null, { excluirRecurrentes: true });
    const tableEl = document.getElementById('tablaPresupuesto');
    if (tableEl) {
      const targetDe = cat => modo === 'pct' ? base * Number(presup[cat] || 0) / 100 : Number(presClp[cat] || 0);
      const ordenadas = cats.slice().sort((a, b) => targetDe(b) - targetDe(a));
      let sumTarget = 0;
      const filas = ordenadas.map(cat => {
        const target = targetDe(cat);
        sumTarget += target;
        const real = gastoPromedio(mesesParaGasto, cat, { excluirRecurrentes: true });
        const diff = target - real;
        const ratio = target > 0 ? real / target : (real > 0 ? 99 : 0);
        const shareReal = totalRealVar > 0 ? (real / totalRealVar) * 100 : 0;
        let b = '';
        if (target === 0 && real === 0) b = '<span class="badge">—</span>';
        else if (ratio > 1.10) b = '<span class="badge danger">Sobre</span>';
        else if (ratio >= 0.85) b = '<span class="badge success">En meta</span>';
        else if (real > 0) b = '<span class="badge warning">Bajo</span>';
        else b = '<span class="badge">Sin gasto</span>';
        const catEsc = escapeHtml(cat).replace(/'/g, "&#39;");
        const input = modo === 'pct'
          ? `<span style="white-space:nowrap; display:inline-flex; align-items:center; gap:4px; justify-content:flex-end"><input type="number" min="0" max="100" step="0.5" value="${Number(presup[cat] || 0)}" style="width:74px; text-align:right" onchange="actualizarPresupuestoPct('${catEsc}', this.value)" />%</span>`
          : `<span style="white-space:nowrap; display:inline-flex; align-items:center; gap:4px; justify-content:flex-end">$<input type="number" min="0" step="1000" value="${Number(presClp[cat] || 0)}" style="width:110px; text-align:right" onchange="actualizarPresupuestoCLP('${catEsc}', this.value)" /></span>`;
        return `<tr>
          <td><strong>${escapeHtml(cat)}</strong></td>
          <td class="num">${input}</td>
          <td class="num">${clp(target)}</td>
          <td class="num ${real > target ? 'num-neg' : ''}">${clp(real)}</td>
          <td class="num" style="color:var(--text-muted)">${shareReal.toFixed(0)}%</td>
          <td class="num ${diff < 0 ? 'num-neg' : 'num-pos'}">${diff >= 0 ? '+' : ''}${clp(diff)}</td>
          <td>${b}</td>
        </tr>`;
      }).join('');
      const pctTotal = base > 0 ? (sumTarget / base) * 100 : 0;
      tableEl.innerHTML = `
        <thead><tr>
          <th>Categoría</th>
          <th class="num" style="width:130px">Presupuesto</th>
          <th class="num">Target /mes</th>
          <th class="num">Gasto real</th>
          <th class="num" title="Qué % de tus costos variables se va en esta categoría">% del total</th>
          <th class="num">Diferencia</th>
          <th style="width:90px">Estado</th>
        </tr></thead>
        <tbody>${filas}</tbody>
        <tfoot><tr style="font-weight:600; background:var(--surface-2)">
          <td>Total variable</td>
          <td class="num">${pctTotal.toFixed(0)}% del ingreso</td>
          <td class="num">${clp(sumTarget)}</td>
          <td class="num">${clp(totalRealVar)}</td>
          <td class="num">100%</td>
          <td class="num ${(sumTarget - totalRealVar) < 0 ? 'num-neg' : 'num-pos'}">${(sumTarget - totalRealVar) >= 0 ? '+' : ''}${clp(sumTarget - totalRealVar)}</td>
          <td></td>
        </tr></tfoot>`;
    }

    // ── Flujo de caja del mes (resumen; detalle completo en vista Cashflow) ──
    renderPresupuestoCashflow(ymHoy);

    if (typeof window.renderListaRecurrentes === 'function') window.renderListaRecurrentes();
  }

  // Resumen compacto de flujo de caja dentro de Plan del mes. Reusa los
  // mismos helpers globales que la vista Flujo de caja completa.
  function renderPresupuestoCashflow(ymHoy) {
    const ingMap = (typeof ventasPorMes === 'function') ? ventasPorMes() : {};
    const gasMap = (typeof gastosPorMes === 'function') ? gastosPorMes() : {};
    let meses = (typeof rangoMeses === 'function') ? rangoMeses() : null;
    if (!meses || !meses.length) {
      meses = Array.from(new Set([...Object.keys(ingMap), ...Object.keys(gasMap)])).sort();
    }
    const mesInicio = state.config.mesInicial || meses[0];
    let saldo = Number(state.config.saldoInicial || 0);
    const filas = meses.map(m => {
      const ent = ingMap[m] || 0;
      const sal = gasMap[m] || 0;
      const neto = ent - sal;
      if (m >= mesInicio) saldo += neto;
      return { mes: m, ent, sal, neto, saldo };
    });
    const fila = filas.find(f => f.mes === ymHoy) || filas[filas.length - 1] || { ent: 0, sal: 0, neto: 0, saldo: saldo };
    const set = (id, val, cls) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = clp(val);
      if (cls) el.className = 'kpi-value ' + cls;
    };
    set('presCfEntro', fila.ent);
    set('presCfSalio', fila.sal);
    set('presCfNeto', fila.neto, fila.neto >= 0 ? 'num-pos' : 'num-neg');
    set('presCfSaldo', fila.saldo, fila.saldo >= 0 ? '' : 'num-neg');

    const tEl = document.getElementById('presCfTabla');
    if (tEl) {
      const fmtM = (typeof fmtMes !== 'undefined' && fmtMes) ? fmtMes : null;
      const lblMes = m => fmtM
        ? fmtM.format(new Date(m + '-02')).replace(/^./, c => c.toUpperCase())
        : m;
      const ult = filas.slice(-6);
      if (!ult.length) {
        tEl.innerHTML = '<tbody><tr><td style="padding:14px; color:var(--text-muted)">Sin movimientos registrados todavía.</td></tr></tbody>';
      } else {
        tEl.innerHTML = `
          <thead><tr><th>Mes</th><th class="num">Entró</th><th class="num">Salió</th><th class="num">Neto</th><th class="num">Saldo</th></tr></thead>
          <tbody>${ult.map(f => `<tr${f.mes === ymHoy ? ' style="background:var(--primary-soft)"' : ''}>
            <td>${lblMes(f.mes)}</td>
            <td class="num num-pos">${clp(f.ent)}</td>
            <td class="num num-neg">${clp(f.sal)}</td>
            <td class="num ${f.neto >= 0 ? 'num-pos' : 'num-neg'}">${clp(f.neto)}</td>
            <td class="num"><strong>${clp(f.saldo)}</strong></td>
          </tr>`).join('')}</tbody>`;
      }
    }
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
    if (!confirm('¿Volver a los valores recomendados de la industria? Se perderán tus ajustes personalizados.')) return;
    state.config.presupuesto = { ...PRESUPUESTO_DEFAULTS };
    state.config.presupuestoCLP = {}; // se re-deriva de los % recomendados × ingreso
    saveState();
    renderPresupuesto();
    toast('Restaurados los valores recomendados', 'success');
  }

  // Cambia entre asignar el presupuesto en pesos ($) o en % del ingreso.
  // Al cambiar de modo convierte los valores para que la tabla quede
  // consistente (no se "pierde" lo que el usuario había puesto).
  function cambiarPresupModo(modo) {
    modo = modo === 'pct' ? 'pct' : 'clp';
    if ((state.config._presupModo || 'clp') === modo) return;
    const { monto: base } = obtenerIngresoBase();
    const presup = state.config.presupuesto || (state.config.presupuesto = {});
    const presClp = state.config.presupuestoCLP || (state.config.presupuestoCLP = {});
    const cats = (state.config.categorias || []).slice();
    if (modo === 'clp') {
      cats.forEach(c => { presClp[c] = base > 0 ? Math.round(base * Number(presup[c] || 0) / 100) : Number(presClp[c] || 0); });
    } else {
      cats.forEach(c => { presup[c] = base > 0 ? Math.round((Number(presClp[c] || 0) / base) * 1000) / 10 : Number(presup[c] || 0); });
    }
    state.config._presupModo = modo;
    saveState();
    renderPresupuesto();
  }

  // Asignar el presupuesto de una categoría directamente en pesos.
  function actualizarPresupuestoCLP(cat, valor) {
    const real = String(cat).replace(/&#39;/g, "'");
    if (!state.config.presupuestoCLP) state.config.presupuestoCLP = {};
    state.config.presupuestoCLP[real] = Math.max(0, Math.round(Number(valor) || 0));
    saveState();
    renderPresupuesto();
  }

  window.renderPresupuesto = renderPresupuesto;
  window.actualizarPresupuestoPct = actualizarPresupuestoPct;
  window.actualizarPresupuestoCLP = actualizarPresupuestoCLP;
  window.cambiarPresupModo = cambiarPresupModo;
  window.guardarAutoAjuste = guardarAutoAjuste;
  window.resetearPresupuestoDefaults = resetearPresupuestoDefaults;
})();
