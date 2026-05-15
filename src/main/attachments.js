// src/main/attachments.js
// Adjuntos (boletas, facturas, comprobantes) que el usuario puede asociar a
// gastos o ventas. Los archivos se copian a userData/attachments/ para no
// depender del path original (que el usuario podría borrar).

const path = require('node:path');
const fs = require('node:fs');
const { app, dialog, shell } = require('electron');

// Selector de archivo + copia al folder de attachments del usuario.
// Devuelve metadata para que el renderer la guarde junto al gasto/venta.
async function attachFile(mainWindow) {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Adjuntar boleta o factura',
    properties: ['openFile'],
    filters: [
      { name: 'Documentos', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'] },
      { name: 'Todos', extensions: ['*'] }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { cancelled: true };
  }
  const sourcePath = result.filePaths[0];
  const baseName = path.basename(sourcePath);
  const stat = fs.statSync(sourcePath);

  const attachmentsDir = path.join(app.getPath('userData'), 'attachments');
  if (!fs.existsSync(attachmentsDir)) fs.mkdirSync(attachmentsDir, { recursive: true });

  // Nombre único: timestamp + nombre original (preserva la extensión).
  const uniqueName = Date.now().toString(36) + '_' + baseName;
  const destPath = path.join(attachmentsDir, uniqueName);
  fs.copyFileSync(sourcePath, destPath);

  return {
    cancelled: false,
    name: baseName,
    path: destPath,
    size: stat.size,
  };
}

// Abre un attachment con la app por defecto del sistema (Preview, etc).
async function openAttachment(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, error: 'Archivo no encontrado' };
  }
  await shell.openPath(filePath);
  return { ok: true };
}

// Escribe un HTML a un archivo temporal y lo abre con el navegador por
// defecto del sistema. Se usa para el reporte P&L imprimible: window.open()
// + document.write es poco confiable en Electron (URL vacía resuelve al
// propio index.html → "muestra cualquier cosa"). Un .html abierto en el
// browser real es 100% confiable y ahí Cmd+P → "Guardar como PDF" anda.
async function abrirHTMLEnNavegador(html, nombreBase) {
  try {
    const dir = path.join(app.getPath('temp'), 'mipyme-reportes');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const safe = String(nombreBase || 'reporte').replace(/[^a-z0-9\-_]+/gi, '_').slice(0, 60);
    const file = path.join(dir, `${safe}_${Date.now()}.html`);
    fs.writeFileSync(file, String(html || ''), 'utf8');
    const err = await shell.openPath(file);
    if (err) return { ok: false, error: err };
    return { ok: true, path: file };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

module.exports = {
  attachFile,
  openAttachment,
  abrirHTMLEnNavegador,
};
