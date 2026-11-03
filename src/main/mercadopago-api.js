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
//      genera asíncrono (segundos a un par de minutos). MP acepta como
//      máximo 60 días por informe y rechaza fechas futuras (400 "Error
//      creating Statement"): períodos más largos se piden en tramos.
//   3. GET /v1/account/settlement_report/list → aparece el archivo.
//   4. GET /v1/account/settlement_report/:file_name → CSV (separador ';').
// Auth: header `Authorization: Bearer <access token>`.
//
// Credenciales: NUNCA hardcodeadas. El access token lo pega el usuario en
// Configuración y se guarda por perfil en el renderer (mismo patrón que
// Fintoc, Meta, Google y LibreDTE). Nada se loguea.

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

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

// Máximo de días por informe (la doc dice 60; margen por el huso GMT-4).
const MAX_DIAS_INFORME = 55;

// Parte [since, until] en tramos consecutivos de hasta maxDias días.
function ventanas(since, until, maxDias) {
  const a0 = new Date(`${since}T00:00:00Z`);
  const fin = new Date(`${until}T00:00:00Z`);
  if (isNaN(a0) || isNaN(fin) || a0 > fin) return [{ since, until }];
  const out = [];
  let a = a0;
  while (a <= fin) {
    const b = new Date(a.getTime() + (maxDias - 1) * 86400000);
    const hasta = b < fin ? b : fin;
    out.push({ since: a.toISOString().slice(0, 10), until: hasta.toISOString().slice(0, 10) });
    a = new Date(hasta.getTime() + 86400000);
  }
  return out;
}

// ¿La fecha ISO cae a ±36 h del día YYYY-MM-DD? MP devuelve begin/end_date
// con huso (GMT-4 o Z), así que comparar el string recortado fallaba.
function cercaDia(iso, ymd) {
  if (!iso || !ymd) return false;
  const a = new Date(iso).getTime(); const b = new Date(`${ymd}T12:00:00Z`).getTime();
  if (isNaN(a) || isNaN(b)) return String(iso).slice(0, 10) === ymd;
  return Math.abs(a - b) <= 36 * 3600000;
}
function _edadMin(x, ahora) {
  const t = new Date(x && x.date_created || 0).getTime();
  return isNaN(t) ? Infinity : (ahora - t) / 60000;
}
// Elige, de la lista de informes de la cuenta, uno ya generado que sirva
// para [since, until]: el del id pendiente de un intento anterior, o uno con
// las mismas fechas creado hace poco (20 min si el tramo llega a hoy, 6 h si
// es histórico). Pura, para poder probarla.
function elegirListo(lista, since, until, pendiente, ahora = Date.now()) {
  const hoy = new Date(ahora).toISOString().slice(0, 10);
  const maxMin = until >= hoy ? 20 : 6 * 60;
  const ok = (lista || []).filter(x => x && x.file_name && (
    (pendiente && pendiente.id && String(x.id) === String(pendiente.id)) ||
    (cercaDia(x.begin_date, since) && cercaDia(x.end_date, until) && _edadMin(x, ahora) <= maxMin)));
  ok.sort((p, q) => String(q.date_created || '').localeCompare(String(p.date_created || '')));
  return ok[0] || null;
}
// Informe pedido antes y todavía sin archivo: se retoma en vez de pedir otro.
function elegirPendiente(lista, since, until, pendiente, ahora = Date.now()) {
  return (lista || []).find(x => x && !x.file_name && _edadMin(x, ahora) <= 6 * 60 && (
    (pendiente && pendiente.id && String(x.id) === String(pendiente.id)) ||
    (cercaDia(x.begin_date, since) && cercaDia(x.end_date, until)))) || null;
}
function _resumenLista(lista) {
  return (lista || []).slice()
    .sort((p, q) => String(q.date_created || '').localeCompare(String(p.date_created || '')))
    .slice(0, 6)
    .map(x => ({ id: x.id, begin_date: x.begin_date, end_date: x.end_date, file_name: x.file_name || '', status: x.status || '', created_from: x.created_from || '', date_created: x.date_created || '' }));
}

const ESPERA_MAX_MS = 5 * 60000;

