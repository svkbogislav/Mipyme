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
const zlib = require('node:zlib');
const MpRetiros = require('../renderer/domain/mp-retiros');

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

function request(method, path, token, body, { timeout = 30000, accept } = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: HOST,
      path,
      method,
      timeout,
      headers: {
        'Authorization': 'Bearer ' + String(token || '').trim(),
        'Accept': accept || 'application/json, text/csv;q=0.9, */*;q=0.5',
        'User-Agent': 'Mipyme/1.0 (+electron)',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const raw = buffer.toString('utf8');
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (e) { json = null; }
        resolve({ status: res.statusCode || 0, headers: res.headers || {}, json, raw, buffer });
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

// Mercado Pago informa la hora en −04:00 y Chile en verano está en −03:00:
// lo que pasa entre las 00:00 y la 01:00 caía en el día anterior. La fecha
// del movimiento es la de Santiago.
function fechaChile(raw) {
  const s = String(raw || '');
  const d = new Date(s);
  if (!/T\d{2}:\d{2}/.test(s) || isNaN(d.getTime())) return s.slice(0, 10);
  try {
    const f = d.toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
    return /^\d{4}-\d{2}-\d{2}$/.test(f) ? f : s.slice(0, 10);
  } catch (e) { return s.slice(0, 10); }
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
    const fechaId = String(fechaRaw).slice(0, 10); // solo para el id (no cambia entre versiones)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaId)) continue;
    const fecha = fechaChile(fechaRaw);
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
    const id = `mp_${r.SOURCE_ID || r.EXTERNAL_REFERENCE || fechaId}_${tipo}_${Math.abs(monto)}`;
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

// ---------- Saldo de la cuenta ----------
// Saldo real de la cuenta de Mercado Pago (disponible + a liberar). Usa el
// endpoint de cuenta del usuario; si no está disponible para esta cuenta,
// la app sigue con el saldo calculado a partir de los movimientos.
async function saldo(token) {
  try {
    const me = await request('GET', '/users/me', token);
    if (!ok2xx(me) || !me.json || !me.json.id) return { ok: false, error: mensajeError(me), status: me.status };
    const r = await request('GET', `/users/${encodeURIComponent(me.json.id)}/mercadopago_account/balance`, token);
    if (!ok2xx(r) || !r.json || typeof r.json !== 'object') return { ok: false, error: mensajeError(r), status: r.status };
    const j = r.json;
    const n = (v) => (v === undefined || v === null || v === '' || isNaN(Number(v))) ? null : Number(v);
    const disponible = n(j.available_balance), aLiberar = n(j.unavailable_balance), total = n(j.total_amount);
    const suma = (disponible !== null || aLiberar !== null) ? (disponible || 0) + (aLiberar || 0) : null;
    const saldoTotal = total !== null ? total : suma;
    if (saldoTotal === null) return { ok: false, error: 'Mercado Pago no informó el saldo.' };
    return { ok: true, total: Math.round(saldoTotal), disponible: disponible === null ? null : Math.round(disponible), a_liberar: aLiberar === null ? null : Math.round(aLiberar), moneda: j.currency_id || 'CLP' };
  } catch (e) {
    return { ok: false, error: 'No pude conectar con Mercado Pago: ' + (e.message || 'error de red') };
  }
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
    if (!rowsTodas.length) { const saldoMP = await saldo(token); return fin({ ok: true, movements: [], file_name, vacio: true, since, until, informes: tramos.length, saldoMP, _csv: csvs.join('\n') }); }
    const movements = normalizar(rowsTodas, { incluirRetiros: !!(args && args.incluirRetiros) })
      .filter(m => m.fecha >= since && m.fecha <= until);
    const saldoMP = await saldo(token);
    diag.saldo = saldoMP.ok ? { total: saldoMP.total, disponible: saldoMP.disponible, a_liberar: saldoMP.a_liberar } : { error: saldoMP.error || null, status: saldoMP.status || null };
    return fin({ ok: true, movements, file_name, filas: rowsTodas.length, since, until, informes: tramos.length, saldoMP, _csv: csvs.join('\n') });
  } catch (e) {
    return fin({ ok: false, error: 'No pude conectar con Mercado Pago: ' + (e.message || 'error de red') });
  }
}

// ---------- Informe de retiros (activities_withdraw) ----------
// El informe "Todas las transacciones" dice que hubo un retiro (PAYOUTS) pero
// no a qué banco fue. El informe de actividades "Retiros" sí trae la cuenta
// de destino (bank_account). Flujo (docs: mercadopago.cl/developers →
// Reportes → Otras operaciones → Crear reporte a través de la API):
//   1. GET /v1/reporting/operations/activities_withdraw/config → columnas
//      (structure.columns[].key). Si falta alguna, PUT …/config/{structure.id}.
//      Si no hay configuración, POST con structure + un notificador (la doc
//      pide al menos uno; internal_sftp es el único sin servidor propio).
//   2. POST …/statements {filters:{creation_date:{range:{gte,lte}}}} → record_id
//      (fechas ISO 8601 con desfase; máximo un año por informe).
//   3. GET …/statements/{uid} → status pending | available | failed | empty.
//   4. GET …/statements/{uid}/download → CSV (los grandes vienen en .zip).
// La referencia detallada de estos endpoints no está publicada, así que la
// lectura de respuestas es tolerante (objeto / lista / {results}) y cada
// intento queda en el diagnóstico local. Si la cuenta no tiene este informe
// (403/404) se devuelve { ok:false, error } y la app sigue con la lógica de
// siempre (retiro sin cuenta de destino).
const RETIROS_BASE = '/v1/reporting/operations/activities_withdraw';
const RETIROS_COLUMNAS = ['date_created', 'operation_id', 'status', 'operation_type', 'transaction_amount', 'net_received_amount', 'counterpart_name', 'bank_account'];
const RETIROS_ESPERA_MAX_MS = 4 * 60000;

function errorRetiros(r, que) {
  const s = r && r.status;
  if (s === 401 || s === 403 || s === 404) return 'Mercado Pago no tiene disponible el informe de retiros para esta cuenta.';
  return `No pude ${que || 'pedir el informe de retiros a Mercado Pago'}: ` + mensajeError(r);
}
// La configuración puede venir como objeto, lista o {results:[…]}.
function _configRetirosDe(json) {
  const lista = Array.isArray(json) ? json
    : (json && Array.isArray(json.results)) ? json.results
      : (json && Array.isArray(json.configs)) ? json.configs
        : json ? [json] : [];
  for (const it of lista) {
    if (!it || typeof it !== 'object') continue;
    const st = it.structure && typeof it.structure === 'object' ? it.structure : (Array.isArray(it.columns) ? it : null);
    if (st && Array.isArray(st.columns)) return { structure: st, notifiers: Array.isArray(it.notifiers) ? it.notifiers : [] };
  }
  return null;
}
function _keysColumnas(st) {
  return ((st && st.columns) || []).map(c => String((c && typeof c === 'object') ? (c.key || c.name || '') : (c || '')).toLowerCase()).filter(Boolean);
}
async function asegurarConfigRetiros(token) {
  const g = await request('GET', `${RETIROS_BASE}/config`, token);
  if (g.status === 401 || g.status === 403) return { ok: false, error: errorRetiros(g), status: g.status, detalle: detalleMP(g) };
  const actual = ok2xx(g) ? _configRetirosDe(g.json) : null;
  const keys = actual ? _keysColumnas(actual.structure) : [];
  const faltan = RETIROS_COLUMNAS.filter(k => !keys.includes(k));
  if (actual && !faltan.length) return { ok: true, creado: false };
  const columns = Array.from(new Set([...keys, ...RETIROS_COLUMNAS])).map(key => ({ key }));
  let r;
  if (actual && actual.structure.id) {
    const st = actual.structure;
    const structure = { name: st.name || 'mipyme-retiros', columns };
    if (st.file_format) structure.file_format = st.file_format;
    if (st.display_timezone) structure.display_timezone = st.display_timezone;
    const ruta = `${RETIROS_BASE}/config/${encodeURIComponent(st.id)}`;
    r = await request('PUT', ruta, token, { structure, notifiers: actual.notifiers });
    if (!ok2xx(r)) r = await request('PUT', ruta, token, { structure });
  } else {
    const structure = { name: 'mipyme-retiros', columns };
    r = await request('POST', `${RETIROS_BASE}/config`, token, { structure, notifiers: [{ type: 'internal_sftp', data: {} }] });
    if (!ok2xx(r)) r = await request('POST', `${RETIROS_BASE}/config`, token, { structure, notifiers: [] });
    if (!ok2xx(r)) r = await request('POST', `${RETIROS_BASE}/config`, token, { structure });
  }
  const cuerpo = (x) => x ? { status: x.status, body: String(x.raw || (x.json ? JSON.stringify(x.json) : '') || '').slice(0, 1200) } : null;
  if (!ok2xx(r)) return { ok: false, error: errorRetiros(r, 'preparar el informe de retiros en Mercado Pago'), status: r.status, detalle: detalleMP(r), raw: { get: cuerpo(g), post: cuerpo(r), columns } };
  return { ok: true, creado: !actual, raw: { get: cuerpo(g), post: cuerpo(r) } };
}

// Lista de informes: lista directa o {results|statements|data|items:[…]}.
function _itemsLista(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  for (const k of ['results', 'statements', 'data', 'items']) if (Array.isArray(json[k])) return json[k];
  return [];
}
const _idInforme = (x) => (x && typeof x === 'object' && (x.record_id || x.statement_id || x.id || x.uid)) || null;
const _creadoInforme = (x) => (x && (x.date_created || x.created_at || x.creation_date || x.date_requested)) || '';
function _rangoInforme(x) {
  const f = x && x.filters && x.filters.creation_date && x.filters.creation_date.range;
  return { gte: String((f && f.gte) || x.begin_date || x.date_from || ''), lte: String((f && f.lte) || x.end_date || x.date_to || '') };
}
// Informe de retiros ya generado que cubra [since, until] y sea reciente
// (20 min si llega a hoy, 6 h si es histórico). Pura, para poder probarla.
function elegirInformeRetiros(lista, since, until, ahora = Date.now()) {
  const hoy = new Date(ahora).toISOString().slice(0, 10);
  const maxMin = until >= hoy ? 20 : 6 * 60;
  return _itemsLista(lista)
    .filter(x => x && _idInforme(x) && String(x.status || '').toLowerCase() === 'available')
    .filter(x => { const r = _rangoInforme(x); return cercaDia(r.gte, since) && cercaDia(r.lte, until) && _edadMin({ date_created: _creadoInforme(x) }, ahora) <= maxMin; })
    .sort((p, q) => String(_creadoInforme(q)).localeCompare(String(_creadoInforme(p))))[0] || null;
}
// Ahora, escrito con desfase -04:00 (hora de Chile continental).
function _ahoraDesfase() {
  return new Date(Date.now() - 4 * 3600000).toISOString().replace(/\.\d{3}Z$/, '-04:00');
}

// Lector mínimo de .zip (directorio central → entradas; sin cifrado).
function leerZip(buf) {
  const out = [];
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return out;
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < n && p + 46 <= buf.length; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const metodo = buf.readUInt16LE(p + 10);
    const tam = buf.readUInt32LE(p + 20);
    const nLen = buf.readUInt16LE(p + 28), eLen = buf.readUInt16LE(p + 30), cLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const nombre = buf.toString('utf8', p + 46, p + 46 + nLen);
    p += 46 + nLen + eLen + cLen;
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) continue;
    const ini = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const datos = buf.subarray(ini, ini + tam);
    try { out.push({ nombre, datos: metodo === 8 ? zlib.inflateRawSync(datos) : Buffer.from(datos) }); }
    catch (e) { /* entrada ilegible: se omite */ }
  }
  return out;
}
// Lee el cuerpo de la descarga: CSV directo, .zip con el CSV adentro, o un
// JSON que apunta al archivo. Devuelve { csv, formato, url?, archivo? }.
function extraerCSVDescarga(buffer, headers) {
  if (!buffer || !buffer.length) return { csv: '', formato: 'vacio' };
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    const entradas = leerZip(buffer);
    const csv = entradas.find(e => /\.csv$/i.test(e.nombre)) || entradas.find(e => /\.(txt|tsv)$/i.test(e.nombre));
    if (csv) return { csv: csv.datos.toString('utf8'), formato: 'zip' };
    if (entradas.some(e => /content_types|^xl\//i.test(e.nombre))) return { csv: '', formato: 'xlsx' };
    return { csv: '', formato: entradas.length ? 'zip-sin-csv' : 'zip-ilegible' };
  }
  const texto = buffer.toString('utf8');
  const tipo = String((headers && headers['content-type']) || '');
  if (/json/i.test(tipo) || /^\s*[\[{]/.test(texto)) {
    let j = null; try { j = JSON.parse(texto); } catch (e) { j = null; }
    if (j && typeof j === 'object') {
      const f0 = Array.isArray(j.files) && j.files[0] && typeof j.files[0] === 'object' ? j.files[0] : null;
      const url = j.url || j.download_url || j.file_url || (j.file && j.file.url) || (f0 && (f0.url || f0.download_url)) || '';
      const archivo = (f0 && f0.name) || j.file_name || j.name || '';
      return { csv: '', formato: 'json', url: String(url || ''), archivo: String(archivo || '') };
    }
  }
  return { csv: texto, formato: 'csv' };
}
// GET a una URL absoluta (archivo que MP deja en otro host). El token va
// solo si el host es el de la API.
function descargarUrl(url, token) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch (e) { return reject(new Error('URL inválida')); }
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET', timeout: 60000,
      headers: {
        'Accept': 'text/csv, application/zip, */*;q=0.5', 'User-Agent': 'Mipyme/1.0 (+electron)',
        ...(u.hostname === HOST ? { 'Authorization': 'Bearer ' + token } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { const buffer = Buffer.concat(chunks); resolve({ status: res.statusCode || 0, headers: res.headers || {}, buffer, raw: buffer.toString('utf8'), json: null }); });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.end();
  });
}
async function _esperarInformeRetiros(token, uid, diag) {
  const t0 = Date.now();
  let ultimo = null;
  diag.estados = [];
  while (Date.now() - t0 < RETIROS_ESPERA_MAX_MS) {
    const s = await request('GET', `${RETIROS_BASE}/statements/${encodeURIComponent(uid)}`, token);
    ultimo = s;
    const j = (s.json && typeof s.json === 'object') ? ((s.json.data && typeof s.json.data === 'object') ? s.json.data : s.json) : {};
    const estado = String(j.status || '').toLowerCase();
    if (diag.estados.length < 40) diag.estados.push(estado || String(s.status));
    if (ok2xx(s) && (estado === 'available' || estado === 'empty')) return { ok: true, estado };
    if (ok2xx(s) && (estado === 'failed' || estado === 'error')) return { ok: false, error: 'Mercado Pago no pudo generar el informe de retiros. Intenta de nuevo más tarde.', detalle: detalleMP(s) };
    if (!ok2xx(s) && s.status !== 404 && s.status !== 429 && s.status < 500) return { ok: false, error: errorRetiros(s, 'consultar el informe de retiros'), status: s.status, detalle: detalleMP(s) };
    await dormir(4000);
  }
  return { ok: false, error: 'Mercado Pago sigue generando el informe de retiros. La próxima sincronización lo retoma.', detalle: detalleMP(ultimo) };
}
async function _descargarInformeRetiros(token, uid, diag) {
  const base = `${RETIROS_BASE}/statements/${encodeURIComponent(uid)}/download`;
  const accept = 'text/csv, application/zip, application/octet-stream, application/json;q=0.8, */*;q=0.5';
  const intentos = [base, `${base}?format=csv`, `${base}?file_type=csv`];
  diag.descargas = [];
  for (let i = 0; i < intentos.length; i++) {
    let d = await request('GET', intentos[i], token, null, { timeout: 60000, accept });
    if ([301, 302, 303, 307, 308].includes(d.status) && d.headers.location) {
      try { d = await descargarUrl(String(d.headers.location), token); }
      catch (e) { d = { status: 0, headers: {}, buffer: Buffer.alloc(0), raw: '', json: null }; }
    }
    const reg = { ruta: intentos[i].slice(RETIROS_BASE.length), status: d.status, tipo: String(d.headers['content-type'] || ''), bytes: d.buffer ? d.buffer.length : 0 };
    diag.descargas.push(reg);
    if (!ok2xx(d)) { reg.detalle = detalleMP(d); continue; }
    const ex = extraerCSVDescarga(d.buffer, d.headers);
    reg.formato = ex.formato;
    if (ex.csv) return { ok: true, csv: ex.csv };
    if (ex.formato === 'vacio') return { ok: true, csv: '' };
    if (ex.formato === 'json' && ex.url) {
      let f = null; try { f = await descargarUrl(ex.url, token); } catch (e) { f = null; }
      if (f && ok2xx(f)) { const ex2 = extraerCSVDescarga(f.buffer, f.headers); reg.url = ex2.formato; if (ex2.csv) return { ok: true, csv: ex2.csv }; }
    }
    if (ex.formato === 'json' && ex.archivo) {
      const conNombre = `${base}?file_name=${encodeURIComponent(ex.archivo)}`;
      if (!intentos.includes(conNombre)) intentos.push(conNombre);
    }
  }
  const primero = diag.descargas[0] || {};
  return { ok: false, error: 'No pude leer el archivo del informe de retiros de Mercado Pago.', status: primero.status || null, detalle: [primero.status, primero.tipo, primero.formato, primero.detalle].filter(Boolean).join(' · ') };
}

// ---------- CSV del informe de retiros ----------
function _colRetiro(headers, candidatos) {
  for (const c of candidatos) { const h = headers.find(x => x === c); if (h) return h; }
  for (const c of candidatos) { const h = headers.find(x => x.includes(c)); if (h) return h; }
  return null;
}
function _fechaRetiro(v) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})[\/-](\d{2})[\/-](\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return '';
}
// Filas del CSV → [{ fecha, monto, neto, bank_account, ultimos4, banco,
// counterpart_name, operation_id, estado, tipo }]. Las cabeceras pueden venir
// como las claves (date_created…) o traducidas; se buscan por nombre parecido.
function normalizarRetiros(rows, headers) {
  headers = headers && headers.length ? headers : Object.keys(rows[0] || {});
  const cFecha = _colRetiro(headers, ['DATE_CREATED', 'FECHA_DE_CREACI_N', 'FECHA', 'DATE']);
  const cMonto = _colRetiro(headers, ['TRANSACTION_AMOUNT', 'MONTO_BRUTO', 'MONTO', 'AMOUNT']);
  const cNeto = _colRetiro(headers, ['NET_RECEIVED_AMOUNT', 'MONTO_NETO', 'NETO']);
  const cBanco = _colRetiro(headers, ['BANK_ACCOUNT', 'CUENTA_BANCARIA', 'CUENTA', 'BANK']);
  const cNombre = _colRetiro(headers, ['COUNTERPART_NAME', 'CONTRAPARTE', 'NOMBRE']);
  const cId = _colRetiro(headers, ['OPERATION_ID', 'ID_DE_OPERACI_N', 'ID_OPERACI_N', 'OPERATION', 'ID']);
  const cEstado = _colRetiro(headers, ['STATUS', 'ESTADO']);
  const cTipo = _colRetiro(headers, ['OPERATION_TYPE', 'TIPO']);
  const texto = (col, r) => (col && !vacio(r[col])) ? String(r[col]).trim() : '';
  const out = [];
  for (const r of rows) {
    const fecha = _fechaRetiro(cFecha ? r[cFecha] : '');
    if (!fecha) continue;
    const estado = texto(cEstado, r).toLowerCase();
    if (/reject|cancel|rechaz|anul/.test(estado)) continue;
    const monto = Math.abs(Math.round(num(cMonto ? r[cMonto] : 0)));
    const neto = Math.abs(Math.round(num(cNeto ? r[cNeto] : 0)));
    if (!monto && !neto) continue;
    const bank_account = texto(cBanco, r);
    out.push({
      fecha, monto: monto || neto, neto: neto || monto, bank_account,
      ultimos4: MpRetiros.ultimos4Cuenta(bank_account), banco: MpRetiros.bancoClave(bank_account),
      counterpart_name: texto(cNombre, r).slice(0, 120),
      operation_id: texto(cId, r),
      estado, tipo: texto(cTipo, r),
    });
  }
  return out;
}

