// src/main/mercadopago-api.js
// Lectura de la plata que ENTRA (y sale) de una cuenta de Mercado Pago, vía
// el "Reporte de Todas las transacciones" de la API oficial.
//
// Por qué el reporte y no /v1/payments/search: el reporte es lo que MP
// define como "las operaciones que afectaron el balance de tu dinero"
// (pagos recibidos, ingresos de dinero, devoluciones, contracargos,
// retiros). payments/search solo lista cobros.
//
// Flujo (docs: mercadopago.cl/developers → Reportes → Todas las transacciones):
//   1. GET/POST/PUT /v1/account/settlement_report/config → asegura columnas.
//   2. POST /v1/account/settlement_report {begin_date, end_date} → 202, se
//      genera asíncrono (segundos a un par de minutos).
//   3. GET /v1/account/settlement_report/list → aparece el archivo.
//   4. GET /v1/account/settlement_report/:file_name → CSV (separador ';').
// Auth: header `Authorization: Bearer <access token>`.
//
// Credenciales: NUNCA hardcodeadas. El access token lo pega el usuario en
// Configuración y se guarda por perfil en el renderer (mismo patrón que
// Fintoc, Meta, Google y LibreDTE). Nada se loguea.

const https = require('node:https');

const HOST = 'api.mercadopago.com';

// Columnas que la app necesita en el CSV. El resto de la configuración del
// usuario se respeta (solo se agregan las que falten).
const COLUMNAS_REQUERIDAS = [
  'TRANSACTION_DATE', 'SOURCE_ID', 'EXTERNAL_REFERENCE', 'TRANSACTION_TYPE',
  'TRANSACTION_AMOUNT', 'TRANSACTION_CURRENCY', 'FEE_AMOUNT',
  'SETTLEMENT_NET_AMOUNT', 'SETTLEMENT_DATE', 'PAYMENT_METHOD_TYPE',
  'PAYMENT_METHOD', 'DESCRIPTION', 'POI_BANK_NAME', 'POI_WALLET_NAME',
];
// Subconjunto mínimo por si MP rechaza alguna de las anteriores.
const COLUMNAS_MINIMAS = COLUMNAS_REQUERIDAS.slice(0, 12);
// Columnas que ayudan a distinguir un pago de una transferencia recibida
// (canal de venta, plataforma de cobro, etiquetas). Si MP las rechaza, se
// sigue sin ellas y no se vuelve a intentar en esta sesión.
const COLUMNAS_OPCIONALES = ['BUSINESS_UNIT', 'SUB_UNIT', 'SEGMENT_DETAIL', 'OPERATION_TAGS', 'ORDER_ID', 'ISSUER_NAME'];
let _opcionalesRechazadas = false;

function request(method, path, token, body, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: HOST,
      path,
      method,
      timeout,
      headers: {
        'Authorization': 'Bearer ' + String(token || '').trim(),
        'Accept': 'application/json, text/csv;q=0.9, */*;q=0.5',
        'User-Agent': 'Mipyme/1.0 (+electron)',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (e) { json = null; }
        resolve({ status: res.statusCode || 0, headers: res.headers || {}, json, raw });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    if (data) req.write(data);
    req.end();
  });
}

const ok2xx = (r) => r.status >= 200 && r.status < 300;
const dormir = (ms) => new Promise(r => setTimeout(r, ms));

// Detalle técnico corto de la respuesta de MP (no sensible).
function detalleMP(r) {
  const j = r && r.json;
  const partes = [String((r && r.status) || '')];
  if (j && j.error) partes.push(String(j.error));
  if (j && j.message) partes.push(String(j.message).slice(0, 160));
  if (j && Array.isArray(j.cause) && j.cause.length) {
    const c = j.cause[0];
    if (c && (c.description || c.code)) partes.push(String(c.description || c.code).slice(0, 120));
  }
  if (!j && r && r.raw) partes.push(String(r.raw).replace(/\s+/g, ' ').slice(0, 120));
  return partes.filter(Boolean).join(' · ');
}