async function generarYDescargar(token, since, until, pendiente) {
  const begin = `${since}T00:00:00Z`;
  // MP rechaza un end_date en el futuro: si el tramo llega a hoy, se corta ahora.
  const ahora = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  let end = `${until}T23:59:59Z`;
  if (end > ahora) end = ahora;
  if (begin >= end) return { ok: true, csv: '', file_name: '' };
  const diag = {};
  const antes = await listar(token);
  const lista0 = antes.ok ? antes.lista : [];
  const idsAntes = new Set(lista0.map(x => String(x.id || x.file_name)));

  // 1) ¿Ya hay un informe listo de un intento anterior? Se usa sin pedir otro.
  let archivo = elegirListo(lista0, since, until, pendiente);
  let reportId = null;
  if (archivo) diag.reutilizado = archivo.file_name;
  else {
    // 2) ¿Hay uno pendiente con estas fechas? Se espera ese. Si no, se pide.
    const pend = elegirPendiente(lista0, since, until, pendiente);
    if (pend) { reportId = pend.id; diag.retomado = pend.id; }
    else {
      const c = await request('POST', '/v1/account/settlement_report', token, { begin_date: begin, end_date: end });
      diag.creacion = { status: c.status, id: c.json && c.json.id, estado: c.json && c.json.status };
      if (c.status === 203) return { ok: false, error: 'Mercado Pago no pudo generar el informe para esas fechas. Intenta de nuevo en unos minutos.', detalle: detalleMP(c), diag };
      if (c.status === 400) return { ok: false, error: `Mercado Pago rechazó el informe del ${since} al ${until}. Intenta de nuevo en un minuto.`, status: 400, detalle: detalleMP(c), diag };
      if (!ok2xx(c)) return { ok: false, error: mensajeError(c), status: c.status, detalle: detalleMP(c), diag };
      reportId = c.json && c.json.id ? c.json.id : null;
    }
    // 3) Espera activa (hasta ESPERA_MAX_MS): por id si lo tenemos, si no
    //    por "informe nuevo con estas fechas".
    const t0 = Date.now();
    while (Date.now() - t0 < ESPERA_MAX_MS) {
      await dormir(5000);
      const l = await listar(token);
      if (!l.ok) continue;
      const porId = reportId ? l.lista.find(x => x && x.file_name && String(x.id) === String(reportId)) : null;
      if (porId) { archivo = porId; break; }
      const nuevos = l.lista.filter(x => x && x.file_name && !idsAntes.has(String(x.id || x.file_name)) && cercaDia(x.begin_date, since))
        .sort((p, q) => String(q.date_created || '').localeCompare(String(p.date_created || '')));
      if (nuevos.length) { archivo = nuevos[0]; break; }
    }
  }
  if (!archivo) {
    const l = await listar(token);
    diag.lista = _resumenLista(l.ok ? l.lista : []);
    return {
      ok: false,
      error: 'Mercado Pago sigue generando el informe (a veces tarda varios minutos). Vuelve a apretar "Sincronizar ahora" en un rato: la app retoma el mismo informe sin pedir otro.',
      pendiente: { id: reportId, since, until, at: new Date().toISOString() },
      diag
    };
  }

  const d = await request('GET', `/v1/account/settlement_report/${encodeURIComponent(archivo.file_name)}`, token, null, { timeout: 60000 });
  if (!ok2xx(d)) return { ok: false, error: 'No pude descargar el informe: ' + mensajeError(d), detalle: detalleMP(d), diag };
  return { ok: true, csv: d.raw || '', file_name: archivo.file_name, diag };
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
  PAYOUT:            { label: 'Retiro a banco',         signo: -1, retiro: true },
  PAYOUTS:           { label: 'Retiro a banco',         signo: -1, retiro: true }, // así viene en Chile (plural)
  WITHDRAWAL:        { label: 'Retiro a banco',         signo: -1, retiro: true },
  WITHDRAWAL_CANCEL: { label: 'Retiro cancelado',       signo: +1, retiro: true },
};

