// src/renderer/views/productos.js
// Vista Productos: tabla del catálogo Shopify con costo unitario editable
// y tipo (consumible vs reutilizable). Margen unitario calculado para los
// consumibles con costo definido.
//
// Dependencias:
//   - shopify.catalog (global)
//   - state.config.productCosts / productTypes (global)
//   - tipoProducto() (helper inline — clasifica producto)
//   - clp, fmtNum, fmtPct, escapeHtml (window globals)
//   - saveState, renderDashboard (globals inline)

(function () {
  'use strict';

  function renderProductos() {
    if (!state.config.productCosts) state.config.productCosts = {};
    if (!state.config.productTypes) state.config.productTypes = {};
    const search = (document.getElementById('prodSearch')?.value || '').toLowerCase().trim();

    const catalogo = (shopify && shopify.catalog) || [];
    let productos = catalogo.map(c => ({
      titulo: c.title,
      productType: c.type || '',
      precioRef: c.minPrice || 0,
      precioMax: c.maxPrice || 0
    }));
    if (search) productos = productos.filter(p => p.titulo.toLowerCase().includes(search));
    productos.sort((a, b) => a.titulo.localeCompare(b.titulo));

    const costos = state.config.productCosts;
    const totalProductos = catalogo.length;
    const conCosto = catalogo.filter(c => Number(costos[c.title] || 0) > 0).length;
    const reusables = catalogo.filter(c => tipoProducto(c.title) === 'reutilizable').length;

    // Margen unitario promedio (solo de productos consumibles con costo definido)
    const consumiblesConCosto = catalogo
      .filter(c => tipoProducto(c.title) === 'consumible' && Number(costos[c.title] || 0) > 0)
      .map(c => {
        const precio = c.minPrice || 0;
        const costo = Number(costos[c.title] || 0);
        return { precio, costo, margen: precio - costo, pct: precio > 0 ? (precio - costo) / precio : 0 };
      });
    const margenProm = consumiblesConCosto.length > 0
      ? consumiblesConCosto.reduce((s, x) => s + x.margen, 0) / consumiblesConCosto.length
      : 0;
    const margenPctProm = consumiblesConCosto.length > 0
      ? consumiblesConCosto.reduce((s, x) => s + x.pct, 0) / consumiblesConCosto.length
      : 0;

    // KPIs
    document.getElementById('prodTotal').textContent = fmtNum.format(totalProductos);
    document.getElementById('prodConCosto').textContent = `${conCosto} / ${totalProductos}`;
    document.getElementById('prodReusables').textContent = String(reusables);
    if (consumiblesConCosto.length > 0) {
      document.getElementById('prodMargenProm').textContent = clp(margenProm);
      document.getElementById('prodMargenPromPct').innerHTML = `<span class="${margenPctProm >= 0.4 ? 'up' : (margenPctProm >= 0 ? '' : 'down')}">${fmtPct.format(margenPctProm)} margen</span>`;
    } else {
      document.getElementById('prodMargenProm').textContent = '—';
      document.getElementById('prodMargenPromPct').innerHTML = '<span style="color:var(--text-muted)">define costos para ver</span>';
    }

    // Tabla
    let tableEl = document.getElementById('tablaProductos');
    if (!tableEl) {
      document.querySelector('#view-productos .table-wrap').innerHTML = '<table id="tablaProductos"></table>';
      tableEl = document.getElementById('tablaProductos');
    }
    if (productos.length === 0) {
      tableEl.outerHTML = '<div class="empty"><h4>Sin resultados</h4>Ajusta el buscador.</div>';
      return;
    }

    tableEl.innerHTML = `
      <thead><tr>
        <th>Producto</th>
        <th style="width:140px">Tipo</th>
        <th class="num" style="width:140px">Precio venta (ref.)</th>
        <th class="num" style="width:140px">Costo unitario</th>
        <th class="num" style="width:130px">Margen unit.</th>
      </tr></thead>
      <tbody>
        ${productos.map(p => {
          const unitCost = Number(costos[p.titulo] || 0);
          const tipo = tipoProducto(p.titulo);
          const margen = p.precioRef - unitCost;
          const margenPct = p.precioRef > 0 ? margen / p.precioRef : 0;
          const titleEsc = escapeHtml(p.titulo).replace(/'/g, "&#39;");
          return `<tr>
            <td>
              <strong>${escapeHtml(p.titulo)}</strong>
              ${p.productType ? `<br><span style="font-size:11px; color:var(--text-muted)">${escapeHtml(p.productType)}</span>` : ''}
            </td>
            <td>
              <select onchange="actualizarTipoProducto('${titleEsc}', this.value)" style="width:130px; font-size:12px">
                <option value="consumible" ${tipo === 'consumible' ? 'selected' : ''}>Consumible</option>
                <option value="reutilizable" ${tipo === 'reutilizable' ? 'selected' : ''}>Reutilizable (activo)</option>
              </select>
            </td>
            <td class="num">${clp(p.precioRef)}${p.precioMax > p.precioRef ? `<br><span style="font-size:11px; color:var(--text-muted)">— ${clp(p.precioMax)}</span>` : ''}</td>
            <td class="num">
              ${tipo === 'reutilizable'
                ? '<span style="color:var(--text-muted); font-size:12px">→ Activos</span>'
                : `<input type="number" min="0" step="100" value="${unitCost}" style="width:110px; text-align:right" onchange="actualizarCostoProducto('${titleEsc}', this.value)" />`}
            </td>
            <td class="num">${tipo === 'consumible' && unitCost > 0
                ? `<strong style="color:${margenPct >= 0.4 ? 'var(--success)' : (margenPct >= 0 ? 'var(--text)' : 'var(--danger)')}">${clp(margen)}<br><span style="font-size:11px">${fmtPct.format(margenPct)}</span></strong>`
                : '<span style="color:var(--text-muted)">—</span>'}
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    `;
  }

  function actualizarTipoProducto(titleEsc, valor) {
    const titulo = titleEsc.replace(/&#39;/g, "'");
    if (!state.config.productTypes) state.config.productTypes = {};
    state.config.productTypes[titulo] = valor;
    saveState();
    renderProductos();
  }

  function actualizarCostoProducto(titleEsc, valor) {
    const titulo = titleEsc.replace(/&#39;/g, "'");
    if (!state.config.productCosts) state.config.productCosts = {};
    const v = Number(valor) || 0;
    if (v <= 0) delete state.config.productCosts[titulo];
    else state.config.productCosts[titulo] = v;
    saveState();
    renderProductos();
    // Si el dashboard está activo, refrescar para que el margen bruto se actualice
    if (document.getElementById('view-dashboard').classList.contains('active')) renderDashboard();
  }

  window.renderProductos = renderProductos;
  window.actualizarTipoProducto = actualizarTipoProducto;
  window.actualizarCostoProducto = actualizarCostoProducto;
})();