function mensajeError(r) {
  const s = r && r.status;
  const msg = r && r.json && r.json.message;
  // MP responde 403 ("At least one policy returned UNAUTHORIZED") tanto para
  // un token inválido como para uno sin permisos: el mensaje cubre ambos.
  if (s === 401 || s === 403) return 'Mercado Pago no aceptó ese access token. Revisa que sea el Access Token de producción (APP_USR-…) completo y vigente de tu aplicación; si lo es, genera uno nuevo en Credenciales de producción.';
  if (s === 404) return 'Mercado Pago no encontró ese recurso.';
  if (s === 400 || s === 422) return 'Mercado Pago rechazó la consulta' + (msg ? `: ${msg}` : '') + '.';
  if (s === 429) return 'Mercado Pago limitó las consultas por un momento. Intenta de nuevo en unos minutos.';
  if (s >= 500) return 'Mercado Pago tuvo un problema temporal. Intenta de nuevo más tarde.';
  return 'No pude conectar con Mercado Pago' + (msg ? `: ${msg}` : '') + '.';
}

function limpiarToken(s) {
  let k = String(s || '').trim();
  k = k.replace(/^authorization\s*:\s*/i, '').replace(/^bearer\s+/i, '').trim();
  k = k.replace(/^["'`]+|["'`]+$/g, '').trim();
  return k.replace(/\s+/g, '');
}
function validarToken(t) {
  const s = limpiarToken(t);
  if (!s) return 'Falta el access token.';
  if (s.length < 20) return 'El access token parece incompleto.';
  return null;
}
function esModoTest(t) { return /^TEST-/i.test(String(t || '')); }

// ---------- Conexión ----------
async function test(creds) {
  const token = limpiarToken(creds && creds.token);
  const v = validarToken(token); if (v) return { ok: false, error: v };
  try {
    const r = await request('GET', '/users/me', token);
    if (!ok2xx(r)) return { ok: false, error: mensajeError(r), status: r.status, detalle: detalleMP(r) };
    const u = r.json || {};
    return {
      ok: true,
      modo: esModoTest(token) ? 'test' : 'live',
      id: u.id,
      nickname: u.nickname || '',
      nombre: [u.first_name, u.last_name].filter(Boolean).join(' '),
      email: u.email || '',
      site: u.site_id || '',
    };
  } catch (e) {
    return { ok: false, error: 'No pude conectar con Mercado Pago: ' + (e.message || 'error de red') };
  }
}

// ---------- Configuración del informe ----------
// Garantiza que el informe traiga las columnas que la app lee, encabezados
// en inglés (son las claves del glosario) y separador ';'. Respeta el resto.
async function asegurarConfig(token) {
  const g = await request('GET', '/v1/account/settlement_report/config', token);
  const existe = ok2xx(g) && g.json && typeof g.json === 'object';
  const actual = existe ? g.json : null;
  const colsActuales = actual && Array.isArray(actual.columns) ? actual.columns.map(c => (c && c.key) || '').filter(Boolean) : [];
  const faltan = COLUMNAS_REQUERIDAS.filter(k => !colsActuales.includes(k));
  const faltanOpc = _opcionalesRechazadas ? [] : COLUMNAS_OPCIONALES.filter(k => !colsActuales.includes(k));
  const idiomaOk = !actual || !actual.header_language || /^en/i.test(String(actual.header_language));
  const sepOk = !actual || !actual.separator || actual.separator === ';';
  if (existe && !faltan.length && !faltanOpc.length && idiomaOk && sepOk) return { ok: true, creado: false };

  const base = actual ? { ...actual } : {};
  delete base.scheduled; delete base.sftp_info; delete base.id; delete base.user_id;
  const armar = (cols) => ({
    ...base,
    file_name_prefix: base.file_name_prefix || 'mipyme-mp',
    header_language: 'en',
    separator: ';',
    display_timezone: base.display_timezone || 'GMT-04',
    include_withdraw: base.include_withdraw !== false,
    refund_detailed: base.refund_detailed !== false,
    show_chargeback_cancel: base.show_chargeback_cancel !== false,
    frequency: base.frequency || { hour: 0, type: 'monthly', value: 1 },
    columns: Array.from(new Set([...colsActuales, ...cols])).map(key => ({ key })),
  });
  const metodo = existe ? 'PUT' : 'POST';
  let r = null;
  if (faltanOpc.length) {
    r = await request(metodo, '/v1/account/settlement_report/config', token, armar([...COLUMNAS_REQUERIDAS, ...COLUMNAS_OPCIONALES]));
    if (!ok2xx(r)) _opcionalesRechazadas = true;
  }
  if (!r || !ok2xx(r)) r = await request(metodo, '/v1/account/settlement_report/config', token, armar(COLUMNAS_REQUERIDAS));
  if (!ok2xx(r)) r = await request(metodo, '/v1/account/settlement_report/config', token, armar(COLUMNAS_MINIMAS));
  if (!ok2xx(r) && !existe) r = await request('PUT', '/v1/account/settlement_report/config', token, armar(COLUMNAS_MINIMAS));
  if (!ok2xx(r)) return { ok: false, error: 'No pude preparar el informe en Mercado Pago: ' + mensajeError(r), detalle: detalleMP(r) };
  return { ok: true, creado: !existe };
}

// ---------- Generar + esperar + descargar ----------
async function listar(token) {
  const r = await request('GET', '/v1/account/settlement_report/list', token);
  if (!ok2xx(r)) return { ok: false, r };
  return { ok: true, lista: Array.isArray(r.json) ? r.json : [] };
}

async function generarYDescargar(token, since, until) {
  const begin = `${since}T00:00:00Z`;
  const end = `${until}T23:59:59Z`;
  const antes = await listar(token);
  const idsAntes = new Set(antes.ok ? antes.lista.map(x => String(x.id || x.file_name)) : []);

  const c = await request('POST', '/v1/account/settlement_report', token, { begin_date: begin, end_date: end });
  if (c.status === 203) return { ok: false, error: 'Mercado Pago no pudo generar el informe para esas fechas. Intenta de nuevo en unos minutos.', detalle: detalleMP(c) };
  if (!ok2xx(c)) return { ok: false, error: mensajeError(c), status: c.status, detalle: detalleMP(c) };

  // Espera activa: hasta ~3 minutos.
  const t0 = Date.now();
  let archivo = null;
  while (Date.now() - t0 < 180000) {
    await dormir(4000);
    const l = await listar(token);
    if (!l.ok) continue;
    const cand = l.lista.filter(x => x && x.file_name && !idsAntes.has(String(x.id || x.file_name)))
      .filter(x => String(x.begin_date || '').slice(0, 10) === since || !x.begin_date)
      .sort((a, b) => String(b.date_created || '').localeCompare(String(a.date_created || '')));
    if (cand.length) { archivo = cand[0]; break; }
  }
  if (!archivo) {
    // Último recurso: un informe manual con las mismas fechas creado hace poco.
    const l = await listar(token);
    if (l.ok) {
      const reciente = l.lista.filter(x => x && x.file_name
        && String(x.begin_date || '').slice(0, 10) === since
        && String(x.end_date || '').slice(0, 10) === until
        && (Date.now() - new Date(x.date_created || 0).getTime()) < 15 * 60000)
        .sort((a, b) => String(b.date_created || '').localeCompare(String(a.date_created || '')));
      if (reciente.length) archivo = reciente[0];
    }
  }
  if (!archivo) return { ok: false, error: 'Mercado Pago sigue generando el informe. Espera un minuto y vuelve a sincronizar.' };

  const d = await request('GET', `/v1/account/settlement_report/${encodeURIComponent(archivo.file_name)}`, token, null, { timeout: 60000 });
  if (!ok2xx(d)) return { ok: false, error: 'No pude descargar el informe: ' + mensajeError(d), detalle: detalleMP(d) };
  return { ok: true, csv: d.raw || '', file_name: archivo.file_name };
}

// ---------- CSV ----------
function parseCSV(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const primera = src.split(/\r?\n/, 1)[0] || '';
  const sep = (primera.split(';').length >= primera.split(',').length) ? ';' : ',';
  const filas = [];
  let fila = [], campo = '', enComillas = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (enComillas) {
      if (ch === '"') {
        if (src[i + 1] === '"') { campo += '"'; i++; }
        else enComillas = false;
      } else campo += ch;
      continue;
    }
    if (ch === '"') { enComillas = true; continue; }
    if (ch === sep) { fila.push(campo); campo = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      fila.push(campo); campo = '';
      if (fila.some(x => x !== '')) filas.push(fila);
      fila = [];
      continue;
    }
    campo += ch;
  }
  if (campo !== '' || fila.length) { fila.push(campo); if (fila.some(x => x !== '')) filas.push(fila); }
  if (!filas.length) return { headers: [], rows: [] };
  const headers = filas[0].map(h => String(h || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, ''));
  const rows = filas.slice(1).map(f => {
    const o = {};
    headers.forEach((h, i) => { o[h] = f[i] != null ? String(f[i]).trim() : ''; });
    return o;
  });
  return { headers, rows };
}

function num(v) {
  let s = String(v == null ? '' : v).trim().replace(/[^\d.,\-]/g, '');
  if (!s) return 0;
  if (s.includes(',') && s.includes('.')) {
    // El último separador es el decimal.
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (s.includes(',')) s = s.replace(',', '.');
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

const TIPOS = {
  SETTLEMENT:        { label: 'Pago recibido',          signo: +1 },
  CASHBACK:          { label: 'Cashback',               signo: +1 },
  REFUND:            { label: 'Devolución',             signo: -1 },
  CHARGEBACK:        { label: 'Contracargo',            signo: -1 },
  DISPUTE:           { label: 'Reclamo',                signo: -1 },
  PAYOUT:            { label: 'Retiro en efectivo',     signo: -1 },
  WITHDRAWAL:        { label: 'Retiro a banco',         signo: -1, retiro: true },
  WITHDRAWAL_CANCEL: { label: 'Retiro cancelado',       signo: +1, retiro: true },
};

// ¿Qué es esta plata que entró? 'pago' = alguien te pagó por algo (link,
// QR, Point, checkout: una venta de tus emprendimientos). 'transferencia' =
// alguien te envió plata a tu cuenta MP (no es una venta). 'otro' = cashback,
// retiro cancelado, etc. Para lo que sale, null.
const RE_TRANSFERENCIA = /transfer|env[ií]o de dinero|dinero recibido|ingreso de dinero|money[ _-]?(in|transfer|send)|send[ _-]?money|\bp2p\b|\bcvu\b|account[ _-]?fund|dep[oó]sito/i;
function clasificar(r, tipo, def, neto) {
  if (neto <= 0) return null;
  if (tipo === 'CASHBACK' || tipo === 'WITHDRAWAL_CANCEL') return 'otro';
  const texto = [r.DESCRIPTION, r.SUB_UNIT, r.SEGMENT_DETAIL, r.BUSINESS_UNIT, r.OPERATION_TAGS].filter(Boolean).join(' ');
  if (RE_TRANSFERENCIA.test(texto)) return 'transferencia';
  const metodoTipo = String(r.PAYMENT_METHOD_TYPE || '').toLowerCase();
  const sinVenta = !r.EXTERNAL_REFERENCE && !r.ORDER_ID && !r.POS_ID && !r.STORE_ID;
  // Plata enviada desde el saldo de otro usuario de MP, sin orden ni
  // referencia de venta: casi siempre es un envío de dinero entre personas.
  if ((metodoTipo === 'available_money' || metodoTipo === 'account_money') && sinVenta) return 'transferencia';
  if (tipo === 'SETTLEMENT') return 'pago';
  // Tipo que no conocemos y suma plata: lo más probable es un ingreso de
  // dinero que no pasó por un cobro. Se revisa a mano la primera vez.
  if (!TIPOS[tipo]) return 'transferencia';
  return 'otro';
}

function normalizar(rows, { incluirRetiros = false } = {}) {
  const out = [];
  for (const r of rows) {
    const tipo = String(r.TRANSACTION_TYPE || '').toUpperCase();
    const def = TIPOS[tipo] || { label: tipo || 'Movimiento', signo: 0 };
    if (def.retiro && !incluirRetiros) continue;
    const moneda = r.TRANSACTION_CURRENCY || r.SETTLEMENT_CURRENCY || 'CLP';
    const bruto = num(r.TRANSACTION_AMOUNT);
    const fee = num(r.FEE_AMOUNT);
    let neto = r.SETTLEMENT_NET_AMOUNT !== undefined && r.SETTLEMENT_NET_AMOUNT !== '' ? num(r.SETTLEMENT_NET_AMOUNT) : (bruto + fee);
    if (!neto && bruto) neto = bruto + fee;
    if (def.signo > 0 && neto < 0) neto = -neto;
    if (def.signo < 0 && neto > 0) neto = -neto;
    const monto = moneda === 'CLP' ? Math.round(neto) : neto;
    if (!monto) continue;
    const fechaRaw = r.TRANSACTION_DATE || r.SETTLEMENT_DATE || '';
    const fecha = String(fechaRaw).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) continue;
    const origen = r.POI_BANK_NAME || r.POI_WALLET_NAME || r.ISSUER_NAME || '';
    const metodo = r.PAYMENT_METHOD_TYPE ? String(r.PAYMENT_METHOD_TYPE).replace(/_/g, ' ') : '';
    const detalle = r.DESCRIPTION || r.EXTERNAL_REFERENCE || '';
    const canal = r.SUB_UNIT || r.BUSINESS_UNIT || '';
    const clase = clasificar(r, tipo, def, monto);
    const label = clase === 'transferencia' && tipo === 'SETTLEMENT' ? 'Transferencia recibida' : def.label;
    const partes = [label];
    if (detalle && String(detalle).trim().toLowerCase() !== label.toLowerCase()) partes.push(String(detalle).slice(0, 120));
    if (origen) partes.push(String(origen).slice(0, 60));
    else if (metodo) partes.push(metodo);
    if (canal) partes.push(String(canal).slice(0, 40));
    const id = `mp_${r.SOURCE_ID || r.EXTERNAL_REFERENCE || fecha}_${tipo}_${Math.abs(monto)}`;
    out.push({
      id,
      fecha,
      tipo,
      tipoLabel: label,
      clase,                 // 'pago' | 'transferencia' | 'otro' | null (sale plata)
      detalle: String(detalle).slice(0, 120),
      canal: String(canal).slice(0, 60),
      monto,                 // positivo = entra plata, negativo = sale (igual que la cartola)
      bruto: moneda === 'CLP' ? Math.round(bruto) : bruto,
      comision: moneda === 'CLP' ? Math.round(fee) : fee,
      moneda,
      descripcion: partes.join(' · ').slice(0, 250),
      metodo: r.PAYMENT_METHOD || '',
      metodoTipo: r.PAYMENT_METHOD_TYPE || '',
      source_id: r.SOURCE_ID || '',
      external_reference: r.EXTERNAL_REFERENCE || '',
    });
  }
  return out;
}

// ---------- Sync completo ----------
// args = { token, since (YYYY-MM-DD), until?, incluirRetiros? }
async function sync(args) {
  const token = limpiarToken(args && args.token);
  const v = validarToken(token); if (v) return { ok: false, error: v };
  const hoy = new Date().toISOString().slice(0, 10);
  const since = String((args && args.since) || '').slice(0, 10) || new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const until = String((args && args.until) || '').slice(0, 10) || hoy;
  try {
    const cfg = await asegurarConfig(token);
    if (!cfg.ok) return cfg;
    const g = await generarYDescargar(token, since, until);
    if (!g.ok) return g;
    const { headers, rows } = parseCSV(g.csv);
    if (!headers.length) return { ok: true, movements: [], file_name: g.file_name, vacio: true };
    const faltan = ['TRANSACTION_TYPE', 'TRANSACTION_DATE'].filter(k => !headers.includes(k));
    if (faltan.length) return { ok: false, error: 'El informe no trae las columnas esperadas.', detalle: 'Encabezados: ' + headers.slice(0, 12).join(', ') };
    const movements = normalizar(rows, { incluirRetiros: !!(args && args.incluirRetiros) })
      .filter(m => m.fecha >= since && m.fecha <= until);
    return { ok: true, movements, file_name: g.file_name, filas: rows.length, since, until };
  } catch (e) {
    return { ok: false, error: 'No pude conectar con Mercado Pago: ' + (e.message || 'error de red') };
  }
}

module.exports = { test, sync, parseCSV, normalizar, clasificar, num, limpiarToken };
