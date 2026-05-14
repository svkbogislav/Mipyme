// src/renderer/domain/reportes.js
// Generación de reportes exportables para el contador / archivo del negocio.
//
// Módulo FUNCIONAL: recibe state/shopify por argumento y devuelve strings
// (CSV o HTML). No toca DOM ni descarga archivos — esa responsabilidad es
// del caller (el inline construye el Blob y dispara la descarga).
//
// Formatos:
//   CSV         — RFC 4180. Comma-delimited, comillas dobles para escape.
//   HTML imprimible — vista limpia que window.print() convierte en PDF via
//                     el diálogo nativo de macOS. Sin librerías externas.

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Helpers CSV
  // ---------------------------------------------------------------------------

  // Escape de un campo CSV. Si contiene coma, comilla o salto, se rodea con
  // comillas dobles y se escapan comillas internas duplicándolas.
  function csvCell(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function csvRow(arr) {
    return arr.map(csvCell).join(',');
  }

  // Construye un CSV completo desde un array de objetos. Las columnas son las
  // keys del primer objeto, en el orden dado por `columnas` si se pasa.
  function csvDesdeObjetos(rows, columnas) {
    if (rows.length === 0) return columnas ? csvRow(columnas) + '\n' : '';
    const cols = columnas || Object.keys(rows[0]);
    const lines = [csvRow(cols)];
    rows.forEach(r => lines.push(csvRow(cols.map(c => r[c]))));
    return lines.join('\n') + '\n';
  }

  // ---------------------------------------------------------------------------
  // Filtros temporales
  // ---------------------------------------------------------------------------

  // ¿La fecha cae dentro del período YYYY-MM? Acepta fechas en
  // 'YYYY-MM-DD' o ISO 8601 (Shopify). Si el período es null, no filtra.
  function enPeriodo(fechaStr, ymPeriodo) {
    if (!ymPeriodo) return true;
    if (!fechaStr) return false;
    return fechaStr.slice(0, 7) === ymPeriodo;
  }

  // ---------------------------------------------------------------------------
  // CSV de gastos
  //
  // Una fila por gasto. Resuelve nombre de proveedor desde proveedor_id si
  // está, o cae al campo legacy `proveedor`. Marca recurrentes.
  // ---------------------------------------------------------------------------
  function csvGastos(state, ymPeriodo) {
    const proveedores = (state.config && state.config.proveedores) || [];
    const rows = (state.gastos || [])
      .filter(g => enPeriodo(g.fecha, ymPeriodo))
      .sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''))
      .map(g => {
        let proveedor = g.proveedor || '';
        if (g.proveedor_id) {
          const p = proveedores.find(x => x.id === g.proveedor_id);
          if (p) proveedor = p.nombre;
        }
        return {
          fecha: g.fecha || '',
          monto: Number(g.monto || 0),
          categoria: g.categoria || '',
          proveedor,
          descripcion: g.descripcion || '',
          metodo: g.metodo || '',
          recurrente: g.recurring_id ? 'sí' : 'no',
        };
      });
    return csvDesdeObjetos(rows, ['fecha', 'monto', 'categoria', 'proveedor', 'descripcion', 'metodo', 'recurrente']);
  }

  // ---------------------------------------------------------------------------
  // CSV de ventas (Shopify + manuales unificadas)
  //
  // Usa Ventas.obtenerVentas() para que pase por los mismos filtros (test,
  // cancelado, no pagado) que ve el resto de la app.
  // ---------------------------------------------------------------------------
  function csvVentas(state, shopify, testPatterns, ymPeriodo) {
    const ventas = window.Ventas.obtenerVentas(state, shopify, testPatterns)
      .filter(v => enPeriodo(v.fecha, ymPeriodo))
      .sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''))
      .map(v => ({
        fecha: (v.fecha || '').slice(0, 10),
        monto: Number(v.total || 0),
        cliente: v.cliente || '',
        num: '#' + (v.num || ''),
        origen: v.manual ? 'manual' : 'shopify',
        metodo: v.manual ? (v.metodo || '') : '',
        productos: (v.items || []).map(i => `${i.quantity || i.qty || 1}× ${i.title || i.name || ''}`).join('; ')
      }));
    return csvDesdeObjetos(ventas, ['fecha', 'monto', 'cliente', 'num', 'origen', 'metodo', 'productos']);
  }

  // ---------------------------------------------------------------------------
  // P&L imprimible (HTML standalone que window.print() convierte a PDF)
  //
  // Estructura: header con nombre negocio + período, tabla de ingresos por
  // mes, tabla de gastos por categoría, totales y utilidad neta.
  // ---------------------------------------------------------------------------
  function htmlPnL(state, shopify, testPatterns, ymPeriodo) {
    const nombreNegocio = (state.config && state.config.nombre) || 'Mi negocio';
    const vpm = window.Ventas.ventasPorMes(state, shopify, testPatterns);
    const totalIngresos = ymPeriodo ? Number(vpm[ymPeriodo] || 0) : Object.values(vpm).reduce((s, n) => s + Number(n || 0), 0);

    // Gastos: agrupar por categoría para el período
    const gastosFiltrados = (state.gastos || []).filter(g => enPeriodo(g.fecha, ymPeriodo));
    const porCategoria = {};
    gastosFiltrados.forEach(g => {
      const cat = g.categoria || 'Otros';
      porCategoria[cat] = (porCategoria[cat] || 0) + Number(g.monto || 0);
    });
    const totalGastos = Object.values(porCategoria).reduce((s, n) => s + n, 0);
    const utilidad = totalIngresos - totalGastos;

    const filasGastos = Object.entries(porCategoria)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, monto]) => {
        const pct = totalGastos > 0 ? ((monto / totalGastos) * 100).toFixed(1) : '0.0';
        return `<tr><td>${escapeHtml(cat)}</td><td class="num">${fmtCLP(monto)}</td><td class="num">${pct}%</td></tr>`;
      }).join('');

    const tituloPeriodo = ymPeriodo
      ? formatearPeriodo(ymPeriodo)
      : 'Todos los movimientos';
    const fechaGeneracion = new Date().toLocaleDateString('es-CL', {
      day: '2-digit', month: 'long', year: 'numeric'
    });

    return `<!DOCTYPE html>
<html lang="es"><head>
<meta charset="UTF-8">
<title>P&L ${escapeHtml(nombreNegocio)} — ${escapeHtml(tituloPeriodo)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
         max-width: 800px; margin: 32px auto; padding: 0 24px; color: #1f2433;
         font-size: 13px; line-height: 1.5; }
  h1 { margin: 0 0 4px 0; font-size: 22px; }
  .header-sub { color: #6b7280; font-size: 12px; margin-bottom: 24px; }
  h2 { font-size: 14px; margin-top: 28px; margin-bottom: 10px; padding-bottom: 6px;
       border-bottom: 1px solid #e6e8ef; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 6px 10px; border-bottom: 1px solid #eef0f5; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; color: #6b7280;
       font-weight: 600; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  tfoot td { border-top: 2px solid #1f2433; border-bottom: none; font-weight: 700; }
  .utilidad { font-size: 16px; padding: 14px; background: #f6f7fb; border-radius: 8px;
              margin-top: 16px; display: flex; justify-content: space-between; align-items: center; }
  .utilidad strong { font-size: 20px; color: ${utilidad >= 0 ? '#15803d' : '#b91c1c'}; }
  .print-hint { margin-top: 32px; padding: 12px; background: #eef0ff; border-radius: 8px;
                font-size: 12px; color: #3730a3; }
  @media print {
    body { margin: 0; padding: 24px; }
    .print-hint { display: none; }
  }
</style>
</head><body>
  <h1>${escapeHtml(nombreNegocio)}</h1>
  <div class="header-sub">Estado de resultados — ${escapeHtml(tituloPeriodo)} · Generado ${escapeHtml(fechaGeneracion)}</div>

  <h2>Ingresos</h2>
  <table>
    <thead><tr><th>Concepto</th><th class="num">Monto</th></tr></thead>
    <tbody>
      <tr><td>Ventas totales (Shopify + manuales)</td><td class="num">${fmtCLP(totalIngresos)}</td></tr>
    </tbody>
    <tfoot><tr><td>Total ingresos</td><td class="num">${fmtCLP(totalIngresos)}</td></tr></tfoot>
  </table>

  <h2>Gastos por categoría</h2>
  ${filasGastos
    ? `<table>
        <thead><tr><th>Categoría</th><th class="num">Monto</th><th class="num">%</th></tr></thead>
        <tbody>${filasGastos}</tbody>
        <tfoot><tr><td>Total gastos</td><td class="num">${fmtCLP(totalGastos)}</td><td class="num">100%</td></tr></tfoot>
      </table>`
    : '<p style="color:#6b7280">Sin gastos registrados en este período.</p>'}

  <div class="utilidad">
    <span>Utilidad neta</span>
    <strong>${fmtCLP(utilidad)}</strong>
  </div>

  <div class="print-hint">
    💡 Para guardar como PDF: Archivo → Imprimir (Cmd+P) → en el diálogo, elige <strong>Guardar como PDF</strong>.
  </div>
</body></html>`;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function fmtCLP(n) {
    // No usamos window.clp() para no depender del módulo de formato — este
    // módulo es exportable de manera totalmente standalone.
    const v = Math.round(Number(n) || 0);
    return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(v);
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function formatearPeriodo(ymPeriodo) {
    const [y, m] = ymPeriodo.split('-').map(Number);
    const fecha = new Date(y, m - 1, 1);
    return fecha.toLocaleDateString('es-CL', { month: 'long', year: 'numeric' });
  }

  window.Reportes = {
    csvGastos,
    csvVentas,
    htmlPnL,
  };
})();