// args = { token, since (YYYY-MM-DD), until?, diagDir? }
// → { ok:true, retiros:[…], filas, since, until } | { ok:false, error, detalle? }
async function retiros(args) {
  const token = limpiarToken(args && args.token);
  const v = validarToken(token); if (v) return { ok: false, error: v };
  const hoy = new Date().toISOString().slice(0, 10);
  let since = String((args && args.since) || '').slice(0, 10) || new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  let until = String((args && args.until) || '').slice(0, 10) || hoy;
  if (until > hoy) until = hoy;
  // MP acepta hasta un año por informe.
  const minSince = new Date(new Date(`${until}T00:00:00Z`).getTime() - 360 * 86400000).toISOString().slice(0, 10);
  if (since < minSince) since = minSince;
  if (since > until) since = until;
  const diagDir = args && args.diagDir;
  const diag = { at: new Date().toISOString(), since, until };
  const fin = (res, csv) => {
    if (diagDir) {
      try {
        fs.writeFileSync(path.join(diagDir, 'mercadopago-retiros-ultimo.json'), JSON.stringify(Object.assign(diag, {
          ok: !!res.ok, error: res.error || null, detalle: res.detalle || null, status: res.status || null,
          filas: res.filas || 0, retiros: res.retiros ? res.retiros.length : 0, conBanco: res.retiros ? res.retiros.filter(r => r.ultimos4).length : 0,
        }), null, 2));
        if (csv !== undefined) fs.writeFileSync(path.join(diagDir, 'mercadopago-retiros-ultimo.csv'), csv);
      } catch (e) { /* diagnóstico opcional */ }
    }
    return res;
  };
  try {
    const cfg = await asegurarConfigRetiros(token);
    diag.config = { ok: cfg.ok, creado: !!cfg.creado, status: cfg.status || null, raw: cfg.raw || null };
    if (!cfg.ok) return fin(cfg);
    const gte = `${since}T00:00:00-04:00`;
    let lte = `${until}T23:59:59-04:00`;
    const ahora = _ahoraDesfase();
    if (lte > ahora) lte = ahora;

    // 1) ¿Ya hay uno listo con estas fechas? Se reutiliza sin pedir otro.
    let d = null;
    const l = await request('GET', `${RETIROS_BASE}/statements`, token);
    const listo = ok2xx(l) ? elegirInformeRetiros(l.json, since, until) : null;
    if (listo) {
      diag.reutilizado = _idInforme(listo);
      d = await _descargarInformeRetiros(token, _idInforme(listo), diag);
      if (!d.ok) diag.reutilizadoFallo = d.error;
    }
    // 2) Si no, se pide, se espera y se descarga.
    if (!d || !d.ok) {
      const c = await request('POST', `${RETIROS_BASE}/statements`, token, { filters: { creation_date: { range: { gte, lte } } } });
      const cj = (c.json && typeof c.json === 'object') ? c.json : {};
      diag.creacion = { status: c.status, estado: cj.status || null };
      if (!ok2xx(c)) return fin({ ok: false, error: errorRetiros(c), status: c.status, detalle: detalleMP(c) });
      const uid = _idInforme(cj) || _idInforme(cj.data);
      if (!uid) return fin({ ok: false, error: 'Mercado Pago no devolvió el identificador del informe de retiros.', detalle: detalleMP(c) });
      diag.uid = uid;
      const e = await _esperarInformeRetiros(token, uid, diag);
      if (!e.ok) return fin(e);
      if (e.estado === 'empty') return fin({ ok: true, retiros: [], filas: 0, vacio: true, since, until }, '');
      d = await _descargarInformeRetiros(token, uid, diag);
      if (!d.ok) return fin(d);
    }
    const { headers, rows } = parseCSV(d.csv);
    diag.headers = headers.slice(0, 30);
    const lista = normalizarRetiros(rows, headers);
    return fin({ ok: true, retiros: lista, filas: rows.length, since, until, vacio: !rows.length }, d.csv);
  } catch (e) {
    return fin({ ok: false, error: 'No pude conectar con Mercado Pago: ' + (e.message || 'error de red') });
  }
}

module.exports = { test, sync, saldo, retiros, parseCSV, normalizar, normalizarRetiros, clasificar, num, limpiarToken, ventanas, MAX_DIAS_INFORME, cercaDia, elegirListo, elegirPendiente, elegirInformeRetiros, leerZip, extraerCSVDescarga, RETIROS_COLUMNAS };
