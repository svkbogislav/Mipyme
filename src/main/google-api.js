// src/main/google-api.js
// Google Ads API: OAuth2 refresh + GAQL queries.
// Maneja rotación de versiones de la API (Google deprecia cada ~6 meses) y
// expone hints accionables para errores comunes que el usuario puede arreglar
// sin tener que entender la jerga de Google Ads.

const https = require('node:https');

// Helper genérico HTTPS POST con cuerpo (JSON o form-urlencoded).
function httpsRequest(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, body: parsed });
        } catch (err) {
          resolve({ status: res.statusCode, raw: data, parseError: err.message });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    if (body) req.write(body);
    req.end();
  });
}

// Intercambia refresh_token por access_token (válido 1h).
async function oauthExchange(clientId, clientSecret, refreshToken) {
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Falta clientId, clientSecret o refreshToken para OAuth');
  }
  const body = `client_id=${encodeURIComponent(clientId)}` +
               `&client_secret=${encodeURIComponent(clientSecret)}` +
               `&refresh_token=${encodeURIComponent(refreshToken)}` +
               `&grant_type=refresh_token`;
  const r = await httpsRequest({
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
    timeout: 15000
  }, body);
  if (r.status !== 200) {
    const e = r.body || {};
    const code = e.error || '';
    const desc = e.error_description || '';
    let hint = '';
    if (code === 'invalid_grant') hint = ' · Causas comunes: refresh token caducado, app en "Testing" mode con > 7d, o el token fue revocado en https://myaccount.google.com/permissions';
    else if (code === 'invalid_client') hint = ' · Client ID o Client Secret incorrectos. Verifica en Google Cloud Console → Credentials';
    else if (code === 'unauthorized_client') hint = ' · OAuth Client mal configurado. Tipo debe ser "Desktop app"';
    throw new Error(`OAuth Google falló (HTTP ${r.status}): ${code}${desc ? ' — ' + desc : ''}${hint}`);
  }
  if (!r.body.access_token) {
    throw new Error('Sin access_token en respuesta OAuth · ' + JSON.stringify(r.body).slice(0, 200));
  }
  return r.body.access_token;
}

// Versiones a probar en orden. Cacheamos la primera que NO devuelva 404 para
// los próximos calls. Google rota versiones cada ~6 meses.
const API_VERSIONS = ['v19', 'v20', 'v18', 'v17'];
let _cachedVersion = null;

// Hints accionables que se concatenan al mensaje de error según el código que
// devuelve Google Ads. La intención es que el usuario sepa qué hacer sin tener
// que buscar la doc.
const ERROR_HINTS = {
  DEVELOPER_TOKEN_NOT_APPROVED: '→ Tu developer token está en modo Test. Andá al MCC → API Center → "Apply for Basic Access". Aprobación: 1-2 días hábiles.',
  DEVELOPER_TOKEN_PROHIBITED: '→ Tu developer token fue suspendido. Contactá a Google Ads support.',
  USER_PERMISSION_DENIED: '→ El usuario OAuth no tiene acceso a este customer. Verificá que el email logueado sea admin del MCC y/o advertiser.',
  CUSTOMER_NOT_ENABLED: '→ El customer está desactivado o cancelado.',
  NOT_ADS_USER: '→ El email de la cuenta OAuth no es un usuario de Google Ads.',
  AUTHENTICATION_ERROR: '→ Problema de autenticación. Reintentá generar el refresh_token.',
  MISSING_LOGIN_CUSTOMER_ID: '→ Falta login-customer-id. Si el customerId es de un advertiser bajo MCC, agregá el ID del MCC en login-customer-id.',
  INVALID_CUSTOMER_ID: '→ El customer ID no existe o el formato es inválido (debe ser 10 dígitos sin guiones).',
};

function formatGoogleAdsError(version, errBody, rawBody) {
  if (!errBody || !errBody.error) {
    return `HTTP: ${(rawBody || '').slice(0, 300)}`;
  }
  const e = errBody.error;
  const partes = [e.message || ''];
  // Google Ads anida errores específicos en error.details[*].errors[*]
  const subErrors = (e.details || []).flatMap(d => d.errors || []);
  let codeValSeen = '';
  if (subErrors.length > 0) {
    const codes = subErrors.map(s => {
      const codeObj = s.errorCode || {};
      const codeKey = Object.keys(codeObj)[0] || '';
      const codeVal = codeObj[codeKey] || '';
      if (codeVal) codeValSeen = codeVal;
      return [codeKey, codeVal, s.message].filter(Boolean).join(' / ');
    }).filter(Boolean);
    if (codes.length > 0) partes.push('Detalles: ' + codes.join('; '));
  }
  const reqId = (e.details || []).find(d => d.requestId)?.requestId;
  if (reqId) partes.push(`request_id=${reqId}`);
  if (codeValSeen && ERROR_HINTS[codeValSeen]) {
    partes.push(ERROR_HINTS[codeValSeen]);
  }
  return partes.filter(Boolean).join(' · ');
}

