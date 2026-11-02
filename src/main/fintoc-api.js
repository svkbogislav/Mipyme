// src/main/fintoc-api.js
// Lectura de movimientos bancarios vía Fintoc (open banking Chile).
//
// Flujo soportado (v1, el documentado públicamente y sin widget embebido):
//   1. El usuario crea el Link en el Dashboard de Fintoc (Links → Crear →
//      Chile / Banking / Individual → elige banco → claves). Al terminar,
//      el Dashboard muestra el link_token UNA sola vez.
//   2. Pega la secret key y ese link_token en Configuración de la app.
//   3. La app lista las cuentas del Link y trae movimientos por cuenta.
//
// Credenciales: NUNCA hardcodeadas. Llegan por argumento desde el renderer,
// que las guarda por negocio/perfil en localStorage (mismo patrón que Meta,
// Google y LibreDTE). Nada se loguea.
//
// Endpoints (docs.fintoc.com):
//   GET /v1/links                              → prueba la secret key
//   GET /v1/accounts?link_token=…              → cuentas del Link
//   GET /v1/accounts/{id}/movements?link_token=…&since=YYYY-MM-DD&per_page=300&page=N
//        amount: entero en pesos, NEGATIVO para cargos (salidas).
//        post_date: fecha en que el banco consolidó. Paginación: header Link rel="next".
// Auth: header `Authorization: <secret key>` (sin "Bearer").

const https = require('node:https');

const HOST = 'api.fintoc.com';

function getJSON(path, secretKey, { timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: HOST,
      path,
      method: 'GET',
      timeout,
      headers: {
        'Authorization': String(secretKey || '').trim(),
        'Accept': 'application/json',
        'User-Agent': 'Mipyme/1.0 (+electron)',
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch (e) { json = null; }
        resolve({ status: res.statusCode || 0, headers: res.headers || {}, json, raw: data });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.end();
  });
}

// Traduce errores HTTP a mensajes que el usuario entienda (sin jerga).
function mensajeError(status, json) {
  const detalle = json && json.error && (json.error.message || json.error.type);
  if (status === 401 || status === 403) return 'La secret key no es válida o no tiene permisos.';
  if (status === 404) return 'No encontré ese Link: el link_token no es válido o ya no existe.';
  if (status === 422) return 'Fintoc rechazó la consulta' + (detalle ? `: ${detalle}` : '') + '.';
  if (status === 429) return 'Fintoc limitó las consultas por un momento. Intenta de nuevo en unos minutos.';
  if (status >= 500) return 'Fintoc tuvo un problema temporal. Intenta de nuevo más tarde.';
  return 'No pude conectar con Fintoc' + (detalle ? `: ${detalle}` : '') + '.';
}

// No imponemos un prefijo: el formato de las llaves lo decide Fintoc y la
// API responde 401 si no sirve. Solo atajamos el error clásico de pegar la
// public key (pk_…) en vez de la secret key.
function validarSK(sk) {
  const s = String(sk || '').trim();
  if (!s) return 'Falta la secret key.';
  if (/^pk_/i.test(s)) return 'Esa es la public key (pk_…). Necesitas la secret key, que está en el Dashboard de Fintoc → API Keys.';
  if (s.length < 12) return 'La secret key parece incompleta.';
  return null;
}
function esModoTest(sk) {
  return /test|sandbox/i.test(String(sk || ''));
}

// Prueba la secret key listando los Links de la cuenta Fintoc.
async function test(creds) {
  const sk = creds && creds.sk;
  const v = validarSK(sk); if (v) return { ok: false, error: v };
  try {
    const r = await getJSON('/v1/links', sk);
    if (r.status < 200 || r.status >= 300) return { ok: false, error: mensajeError(r.status, r.json) };
    const links = Array.isArray(r.json) ? r.json : [];
    return {
      ok: true,
      modo: esModoTest(sk) ? 'test' : 'live',
      links: links.map(l => ({
        id: l.id,
        institution: l.institution && l.institution.name,
        status: l.status,
        holder_type: l.holder_type,
      })),
    };
  } catch (e) {
    return { ok: false, error: 'No pude conectar con Fintoc: ' + (e.message || 'error de red') };
  }
}

