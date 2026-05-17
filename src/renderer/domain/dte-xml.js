// src/renderer/domain/dte-xml.js
// Parser de XML de Documentos Tributarios Electrónicos (DTE) del SII de Chile.
// Soporta:
//   - <EnvioDTE> con uno o varios <DTE> (set de documentos)
//   - <DTE> individual
//   - factura afecta (33), exenta (34), notas de crédito/débito (61/56),
//     boletas (39/41), factura de compra (46), etc. — todas comparten la
//     estructura Encabezado/Totales.
//
// 100% offline (DOMParser del renderer). No se envía nada afuera.
//
// API: window.DTEXML = { parse(xmlString) -> { ok, documentos:[...], error? } }
//   Cada documento: { tipoDTE, tipoNombre, folio, fecha, rutEmisor,
//     razonEmisor, giroEmisor, rutReceptor, razonReceptor, neto, iva,
//     exento, total, items:[{nombre, cantidad, monto}] }

(function () {
  'use strict';

  const TIPOS = {
    33: 'Factura electrónica',
    34: 'Factura exenta',
    39: 'Boleta electrónica',
    41: 'Boleta exenta',
    43: 'Liquidación factura',
    46: 'Factura de compra',
    52: 'Guía de despacho',
    56: 'Nota de débito',
    61: 'Nota de crédito',
    110: 'Factura de exportación',
  };

  // Busca el primer elemento con ese localName (ignora namespace/prefijo SII).
  function el(parent, name) {
    if (!parent) return null;
    const list = parent.getElementsByTagNameNS('*', name);
    return list && list.length ? list[0] : null;
  }
  function txt(parent, name) {
    const e = el(parent, name);
    return e && e.textContent != null ? e.textContent.trim() : '';
  }
  function num(parent, name) {
    const t = txt(parent, name);
    if (!t) return 0;
    const n = Number(String(t).replace(/[^\d.\-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }

  function parseDocumento(dteNode) {
    // Encabezado vive en <Documento><Encabezado> (o <Liquidacion>, etc.)
    const enc = el(dteNode, 'Encabezado');
    if (!enc) return null;
    const idDoc = el(enc, 'IdDoc');
    const emisor = el(enc, 'Emisor');
    const receptor = el(enc, 'Receptor');
    const totales = el(enc, 'Totales');

    const tipoDTE = Number(txt(idDoc, 'TipoDTE')) || null;
    const folio = txt(idDoc, 'Folio');
    const fecha = (txt(idDoc, 'FchEmis') || '').slice(0, 10);

    // Items de detalle (pueden ser varios <Detalle>)
    const items = [];
    if (dteNode.getElementsByTagNameNS) {
      const dets = dteNode.getElementsByTagNameNS('*', 'Detalle');
      for (let i = 0; i < dets.length && i < 50; i++) {
        const d = dets[i];
        const nombre = txt(d, 'NmbItem');
        if (!nombre && !num(d, 'MontoItem')) continue;
        items.push({
          nombre: nombre || '—',
          cantidad: num(d, 'QtyItem') || 1,
          monto: num(d, 'MontoItem'),
        });
      }
    }

    return {
      tipoDTE,
      tipoNombre: TIPOS[tipoDTE] || `DTE tipo ${tipoDTE || '?'}`,
      folio,
      fecha,
      rutEmisor: txt(emisor, 'RUTEmisor'),
      razonEmisor: txt(emisor, 'RznSoc') || txt(emisor, 'RznSocEmisor'),
      giroEmisor: txt(emisor, 'GiroEmis') || txt(emisor, 'GiroEmisor'),
      rutReceptor: txt(receptor, 'RUTRecep'),
      razonReceptor: txt(receptor, 'RznSocRecep'),
      neto: num(totales, 'MntNeto'),
      iva: num(totales, 'IVA'),
      exento: num(totales, 'MntExe'),
      total: num(totales, 'MntTotal'),
      items,
    };
  }

  function parse(xmlString) {
    try {
      if (!xmlString || typeof xmlString !== 'string') {
        return { ok: false, error: 'Archivo vacío o ilegible' };
      }
      const doc = new DOMParser().parseFromString(xmlString, 'application/xml');
      if (doc.getElementsByTagName('parsererror').length) {
        return { ok: false, error: 'El archivo no es un XML válido' };
      }
      // Todos los nodos <DTE> (uno o varios dentro de EnvioDTE/SetDTE)
      let dteNodes = Array.from(doc.getElementsByTagNameNS('*', 'DTE'));
      // Si no hay <DTE> pero sí <Documento>, tratamos el doc raíz como uno.
      if (dteNodes.length === 0 && doc.getElementsByTagNameNS('*', 'Documento').length) {
        dteNodes = [doc.documentElement];
      }
      if (dteNodes.length === 0) {
        return { ok: false, error: 'No se encontró ningún DTE en el XML' };
      }
      const documentos = [];
      dteNodes.forEach(n => {
        const d = parseDocumento(n);
        if (d && d.total) documentos.push(d);
      });
      if (documentos.length === 0) {
        return { ok: false, error: 'No se pudo extraer ninguna factura con monto del XML' };
      }
      return { ok: true, documentos };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }

  window.DTEXML = { parse, TIPOS };
})();
