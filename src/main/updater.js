// src/main/updater.js
// Auto-update: dos caminos según contexto.
//
// 1) App packaged (DMG/EXE instalado en /Applications o Program Files):
//    usamos electron-updater. Lee el feed de GitHub Releases configurado en
//    package.json.build.publish, descarga el .dmg/.exe nuevo, y reinicia la
//    app aplicando la nueva versión. ESTE es el flujo para usuarios finales.
//
// 2) App en modo dev (npm run start):
//    fallback al script local actualizar.command que bumpea versión y
//    re-empaqueta. Solo el dev/desarrollador lo usa.
//
// IPC events que emite al renderer (canal 'app:updateProgress'):
//   start, checking, available, not-available, downloading, downloaded,
//   error, exit, stdout, stderr
//
// Y los nuevos para el flujo remoto:
//   remote:checking, remote:available, remote:not-available,
//   remote:download-progress, remote:downloaded, remote:error

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, dialog } = require('electron');
const { spawn } = require('node:child_process');
const { autoUpdater } = require('electron-updater');

// electron-updater logging: importante para debug en producción
autoUpdater.autoDownload = false;        // pedimos confirmación antes de bajar
autoUpdater.autoInstallOnAppQuit = true; // al cerrar la app, instala lo descargado

const INSTALL_CONFIG_FILE = 'install-config.json';
const UPDATE_SCRIPT_NAME = 'actualizar.command';

// Ubica la carpeta fuente. Estrategia:
//   1. Lee install-config.json en userData (lo configura "Elegir carpeta").
//   2. Sondea paths comunes donde la gente suele tener proyectos.
//   3. Devuelve null si nada matchea → la UI le pide al usuario que elija.
function findProjectSourcePath() {
  const configPath = path.join(app.getPath('userData'), INSTALL_CONFIG_FILE);
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (cfg.sourcePath && fs.existsSync(path.join(cfg.sourcePath, UPDATE_SCRIPT_NAME))) {
        return cfg.sourcePath;
      }
    } catch {}
  }
  const home = os.homedir();
  const candidates = [
    path.join(home, 'Code/App Financiera Mac'),
    path.join(home, 'Documents/App Financiera Mac'),
    path.join(home, 'Desktop/App Financiera Mac'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(path.join(p, UPDATE_SCRIPT_NAME))) return p;
  }
  return null;
}

function setProjectSourcePath(sourcePath) {
  const configPath = path.join(app.getPath('userData'), INSTALL_CONFIG_FILE);
  try {
    fs.writeFileSync(configPath, JSON.stringify({
      sourcePath,
      savedAt: new Date().toISOString()
    }, null, 2));
    return true;
  } catch {
    return false;
  }
}

// IPC: lectura simple — versión actual + último source path conocido +
// modo (packaged → flujo remoto via electron-updater; dev → script local).
function getVersion() {
  return {
    version: app.getVersion(),
    sourcePath: findProjectSourcePath(),
    isPackaged: app.isPackaged,
    platform: process.platform
  };
}

// IPC: pide al usuario que elija la carpeta del proyecto (cuando no la encontramos).
async function pickProjectFolder(mainWindow) {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecciona la carpeta del proyecto (donde vive actualizar.command)',
    properties: ['openDirectory'],
    message: 'Buscamos un folder que contenga actualizar.command'
  });
  if (result.canceled || result.filePaths.length === 0) return { cancelled: true };
  const chosen = result.filePaths[0];
  if (!fs.existsSync(path.join(chosen, UPDATE_SCRIPT_NAME))) {
    return { ok: false, error: `Esa carpeta no contiene ${UPDATE_SCRIPT_NAME}` };
  }
  setProjectSourcePath(chosen);
  return { ok: true, sourcePath: chosen };
}

// Cuando Electron lanza un child process, el PATH es minimal y no incluye
// node/npm/brew. Inyectamos uno amplio que cubre las ubicaciones típicas de
// macOS para que el script encuentre `node` y `npm`.
function ampliarPATH(basePath) {
  return [
    '/opt/homebrew/bin',  // Apple Silicon homebrew
    '/usr/local/bin',     // Intel homebrew + macOS Node installer default
    '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    basePath || ''
  ].filter(Boolean).join(':');
}

