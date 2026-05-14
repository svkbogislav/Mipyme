// preload.js — Puente seguro entre main.js (Node) y el HTML (renderer).
// Solo expone los métodos específicos que el HTML necesita; el token de
// Shopify nunca cruza este puente.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ¿Está configurado Shopify? (creds opcionales para chequear credenciales custom)
  shopifyStatus: (creds) => ipcRenderer.invoke('shopify:status', creds),

  // Test rápido: verifica que las credenciales funcionen (1 query a /shop)
  testShopify: (creds) => ipcRenderer.invoke('shopify:test', creds),

  // Trae todos los datos frescos: pedidos detallados (60d), agregados mensuales (3 años), catálogo.
  // Si pasas creds, las usa en vez de .env. Útil para multi-negocio.
  refreshShopify: (creds) => ipcRenderer.invoke('shopify:refresh', creds),

  // Abre Finder en el folder donde vive .env (para que el usuario lo edite)
  openEnvFolder: () => ipcRenderer.invoke('app:openEnvFolder'),

  // Path donde puede guardar respaldos
  getUserDataPath: () => ipcRenderer.invoke('app:getUserDataPath'),

  // Selector de archivo + copia a carpeta de attachments. Devuelve {name, path, size}
  attachFile: () => ipcRenderer.invoke('app:attachFile'),

  // Abrir un attachment con la app por defecto
  openAttachment: (filePath) => ipcRenderer.invoke('app:openAttachment', filePath),

  // OAuth flow Shopify: abre navegador, captura callback, devuelve token
  shopifyOAuthStart: (params) => ipcRenderer.invoke('shopify:oauth-start', params),
  shopifyOAuthPort: () => ipcRenderer.invoke('shopify:oauth-port'),

  // App update — 2 flujos según contexto:
  //   - Dev: actualizar.command (script local que re-empaqueta). Reciclado.
  //   - Producción (app packageada): electron-updater contra GitHub Releases.
  // getVersion devuelve { version, sourcePath, isPackaged, platform }.
  // El renderer puede decidir qué flujo usar mirando isPackaged.
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  pickProjectFolder: () => ipcRenderer.invoke('app:pickProjectFolder'),
  updateApp: () => ipcRenderer.invoke('app:updateApp'),
  // Flujo remoto (producción):
  checkRemoteUpdate:    () => ipcRenderer.invoke('app:checkRemoteUpdate'),
  downloadRemoteUpdate: () => ipcRenderer.invoke('app:downloadRemoteUpdate'),
  quitAndInstallRemote: () => ipcRenderer.invoke('app:quitAndInstallRemote'),
  // Suscribirse a eventos de progreso del update. callback recibe { type, data, ts }
  // type local: start, stdout, stderr, error, exit
  // type remoto: remote:checking, remote:available, remote:not-available,
  //              remote:download-progress, remote:downloaded, remote:error
  onUpdateProgress: (callback) => {
    const sub = (_event, payload) => callback(payload);
    ipcRenderer.on('app:updateProgress', sub);
    return () => ipcRenderer.removeListener('app:updateProgress', sub);
  },

  // Meta Ads — test conexión + fetch ad spend mensual
  metaAdsTest: (creds) => ipcRenderer.invoke('meta:test', creds),
  metaAdsFetchSpend: (creds, meses) => ipcRenderer.invoke('meta:fetchSpend', { creds, meses }),

  // Google Ads — test conexión + fetch ad spend mensual (12m, GAQL)
  googleAdsTest: (creds) => ipcRenderer.invoke('google:test', creds),
  googleAdsFetchSpend: (creds) => ipcRenderer.invoke('google:fetchSpend', { creds }),

  // Marca de que estamos corriendo en Electron (para el HTML lo detecte)
  isElectron: true,
  platform: process.platform,
});
