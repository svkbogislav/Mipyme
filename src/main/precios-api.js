// src/main/precios-api.js
// Cotización de inversiones SIN API keys (todo endpoints públicos gratuitos):
//   - Acciones / ETF (USA y Bolsa de Santiago) → Yahoo Finance
//       USA:      AAPL, VOO, MSFT…           (devuelve USD)
//       Santiago: FALABELLA.SN, CHILE.SN…    (devuelve CLP, sufijo .SN)
//   - Cripto → CoinGecko (devuelve USD)
//   - Dólar observado + UF + UTM → mindicador.cl (CLP)
//
// La conversión USD→CLP la hace el renderer con el `usdclp` que devolvemos
// acá (dólar de mindicador), para no pedir el tipo de cambio N veces.
//
// Filosofía: best-effort. Un símbolo que falla no rompe el resto; va a
// `errores` y el renderer cae al precio manual que tenga guardado.

const https = require('node:https');

// GET JSON con timeout y User-Agent (Yahoo rechaza requests sin UA).
function getJSON(url, { timeout = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('URL inválida')); }
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json,text/plain,*/*',
      },
    }, (res) => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (err) { reject(new Error('Respuesta no-JSON: ' + String(data).slice(0, 120))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.end();
  });
}

// ── Yahoo Finance: una acción/ETF. symbol tal cual (con .SN si es chilena).
async function cotizarYahoo(symbol) {
  const s = encodeURIComponent(String(symbol).trim().toUpperCase());
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${s}?interval=1d&range=1d`;
  const j = await getJSON(url);
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  const meta = r && r.meta;
  const precio = meta && (meta.regularMarketPrice ?? meta.previousClose);
  if (!meta || precio == null || !isFinite(Number(precio))) {
    throw new Error('Sin precio para ' + symbol);
  }
  return { precio: Number(precio), moneda: meta.currency || 'USD', nombre: meta.longName || meta.shortName || symbol };
}

// ── CoinGecko: cripto por id (bitcoin, ethereum, solana…). Devuelve USD.
async function cotizarCripto(ids) {
  const list = ids.map(x => encodeURIComponent(String(x).trim().toLowerCase())).join(',');
  if (!list) return {};
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${list}&vs_currencies=usd`;
  const j = await getJSON(url);
  const out = {};
  Object.keys(j || {}).forEach(id => {
    const v = j[id] && j[id].usd;
    if (v != null && isFinite(Number(v))) out[id] = { precio: Number(v), moneda: 'USD', nombre: id };
  });
  return out;
}

// ── mindicador.cl: dólar observado + UF + UTM (todo en CLP).
async function indicadoresChile() {
  try {
    const j = await getJSON('https://mindicador.cl/api');
    return {
      usdclp: Number((j.dolar && j.dolar.valor) || 0) || 0,
      uf:     Number((j.uf && j.uf.valor) || 0) || 0,
      utm:    Number((j.utm && j.utm.valor) || 0) || 0,
    };
  } catch (e) {
    return { usdclp: 0, uf: 0, utm: 0, _err: e.message };
  }
}

// Entrada principal. items = [{ tipo, simbolo }]
//   tipo: 'accion' | 'etf' | 'cripto' | 'usd' | 'uf' | 'manual'
//   simbolo: ticker Yahoo ('AAPL', 'FALABELLA.SN'), id CoinGecko ('bitcoin'),
//            o 'USD' / 'UF' (no necesita símbolo real).
// Devuelve { ok, usdclp, uf, utm, cotizaciones:{SIM:{precio,moneda,nombre}}, errores:{SIM:msg} }
async function cotizar(items) {
  const lista = Array.isArray(items) ? items : [];
  const ind = await indicadoresChile();
  const cotizaciones = {};
  const errores = {};

  const cripto = [];
  const yahoo = [];
  for (const it of lista) {
    const tipo = String(it && it.tipo || '').toLowerCase();
    const sim = String(it && it.simbolo || '').trim();
    if (tipo === 'cripto' && sim) cripto.push(sim);
    else if ((tipo === 'accion' || tipo === 'etf') && sim) yahoo.push(sim);
    // 'usd' / 'uf' / 'manual' no requieren cotización individual.
  }

  // Cripto en una sola llamada
  if (cripto.length) {
    try {
      const cg = await cotizarCripto([...new Set(cripto)]);
      Object.assign(cotizaciones, cg);
      cripto.forEach(id => { if (!cg[id.toLowerCase()]) errores[id] = 'No encontrada en CoinGecko'; });
    } catch (e) {
      cripto.forEach(id => { errores[id] = 'CoinGecko: ' + e.message; });
    }
  }

  // Acciones/ETF: una request por símbolo (en paralelo, dedup)
  const uniqYahoo = [...new Set(yahoo)];
  await Promise.all(uniqYahoo.map(async sym => {
    try { cotizaciones[sym.toUpperCase()] = await cotizarYahoo(sym); }
    catch (e) { errores[sym] = e.message; }
  }));

  return {
    ok: true,
    usdclp: ind.usdclp,
    uf: ind.uf,
    utm: ind.utm,
    cotizaciones,
    errores,
    ts: Date.now(),
  };
}

module.exports = { cotizar };