// ¿Qué es esta plata que entró? 'pago' = alguien te pagó por algo (link,
// QR, Point, checkout: una venta de tus emprendimientos). 'transferencia' =
// alguien te envió plata a tu cuenta MP (no es una venta). 'otro' = cashback,
// retiro cancelado, etc. Para lo que sale, null.
const RE_TRANSFERENCIA = /transfer|env[ií]o de dinero|dinero recibido|ingreso de dinero|money[ _-]?(in|transfer|send)|send[ _-]?money|\bp2p\b|\bcvu\b|account[ _-]?fund|dep[oó]sito/i;
// MP manda "null" como texto en varias columnas.
const vacio = (v) => { const s = String(v === undefined || v === null ? '' : v).trim(); return !s || s.toLowerCase() === 'null'; };
// Rendimientos del saldo (intereses diarios): SETTLEMENT positivo de pocos
// pesos, sin medio de pago, sin referencia, sin orden ni canal. Verificado
// con un informe real (116 filas en 3 meses, 1 a 468 pesos).
function esRendimiento(r, tipo, neto) {
  return tipo === 'SETTLEMENT' && neto > 0 && neto <= 5000
    && vacio(r.PAYMENT_METHOD_TYPE) && vacio(r.PAYMENT_METHOD)
    && vacio(r.EXTERNAL_REFERENCE) && vacio(r.ORDER_ID) && vacio(r.SUB_UNIT) && vacio(r.SEGMENT_DETAIL) && vacio(r.ISSUER_NAME);
}
function clasificar(r, tipo, def, neto) {
  if (neto <= 0) return null;
  if (tipo === 'CASHBACK' || tipo === 'WITHDRAWAL_CANCEL') return 'otro';
  if (tipo === 'REFUND') return 'otro'; // devolución que recibiste por una compra
  if (esRendimiento(r, tipo, neto)) return 'rendimiento';
  const texto = [r.DESCRIPTION, r.SUB_UNIT, r.SEGMENT_DETAIL, r.BUSINESS_UNIT, r.OPERATION_TAGS].filter(x => !vacio(x)).join(' ');
  if (RE_TRANSFERENCIA.test(texto)) return 'transferencia';
  const metodoTipo = String(r.PAYMENT_METHOD_TYPE || '').toLowerCase();
  // Un cobro (link, QR, Point, checkout) siempre trae referencia, orden o canal.
  const sinVenta = vacio(r.EXTERNAL_REFERENCE) && vacio(r.ORDER_ID) && vacio(r.POS_ID) && vacio(r.STORE_ID) && vacio(r.SUB_UNIT);
  // Plata enviada desde el saldo de otro usuario de MP, sin orden ni
  // referencia de venta: casi siempre es un envío de dinero entre personas.
  if ((metodoTipo === 'available_money' || metodoTipo === 'account_money') && sinVenta) return 'transferencia';
  // TEF sin referencia, orden, canal ni comisión: alguien te transfirió
  // desde su banco a tu cuenta MP (un cobro por transferencia trae canal).
  if (metodoTipo === 'bank_transfer' && sinVenta && !num(r.FEE_AMOUNT)) return 'transferencia';
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
    // El informe ya trae el signo correcto (verificado con datos reales): un
    // SETTLEMENT negativo es una compra tuya pagada con el saldo, un REFUND
    // positivo es una devolución que recibiste. No se fuerza el signo.
    const monto = moneda === 'CLP' ? Math.round(neto) : neto;
    if (!monto) continue;
    const fechaRaw = r.TRANSACTION_DATE || r.SETTLEMENT_DATE || '';
    const fecha = String(fechaRaw).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) continue;
    const origen = r.POI_BANK_NAME || r.POI_WALLET_NAME || r.ISSUER_NAME || '';
    const metodo = r.PAYMENT_METHOD_TYPE ? String(r.PAYMENT_METHOD_TYPE).replace(/_/g, ' ') : '';
    const detalle = !vacio(r.DESCRIPTION) ? r.DESCRIPTION : (!vacio(r.EXTERNAL_REFERENCE) ? r.EXTERNAL_REFERENCE : '');
    const canal = !vacio(r.SUB_UNIT) ? r.SUB_UNIT : (!vacio(r.BUSINESS_UNIT) ? r.BUSINESS_UNIT : '');
    const clase = clasificar(r, tipo, def, monto);
    const seg = vacio(r.SEGMENT_DETAIL) ? '' : String(r.SEGMENT_DETAIL);
    let label = def.label;
    if (clase === 'transferencia' && tipo === 'SETTLEMENT') label = 'Transferencia recibida';
    else if (clase === 'rendimiento') label = 'Rendimiento del saldo';
    else if (tipo === 'REFUND') label = monto > 0 ? 'Devolución recibida' : 'Devolución a cliente';
    else if (tipo === 'SETTLEMENT' && monto < 0) label = /transport/i.test(seg) ? 'Recarga transporte público' : 'Pago con saldo de Mercado Pago';
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
      clase,                 // 'pago' | 'transferencia' | 'rendimiento' | 'otro' | null (sale plata)
      retiro: !!def.retiro,  // retiro a tu banco (no es gasto: es traspaso)
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

