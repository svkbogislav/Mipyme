// src/renderer/domain/factura-pdf.js
// Lee facturas/boletas chilenas en PDF extrayendo la CAPA DE TEXTO con
// pdf.js y parseando los campos con expresiones regulares. Funciona con
// los PDF de factura electrónica que traen texto seleccionable (la gran
// mayoría de los proveedores de facturación). Para PDF escaneados (solo
// imagen) no hay texto que leer → se avisa y se sugiere el XML.
//
// Devuelve la MISMA forma que window.DTEXML.parse para reutilizar el
// mismo flujo de revisión/importación:
//   { ok, documentos:[{ tipoDTE, tipoNombre, folio, fecha, rutEmisor,
//       razonEmisor, rutReceptor, razonReceptor, neto, iva, exento,
//       total, items:[] }], error? }
//
// API: window.FacturaPDF = { parse(arrayBuffer) -> Promise<...> }

(function () {
  'use strict';

  const TIPOS = {
    33: 'Factura electrónica',
    34: 'Factura exenta',
    39: 'Boleta electrónica',
    41: 'Boleta exenta',
    46: 'Factura de compra',
    56: 'Nota de débito',
    61: 'Nota de crédito',
    110: 'Factura de exportación',
  };

  function _num(s) {
    if (s == null) return null;
    const limpio = String(s).replace(/[^\d]/g, '');
    if (!limpio) return null;
    const n = Number(limpio);
    return Number.isFinite(n) ? n : null;
  }

  function _fecha(txt) {
    if (!txt) return '';
    let m = txt.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (m) {
      let y = +m[3]; if (y < 100) y += 2000;
      if (y > 2000 && y < 2100) return `${y}-${String(+m[2]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
    }
    m = txt.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
    // "12 de mayo de 2026"
    const meses = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
    m = txt.toLowerCase().match(/(\d{1,2})\s+de\s+([a-záéíóú]+)\s+del?\s+(\d{4})/);
    if (m && meses[m[2]]) return `${m[3]}-${String(meses[m[2]]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
    return '';
  }

  function _parseTexto(texto) {
    const T = texto.replace(/\s+/g, ' ').trim();
    const U = T.toUpperCase();

    // Tipo de documento
    let tipoDTE = 33;
    if (/NOTA\s+DE\s+CR[EÉ]DITO/.test(U)) tipoDTE = 61;
    else if (/NOTA\s+DE\s+D[EÉ]BITO/.test(U)) tipoDTE = 56;
    else if (/BOLETA\s+(ELECTR[OÓ]NICA\s+)?EXENTA/.test(U)) tipoDTE = 41;
    else if (/BOLETA\s+(ELECTR[OÓ]NICA|DE\s+VENTAS)/.test(U)) tipoDTE = 39;
    else if (/FACTURA\s+(ELECTR[OÓ]NICA\s+)?(NO\s+AFECTA|EXENTA)/.test(U)) tipoDTE = 34;
    else if (/FACTURA\s+DE\s+COMPRA/.test(U)) tipoDTE = 46;
    else if (/FACTURA/.test(U)) tipoDTE = 33;

    // RUTs (formato chileno, admite espacio antes del dígito: "12.345.678- 9")
    const reRUT = /\d{1,2}\.?\d{3}\.?\d{3}\s*-\s*[\dkK]/g;
    const norm = r => r.replace(/\s/g, '').toUpperCase();
    const ruts = (T.match(reRUT) || []).map(norm);

    // Emisor: el RUT que va JUSTO ANTES del tipo de documento (recuadro SII:
    // "R.U.T.: 76.587.991-4  FACTURA ELECTRONICA Nº336").
    let rutEmisor = '';
    const mEmi = U.match(/(\d{1,2}\.?\d{3}\.?\d{3}\s*-\s*[\dKK])[^A-Z0-9]{0,8}(?:S\.?\s*I\.?\s*I\.?\s*)?(?:FACTURA|BOLETA|NOTA\s+DE|GU[IÍ]A|LIQUIDACI)/);
    if (mEmi) rutEmisor = norm(mEmi[1]);

    // Receptor: el RUT después de "SEÑOR(ES)/CLIENTE/RECEPTOR".
    let rutReceptor = '';
    const mRecep = U.match(/(?:SE[NÑ]OR\(ES\)|SE[NÑ]ORES|SE[NÑ]OR|CLIENTE|RECEPTOR)[^]{0,180}?R\.?U\.?T\.?\s*:?\s*(\d{1,2}\.?\d{3}\.?\d{3}\s*-\s*[\dKK])/);
    if (mRecep) rutReceptor = norm(mRecep[1]);

    // Fallbacks: completar con los RUTs encontrados sin pisar lo ya resuelto.
    if (!rutEmisor) rutEmisor = ruts.find(r => r !== rutReceptor) || ruts[0] || '';
    if (!rutReceptor) rutReceptor = ruts.find(r => r !== rutEmisor) || '';

    // Razón social emisor: el texto inicial antes de "GIRO:".
    let razonEmisor = '';
    const mRz = T.match(/^\s*([A-Za-zÁÉÍÓÚÑáéíóúñ0-9 .,&'\-]{3,70}?)\s+Giro\s*:/i);
    if (mRz) razonEmisor = mRz[1].trim();
    // Razón social receptor: entre "SEÑOR(ES):" y "R.U.T."
    let razonReceptor = '';
    const mRzR = T.match(/SE[NÑ]OR(?:\(ES\)|ES|)\s*:?\s*([^]{3,80}?)\s+R\.?U\.?T\.?\s*:/i);
    if (mRzR) razonReceptor = mRzR[1].trim();

    // Folio: "N° 1234" cerca del tipo de documento, o "FOLIO 1234"
    let folio = '';
    let mF = U.match(/FOLIO\s*[:N°º]*\s*(\d{1,9})/);
    if (!mF) mF = U.match(/(?:FACTURA|BOLETA|NOTA)[^0-9]{0,40}N[°ºO]\s*(\d{1,9})/);
    if (!mF) mF = U.match(/N[°º]\s*(\d{2,9})/);
    if (mF) folio = mF[1];

    // Fecha de emisión
    let fecha = '';
    let mFe = T.match(/Fecha\s*(?:de\s*)?Emisi[oó]n[^0-9A-Za-z]{0,8}([^\n]{0,24})/i);
    fecha = _fecha(mFe ? mFe[1] : '');
    if (!fecha) fecha = _fecha(T);

    // Montos
    const cap = re => { const m = U.match(re); return m ? _num(m[1]) : null; };
    const neto = cap(/(?:MONTO\s+)?NETO\s*\$?\s*([\d.\s]{2,})/) || 0;
    const iva = cap(/I\.?\s*V\.?\s*A\.?\s*(?:\d{1,2}\s*%)?\s*\$?\s*([\d.\s]{2,})/) || 0;
    const exento = cap(/(?:MONTO\s+)?EXENTO\s*\$?\s*([\d.\s]{2,})/) || 0;
    let total = cap(/(?:MONTO\s+)?TOTAL\s*\$?\s*([\d.\s]{2,})/);
    if (total == null && (neto || iva || exento)) total = (neto || 0) + (iva || 0) + (exento || 0);

    if (!total || !Number.isFinite(total)) return null; // sin total no importamos (evita basura)

    return {
      tipoDTE,
      tipoNombre: TIPOS[tipoDTE] || `DTE tipo ${tipoDTE}`,
      folio: folio || '',
      fecha: fecha || '',
      rutEmisor,
      razonEmisor: razonEmisor || '',
      giroEmisor: '',
      rutReceptor,
      razonReceptor: razonReceptor || '',
      neto, iva, exento,
      total: Math.round(total),
      items: [],
      _fuente: 'pdf'
    };
  }

  async function parse(arrayBuffer) {
    try {
      const pdfjs = window.pdfjsLib;
      if (!pdfjs) return { ok: false, error: 'Motor de PDF no disponible (recarga la app)' };
      // Sin worker: dentro del .asar empaquetado crear un Web Worker desde
      // file:// suele fallar. pdf.js corre en el hilo principal (modo "fake
      // worker"); para PDFs de factura (1-2 págs) es perfectamente rápido.
      const data = arrayBuffer instanceof ArrayBuffer ? new Uint8Array(arrayBuffer) : arrayBuffer;
      const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
      let texto = '';
      const maxPag = Math.min(doc.numPages, 8);
      for (let p = 1; p <= maxPag; p++) {
        const page = await doc.getPage(p);
        const tc = await page.getTextContent();
        texto += ' ' + tc.items.map(i => i.str).join(' ');
      }
      texto = texto.trim();
      if (texto.replace(/\s/g, '').length < 20) {
        return { ok: false, error: 'Este PDF no tiene texto legible (parece escaneado). Sube el XML del DTE para importarlo exacto.' };
      }
      const d = _parseTexto(texto);
      if (!d) return { ok: false, error: 'No pude extraer los datos de la factura del PDF. Si tienes el XML, súbelo (es exacto).' };
      return { ok: true, documentos: [d] };
    } catch (e) {
      return { ok: false, error: 'Error leyendo el PDF: ' + (e && e.message || e) };
    }
  }

  window.FacturaPDF = { parse };
})();
