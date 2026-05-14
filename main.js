// main.js — Entry point del proceso main de Electron.
//
// Responsabilidades:
//   1. Crear la BrowserWindow.
//   2. Registrar los handlers IPC (delegados a src/main/ipc.js).
//   3. Lifecycle de la app (whenReady, activate, window-all-closed) y menú.
//
// La lógica de integraciones (Shopify, Meta, Google), OAuth, attachments y
// auto-update vive en src/main/*. Este archivo NO debe crecer: cada feature
// nueva del main process se añade como un módulo en src/main/ y se registra
// en src/main/ipc.js.

const { app, BrowserWindow, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ipc = require('./src/main/ipc');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 480,
    minHeight: 500,
    title: 'Mipyme',
    backgroundColor: '#f6f7fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // DevTools en modo desarrollo
  if (process.env.NODE_ENV === 'development' || process.argv.includes('--devtools')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Editar',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'Ver',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Ventana',
      submenu: [
        { role: 'minimize' }, { role: 'close' },
      ],
    },
  ]);
}

app.whenReady().then(() => {
  // Setear icono del dock en dev mode (npm start). En la build empaquetada
  // electron-builder usa build/icon.icns automáticamente.
  if (process.platform === 'darwin' && app.dock && typeof app.dock.setIcon === 'function') {
    const iconPath = path.join(__dirname, 'build', 'icon.png');
    if (fs.existsSync(iconPath)) {
      try { app.dock.setIcon(iconPath); } catch {}
    }
  }

  createWindow();

  // Registrar IPC con un getter perezoso de mainWindow: cada handler que
  // necesite la ventana siempre obtiene la instancia vigente, incluso si se
  // recrea en `activate`.
  ipc.register({ getMainWindow: () => mainWindow });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  Menu.setApplicationMenu(buildMenu());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