// IPC: ejecuta actualizar.command. detached:true asegura que el script sobreviva
// cuando esta instancia de la app se cierra (osascript quit) durante el reemplazo
// del .app en /Applications.
async function updateApp(mainWindow) {
  const sourcePath = findProjectSourcePath();
  if (!sourcePath) {
    return { ok: false, error: `No encuentro el folder del proyecto. Elige la carpeta donde vive ${UPDATE_SCRIPT_NAME} primero.` };
  }
  const scriptPath = path.join(sourcePath, UPDATE_SCRIPT_NAME);
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, error: `No existe ${UPDATE_SCRIPT_NAME} en ${sourcePath}` };
  }
  try { fs.chmodSync(scriptPath, 0o755); } catch {}

  const send = (type, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('app:updateProgress', { type, data, ts: Date.now() }); } catch {}
    }
  };

  try {
    const child = spawn('/bin/bash', [scriptPath], {
      cwd: sourcePath,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: ampliarPATH(process.env.PATH) }
    });

    send('start', { pid: child.pid, sourcePath });
    child.stdout.on('data', chunk => send('stdout', chunk.toString()));
    child.stderr.on('data', chunk => send('stderr', chunk.toString()));
    child.on('error', err => send('error', { message: err.message }));
    child.on('exit', code => send('exit', { code }));
    child.unref(); // independizar del lifecycle del padre

    return { ok: true, pid: child.pid, sourcePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Flujo REMOTO (electron-updater) ────────────────────────────────────
// Solo activo en app packageada. En dev no hace nada (electron-updater
// busca un app-update.yml junto al binario que existe solo después de build).

let _updaterWired = false;
function wireRemoteUpdater(mainWindow) {
  if (_updaterWired) return;
  _updaterWired = true;
  const send = (type, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('app:updateProgress', { type, data, ts: Date.now() }); } catch {}
    }
  };
  autoUpdater.on('checking-for-update', () => send('remote:checking', {}));
  autoUpdater.on('update-available',    info => send('remote:available', info));
  autoUpdater.on('update-not-available', info => send('remote:not-available', info));
  autoUpdater.on('error', err => send('remote:error', { message: _limpiarErrorUpdater(err) }));
  autoUpdater.on('download-progress', p => send('remote:download-progress', {
    percent: p.percent, bytesPerSecond: p.bytesPerSecond, transferred: p.transferred, total: p.total
  }));
  autoUpdater.on('update-downloaded', info => send('remote:downloaded', info));
}

// Lee la config publish del package.json bundleado. Devuelve { owner, repo }
// o null si no está configurada.
function _leerPublishConfig() {
  try {
    const pkg = require('../../package.json');
    const p = pkg && pkg.build && pkg.build.publish;
    if (!p || !p.owner || !p.repo) return null;
    return { owner: p.owner, repo: p.repo };
  } catch (e) { return null; }
}

// Detecta si el repo está sin configurar (placeholders del package.json del
// repo). Útil para no llamar al API de GitHub y devolver un mensaje claro.
function _publishEstaSinConfigurar() {
  const pc = _leerPublishConfig();
  if (!pc) return true;
  return (pc.owner || '').includes('PLACEHOLDER') || (pc.repo || '').includes('PLACEHOLDER');
}

// Reduce un error largo de electron-updater (que a veces incluye headers
// HTTP, cookies, set-cookie, etc) a una línea legible. Se queda con el
// primer match útil o la primera línea no-vacía.
function _limpiarErrorUpdater(err) {
  if (!err) return 'Error desconocido';
  const msg = err.message || String(err);
  // Patrón típico: 'HttpError: 404 ...' o 'method: GET url: ...'
  const m404 = msg.match(/(\d{3})\s+(?:".*?")?/);
  if (m404 && m404[1] === '404') {
    return 'El repo de GitHub Releases no existe o no es accesible (404). Verifica owner/repo en package.json.';
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(msg)) {
    return 'No hay conexión a internet o GitHub no responde. Intenta de nuevo en un rato.';
  }
  if (/unauthorized|401/i.test(msg)) {
    return 'Sin autorización para acceder al repo (¿es privado y no hay token?).';
  }
  if (/rate limit/i.test(msg)) {
    return 'GitHub temporalmente bloqueó las consultas por rate-limit. Intenta en 1 hora.';
  }
  // Fallback: primera línea no-vacía, max 200 chars.
  const primera = msg.split(/\r?\n/).find(l => l.trim()) || msg;
  return primera.slice(0, 200);
}

// Comprueba si hay una nueva versión en el feed. No descarga automáticamente.
async function checkRemoteUpdate(mainWindow) {
  if (!app.isPackaged) {
    return { ok: false, mode: 'dev', error: 'En modo desarrollo. Usa el script local actualizar.command.' };
  }
  if (_publishEstaSinConfigurar()) {
    return {
      ok: false,
      error: 'El sistema de auto-actualización aún no está configurado. Falta definir owner/repo de GitHub en package.json (build.publish). Ver RELEASING.md.'
    };
  }
  wireRemoteUpdater(mainWindow);
  try {
    const result = await autoUpdater.checkForUpdates();
    if (result && result.updateInfo) {
      return {
        ok: true,
        currentVersion: app.getVersion(),
        latestVersion: result.updateInfo.version,
        hasUpdate: result.updateInfo.version !== app.getVersion(),
        releaseNotes: result.updateInfo.releaseNotes || null,
        releaseDate: result.updateInfo.releaseDate || null
      };
    }
    return { ok: true, currentVersion: app.getVersion(), hasUpdate: false };
  } catch (err) {
    return { ok: false, error: _limpiarErrorUpdater(err) };
  }
}

// Descarga la versión nueva (la app sigue funcionando mientras tanto).
async function downloadRemoteUpdate() {
  if (!app.isPackaged) return { ok: false, error: 'No aplica en modo desarrollo' };
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// Instala la versión descargada y reinicia la app. Llamar SOLO después de
// haber recibido 'remote:downloaded'.
function quitAndInstallRemote() {
  if (!app.isPackaged) return { ok: false, error: 'No aplica en modo desarrollo' };
  // setImmediate para que el IPC reply alcance al renderer antes del quit.
  setImmediate(() => autoUpdater.quitAndInstall());
  return { ok: true };
}

module.exports = {
  findProjectSourcePath,
  setProjectSourcePath,
  getVersion,
  pickProjectFolder,
  updateApp,
  // Flujo remoto (producción):
  checkRemoteUpdate,
  downloadRemoteUpdate,
  quitAndInstallRemote,
  wireRemoteUpdater,
};
