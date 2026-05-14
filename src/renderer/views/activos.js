// src/renderer/views/activos.js
// Vista Activos (CAPEX): inventario de bienes durables del negocio con
// cálculo de depreciación lineal. Incluye los handlers del modal de
// crear/editar/eliminar activo.
//
// Dependencias:
//   - state.config.activos (global)
//   - saveState, toast, uid (globals)
//   - clp, fmtNum, fmtPct, fmtFechaCorta, escapeHtml (window globals)

(function () {
  'use strict';

  // Calcula depreciación lineal de un activo: distribuye el costo total
  // entre `vida_util_meses` desde `fecha_compra`. Devuelve costo total,
  // depr. mensual, meses transcurridos, depr. acumulada, valor actual.
  function calcularDepreciacionActivo(activo) {
    const costoTotal = Number(activo.cantidad || 0) * Number(activo.costo_unitario || 0);
    const vidaUtil = Math.max(1, Number(activo.vida_util_meses || 60));
    const depMensual = costoTotal / vidaUtil;
    if (!activo.fecha_compra) {
      return { costoTotal, depMensual, mesesTranscurridos: 0, depAcumulada: 0, valorActual: costoTotal };
    }
    const compra = new Date(activo.fecha_compra + 'T12:00:00');
    const hoy = new Date();
    const mesesTranscurridos = Math.max(0, (hoy.getFullYear() - compra.getFullYear()) * 12 + (hoy.getMonth() - compra.getMonth()));
    const depAcumulada = Math.min(costoTotal, depMensual * mesesTranscurridos);
    const valorActual = Math.max(0, costoTotal - depAcumulada);
    return { costoTotal, depMensual, mesesTranscurridos, depAcumulada, valorActual };
  }

  function renderActivos() {
    if (!state.config.activos) state.config.activos = [];
    const activos = state.config.activos;

    let totalCapex = 0, totalValorActual = 0, totalDepAcum = 0, totalDepMensual = 0;
    const detalles = activos.map(a => {
      const calc = calcularDepreciacionActivo(a);
      totalCapex += calc.costoTotal;
      totalValorActual += calc.valorActual;
      totalDepAcum += calc.depAcumulada;
      totalDepMensual += calc.depMensual;
      return { ...a, calc };
    });

    document.getElementById('actCapex').textContent = clp(totalCapex);
    document.getElementById('actValorActual').textContent = clp(totalValorActual);
    document.getElementById('actValorPct').innerHTML = totalCapex > 0
      ? `<span style="color:var(--text-muted)">${fmtPct.format(totalValorActual / totalCapex)} del costo original</span>` : '';
    document.getElementById('actDepAcum').textContent = clp(totalDepAcum);
    document.getElementById('actDepMensual').textContent = clp(totalDepMensual);

    const wrap = document.querySelector('#view-activos .table-wrap');
    if (activos.length === 0) {
      wrap.innerHTML = '<div class="empty"><h4>Sin activos registrados</h4>Haz click en "Agregar activo" para registrar tus mesas, juegos, parlantes, etc.</div>';
      return;
    }
    // Reordenar: mayor inversión primero
    detalles.sort((a, b) => b.calc.costoTotal - a.calc.costoTotal);

    wrap.innerHTML = `<table>
      <thead><tr>
        <th>Activo</th>
        <th class="num">Cant.</th>
        <th class="num">Costo unit.</th>
        <th class="num">Costo total</th>
        <th>Compra</th>
        <th class="num">Vida útil</th>
        <th class="num">Desgaste/mes</th>
        <th class="num">Desgaste acum.</th>
        <th class="num">Valor actual</th>
        <th></th>
      </tr></thead>
      <tbody>
        ${detalles.map(a => `<tr>
          <td><strong>${escapeHtml(a.nombre)}</strong>${a.notas ? `<br><span style="font-size:11px; color:var(--text-muted)">${escapeHtml(a.notas)}</span>` : ''}</td>
          <td class="num">${fmtNum.format(a.cantidad)}</td>
          <td class="num">${clp(a.costo_unitario)}</td>
          <td class="num"><strong>${clp(a.calc.costoTotal)}</strong></td>
          <td>${a.fecha_compra ? fmtFechaCorta.format(new Date(a.fecha_compra + 'T12:00:00')) : '—'}</td>
          <td class="num">${a.vida_util_meses}m<br><span style="font-size:10px; color:var(--text-muted)">(${(a.vida_util_meses / 12).toFixed(1)} años)</span></td>
          <td class="num num-neg">${clp(a.calc.depMensual)}</td>
          <td class="num num-neg">${clp(a.calc.depAcumulada)}</td>
          <td class="num"><strong style="color:${a.calc.valorActual / a.calc.costoTotal > 0.5 ? 'var(--success)' : 'var(--warning)'}">${clp(a.calc.valorActual)}</strong></td>
          <td style="text-align:right; white-space:nowrap">
            <button class="btn sm ghost" onclick="editarActivo('${a.id}')">Editar</button>
          </td>
        </tr>`).join('')}
      </tbody>
      <tfoot>
        <tr style="font-weight:600; background:var(--surface-2)">
          <td>Totales</td>
          <td class="num">${fmtNum.format(activos.reduce((s, a) => s + Number(a.cantidad || 0), 0))}</td>
          <td class="num">—</td>
          <td class="num">${clp(totalCapex)}</td>
          <td>—</td>
          <td>—</td>
          <td class="num num-neg">${clp(totalDepMensual)}</td>
          <td class="num num-neg">${clp(totalDepAcum)}</td>
          <td class="num"><strong>${clp(totalValorActual)}</strong></td>
          <td>—</td>
        </tr>
      </tfoot>
    </table>`;
  }

  // ─── Modal handlers ───────────────────────────────────────────────
  function abrirModalActivo() {
    document.getElementById('modalActTitulo').textContent = 'Nuevo activo';
    document.getElementById('actId').value = '';
    document.getElementById('actNombre').value = '';
    document.getElementById('actCantidad').value = '1';
    document.getElementById('actCostoUnit').value = '';
    document.getElementById('actFechaCompra').value = new Date().toISOString().slice(0, 10);
    document.getElementById('actVidaUtil').value = '60';
    document.getElementById('actNotas').value = '';
    document.getElementById('btnEliminarActivo').style.display = 'none';
    document.getElementById('modalActivo').classList.add('show');
    setTimeout(() => document.getElementById('actNombre').focus(), 100);
  }

  function editarActivo(id) {
    const a = (state.config.activos || []).find(x => x.id === id);
    if (!a) return;
    document.getElementById('modalActTitulo').textContent = 'Editar activo';
    document.getElementById('actId').value = id;
    document.getElementById('actNombre').value = a.nombre || '';
    document.getElementById('actCantidad').value = a.cantidad || 1;
    document.getElementById('actCostoUnit').value = a.costo_unitario || '';
    document.getElementById('actFechaCompra').value = a.fecha_compra || '';
    document.getElementById('actVidaUtil').value = a.vida_util_meses || 60;
    document.getElementById('actNotas').value = a.notas || '';
    document.getElementById('btnEliminarActivo').style.display = '';
    document.getElementById('modalActivo').classList.add('show');
  }

  function cerrarModalActivo() {
    document.getElementById('modalActivo').classList.remove('show');
  }

  function guardarActivo() {
    const id = document.getElementById('actId').value;
    const nombre = document.getElementById('actNombre').value.trim();
    const cantidad = Number(document.getElementById('actCantidad').value);
    const costo_unitario = Number(document.getElementById('actCostoUnit').value);
    if (!nombre || !cantidad || cantidad <= 0 || !costo_unitario || costo_unitario < 0) {
      toast('Completa nombre, cantidad y costo', 'error'); return;
    }
    const obj = {
      id: id || uid(),
      nombre,
      cantidad,
      costo_unitario,
      fecha_compra: document.getElementById('actFechaCompra').value || null,
      vida_util_meses: Number(document.getElementById('actVidaUtil').value) || 60,
      notas: document.getElementById('actNotas').value.trim()
    };
    if (!state.config.activos) state.config.activos = [];
    if (id) {
      state.config.activos = state.config.activos.map(a => a.id === id ? obj : a);
    } else {
      state.config.activos.push(obj);
    }
    saveState();
    cerrarModalActivo();
    toast('Activo guardado', 'success');
    renderActivos();
  }

  function eliminarActivo() {
    const id = document.getElementById('actId').value;
    if (!id) return;
    if (!confirm('¿Eliminar este activo del inventario?')) return;
    state.config.activos = (state.config.activos || []).filter(a => a.id !== id);
    saveState();
    cerrarModalActivo();
    toast('Activo eliminado', 'success');
    renderActivos();
  }

  // Exponer todo lo necesario al window (onclick handlers en HTML + otros calls)
  window.calcularDepreciacionActivo = calcularDepreciacionActivo;
  window.renderActivos = renderActivos;
  window.abrirModalActivo = abrirModalActivo;
  window.editarActivo = editarActivo;
  window.cerrarModalActivo = cerrarModalActivo;
  window.guardarActivo = guardarActivo;
  window.eliminarActivo = eliminarActivo;
})();