// Cuentas de un Link (necesita link_token).
async function accounts(args) {
  const sk = args && args.sk, linkToken = String((args && args.linkToken) || '').trim();
  const v = validarSK(sk); if (v) return { ok: false, error: v };
  if (!linkToken) return { ok: false, error: 'Falta el link_token.' };
  try {
    const r = await getJSON(`/v1/accounts?link_token=${encodeURIComponent(linkToken)}`, sk);
    if (r.status < 200 || r.status >= 300) return { ok: false, error: mensajeError(r.status, r.json) };
    const list = Array.isArray(r.json) ? r.json : [];
    return {
      ok: true,
      accounts: list.map(a => ({
        id: a.id,
        name: a.name || a.official_name || 'Cuenta',
        official_name: a.official_name || '',
        number: a.number || '',
        type: a.type || '',
        currency: a.currency || 'CLP',
        balance: (a.balance && (a.balance.available != null ? a.balance.available : a.balance.current)) || 0,
        refreshed_at: a.refreshed_at || null,
      })),
    };
  } catch (e) {
    return { ok: false, error: 'No pude conectar con Fintoc: ' + (e.message || 'error de red') };
  }
}

// Lee el header Link y devuelve true si hay página siguiente.
function haySiguiente(headers) {
  const link = headers && (headers.link || headers.Link);
  if (!link) return false;
  return /rel="next"/.test(String(link));
}

// Movimientos de una cuenta desde `since` (YYYY-MM-DD). Pagina hasta agotar
// (cap de 40 páginas × 300 = 12.000 movimientos, más que suficiente).
async function movements(args) {
  const sk = args && args.sk;
  const linkToken = String((args && args.linkToken) || '').trim();
  const accountId = String((args && args.accountId) || '').trim();
  const since = String((args && args.since) || '').slice(0, 10);
  const until = String((args && args.until) || '').slice(0, 10);
  const v = validarSK(sk); if (v) return { ok: false, error: v };
  if (!linkToken) return { ok: false, error: 'Falta el link_token.' };
  if (!accountId) return { ok: false, error: 'Falta la cuenta.' };
  const out = [];
  try {
    for (let page = 1; page <= 40; page++) {
      const qs = [
        `link_token=${encodeURIComponent(linkToken)}`,
        'per_page=300',
        `page=${page}`,
        since ? `since=${encodeURIComponent(since)}` : '',
        until ? `until=${encodeURIComponent(until)}` : '',
      ].filter(Boolean).join('&');
      const r = await getJSON(`/v1/accounts/${encodeURIComponent(accountId)}/movements?${qs}`, sk);
      if (r.status < 200 || r.status >= 300) return { ok: false, error: mensajeError(r.status, r.json), movements: out };
      const list = Array.isArray(r.json) ? r.json : [];
      for (const m of list) {
        if (m.status && m.status !== 'confirmed') continue;
        if (m.pending) continue;
        out.push({
          id: m.id,
          amount: Number(m.amount || 0),
          currency: m.currency || 'CLP',
          description: String(m.description || '').trim(),
          comment: m.comment ? String(m.comment).trim() : '',
          post_date: String(m.post_date || '').slice(0, 10),
          transaction_date: m.transaction_date ? String(m.transaction_date).slice(0, 10) : null,
          type: m.type || 'other',
          reference_id: m.reference_id || null,
        });
      }
      if (list.length < 300 && !haySiguiente(r.headers)) break;
      if (!haySiguiente(r.headers)) break;
    }
    return { ok: true, movements: out };
  } catch (e) {
    return { ok: false, error: 'No pude conectar con Fintoc: ' + (e.message || 'error de red'), movements: out };
  }
}

module.exports = { test, accounts, movements };
