// src/main/ipc.js
// Punto central donde registramos TODOS los handlers IPC del main process.
// Cada handler delega a un módulo especializado. Tener un solo lugar con la
// superficie IPC facilita auditar qué puede invocar el renderer.
//
// Patrón:
//   - Funciones puras (sin acceso a la BrowserWindow) → llamada directa.
//   - Funciones que necesitan la ventana (dialogs, webContents.send) reciben
//     `mainWindow` por argumento. Lo obtenemos vía el callback `getMainWindow`
//     que pasa main.js, así siempre referencia la instancia vigente.

const { ipcMain } = require('electron');
const env = require('./env');
const shopifyApi = require('./shopify-api');
const shopifyOAuth = require('./shopify-oauth');
const metaApi = require('./meta-api');
const googleApi = require('./google-api');
const updater = require('./updater');
const attachments = require('./attachments');

function register({ getMainWindow }) {
  const win = () => getMainWindow();

  // === Shopify ===
  ipcMain.handle('shopify:status',      async (_e, creds)  => shopifyApi.status(creds));
  ipcMain.handle('shopify:refresh',     async (_e, creds)  => shopifyApi.refreshAll(creds));
  ipcMain.handle('shopify:test',        async (_e, creds)  => shopifyApi.test(creds));
  ipcMain.handle('shopify:oauth-start', async (_e, params) => shopifyOAuth.start(params));
  ipcMain.handle('shopify:oauth-port',  async ()           => shopifyOAuth.PORT);

  // === Meta Ads ===
  ipcMain.handle('meta:test',       async (_e, creds) => metaApi.test(creds));
  ipcMain.handle('meta:fetchSpend', async (_e, args)  => metaApi.fetchSpend(args));

  // === Google Ads ===
  ipcMain.handle('google:test',       async (_e, creds) => googleApi.test(creds));
  ipcMain.handle('google:fetchSpend', async (_e, args)  => googleApi.fetchSpend(args));

  // === Attachments ===
  ipcMain.handle('app:attachFile',     async ()            => attachments.attachFile(win()));
  ipcMain.handle('app:openAttachment', async (_e, p)       => attachments.openAttachment(p));

  // === Auto-update (dev: script local · prod: electron-updater) ===
  ipcMain.handle('app:getVersion',        async ()  => updater.getVersion());
  ipcMain.handle('app:pickProjectFolder', async ()  => updater.pickProjectFolder(win()));
  ipcMain.handle('app:updateApp',         async ()  => updater.updateApp(win()));
  // Producción: flujo remoto via GitHub Releases + electron-updater
  ipcMain.handle('app:checkRemoteUpdate',    async () => updater.checkRemoteUpdate(win()));
  ipcMain.handle('app:downloadRemoteUpdate', async () => updater.downloadRemoteUpdate());
  ipcMain.handle('app:quitAndInstallRemote', async () => updater.quitAndInstallRemote());
  // Instalación manual (bypass Squirrel.Mac, funciona sin firma de Apple)
  ipcMain.handle('app:descargarInstalarManual', async (_e, ver) => updater.descargarEInstalarManual(win(), ver));

  // === Filesystem helpers ===
  ipcMain.handle('app:openEnvFolder',   async () => env.openEnvFolder());
  ipcMain.handle('app:getUserDataPath', async () => env.getUserDataPath());
}

module.exports = { register };
