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
//   - detectarCuotaDeuda(mov, state) → { deuda, claro } | null
//        Reconoce la cuota de un crédito (glosa + monto ±2% de la cuota
//        mensual) y devuelve la deuda de "Mis deudas" a la que pertenece.
//   - aplicarMatch / crearDesdeMovimiento / aplicarCuotaDeuda: mutan state
//        in-place. El caller persiste con saveState().
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

  // ─── Cartolas "narrativas" (Tenpo, MercadoPago, fintech) ───────────────
  // Algunos bancos no exportan columnas: cada movimiento es UNA frase tipo
  //   "Abono por transferencia de JUAN ... el 16/05/2026 ... monto 1290"
  //   "Cargo por compra en ARAMCO el 16/05/2026 ... monto 9020"
  // Acá el tipo (abono/cargo), la fecha y el monto van DENTRO del texto.
  // Mapear columnas no sirve — hay que leer la frase.
  function _parsearMovTexto(txt) {
    const t = String(txt || '').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    const low = t.toLowerCase();

    // Tipo: palabra inicial manda; si no, por palabras clave.
    let signo = 0;
    if (/^\s*(abono|dep[oó]sito|devoluci[oó]n|reembolso)\b/.test(low)) signo = 1;
    else if (/^\s*(cargo|compra|pago|giro|retiro|comisi[oó]n)\b/.test(low)) signo = -1;
    else if (/\babono\b|\bdep[oó]sito\b|transferencia (recibida|de)\b|\bdevoluci[oó]n\b|\bingreso\b/.test(low)) signo = 1;
    else if (/\bcargo\b|\bcompra\b|\bpago\b|\bgiro\b|\bretiro\b|\bcomisi[oó]n\b|\begreso\b/.test(low)) signo = -1;
    if (signo === 0) return null;

    // Fecha: "el dd/mm/aaaa" preferido; si no, primer dd/mm/aaaa o ISO.
    let fecha = null;
    let mF = low.match(/\bel\s+(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (!mF) mF = t.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (mF) {
      let yr = +mF[3]; if (yr < 100) yr += 2000;
      const d = new Date(yr, +mF[2] - 1, +mF[1], 12, 0, 0);
      if (!isNaN(d) && d.getFullYear() > 2000 && d.getFullYear() < 2100) fecha = d;
    }
    if (!fecha) {
      const mISO = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (mISO) { const d = new Date(+mISO[1], +mISO[2] - 1, +mISO[3], 12, 0, 0); if (!isNaN(d)) fecha = d; }
    }
    if (!fecha) return null;

    // Monto: "monto N" preferido; si no, primer "$ N"; si no, el número
    // más grande de la frase (evita confundir con RUT/hora).
    let monto = null;
    // Solo montos EXPLÍCITOS ("monto N" o "$ N"). Sin fallback al número
    // más grande: en estas frases hay RUTs/horas que se confundirían.
    let mM = low.match(/monto\s*\$?\s*([\d][\d.,]*)/);
    if (mM) monto = _parsearMonto(mM[1]);
    if (monto == null) {
      const mD = t.match(/\$\s*([\d][\d.,]*)/);
      if (mD) monto = _parsearMonto(mD[1]);
    }
    if (monto == null || !Number.isFinite(monto) || monto === 0) return null;

    return {
      fecha: window.ymdOf(fecha.toISOString()),
      monto: Math.round(Math.abs(monto)) * signo,
      descripcion: t.slice(0, 250)
    };
  }

  function _parsearCartolaTexto(filas) {
    // Texto de cada fila = todas las celdas unidas (cubre 1 sola columna o
    // varias mal alineadas).
    const textos = filas.map(f => (Array.isArray(f) ? f.join(' ') : String(f || '')).trim())
      .filter(s => s);
    if (textos.length < 2) return null;
    const parsed = [];
    let conPatron = 0;
    textos.forEach(t => {
      if (_esFilaSaldo([t])) return;
      const low = t.toLowerCase();
      const pareceMov = /\b(abono|cargo|compra|pago|giro|retiro|dep[oó]sito|transferencia|comisi[oó]n)\b/.test(low)
        && /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}-\d{1,2}-\d{1,2}/.test(t);
      if (!pareceMov) return;
      conPatron++;
      const mv = _parsearMovTexto(t);
      if (mv) parsed.push({ _id: window.uid(), fecha: mv.fecha, descripcion: mv.descripcion, monto: mv.monto, _raw: [t] });
    });
    // Solo usamos este modo si la mayoría de las filas son frases-movimiento
    // (evita robarle el parseo a una cartola columnar normal).
    if (parsed.length >= 3 && parsed.length >= conPatron * 0.6) {
      return { movimientos: parsed, columnas: { formato: 'texto' }, totalFilas: filas.length, filas };
    }
    return null;
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

  // ¿La fila es un renglón de SALDO / TOTAL / encabezado de resumen y NO
  // un movimiento real? Los bancos meten "Saldo final", "Saldo inicial",
  // "Saldo disponible", "Saldo contable", "Total cargos/abonos", etc. en
  // medio o al final de la cartola con un monto — sin esto se cuelan como
  // ventas/gastos falsos.
  function _esFilaSaldo(fila) {
    const txt = (Array.isArray(fila) ? fila.join(' ') : String(fila || '')).toLowerCase();
    if (!txt.trim()) return true;
    // "saldo ..." (final, inicial, anterior, disponible, contable, nuevo,
    // al cierre, del periodo, en cuenta) o "total ..." de resumen.
    if (/\bsaldo\b\s*(final|inicial|anterior|disponible|contable|nuevo|en\s+cuenta|al\s+cierre|del\s+per[ií]odo|actual|a\s+favor)?/.test(txt)
        && !/transferenc|pago|compra|giro|abono\s+de|dep[oó]sito\s+de|cargo\s+por/.test(txt)) {
      // Solo si NO parece una transacción real con contraparte
      if (/^\s*saldo\b/.test(txt) || /\bsaldo\s+(final|inicial|anterior|disponible|contable|nuevo|al|del|actual)\b/.test(txt))
        return true;
    }
    if (/^\s*total\s+(cargos|abonos|movimientos|d[eé]bitos|cr[eé]ditos|general|del\s+per[ií]odo)/.test(txt)) return true;
    if (/^\s*(saldo|total)\s*$/.test(txt)) return true;
    return false;
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
        if (_esFilaSaldo(fila)) continue; // "Saldo final/inicial", "Total ..." → no es movimiento
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
        columnas: { headerIdx: headerRow, idxFecha, idxMonto, idxDesc, idxSigno, idxCargo: null, idxAbono: null, formato: 'bice' },
        totalFilas: filas.length,
        filas
      };
    }

    // ─── Modo genérico (CSV simple, banco estilo Santander/BCI/etc) ───
    const cols = _detectarColumnas(filas);
    if (!cols) {
      // Último recurso: cartola "narrativa" (cada movimiento es una frase).
      const txtRes = _parsearCartolaTexto(filas);
      if (txtRes) return txtRes;
      return { error: 'No pude detectar las columnas de fecha y monto. ¿El archivo tiene esas columnas?' };
    }

    const movs = [];
    let ultimaFecha = null;
    filas.forEach((fila, i) => {
      if (i === cols.headerIdx) return;
      if (_esFilaSaldo(fila)) return; // "Saldo final/inicial", "Total ..." → no es movimiento
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
    return { movimientos: movs, columnas: cols, totalFilas: filas.length, filas };
  }

  // Re-parsea con un MAPEO de columnas explícito dado por el usuario (cuando
  // la autodetección se equivocó, ej. tomó la columna de Saldo como ingreso).
  // mapeo = { headerIdx, idxFecha, idxDesc, idxMonto, idxCargo, idxAbono }
  // (índices numéricos o null/''). Sigue ignorando filas de saldo/total.
  function reparsearConMapeo(filas, mapeo) {
    if (!Array.isArray(filas) || filas.length === 0) return { error: 'Sin filas' };
    const N = x => (x === '' || x === null || x === undefined) ? null : Number(x);
    const m = {
      headerIdx: N(mapeo.headerIdx),
      idxFecha: N(mapeo.idxFecha),
      idxDesc:  N(mapeo.idxDesc),
      idxMonto: N(mapeo.idxMonto),
      idxCargo: N(mapeo.idxCargo),
      idxAbono: N(mapeo.idxAbono),
      idxSigno: N(mapeo.idxSigno)   // columna Categoría (Cargos/Abonos)
    };
    const movs = [];
    let ultimaFecha = null;
    filas.forEach((fila, i) => {
      if (m.headerIdx !== null && i === m.headerIdx) return;
      if (_esFilaSaldo(fila)) return;
      const fechaCelda = (m.idxFecha !== null ? fila[m.idxFecha] : '') || '';
      if (fechaCelda) {
        const fD = _parsearFecha(fechaCelda);
        if (fD) ultimaFecha = window.ymdOf(fD.toISOString());
      }
      if (!ultimaFecha) return;
      let monto = null;
      if (m.idxMonto !== null && m.idxSigno !== null) {
        // Monto + columna Categoría (Cargos/Abonos) define el signo
        const v = Math.abs(_parsearMonto(fila[m.idxMonto]) || 0);
        const cat = String(fila[m.idxSigno] || '').toLowerCase();
        if (v > 0) {
          if (/cargo|d[eé]bito|giro|egreso/.test(cat)) monto = -v;
          else if (/abono|cr[eé]dito|dep[oó]sito|ingreso/.test(cat)) monto = v;
        }
      } else if (m.idxMonto !== null) {
        monto = _parsearMonto(fila[m.idxMonto]);
      } else if (m.idxCargo !== null && m.idxAbono !== null) {
        const cargo = _parsearMonto(fila[m.idxCargo]);
        const abono = _parsearMonto(fila[m.idxAbono]);
        if (abono && abono > 0) monto = abono;
        else if (cargo && cargo > 0) monto = -cargo;
      } else if (m.idxAbono !== null) {
        const a = _parsearMonto(fila[m.idxAbono]); if (a && a > 0) monto = a;
      } else if (m.idxCargo !== null) {
        const c = _parsearMonto(fila[m.idxCargo]); if (c && c > 0) monto = -c;
      }
      if (monto === null || !Number.isFinite(monto) || monto === 0) return;
      const descripcion = (m.idxDesc !== null ? fila[m.idxDesc] : fila.join(' ')) || '';
      movs.push({
        _id: window.uid(),
        fecha: ultimaFecha,
        descripcion: String(descripcion).trim().slice(0, 250),
        monto: Math.round(monto),
        _raw: fila
      });
    });
    return { movimientos: movs, columnas: m, totalFilas: filas.length, filas };
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
      // La cuota de un crédito crea un gasto ligado al pago de la deuda: ese
      // gasto ya está conciliado (no se vuelve a ofrecer como cruce).
      if (c.gasto_id) conciliados.add(`gasto:${c.gasto_id}`);
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
          if (g.auto_estimado) return; // estimaciones (comisión/IVA) no son movimientos reales
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

  // ─── Cuotas de crédito → "Mis deudas" ─────────────────────────────────
  // Fintoc no expone los créditos de consumo como cuenta: la cuota llega
  // solo como un cargo en la cuenta corriente. Acá reconocemos ese cargo y
  // lo ligamos a la deuda correspondiente (state.deudas) en vez de dejarlo
  // como gasto suelto. Señales, por deuda activa (saldo pendiente > 0):
  //   - texto:    la glosa trae CUOTA / CREDITO DE CONSUMO / PRESTAMO /
  //               DIVIDENDO / HIPOTECARIO… (y no es tarjeta, línea, compra)
  //   - acreedor: el nombre del acreedor aparece en la glosa
  //   - monto:    |monto| coincide (±2%) con la cuota_mensual de la deuda
  //   - fecha:    el día del mes está cerca (±5 días) del día de pago
  // "claro" = (texto o acreedor) + monto. Solo lo claro se aplica solo; lo
  // demás queda como candidato para que el usuario lo elija en la revisión.
  const RE_CUOTA = /\b(CUOTAS?|CREDITO DE CONSUMO|CRED(?:ITO)?\.? ?(?:DE )?CONS(?:UMO)?|PAGO (?:DE )?CRED(?:ITO)?|PRESTAMO|DIVIDENDO|HIPOTECARI[OA]|AUTOMOTRIZ)\b/;
  const RE_NO_CUOTA = /\b(LINEA DE CREDITO|TARJETA|COMPRA|INTERES(?:ES)?|COMISION|SEGURO)\b/;
  const PALABRAS_GENERICAS = new Set(['BANCO', 'CREDITO', 'CONSUMO', 'PRESTAMO', 'DEUDA', 'CUOTA', 'TARJETA', 'FINANCIERA', 'COOPERATIVA', 'CAJA', 'CHILE']);

  function _norm(s) {
    return String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  }

  function _saldoDeuda(d) {
    if (window.Deudas && window.Deudas.saldoPendiente) return window.Deudas.saldoPendiente(d);
    const pagado = ((d && d.pagos) || []).reduce((s, p) => s + Number(p.monto || 0), 0);
    return Math.max(0, Number((d && d.monto_total) || 0) - pagado);
  }

  // Palabras del acreedor que identifican al banco/financiera en una glosa
  // ("Banco Santander" → SANTANDER; "Caja Los Andes" → ANDES).
  function _clavesAcreedor(acreedor) {
    return _norm(acreedor).replace(/[^A-Z0-9 ]/g, ' ').split(' ')
      .filter(w => w.length >= 4 && !PALABRAS_GENERICAS.has(w));
  }

  // Día del mes en que se paga la cuota: el del vencimiento o, si no hay,
  // el de la emisión. null si la deuda no tiene fechas.
  function _diaPagoDeuda(d) {
    const f = (d && (d.fecha_vencimiento || d.fecha_emision)) || '';
    const dia = Number(String(f).slice(8, 10));
    return dia >= 1 && dia <= 31 ? dia : null;
  }

  function _cercaDiaPago(ymd, dia) {
    if (!dia) return true; // sin fecha de referencia no restringimos
    const dm = Number(String(ymd || '').slice(8, 10));
    if (!dm) return false;
    const diff = Math.abs(dm - dia);
    return Math.min(diff, 31 - diff) <= 5;
  }

  // ¿La deuda ya tiene un pago por este monto en una fecha cercana? (evita
  // duplicar la cuota si se vuelve a subir la misma cartola o si el usuario
  // ya la registró a mano)
  function _yaTienePago(d, ymd, abs) {
    return ((d && d.pagos) || []).some(p =>
      p.fecha && Math.abs(Number(p.monto || 0) - abs) <= abs * 0.02 + 1 && _diffDias(p.fecha, ymd) <= 5);
  }

  // Devuelve { deuda, claro, score } con la mejor deuda candidata para el
  // movimiento, o null si no hay ninguna.
  function detectarCuotaDeuda(mov, state) {
    if (!mov || !(mov.monto < 0)) return null;
    const abs = Math.abs(Number(mov.monto));
    if (!abs) return null;
    const glosa = _norm(mov.descripcion);
    const texto = RE_CUOTA.test(glosa) && !RE_NO_CUOTA.test(glosa);
    const cands = [];
    ((state && state.deudas) || []).forEach(d => {
      if (_saldoDeuda(d) <= 0) return;
      if (_yaTienePago(d, mov.fecha, abs)) return;
      const cuota = Number(d.cuota_mensual || 0);
      const monto = cuota > 0 && Math.abs(abs - cuota) <= cuota * 0.02;
      const acreedor = _clavesAcreedor(d.acreedor).some(k => new RegExp('\\b' + k + '\\b').test(glosa));
      const fecha = monto && _cercaDiaPago(mov.fecha, _diaPagoDeuda(d));
      if (!texto && !acreedor && !fecha) return;
      const score = (texto ? 2 : 0) + (acreedor ? 3 : 0) + (monto ? 3 : 0) + (fecha ? 1 : 0);
      const dist = cuota > 0 ? Math.abs(abs - cuota) / cuota : 9;
      cands.push({ deuda: d, score, dist, claro: (texto || acreedor) && monto });
    });
    if (!cands.length) return null;
    cands.sort((a, b) => (b.score - a.score) || (a.dist - b.dist));
    const top = cands[0];
    // Dos deudas igual de probables → no es claro: que decida el usuario.
    const empate = cands.length > 1 && cands[1].score === top.score && cands[1].dist === top.dist;
    return { deuda: top.deuda, claro: !!top.claro && !empate, score: top.score };
  }

  // Registra el movimiento como pago de la deuda. Crea UN gasto (igual que
  // el pago manual en "Mis deudas": así el flujo de caja y el saldo de la
  // cuenta ven la plata que salió) ligado al pago, y una conciliación
  // ref_type 'deuda_pago' con el lote para poder retirarla después.
  function aplicarCuotaDeuda(state, mov, deuda, account_id, lote, categoria) {
    const d = (state.deudas || []).find(x => x === deuda || (deuda && x.id === deuda.id));
    if (!d || !mov || !(mov.monto < 0)) return null;
    const monto = Math.abs(Math.round(mov.monto));
    if (!monto) return null;
    const personal = !!(state.config && state.config.perfil === 'personal');
    const gasto = {
      id: window.uid(),
      fecha: mov.fecha,
      monto,
      categoria: categoria || 'Bancarios',
      proveedor: d.acreedor || mov.descripcion,
      descripcion: `${personal ? 'Cuota de crédito' : 'Pago deuda'} — ${d.descripcion || d.acreedor}`,
      metodo: 'Transferencia',
      account_id,
      deuda_id: d.id,
      attachments: []
    };
    if (d.acreedor && typeof window.buscarOCrearProveedor === 'function') {
      gasto.proveedor_id = window.buscarOCrearProveedor(d.acreedor);
    }
    if (!state.gastos) state.gastos = [];
    state.gastos.push(gasto);
    const pago = { id: window.uid(), fecha: mov.fecha, monto, account_id, gasto_id: gasto.id, origen: 'cartola' };
    if (!d.pagos) d.pagos = [];
    d.pagos.push(pago);
    if (!state.conciliaciones) state.conciliaciones = [];
    state.conciliaciones.push({
      id: window.uid(),
      ref_type: 'deuda_pago',
      ref_id: pago.id,
      deuda_id: d.id,
      gasto_id: gasto.id,
      account_id,
      cartola_fecha: mov.fecha,
      cartola_descripcion: mov.descripcion,
      cartola_monto: mov.monto,
      auto_creado: true,
      lote: lote || null,
      created_at: new Date().toISOString()
    });
    return { tipo: 'deuda_pago', ref: pago, gasto, deuda: d };
  }

  // Deshace una conciliación 'deuda_pago': quita el pago de la deuda y borra
  // el gasto ligado. Devuelve true si borró algo.
  function deshacerCuotaDeuda(state, conc) {
    if (!conc || conc.ref_type !== 'deuda_pago') return false;
    let quitado = false;
    const d = (state.deudas || []).find(x => x.id === conc.deuda_id);
    if (d && Array.isArray(d.pagos)) {
      const n = d.pagos.length;
      d.pagos = d.pagos.filter(p => p.id !== conc.ref_id);
      quitado = d.pagos.length < n;
    }
    if (conc.gasto_id) {
      const n = (state.gastos || []).length;
      state.gastos = (state.gastos || []).filter(g => g.id !== conc.gasto_id);
      quitado = quitado || state.gastos.length < n;
    }
    return quitado;
  }

  // ─── Aplicar match (marca como conciliado en state.conciliaciones) ───
  function aplicarMatch(state, mov, candidato, account_id, lote) {
    if (!state.conciliaciones) state.conciliaciones = [];
    state.conciliaciones.push({
      id: window.uid(),
      ref_type: candidato.tipo,
      ref_id: candidato.ref.id,
      account_id,
      cartola_fecha: mov.fecha,
      cartola_descripcion: mov.descripcion,
      cartola_monto: mov.monto,
      lote: lote || null,
      created_at: new Date().toISOString()
    });
    return true;
  }

  // ─── Crear gasto/venta desde un movimiento sin match ──────────────────
  function crearDesdeMovimiento(state, mov, account_id, categoriaOverride, lote) {
    if (mov.monto < 0) {
      // Cargo → gasto. Categoría: override del usuario > sugerencia del
      // categorizador (reglas base + aprendido) > "Por clasificar".
      let categoria = categoriaOverride;
      if (!categoria && window.Categorizador) {
        const sug = window.Categorizador.sugerir(mov.descripcion, mov.monto, state);
        if (sug && sug.categoria) categoria = sug.categoria;
      }
      if (!categoria) categoria = 'Por clasificar';
      const gasto = {
        id: window.uid(),
        fecha: mov.fecha,
        monto: Math.abs(mov.monto),
        categoria,
        proveedor: mov.descripcion,
        descripcion: mov.descripcion,
        metodo: 'Transferencia',
        account_id
      };
      const rawG = mov._raw || {};
      if (rawG.mp_id) { gasto.mp_id = rawG.mp_id; gasto.metodo = 'Mercado Pago'; gasto.origen = 'mercadopago'; }
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
        lote: lote || null,
        created_at: new Date().toISOString()
      });
      return { tipo: 'gasto', ref: gasto };
    } else {
      // Abono → venta manual (en perfil personal, "ingreso"). categoriaOverride
      // acá es el tipo de ingreso ('emprendimiento' | 'transferencia' |
      // 'sueldo' | 'otro') o null si no se clasificó.
      const raw = mov._raw || {};
      const esMP = !!raw.mp_id;
      const venta = {
        id: window.uid(),
        fecha: mov.fecha,
        monto: mov.monto,
        canal: 'transferencia',
        concepto: mov.descripcion,
        descripcion: mov.descripcion,
        cliente: '',
        metodo: esMP ? 'Mercado Pago' : 'Transferencia',
        origen: esMP ? 'mercadopago' : (raw.fintoc_id ? 'banco' : 'cartola'),
        tipo_ingreso: categoriaOverride || null,
        account_id,
        created_at: new Date().toISOString()
      };
      if (esMP) venta.mp_id = raw.mp_id;
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
        lote: lote || null,
        created_at: new Date().toISOString()
      });
      return { tipo: 'venta', ref: venta };
    }
  }

  window.Conciliacion = {
    parsearCartola,
    parsearCartolaFilas,
    reparsearConMapeo,
    matchearMovimientos,
    aplicarMatch,
    crearDesdeMovimiento,
    detectarCuotaDeuda,
    aplicarCuotaDeuda,
    deshacerCuotaDeuda,
    _parsearFecha,
    _parsearMonto
  };
})();