// ---------- Diagnóstico local ----------
// Deja en userData (args.diagDir) un resumen de la última sincronización y
// el último informe crudo, para poder revisar qué devolvió MP cuando algo no
// cuadra. Nunca incluye el token.
function escribirDiag(dir, resumen, csv) {
  if (!dir) return;
  try {
    fs.writeFileSync(path.join(dir, 'mercadopago-ultimo-sync.json'), JSON.stringify(resumen, null, 2));
    if (csv !== undefined) fs.writeFileSync(path.join(dir, 'mercadopago-ultimo-informe.csv'), csv);
  } catch (e) { /* diagnóstico opcional */ }
}
function contar(rows, campo) {
  const c = {};
  rows.forEach(r => { const k = String(r[campo] || '(vacío)'); c[k] = (c[k] || 0) + 1; });
  return c;
}

// ---------- Sync completo ----------
// args = { token, since (YYYY-MM-DD), until?, incluirRetiros?, diagDir? }
async function sync(args) {
  const token = limpiarToken(args && args.token);
  const v = validarToken(token); if (v) return { ok: false, error: v };
  const hoy = new Date().toISOString().slice(0, 10);
  const since = String((args && args.since) || '').slice(0, 10) || new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const until = String((args && args.until) || '').slice(0, 10) || hoy;
  const diagDir = args && args.diagDir;
  const diag = { at: new Date().toISOString(), since, until, incluirRetiros: !!(args && args.incluirRetiros), tramos: [] };
  const fin = (res) => {
    escribirDiag(diagDir, Object.assign(diag, { ok: !!res.ok, error: res.error || null, detalle: res.detalle || null, status: res.status || null, pendiente: res.pendiente || null,
      filas: res.filas || 0, movimientos: res.movements ? res.movements.length : 0, vacio: !!res.vacio,
      clases: res.movements ? contar(res.movements, 'clase') : null, tiposMov: res.movements ? contar(res.movements, 'tipo') : null }), res._csv);
    delete res._csv;
    return res;
  };
  try {
    const cfg = await asegurarConfig(token);
    if (!cfg.ok) return fin(cfg);
    // Un informe por tramo de hasta MAX_DIAS_INFORME días, del más viejo al
    // más nuevo. Si uno falla, se avisa y no se marca nada como sincronizado.
    const tramos = ventanas(since, until, MAX_DIAS_INFORME);
    const rowsTodas = [];
    const csvs = [];
    let file_name = '';
    const pendiente = args && args.pendiente && typeof args.pendiente === 'object' ? args.pendiente : null;
    for (const t of tramos) {
      const pend = pendiente && pendiente.since === t.since && pendiente.until === t.until ? pendiente : null;
      const g = await generarYDescargar(token, t.since, t.until, pend);
      if (!g.ok) { diag.tramos.push({ since: t.since, until: t.until, error: g.error || 'falló', detalle: g.diag || null }); return fin(g); }
      if (g.file_name) file_name = g.file_name;
      const { headers, rows } = parseCSV(g.csv);
      diag.tramos.push({ since: t.since, until: t.until, file_name: g.file_name || '', bytes: (g.csv || '').length, filas: rows.length, headers: headers.slice(0, 40), tipos: contar(rows, 'TRANSACTION_TYPE'), metodos: contar(rows, 'PAYMENT_METHOD_TYPE'), detalle: g.diag || null });
      // Para el CSV de diagnóstico, el encabezado va una sola vez.
      csvs.push(csvs.length && headers.length ? String(g.csv || '').replace(/^[^\n]*\n?/, '') : (g.csv || ''));
      if (!headers.length) continue;
      const faltan = ['TRANSACTION_TYPE', 'TRANSACTION_DATE'].filter(k => !headers.includes(k));
      if (faltan.length) return fin({ ok: false, error: 'El informe no trae las columnas esperadas.', detalle: 'Encabezados: ' + headers.slice(0, 12).join(', '), _csv: csvs.join('\n') });
      rowsTodas.push(...rows);
    }
    if (!rowsTodas.length) return fin({ ok: true, movements: [], file_name, vacio: true, since, until, informes: tramos.length, _csv: csvs.join('\n') });
    const movements = normalizar(rowsTodas, { incluirRetiros: !!(args && args.incluirRetiros) })
      .filter(m => m.fecha >= since && m.fecha <= until);
    return fin({ ok: true, movements, file_name, filas: rowsTodas.length, since, until, informes: tramos.length, _csv: csvs.join('\n') });
  } catch (e) {
    return fin({ ok: false, error: 'No pude conectar con Mercado Pago: ' + (e.message || 'error de red') });
  }
}

module.exports = { test, sync, parseCSV, normalizar, clasificar, num, limpiarToken, ventanas, MAX_DIAS_INFORME, cercaDia, elegirListo, elegirPendiente };
