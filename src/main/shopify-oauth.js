// src/main/shopify-oauth.js
// Flujo OAuth para una Custom App de Shopify. Levanta un servidor HTTP local
// en PORT, abre el navegador para que el usuario autorice, captura el redirect
// y cambia el authorization code por un access_token.

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { shell } = require('electron');

// Debe coincidir con la "URL de redireccionamiento" registrada en el Dev Dashboard.
const PORT = 54321;

// Estado del servidor activo: solo permitimos un OAuth en curso a la vez.
let _activeServer = null;
let _activeCleanup = null;

// Scopes que la app financiera necesita para sincronizar todo lo relevante.
const REQUIRED_SCOPES = [
  'read_orders', 'read_products', 'read_customers', 'read_analytics',
  'read_inventory', 'read_reports', 'read_returns', 'read_discounts',
  'read_price_rules', 'read_fulfillments', 'read_locations',
  'read_shopify_payments_payouts', 'read_shopify_payments_disputes'
];

function escapeHTML(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Intercambia el authorization code por un access_token contra Shopify.
function exchangeCodeForToken({ host, clientId, clientSecret, code }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ client_id: clientId, client_secret: clientSecret, code });
    const req = https.request({
      hostname: host,
      path: '/admin/oauth/access_token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          if (parsed.access_token) resolve(parsed);
          else reject(new Error('Sin access_token en respuesta: ' + data.slice(0, 300)));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Timeout exchange')));
    req.write(body);
    req.end();
  });
}

// Inicia el flujo OAuth completo. Resuelve cuando el navegador completa el
// callback (éxito o error), o si pasan 5 minutos sin actividad.
async function start(params) {
  const { store, clientId, clientSecret } = params || {};
  if (!store || !clientId || !clientSecret) {
    return { ok: false, error: 'Faltan datos: store, clientId, clientSecret' };
  }

  // Cancelar cualquier OAuth previo pendiente para evitar "state mismatch"
  // entre intentos sucesivos.
  if (_activeServer) {
    try { _activeServer.close(); } catch {}
    _activeServer = null;
  }
  if (_activeCleanup) {
    try { _activeCleanup(); } catch {}
    _activeCleanup = null;
  }
  await new Promise(r => setTimeout(r, 200)); // dar tiempo a que el puerto se libere

  const cleanStore = String(store).replace(/^https?:\/\//, '').replace(/\/$/, '').split('.')[0];
  const host = `${cleanStore}.myshopify.com`;

  const stateNonce = crypto.randomBytes(16).toString('hex');
  const redirectUri = `http://127.0.0.1:${PORT}/callback`;
  const authUrl = `https://${host}/admin/oauth/authorize?` +
    `client_id=${encodeURIComponent(clientId)}&` +
    `scope=${encodeURIComponent(REQUIRED_SCOPES.join(','))}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `state=${stateNonce}`;

  return new Promise((resolve) => {
    let server = null;
    const cleanup = () => {
      try { server && server.close(); } catch {}
      if (_activeServer === server) { _activeServer = null; _activeCleanup = null; }
    };
    _activeCleanup = cleanup;

    const timeout = setTimeout(() => {
      cleanup();
      resolve({ ok: false, error: 'Timeout (5 min). Cancelaste la autorización?' });
    }, 5 * 60 * 1000);

    server = http.createServer(async (req, res) => {
      try {
        const urlObj = new URL(req.url, `http://127.0.0.1:${PORT}`);
        if (urlObj.pathname !== '/callback') {
          res.writeHead(404); res.end('Not found'); return;
        }
        const code = urlObj.searchParams.get('code');
        const stateBack = urlObj.searchParams.get('state');
        const errorDesc = urlObj.searchParams.get('error_description') || urlObj.searchParams.get('error');
        if (errorDesc) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<html><body style="font-family:system-ui; padding:40px"><h2>❌ Error de Shopify</h2><p>${escapeHTML(errorDesc)}</p><p>Vuelve a la app y reintenta.</p></body></html>`);
          clearTimeout(timeout); cleanup();
          resolve({ ok: false, error: errorDesc });
          return;
        }
        if (stateBack !== stateNonce) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<html><body style="font-family:system-ui; padding:40px"><h2>❌ State mismatch</h2><p>Posible CSRF. Reintenta.</p></body></html>`);
          clearTimeout(timeout); cleanup();
          resolve({ ok: false, error: 'State mismatch' });
          return;
        }
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<html><body style="font-family:system-ui; padding:40px"><h2>❌ Sin code</h2></body></html>`);
          clearTimeout(timeout); cleanup();
          resolve({ ok: false, error: 'Sin code en callback' });
          return;
        }

        try {
          const tokenData = await exchangeCodeForToken({ host, clientId, clientSecret, code });
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<html><body style="font-family:system-ui; padding:40px; text-align:center"><h2>✅ Conectado correctamente</h2><p>Token obtenido. Ya puedes cerrar esta pestaña y volver a la app.</p></body></html>`);
          clearTimeout(timeout); cleanup();
          resolve({ ok: true, token: tokenData.access_token, scopes: tokenData.scope });
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<html><body style="font-family:system-ui; padding:40px"><h2>❌ Error intercambiando code</h2><p>${escapeHTML(err.message)}</p></body></html>`);
          clearTimeout(timeout); cleanup();
          resolve({ ok: false, error: err.message });
        }
      } catch (err) {
        res.writeHead(500); res.end('Error interno: ' + err.message);
        clearTimeout(timeout); cleanup();
        resolve({ ok: false, error: err.message });
      }
    });

    server.on('error', (err) => {
      clearTimeout(timeout);
      if (err.code === 'EADDRINUSE') {
        resolve({ ok: false, error: `Puerto ${PORT} en uso. Cierra otras apps que lo estén usando o reintenta en unos segundos.` });
      } else {
        resolve({ ok: false, error: err.message });
      }
    });

    server.listen(PORT, '127.0.0.1', () => {
      _activeServer = server;
      shell.openExternal(authUrl);
    });
  });
}

module.exports = {
  PORT,
  start,
};