// Ejecuta una GAQL query. Si la versión cacheada falla con 404, prueba las
// otras hasta encontrar una activa.
async function query(creds, gaqlQuery) {
  const customerIdLimpio = String(creds.customerId || '').replace(/-/g, '');
  if (!customerIdLimpio) throw new Error('Customer ID inválido');
  const accessToken = await oauthExchange(creds.clientId, creds.clientSecret, creds.refreshToken);
  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'developer-token': creds.devToken,
    'Content-Type': 'application/json',
  };
  if (creds.loginCustomerId) {
    headers['login-customer-id'] = String(creds.loginCustomerId).replace(/-/g, '');
  }
  const body = JSON.stringify({ query: gaqlQuery });

  const versionsToTry = _cachedVersion
    ? [_cachedVersion, ...API_VERSIONS.filter(v => v !== _cachedVersion)]
    : API_VERSIONS;

  for (const version of versionsToTry) {
    const r = await httpsRequest({
      hostname: 'googleads.googleapis.com',
      path: `/${version}/customers/${customerIdLimpio}/googleAds:search`,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      timeout: 30000
    }, body);
    if (r.status === 404) continue; // versión deprecada, probar la siguiente
    _cachedVersion = version;
    if (r.status !== 200) {
      throw new Error(`Google Ads API (${version}): ${formatGoogleAdsError(version, r.body, r.raw)}`);
    }
    return r.body;
  }
  throw new Error(`Google Ads API: ninguna versión disponible respondió. Probadas: ${API_VERSIONS.join(', ')}. Verificá que la API esté habilitada en Cloud Console y que el customer ID sea válido.`);
}

// Test: query mínima al customer para validar todas las credenciales.
async function test(creds) {
  try {
    if (!creds || !creds.customerId || !creds.devToken || !creds.refreshToken || !creds.clientId || !creds.clientSecret) {
      return { ok: false, error: 'Faltan credenciales (customerId, devToken, refreshToken, clientId, clientSecret)' };
    }
    const result = await query(creds, 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer LIMIT 1');
    const row = (result.results && result.results[0]) || {};
    const c = row.customer || {};
    return {
      ok: true,
      customer: {
        id: c.id,
        name: c.descriptiveName,
        currency: c.currencyCode,
        timezone: c.timeZone
      }
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Fetch de spend mensual últimos 12 meses agregado por mes.
async function fetchSpend(args) {
  const creds = args && args.creds ? args.creds : args;
  try {
    if (!creds || !creds.customerId || !creds.devToken || !creds.refreshToken || !creds.clientId || !creds.clientSecret) {
      return { ok: false, error: 'Faltan credenciales' };
    }
    // GAQL no acepta LAST_365_DAYS — calculamos rango explícito.
    const hoyD = new Date();
    const desdeD = new Date(hoyD.getFullYear() - 1, hoyD.getMonth(), hoyD.getDate());
    const fmtFecha = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const sinceStr = fmtFecha(desdeD);
    const untilStr = fmtFecha(hoyD);
    const gaql = `
      SELECT
        segments.month,
        metrics.cost_micros,
        metrics.impressions,
        metrics.clicks,
        metrics.conversions
      FROM customer
      WHERE segments.date BETWEEN '${sinceStr}' AND '${untilStr}'
      ORDER BY segments.month
    `;
    const result = await query(creds, gaql);
    const rows = (result.results || []).map(r => ({
      month: (r.segments && r.segments.month || '').slice(0, 7),
      spend: Number(((r.metrics && r.metrics.costMicros) || 0)) / 1000000, // micros → unidad
      impressions: Number((r.metrics && r.metrics.impressions) || 0),
      clicks: Number((r.metrics && r.metrics.clicks) || 0),
      conversions: Number((r.metrics && r.metrics.conversions) || 0)
    }));
    // Agregar por mes (Google puede devolver múltiples rows si hay segments extras).
    const byMonth = {};
    rows.forEach(r => {
      if (!r.month) return;
      if (!byMonth[r.month]) byMonth[r.month] = { month: r.month, spend: 0, impressions: 0, clicks: 0, conversions: 0 };
      byMonth[r.month].spend += r.spend;
      byMonth[r.month].impressions += r.impressions;
      byMonth[r.month].clicks += r.clicks;
      byMonth[r.month].conversions += r.conversions;
    });
    const monthly = Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month));
    return { ok: true, monthly, fetchedAt: new Date().toISOString() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  test,
  fetchSpend,
};
