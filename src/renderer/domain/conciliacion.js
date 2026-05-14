// src/renderer/domain/conciliacion.js
// Conciliación bancaria asistida: parsea una cartola CSV/TSV de cualquier
// banco chileno, cruza cada movimiento contra ventas y gastos existentes
// (matching por fecha ±2 días + monto exacto), y deja todo listo para que
// el usuario confirme con un click.
//
// Diseño:
//   - parsearCartola(text) → [{ fecha, descripcion, monto }]
//        Detecta columnas automáticamente por contenido (no por nombre,
//        porque cada banco usa headers distintos).
//   - matchearMovimientos(movs, state) → [{ mov, candidatos }]
//        Para cada movimiento, busca ventas (si monto>0) o gastos (monto<0)
//        cercanos en fecha (±2 días) y mismo monto absoluto.
//   - aplicarMatch / crearDesdeMovimiento: mutan state in-place. El caller
//        persiste con saveState().
//
// Asume window.uid() y window.ymdOf() ya están cargados (utils/*).

(function () {
  'use strict';

  // ─── Parsing CSV/TSV ──────────────────────────────────────────────────
  // Detecta delimitador entre ',' ';' '\t' '|' tomando el más frecuente en
  // la línea no-vacía con más caracteres (presumiblemente una fila de datos).
  function _detectarDelim(text) {
    const lineas = text.split(/\r?\n/).filter(l => l.trim()).slice(0, 30);
    if (lineas.length === 0) return ',';
    // Tomamos la línea con más caracteres — más probable que sea una fila de datos
    const muestra = lineas.sort((a, b) => b.length - a.length)[0];
    const cand = [',', ';', '\t', '|'];
    let mejor = ',', maxN = 0;
    cand.forEach(d => {
      const n = (muestra.match(new RegExp('\\' + d, 'g')) || []).length;
      if (n > maxN) { maxN = n; mejor = d; }
    });
    return mejor;
  }

  // Parser CSV simple, con soporte para campos entrecomillados con "".
  function _parseCSVLine(line, delim) {
    const out = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuote) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQuote = false;
        else cur += ch;
      } else {
        if (ch === '"') inQuote = true;
        else if (ch === delim) { out.push(cur); cur = ''; }
        else cur += ch;
      }
    }
    out.push(cur);
    return out.map(c => c.trim());
  }

  // ─── Detección de columnas ────────────────────────────────────────────
  // No confiamos en nombres de headers porque varían por banco. Inferimos
  // por contenido:
  //   - fecha: parsea a Date válida (formatos dd/mm/yyyy, yyyy-mm-dd, etc)
  //   - monto: número (con miles o decimales) que cambia entre filas
  //   - descripcion: el campo de texto más largo en promedio
  function _esFecha(s) {
    return !!_parsearFecha(s);
  }

  function _parsearFecha(s) {
    if (!s) return null;
    s = String(s).trim();
    // ISO yyyy-mm-dd
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) {
      const d = new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
      if (!isNaN(d)) return d;
    }
    // dd/mm/yyyy o dd-mm-yyyy
    m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (m) {
      let yr = +m[3];
      if (yr < 100) yr += 2000;
      const d = new Date(yr, +m[2] - 1, +m[1], 12, 0, 0);
      if (!isNaN(d) && d.getFullYear() > 2000 && d.getFullYear() < 2100) return d;
    }
    // Formato BICE: "14 may 2026" (día + mes ES corto + año)
    const meses = {
      ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5,
      jul: 6, ago: 7, sep: 8, oct: 9, nov: 10, dic: 11
    };
    m = s.toLowerCase().match(/^(\d{1,2})\s+([a-záéíóú]{3,})\.?\s+(\d{4})/);
    if (m && meses[m[2].slice(0, 3)] !== undefined) {
      const d = new Date(+m[3], meses[m[2].slice(0, 3)], +m[1], 12, 0, 0);
      if (!isNaN(d)) return d;
    }
    return null;
  }

  function _parsearMonto(s) {
    if (s === null || s === undefined) return null;
    s = String(s).trim();
    if (!s) return null;
    // Quitar $, espacios. Detectar separador decimal: si tiene "," y "." → "." es miles,
    // "," es decimal (es-CL). Si tiene solo "," sin ".", la "," puede ser decimal o miles.
    s = s.replace(/[$\s]/g, '');
    // Signo entre paréntesis: (1.000) → -1000 (formato contable)
    let signo = 1;
    if (/^\(.*\)$/.test(s)) { signo = -1; s = s.slice(1, -1); }
    if (/^-/.test(s)) { signo = -1; s = s.slice(1); }
    // Eliminar puntos como separadores de miles (es-CL): "1.234.567" → "1234567"
    // Pero conservar coma como decimal: "1.234,50" → "1234.50"
    if (s.includes(',') && s.includes('.')) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else if (s.includes(',')) {
      // Solo coma: si está al final con 2 dígitos, probablemente decimal
      const partes = s.split(',');
      if (partes.length === 2 && partes[1].length <= 2) {
        s = partes[0] + '.' + partes[1];
      } else {
        s = s.replace(/,/g, '');
      }
    } else if (s.includes('.')) {
      // Solo punto: en CLP usualmente miles, salvo que tenga decimal explícito
      const partes = s.split('.');
      if (partes.length === 2 && partes[1].length <= 2) {
        // probablemente decimal (raro en CLP, común en UF/USD)
        s = partes[0] + '.' + partes[1];
      } else {
        s = s.replace(/\./g, '');
      }
    }
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return signo * n;
  }

  // Detecta índices de columnas (fecha, monto, descripcion) en las filas
  // ya parseadas. Si hay header lo descarta. Devuelve { headerIdx, idxFecha,
  // idxMonto, idxDesc, idxAbono, idxCargo } — algunos pueden ser null si
  // no se pudieron identificar.
  function _detectarColumnas(filas) {
    if (filas.length === 0) return null;
    const numCols = Math.max(...filas.map(f => f.length));
    if (numCols < 2) return null;

    // Score por columna: fracción de filas donde el valor es fecha/monto.
    const scoreFecha = Array(numCols).fill(0);
    const scoreMonto = Array(numCols).fill(0);
    const lenTexto   = Array(numCols).fill(0);
    let filasDatos = 0;

    filas.forEach((fila, i) => {
      // Skip primera fila si parece header (sin valores parseable como fecha/monto)
      const tieneFecha = fila.some(c => _esFecha(c));
      const tieneMonto = fila.some(c => _parsearMonto(c) !== null && c.match(/\d/));
      if (i === 0 && !tieneFecha && !tieneMonto) return; // header
      filasDatos++;
      for (let j = 0; j < fila.length; j++) {
        if (_esFecha(fila[j])) scoreFecha[j]++;
        if (_parsearMonto(fila[j]) !== null && /\d/.test(fila[j])) scoreMonto[j]++;
        lenTexto[j] += (fila[j] || '').length;
      }
    });

    if (filasDatos === 0) return null;

    const idxFecha = scoreFecha.indexOf(Math.max(...scoreFecha));
    if (scoreFecha[idxFecha] / filasDatos < 0.6) return null;

    // Identificación de columnas de monto. Estrategia:
    //   a) Si el header tiene "cargo"/"débito" + "abono"/"crédito", usamos esas
    //      dos directamente (es un layout de cartola con cargo/abono separados).
    //   b) Si no, miramos columnas con monto parseable en >25% de filas.
    //      Si hay 2 que cubren casi todas las filas entre las dos, son
    //      cargo/abono. Si hay 1 sola fuerte, es monto único (signo).
    const header = filas[0] || [];
    let idxMonto = null, idxCargo = null, idxAbono = null;

    // a) Buscar headers cargo+abono
    let headerCargoIdx = null, headerAbonoIdx = null;
    for (let j = 0; j < numCols; j++) {
      if (j === idxFecha) continue;
      const h = String(header[j] || '').toLowerCase();
      if (/cargo|d[eé]bito|debe|egreso|salida/.test(h)) headerCargoIdx = j;
      else if (/abono|cr[eé]dito|haber|ingreso|entrada|dep[oó]sito/.test(h)) headerAbonoIdx = j;
    }
    if (headerCargoIdx !== null && headerAbonoIdx !== null) {
      idxCargo = headerCargoIdx;
      idxAbono = headerAbonoIdx;
    } else {
      // b) Fallback por score
      const montoCandidatos = [];
      for (let j = 0; j < numCols; j++) {
        if (j === idxFecha) continue;
        if (scoreMonto[j] / filasDatos > 0.25) montoCandidatos.push(j);
      }
      montoCandidatos.sort((a, b) => scoreMonto[b] - scoreMonto[a]);
      if (montoCandidatos.length === 0) return null;
      if (montoCandidatos.length === 1) {
        idxMonto = montoCandidatos[0];
      } else {
        // Tomar las 2 con mayor score. Si juntas cubren >80% de filas, son
        // cargo/abono. Si no, queda solo la primera como monto.
        const a = montoCandidatos[0], b = montoCandidatos[1];
        const cobertura = (scoreMonto[a] + scoreMonto[b]) / filasDatos;
        if (cobertura > 0.8 && scoreMonto[b] / filasDatos > 0.2) {
          // Asumir orden: cargo primero (más a la izquierda), abono después
          const [first, second] = a < b ? [a, b] : [b, a];
          idxCargo = first; idxAbono = second;
        } else {
          idxMonto = a;
        }
      }
    }

    // Descripción: la columna no-fecha y no-monto con mayor longitud promedio
    let idxDesc = null, maxLen = 0;
    for (let j = 0; j < numCols; j++) {
      if (j === idxFecha || j === idxMonto || j === idxCargo || j === idxAbono) continue;
      if (lenTexto[j] > maxLen) { maxLen = lenTexto[j]; idxDesc = j; }
    }

    const headerIdx = (filas[0].some(c => _esFecha(c)) || filas[0].some(c => _parsearMonto(c) !== null && /\d/.test(c))) ? -1 : 0;
    return { headerIdx, idxFecha, idxMonto, idxDesc, idxCargo, idxAbono };
  }

  // Detección heurística del formato BICE: una columna con valores "Cargos"
  // o "Abonos" que clasifica el signo de la fila. Si encontramos esa columna,
  // devolvemos su índice; si no, null.
  function _detectarColumnaSigno(filas) {
    if (filas.length < 3) return null;
    const numCols = Math.max(...filas.map(f => f.length));
    for (let j = 0; j < numCols; j++) {
      let cargos = 0, abonos = 0;
      filas.forEach(f => {
        const v = String(f[j] || '').toLowerCase().trim();
        if (v === 'cargos' || v === 'cargo' || v === 'débito' || v === 'debito') cargos++;
        else if (v === 'abonos' || v === 'abono' || v === 'crédito' || v === 'credito') abonos++;
      });
      if (cargos >= 1 && abonos >= 1) return j;
    }
    return null;
  }

  // Parsea un array de filas (cada fila es un array de celdas). Acepta CSV
  // ya parseado, o XLSX vía SheetJS sheet_to_json({header:1}).
  // Si detecta columna de "Categoría" tipo BICE, usa ese signo en vez de
  // depender del valor monetario. Soporta forward-fill de fecha cuando una
  // fila no la trae (algunos bancos solo ponen la fecha en el primer item
  // del día).
  function parsearCartolaFilas(filas) {
    if (!Array.isArray(filas) || filas.length === 0) return { error: 'Archivo vacío' };
    // Limpiar filas: trim de cada celda, quitar columnas/filas completamente vacías al borde.
    filas = filas.map(f => (Array.isArray(f) ? f : [f]).map(c => (c === null || c === undefined) ? '' : String(c).trim()));
    filas = filas.filter(f => f.some(c => c !== ''));
    if (filas.length === 0) return { error: 'No se encontraron filas con datos' };

    const idxSigno = _detectarColumnaSigno(filas);

    if (idxSigno !== null) {
      // ─── Modo BICE: columna de Categoría dice Cargos/Abonos por fila ───
      // Buscar header row: la que tiene "fecha" + "monto" como labels
      let headerRow = -1;
      for (let i = 0; i < Math.min(40, filas.length); i++) {
        const row = filas[i].map(c => c.toLowerCase());
        if (row.some(c => c === 'fecha') && row.some(c => c === 'monto')) {
          headerRow = i;
          break;
        }
      }
      const header = headerRow >= 0 ? filas[headerRow].map(c => c.toLowerCase()) : [];
      const idxFecha = header.indexOf('fecha');
      const idxDesc  = header.indexOf('descripción') >= 0 ? header.indexOf('descripción') : header.indexOf('descripcion');
      const idxMonto = header.indexOf('monto');
      if (idxFecha < 0 || idxMonto < 0) {
        return { error: 'Detecté columna de Cargos/Abonos pero no Fecha/Monto en el header.' };
      }

      const movs = [];
      let ultimaFecha = null;
      for (let i = headerRow + 1; i < filas.length; i++) {
        const fila = filas[i];
        // Si la fila tiene solo texto (sin monto), probablemente es footer/disclaimer.
        const montoTxt = fila[idxMonto] || '';
        if (!montoTxt || !/\d/.test(montoTxt)) continue;
        const monto = _parsearMonto(montoTxt);
        if (monto === null || !Number.isFinite(monto) || monto === 0) continue;
        // Fecha: si la fila la trae, úsala; si no, hereda la última.
        const fechaCelda = fila[idxFecha] || '';
        if (fechaCelda) {
          const fD = _parsearFecha(fechaCelda);
          if (fD) ultimaFecha = window.ymdOf(fD.toISOString());
        }
        if (!ultimaFecha) continue;
        // Signo según Categoría
        const cat = String(fila[idxSigno] || '').toLowerCase();
        const esCargo = /cargo|d[eé]bito/.test(cat);
        const esAbono = /abono|cr[eé]dito/.test(cat);
        let signo = 0;
        if (esCargo) signo = -1;
        else if (esAbono) signo = 1;
        else continue; // Sin clasificación clara → skip
        const descripcion = idxDesc >= 0 ? (fila[idxDesc] || '') : fila.join(' ');
        movs.push({
          _id: window.uid(),
          fecha: ultimaFecha,
          descripcion: String(descripcion).trim().slice(0, 250),
          monto: Math.round(Math.abs(monto)) * signo,
          _raw: fila
        });
      }
      return {
        movimientos: movs,
        columnas: { headerIdx: headerRow, idxFecha, idxMonto, idxDesc, idxSigno, formato: 'bice' },
        totalFilas: filas.length
      };
    }

    // ─── Modo genérico (CSV simple, banco estilo Santander/BCI/etc) ───
    const cols = _detectarColumnas(filas);
    if (!cols) return { error: 'No pude detectar las columnas de fecha y monto. ¿El archivo tiene esas columnas?' };

    const movs = [];
    let ultimaFecha = null;
    filas.forEach((fila, i) => {
      if (i === cols.headerIdx) return;
      const fechaCelda = fila[cols.idxFecha] || '';
      if (fechaCelda) {
        const fD = _parsearFecha(fechaCelda);
        if (fD) ultimaFecha = window.ymdOf(fD.toISOString());
      }
      if (!ultimaFecha) return;
      let monto = null;
      if (cols.idxMonto !== null) {
        monto = _parsearMonto(fila[cols.idxMonto]);
      } else if (cols.idxCargo !== null && cols.idxAbono !== null) {
        const cargo = _parsearMonto(fila[cols.idxCargo]);
        const abono = _parsearMonto(fila[cols.idxAbono]);
        if (abono && abono > 0)  monto = abono;
        else if (cargo && cargo > 0) monto = -cargo;
      }
      if (monto === null || !Number.isFinite(monto)) return;
      const descripcion = (cols.idxDesc !== null ? fila[cols.idxDesc] : fila.join(' ')) || '';
      movs.push({
        _id: window.uid(),
        fecha: ultimaFecha,
        descripcion: String(descripcion).trim().slice(0, 250),
        monto: Math.round(monto),
        _raw: fila
      });
    });
    return { movimientos: movs, columnas: cols, totalFilas: filas.length };
  }

  // Compatibilidad hacia atrás: parsea texto CSV/TSV y delega a parsearCartolaFilas.
  function parsearCartola(text) {
    if (!text || typeof text !== 'string') return { error: 'Archivo vacío' };
    const delim = _detectarDelim(text);
    const filas = text.split(/\r?\n/)
      .map(l => l.trim()).filter(l => l)
      .map(l => _parseCSVLine(l, delim));
    return parsearCartolaFilas(filas);
  }

  // ─── Matching ────────────────────────────────────────────────────────
  // Para cada movimiento de cartola busca candidatos en ventas/gastos:
  //   - mismo monto absoluto (CLP exacto)
  //   - fecha ±2 días
  // Si monto > 0 (abono), busca ventas o cobros. Si monto < 0 (cargo), busca gastos.
  function _diffDias(ymdA, ymdB) {
    const a = new Date(ymdA + 'T12:00:00');
    const b = new Date(ymdB + 'T12:00:00');
    return Math.round(Math.abs(a - b) / (24 * 3600 * 1000));
  }

  function matchearMovimientos(movs, state) {
    const ventas = state.ventasManuales || [];
    const gastos = state.gastos || [];
    const cobros = state.cobros || [];
    const conciliados = new Set();
    (state.conciliaciones || []).forEach(c => {
      if (c.ref_type && c.ref_id) conciliados.add(`${c.ref_type}:${c.ref_id}`);
    });

    return movs.map(mov => {
      const candidatos = [];
      const absMonto = Math.abs(mov.monto);

      if (mov.monto > 0) {
        // Abono: ventas o cobros
        ventas.forEach(v => {
          if (conciliados.has(`venta:${v.id}`)) return;
          if (Number(v.monto) !== absMonto) return;
          const d = _diffDias(mov.fecha, v.fecha);
          if (d > 2) return;
          candidatos.push({ tipo: 'venta', ref: v, score: 100 - d * 5 });
        });
        cobros.forEach(c => {
          if (conciliados.has(`cobro:${c.id}`)) return;
          (c.pagos || []).forEach(p => {
            if (Number(p.monto) !== absMonto) return;
            const d = _diffDias(mov.fecha, p.fecha || c.fecha_emision);
            if (d > 2) return;
            candidatos.push({ tipo: 'cobro', ref: c, refPago: p, score: 100 - d * 5 });
          });
        });
      } else {
        // Cargo: gastos
        gastos.forEach(g => {
          if (conciliados.has(`gasto:${g.id}`)) return;
          if (Number(g.monto) !== absMonto) return;
          const d = _diffDias(mov.fecha, g.fecha);
          if (d > 2) return;
          candidatos.push({ tipo: 'gasto', ref: g, score: 100 - d * 5 });
        });
      }
      candidatos.sort((a, b) => b.score - a.score);
      return { mov, candidatos };
    });
  }

  // ─── Aplicar match (marca como conciliado en state.conciliaciones) ───
  function aplicarMatch(state, mov, candidato, account_id) {
    if (!state.conciliaciones) state.conciliaciones = [];
    state.conciliaciones.push({
      id: window.uid(),
      ref_type: candidato.tipo,
      ref_id: candidato.ref.id,
      account_id,
      cartola_fecha: mov.fecha,
      cartola_descripcion: mov.descripcion,
      cartola_monto: mov.monto,
      created_at: new Date().toISOString()
    });
    return true;
  }

  // ─── Crear gasto/venta desde un movimiento sin match ──────────────────
  function crearDesdeMovimiento(state, mov, account_id) {
    if (mov.monto < 0) {
      // Cargo → gasto en "Por clasificar"
      const gasto = {
        id: window.uid(),
        fecha: mov.fecha,
        monto: Math.abs(mov.monto),
        categoria: 'Por clasificar',
        proveedor: mov.descripcion,
        descripcion: mov.descripcion,
        metodo: 'Transferencia',
        account_id
      };
      if (!state.gastos) state.gastos = [];
      state.gastos.push(gasto);
      if (!state.conciliaciones) state.conciliaciones = [];
      state.conciliaciones.push({
        id: window.uid(),
        ref_type: 'gasto',
        ref_id: gasto.id,
        account_id,
        cartola_fecha: mov.fecha,
        cartola_descripcion: mov.descripcion,
        cartola_monto: mov.monto,
        auto_creado: true,
        created_at: new Date().toISOString()
      });
      return { tipo: 'gasto', ref: gasto };
    } else {
      // Abono → venta manual
      const venta = {
        id: window.uid(),
        fecha: mov.fecha,
        monto: mov.monto,
        canal: 'transferencia',
        concepto: mov.descripcion,
        account_id
      };
      if (!state.ventasManuales) state.ventasManuales = [];
      state.ventasManuales.push(venta);
      if (!state.conciliaciones) state.conciliaciones = [];
      state.conciliaciones.push({
        id: window.uid(),
        ref_type: 'venta',
        ref_id: venta.id,
        account_id,
        cartola_fecha: mov.fecha,
        cartola_descripcion: mov.descripcion,
        cartola_monto: mov.monto,
        auto_creado: true,
        created_at: new Date().toISOString()
      });
      return { tipo: 'venta', ref: venta };
    }
  }

  window.Conciliacion = {
    parsearCartola,
    parsearCartolaFilas,
    matchearMovimientos,
    aplicarMatch,
    crearDesdeMovimiento,
    _parsearFecha,
    _parsearMonto
  };
})();
