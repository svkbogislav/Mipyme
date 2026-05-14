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

module.exports = {
  attachFile,
  openAttachment,
};
