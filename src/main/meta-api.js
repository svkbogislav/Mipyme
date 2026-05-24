// src/main/meta-api.js
// Meta Graph API: test de cuenta y fetch de ad spend mensual.
// Requiere un long-lived access token (~60 días); en el dashboard explicamos
// al usuario cómo conseguirlo.

const https = require('node:https');

function metaGraphRequest(pathAndQuery) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'graph.facebook.com',
      path: pathAndQuery,
      method: 'GET',
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(`Meta API: ${parsed.error.message} (code ${parsed.error.code})`));
          } else {
            resolve(parsed);
          }
        } catch (err) {
          reject(new Error('Parse error: ' + err.message + ' · raw: ' + data.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.end();
  });
}

// Normaliza el adAccountId (puede venir con o sin prefijo "act_").
function normalizarAccId(id) {
  return String(id).startsWith('act_') ? id : `act_${id}`;
}

// Test rápido: pide info básica de la cuenta. Una sola llamada.
async function test(creds) {
  try {
    if (!creds || !creds.adAccountId || !creds.accessToken) {
      return { ok: false, error: 'Faltan adAccountId o accessToken' };
    }
    const accId = normalizarAccId(creds.adAccountId);
    const apiVersion = creds.apiVersion || 'v19.0';
    const path = `/${apiVersion}/${accId}?fields=name,account_status,currency,timezone_name,amount_spent` +
                 `&access_token=${encodeURIComponent(creds.accessToken)}`;
    const data = await metaGraphRequest(path);
    return { ok: true, account: data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Fetch de spend mensual agregado para los últimos `meses` meses (default 12).
// Devuelve { ok, monthly: [{month, spend, impressions, clicks, reach, conversions}], fetchedAt }
async function fetchSpend(args) {
  const creds = args && args.creds ? args.creds : args;
  const meses = (args && args.meses) || 12;
  try {
    if (!creds || !creds.adAccountId || !creds.accessToken) {
      return { ok: false, error: 'Faltan credenciales' };
    }
    const accId = normalizarAccId(creds.adAccountId);
    const apiVersion = creds.apiVersion || 'v19.0';
    const hoy = new Date();
    const desde = new Date(hoy.getFullYear(), hoy.getMonth() - meses + 1, 1);
    const fmtFecha = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const since = fmtFecha(desde);
    const until = fmtFecha(hoy);
    const fields = 'spend,impressions,clicks,reach,actions,date_start,date_stop';
    const path = `/${apiVersion}/${accId}/insights` +
      `?fields=${fields}` +
      `&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}` +
      `&time_increment=monthly` +
      `&access_token=${encodeURIComponent(creds.accessToken)}`;
    const data = await metaGraphRequest(path);
    const rows = (data.data || []).map(r => ({
      month: (r.date_start || '').slice(0, 7),
      date_start: r.date_start,
      date_stop: r.date_stop,
      spend: Number(r.spend || 0),
      impressions: Number(r.impressions || 0),
      clicks: Number(r.clicks || 0),
      reach: Number(r.reach || 0),
      // Conversiones se extraen de "actions" buscando purchase/lead/registration.
      conversions: ((r.actions || []).find(a => /purchase|lead|complete_registration/i.test(a.action_type)) || {}).value || 0
    }));
    return { ok: true, monthly: rows, fetchedAt: new Date().toISOString() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Lista de campañas con su daily_budget actual + spend de los últimos 30 días
// por campaña. Útil para recomendar presupuestos por campaña.
//
// Meta API:
//   - Daily/lifetime budgets vienen en /campaigns como CENTAVOS (string).
//     Si están a nivel de ad set (CBO desactivado), el campaign.daily_budget
//     es null → en ese caso el budget vive en cada adset, requiere otra call.
//     Por ahora reportamos lo que devuelva el campaign-level.
//   - Currency del account: necesario para interpretar los centavos.
async function fetchCampaigns(args) {
  const creds = args && args.creds ? args.creds : args;
  try {
    if (!creds || !creds.adAccountId || !creds.accessToken) {
      return { ok: false, error: 'Faltan credenciales' };
    }
    const accId = normalizarAccId(creds.adAccountId);
    const apiVersion = creds.apiVersion || 'v19.0';

    // 1) Currency del account
    let currency = 'USD';
    try {
      const acct = await metaGraphRequest(
        `/${apiVersion}/${accId}?fields=currency&access_token=${encodeURIComponent(creds.accessToken)}`
      );
      if (acct && acct.currency) currency = acct.currency;
    } catch (_) {}

    // 2) Campañas con sus presupuestos
    const fields = 'id,name,status,daily_budget,lifetime_budget,objective,start_time,stop_time';
    const campsPath = `/${apiVersion}/${accId}/campaigns` +
      `?fields=${fields}` +
      `&limit=200` +
      `&access_token=${encodeURIComponent(creds.accessToken)}`;
    const camps = await metaGraphRequest(campsPath);
    const campaignsRaw = (camps && camps.data) || [];

    // 3) Spend últimos 30 días por campaña (un solo call con level=campaign)
    const spendByCampaign = {};
    try {
      const hoy = new Date();
      const desde = new Date(hoy); desde.setDate(hoy.getDate() - 29);
      const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const insPath = `/${apiVersion}/${accId}/insights` +
        `?level=campaign` +
        `&fields=campaign_id,spend,impressions,clicks` +
        `&time_range=${encodeURIComponent(JSON.stringify({ since: fmt(desde), until: fmt(hoy) }))}` +
        `&limit=500` +
        `&access_token=${encodeURIComponent(creds.accessToken)}`;
      const ins = await metaGraphRequest(insPath);
      (ins && ins.data || []).forEach(r => {
        spendByCampaign[r.campaign_id] = {
          spend30d: Number(r.spend || 0),
          impressions30d: Number(r.impressions || 0),
          clicks30d: Number(r.clicks || 0),
        };
      });
    } catch (_) { /* best-effort */ }

    const campaigns = campaignsRaw.map(c => {
      // daily_budget / lifetime_budget vienen como CENTAVOS string. Las
      // monedas CLP/JPY no usan centavos así que en Meta vienen igual como
      // string-de-centavos (dividimos por 100 siempre).
      const daily = c.daily_budget != null ? Number(c.daily_budget) / 100 : 0;
      const lifetime = c.lifetime_budget != null ? Number(c.lifetime_budget) / 100 : 0;
      const stats = spendByCampaign[c.id] || { spend30d: 0, impressions30d: 0, clicks30d: 0 };
      return {
        id: c.id,
        name: c.name,
        status: c.status, // ACTIVE | PAUSED | ARCHIVED | DELETED
        objective: c.objective || '',
        dailyBudget: daily,
        lifetimeBudget: lifetime,
        currency,
        ...stats,
        spendAvgDaily30d: stats.spend30d / 30,
      };
    });

    return { ok: true, campaigns, currency, fetchedAt: new Date().toISOString() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  test,
  fetchSpend,
  fetchCampaigns,
};
