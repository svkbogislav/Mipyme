// src/renderer/views/facturacion.js
// Vista Facturación: emisión de DTE (factura/boleta) y BHE vía LibreDTE,
// conectado al SII. El token (hash) de LibreDTE se guarda por negocio en
// state.config.sii (localStorage) — NUNCA va en el binario ni en el repo.
//
// Depende de globals: state, saveState, toast, clp, escapeHtml,
//   window.electronAPI.sii* (bridges en preload).

(function () {
  'use strict';

  // Líneas del detalle del DTE en edición (memoria de la vista).
  let facLineas = [{ nombre: '', cantidad: 1, precio: 0 }];

  function credsSII() {
    const c = state.config.sii || {};
    return {
      hash: c.hash || '',
      rutEmisor: c.rutEmisor || '',
      ambiente: c.ambiente || 'certificacion',
      host: c.host || '',
    };
  }
  function estaConfigurado() {
    const c = state.config.sii || {};
    return !!(c.hash && c.rutEmisor);
  }

  // ── Configuración (vive en Configuración → Conexiones) ──
  function refrescarSIIUI() {
    const c = state.config.sii || {};
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v || ''; };
    set('siiHash', c.hash);
    set('siiRutEmisor', c.rutEmisor);
    set('siiHost', c.host);
    const amb = document.getElementById('siiAmbiente');
    if (amb) amb.value = c.ambiente || 'certificacion';
    const span = document.getElementById('siiConnState');
    if (span) {
      if (c.hash && c.rutEmisor) {
        span.innerHTML = `Guardado · RUT <code>${escapeHtml(c.rutEmisor)}</code> · ${c.ambiente === 'produccion' ? '<strong style="color:var(--danger)">PRODUCCIÓN</strong>' : 'certificación'}`;
        span.style.color = 'var(--text-muted)';
      } else {
        span.innerHTML = '— sin configurar';
        span.style.color = 'var(--text-muted)';
      }
    }
  }

  function guardarConexionSII() {
    const hash = (document.getElementById('siiHash').value || '').trim();
    const rutEmisor = (document.getElementById('siiRutEmisor').value || '').trim();
    const ambiente = document.getElementById('siiAmbiente').value || 'certificacion';
    const host = (document.getElementById('siiHost').value || '').trim();
    if (!hash || !rutEmisor) { toast('Completa el token (hash) y el RUT emisor', 'error'); return; }
    if (ambiente === 'produccion') {
      if (!confirm('⚠️ Vas a guardar en PRODUCCIÓN. Cada documento que emitas será un documento tributario REAL ante el SII. ¿Continuar?')) return;
    }
    state.config.sii = { hash, rutEmisor, ambiente, host, savedAt: new Date().toISOString() };
    saveState();
    refrescarSIIUI();
    toast('Conexión LibreDTE guardada' + (ambiente === 'produccion' ? ' · PRODUCCIÓN activa' : ' · certificación'), 'success');
  }

  function quitarConexionSII() {
    if (!confirm('¿Desconectar LibreDTE? Se borra el token de este equipo.')) return;
    delete state.config.sii;
    saveState();
    refrescarSIIUI();
    toast('LibreDTE desconectado', '');
  }

  async function probarConexionSII() {
    if (!(window.electronAPI && window.electronAPI.siiTest)) { toast('Solo disponible en la app de escritorio', 'error'); return; }
    const hash = (document.getElementById('siiHash').value || '').trim();
    const rutEmisor = (document.getElementById('siiRutEmisor').value || '').trim();
    const ambiente = document.getElementById('siiAmbiente').value || 'certificacion';
    const host = (document.getElementById('siiHost').value || '').trim();
    if (!hash) { toast('Pega primero el token (hash)', 'error'); return; }
    toast('Probando conexión con LibreDTE…', '');
    const r = await window.electronAPI.siiTest({ hash, rutEmisor, ambiente, host });
    const span = document.getElementById('siiConnState');
    if (r.ok) {
      const u = r.usuario || {};
      if (span) {
        span.innerHTML = `✓ Conectado${u.nombre ? ` como <strong>${escapeHtml(u.nombre)}</strong>` : ''} · ${ambiente === 'produccion' ? 'PRODUCCIÓN' : 'certificación'}`;
        span.style.color = 'var(--success)';
      }
      toast('✓ Conexión LibreDTE OK', 'success');
    } else {
      if (span) { span.innerHTML = `✗ ${escapeHtml(r.error || 'Error')}`; span.style.color = 'var(--danger)'; }
      toast('Error: ' + (r.error || ''), 'error');
    }
  }

  // ── Vista Facturación ──
  function renderFacturacion() {
    const noCfg = document.getElementById('facNoConfig');
    const okCfg = document.getElementById('facConfigOk');
    const badge = document.getElementById('facAmbienteBadge');
    const cfgOk = estaConfigurado();
    if (noCfg) noCfg.style.display = cfgOk ? 'none' : '';
    if (okCfg) okCfg.style.display = cfgOk ? '' : 'none';
    if (badge) {
      const amb = (state.config.sii || {}).ambiente || 'certificacion';
      const prod = amb === 'produccion';
      badge.textContent = prod ? '● PRODUCCIÓN (documentos reales)' : '● Certificación (pruebas)';
      badge.style.color = prod ? 'var(--danger)' : 'var(--text-muted)';
      badge.style.borderColor = prod ? 'var(--danger)' : 'var(--border)';
    }
    if (!cfgOk) return;

    const fecha = document.getElementById('facFecha');
    if (fecha && !fecha.value) fecha.value = new Date().toISOString().slice(0, 10);

    renderFacDetalle();
    bindBHECalc();
    cargarEmitidosSII();
  }

  function renderFacDetalle() {
    const t = document.getElementById('facDetalleTabla');
    if (!t) return;
    t.innerHTML = `
      <thead><tr>
        <th>Descripción</th>
        <th class="num" style="width:90px">Cantidad</th>
        <th class="num" style="width:140px">Precio unit.</th>
        <th class="num" style="width:130px">Subtotal</th>
        <th style="width:40px"></th>
      </tr></thead>
      <tbody>${facLineas.map((l, i) => `<tr>
        <td><input type="text" value="${escapeHtml(String(l.nombre || ''))}" placeholder="Producto o servicio" oninput="facSetLinea(${i},'nombre',this.value)" style="width:100%" /></td>
        <td class="num"><input type="number" min="0" step="1" value="${Number(l.cantidad || 0)}" oninput="facSetLinea(${i},'cantidad',this.value)" style="width:80px; text-align:right" /></td>
        <td class="num"><input type="number" min="0" step="1" value="${Number(l.precio || 0)}" oninput="facSetLinea(${i},'precio',this.value)" style="width:120px; text-align:right" /></td>
        <td class="num">${clp(Number(l.cantidad || 0) * Number(l.precio || 0))}</td>
        <td class="num">${facLineas.length > 1 ? `<button class="btn ghost sm" title="Quitar" onclick="facQuitarLinea(${i})" style="color:var(--danger); padding:2px 8px">×</button>` : ''}</td>
      </tr>`).join('')}</tbody>`;
    recalcularTotales();
  }

  function facSetLinea(i, campo, valor) {
    if (!facLineas[i]) return;
    facLineas[i][campo] = campo === 'nombre' ? valor : Number(valor || 0);
    // Sólo recalcular totales en vivo (no re-render para no perder foco).
    recalcularTotales();
    // refrescar subtotal de la fila
    const t = document.getElementById('facDetalleTabla');
    if (t) {
      const fila = t.querySelectorAll('tbody tr')[i];
      if (fila) fila.children[3].textContent = clp(Number(facLineas[i].cantidad || 0) * Number(facLineas[i].precio || 0));
    }
  }
  function facAgregarLinea() { facLineas.push({ nombre: '', cantidad: 1, precio: 0 }); renderFacDetalle(); }
  function facQuitarLinea(i) { facLineas.splice(i, 1); if (!facLineas.length) facLineas = [{ nombre: '', cantidad: 1, precio: 0 }]; renderFacDetalle(); }

  function tipoEsExento() {
    const t = document.getElementById('facTipoDte');
    return t && (t.value === '34' || t.value === '41');
  }
  function recalcularTotales() {
    const neto = facLineas.reduce((s, l) => s + Number(l.cantidad || 0) * Number(l.precio || 0), 0);
    const exento = tipoEsExento();
    const iva = exento ? 0 : Math.round(neto * 0.19);
    const total = neto + iva;
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = clp(v); };
    set('facNeto', neto);
    set('facIva', iva);
    set('facTotal', total);
  }

  async function emitirDocumentoSII() {
    if (!(window.electronAPI && window.electronAPI.siiEmitirDTE)) { toast('Solo disponible en la app de escritorio', 'error'); return; }
    const creds = credsSII();
    const tipo = Number(document.getElementById('facTipoDte').value);
    const fecha = document.getElementById('facFecha').value || new Date().toISOString().slice(0, 10);
    const rutRecep = (document.getElementById('facRutReceptor').value || '').trim();
    const rznRecep = (document.getElementById('facRazonReceptor').value || '').trim();
    const giroRecep = (document.getElementById('facGiroReceptor').value || '').trim();
    const dirRecep = (document.getElementById('facDirReceptor').value || '').trim();
    const lineas = facLineas.filter(l => l.nombre && Number(l.cantidad) > 0);
    if (!lineas.length) { toast('Agrega al menos una línea con descripción y cantidad', 'error'); return; }

    const esBoleta = tipo === 39 || tipo === 41;
    if (!esBoleta && (!rutRecep || !rznRecep)) { toast('En factura el receptor (RUT + razón social) es obligatorio', 'error'); return; }

    const exento = tipo === 34 || tipo === 41;
    const documento = {
      Encabezado: {
        IdDoc: { TipoDTE: tipo, FchEmis: fecha },
        Emisor: { RUTEmisor: creds.rutEmisor },
        Receptor: {
          RUTRecep: rutRecep || '66666666-6',
          RznSocRecep: rznRecep || 'Consumidor final',
          GiroRecep: giroRecep || undefined,
          DirRecep: dirRecep || undefined,
        },
      },
      Detalle: lineas.map(l => ({
        NmbItem: String(l.nombre).slice(0, 80),
        QtyItem: Number(l.cantidad),
        PrcItem: Number(l.precio),
        IndExe: exento ? 1 : undefined,
      })),
    };

    const amb = creds.ambiente === 'produccion' ? 'PRODUCCIÓN (documento tributario REAL)' : 'certificación (prueba)';
    if (!confirm(`Vas a emitir un documento tipo ${tipo} en ${amb}. ¿Continuar?`)) return;

    const btn = document.getElementById('facBtnEmitir');
    const est = document.getElementById('facEmitirEstado');
    if (btn) { btn.disabled = true; btn.textContent = 'Emitiendo…'; }
    if (est) { est.textContent = 'Enviando a LibreDTE → SII…'; est.style.color = 'var(--text-muted)'; }

    const r = await window.electronAPI.siiEmitirDTE({ creds, documento });

    if (btn) { btn.disabled = false; btn.textContent = 'Emitir documento'; }
    if (r.ok) {
      const w = r.warning ? ` ⚠️ ${r.warning}` : '';
      if (est) { est.innerHTML = `✓ Emitido — tipo ${r.dte}, folio <strong>${r.folio}</strong>${r.trackid ? ` · track ${r.trackid}` : ''}${w ? `<br><span style="color:var(--warning)">${escapeHtml(r.warning)}</span>` : ''}`; est.style.color = 'var(--success)'; }
      toast(`✓ Documento ${r.dte} folio ${r.folio} emitido (${creds.ambiente})`, 'success');
      facLineas = [{ nombre: '', cantidad: 1, precio: 0 }];
      renderFacDetalle();
      cargarEmitidosSII();
    } else {
      if (est) { est.innerHTML = `✗ ${escapeHtml(r.error || 'Error')}`; est.style.color = 'var(--danger)'; }
      toast('Error al emitir: ' + (r.error || ''), 'error');
    }
  }

  async function cargarEmitidosSII() {
    const t = document.getElementById('facEmitidosTabla');
    if (!t || !(window.electronAPI && window.electronAPI.siiListarEmitidos)) return;
    t.innerHTML = '<tbody><tr><td style="padding:14px; color:var(--text-muted)">Cargando…</td></tr></tbody>';
    const creds = credsSII();
    const r = await window.electronAPI.siiListarEmitidos({ creds });
    if (!r.ok) {
      t.innerHTML = `<tbody><tr><td style="padding:14px; color:var(--text-muted)">No se pudo cargar la lista: ${escapeHtml(r.error || '')}</td></tr></tbody>`;
      return;
    }
    const docs = Array.isArray(r.documentos) ? r.documentos : [];
    if (!docs.length) {
      t.innerHTML = '<tbody><tr><td style="padding:14px; color:var(--text-muted)">Aún no hay documentos emitidos en esta cuenta.</td></tr></tbody>';
      return;
    }
    t.innerHTML = `
      <thead><tr><th>Tipo</th><th class="num">Folio</th><th>Receptor</th><th class="num">Total</th><th>Fecha</th><th>Estado SII</th><th></th></tr></thead>
      <tbody>${docs.slice(0, 50).map(d => {
        const dte = d.dte || d.TipoDTE || '';
        const folio = d.folio || d.Folio || '';
        return `<tr>
          <td>${escapeHtml(String(dte))}</td>
          <td class="num">${escapeHtml(String(folio))}</td>
          <td>${escapeHtml(String(d.razon_social || d.RznSocRecep || d.receptor || '—'))}</td>
          <td class="num">${clp(Number(d.total || d.MntTotal || 0))}</td>
          <td>${escapeHtml(String(d.fecha || d.FchEmis || '—'))}</td>
          <td>${escapeHtml(String(d.estado || d.revision_estado || d.glosa || '—'))}</td>
          <td><button class="btn ghost sm" onclick="descargarPDFSII(${Number(dte) || 0},${Number(folio) || 0})">PDF</button></td>
        </tr>`;
      }).join('')}</tbody>`;
  }

  async function descargarPDFSII(dte, folio) {
    if (!dte || !folio || !(window.electronAPI && window.electronAPI.siiPdfDTE)) return;
    toast('Descargando PDF…', '');
    const r = await window.electronAPI.siiPdfDTE({ creds: credsSII(), dte, folio });
    if (!r.ok) { toast('No se pudo descargar el PDF: ' + (r.error || ''), 'error'); return; }
    try {
      const bin = atob(r.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `DTE_${dte}_${folio}.pdf`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
    } catch (e) {
      toast('Error abriendo el PDF: ' + e.message, 'error');
    }
  }

  // ── BHE ──
  function bindBHECalc() {
    const m = document.getElementById('bheMonto');
    if (m && !m._bheBound) {
      m.addEventListener('input', calcBHE);
      m._bheBound = true;
    }
    calcBHE();
  }
  function calcBHE() {
    const bruto = Number((document.getElementById('bheMonto') || {}).value || 0);
    const ret = Math.round(bruto * 0.1525); // retención 2026 = 15,25%
    const liq = bruto - ret;
    const r = document.getElementById('bheRetencion'); if (r) r.textContent = clp(ret);
    const l = document.getElementById('bheLiquido'); if (l) l.textContent = clp(liq);
  }

  async function emitirBHESII() {
    if (!(window.electronAPI && window.electronAPI.siiEmitirBHE)) { toast('Solo disponible en la app de escritorio', 'error'); return; }
    const creds = credsSII();
    const rut = (document.getElementById('bheRut').value || '').trim();
    const razon = (document.getElementById('bheRazon').value || '').trim();
    const glosa = (document.getElementById('bheGlosa').value || '').trim();
    const monto = Number(document.getElementById('bheMonto').value || 0);
    if (!rut || !razon || !glosa || monto <= 0) { toast('Completa receptor, glosa y monto', 'error'); return; }
    const amb = creds.ambiente === 'produccion' ? 'PRODUCCIÓN (boleta REAL ante el SII)' : 'certificación';
    if (!confirm(`Emitir boleta de honorarios por ${clp(monto)} en ${amb}. La BHE automatiza el portal del SII vía LibreDTE. ¿Continuar?`)) return;

    const boleta = {
      receptor: { rut, razon_social: razon },
      detalle: glosa,
      monto,
    };
    const btn = document.getElementById('bheBtnEmitir');
    const est = document.getElementById('bheEstado');
    if (btn) { btn.disabled = true; btn.textContent = 'Emitiendo…'; }
    if (est) { est.textContent = 'Emitiendo BHE…'; est.style.color = 'var(--text-muted)'; }
    const r = await window.electronAPI.siiEmitirBHE({ creds, boleta });
    if (btn) { btn.disabled = false; btn.textContent = 'Emitir boleta de honorarios'; }
    if (r.ok) {
      if (est) { est.innerHTML = '✓ Boleta de honorarios emitida'; est.style.color = 'var(--success)'; }
      toast('✓ BHE emitida', 'success');
    } else {
      if (est) { est.innerHTML = `✗ ${escapeHtml(r.error || 'Error')}`; est.style.color = 'var(--danger)'; }
      toast('Error BHE: ' + (r.error || ''), 'error');
    }
  }

  // Exponer al scope global (el HTML usa onclick="...").
  window.renderFacturacion = renderFacturacion;
  window.refrescarSIIUI = refrescarSIIUI;
  window.guardarConexionSII = guardarConexionSII;
  window.quitarConexionSII = quitarConexionSII;
  window.probarConexionSII = probarConexionSII;
  window.facAgregarLinea = facAgregarLinea;
  window.facQuitarLinea = facQuitarLinea;
  window.facSetLinea = facSetLinea;
  window.emitirDocumentoSII = emitirDocumentoSII;
  window.cargarEmitidosSII = cargarEmitidosSII;
  window.descargarPDFSII = descargarPDFSII;
  window.emitirBHESII = emitirBHESII;

  // Recalcular IVA al cambiar tipo de documento (afecto/exento).
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'facTipoDte') recalcularTotales();
  });
})();
