// src/main/env.js
// Lectura de .env y resolución de credenciales Shopify.
// Política: si el renderer pasa credenciales explícitas (config por negocio),
// tienen prioridad; .env queda como fallback global. El renderer NUNCA ve
// el token: solo se pasa a través de este módulo hacia las APIs externas.

const { app, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// Lee el primer .env que exista en las ubicaciones esperadas.
function loadEnv() {
  const candidates = [
    path.join(__dirname, '..', '..', '.env'),       // proyecto en desarrollo
    path.join(process.resourcesPath || '', '.env'), // .app empaquetada
    path.join(app.getPath('userData'), '.env'),     // override por usuario
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const env = {};
        fs.readFileSync(p, 'utf8').split('\n').forEach(line => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) return;
          const [k, ...rest] = trimmed.split('=');
          env[k.trim()] = rest.join('=').trim().replace(/^["']|["']$/g, '');
        });
        return { env, path: p };
      }
    } catch {}
  }
  return { env: {}, path: null };
}

// Resuelve config Shopify: overrides del renderer ganan; .env es fallback.
// Siempre re-lee .env para reflejar cambios en runtime.
function getShopifyConfig(overrides) {
  let store, token, apiVersion, envPath = null;
  if (overrides && (overrides.store || overrides.token)) {
    store = (overrides.store || '').trim();
    token = (overrides.token || '').trim();
    apiVersion = (overrides.apiVersion || '2024-10').trim();
  } else {
    const loaded = loadEnv();
    envPath = loaded.path;
    const ENV = loaded.env;
    store = (ENV.SHOPIFY_STORE || process.env.SHOPIFY_STORE || '').trim();
    token = (ENV.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN || '').trim();
    apiVersion = (ENV.SHOPIFY_API_VERSION || '2024-10').trim();
  }
  store = store.replace(/^https?:\/\//, '').replace(/\/$/, '').split('.')[0];
  const host = store && (store.endsWith('.myshopify.com') ? store : `${store}.myshopify.com`);
  return { host, token, apiVersion, configured: !!(store && token), envPath };
}

// IPC: abre Finder en el folder donde vive .env (o userData si no hay .env).
function openEnvFolder() {
  const cfg = getShopifyConfig();
  const target = cfg.envPath || app.getPath('userData');
  shell.showItemInFolder(target);
  return { ok: true, path: target };
}

function getUserDataPath() {
  return app.getPath('userData');
}

module.exports = {
  loadEnv,
  getShopifyConfig,
  openEnvFolder,
  getUserDataPath,
};
