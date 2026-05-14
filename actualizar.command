#!/bin/bash
# Doble click → bump versión → build → instalar en /Applications → abrir.
# Si algo falla, deja el Terminal abierto para que veas el error.

set -e
cd "$(dirname "$0")"

# Cuando Electron ejecuta este script via spawn(), el PATH es mínimo y no
# incluye node/npm. Cargamos los paths comunes de macOS y, si existe, el shell
# config del usuario para soportar nvm / fnm / etc.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
[ -f "$HOME/.zshrc" ]        && source "$HOME/.zshrc"        2>/dev/null || true
[ -f "$HOME/.bash_profile" ] && source "$HOME/.bash_profile" 2>/dev/null || true
[ -f "$HOME/.profile" ]      && source "$HOME/.profile"      2>/dev/null || true
# Si nvm está instalado, cargarlo también (define el current node version)
[ -s "$HOME/.nvm/nvm.sh" ]   && \. "$HOME/.nvm/nvm.sh"        2>/dev/null || true

# Verificación temprana: si node sigue sin estar, abortar con un mensaje claro
if ! command -v node >/dev/null 2>&1; then
  echo "❌ node no se encontró en el PATH."
  echo "   PATHs probados: $PATH"
  echo "   Solución: instalar Node.js desde https://nodejs.org/"
  exit 127
fi
echo "✓ node $(node --version) en $(which node)"

# Guarda la ubicación de este script para que el botón "Actualizar a nueva
# versión" dentro de la app sepa dónde encontrarlo en el próximo ciclo.
INSTALL_CFG_DIR="$HOME/Library/Application Support/Drinking Partners Finanzas"
mkdir -p "$INSTALL_CFG_DIR"
cat > "$INSTALL_CFG_DIR/install-config.json" <<EOF
{ "sourcePath": "$(pwd)", "savedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)" }
EOF

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Actualizando Drinking Partners Finanzas"
echo "═══════════════════════════════════════════════════════"
echo ""

# 1) Bumpear versión patch (1.0.0 → 1.0.1 → 1.0.2 ...)
NEW_VERSION=$(node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const [maj, min, patch] = pkg.version.split('.').map(Number);
pkg.version = maj + '.' + min + '.' + (patch + 1);
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log(pkg.version);
")
echo "Nueva versión: $NEW_VERSION"
echo ""

# 2) Verificar que node_modules existe; si no, instalar
if [ ! -d "node_modules" ]; then
  echo "📦 Instalando dependencias (primera vez, ~2 min)..."
  npm install --no-audit --no-fund
  echo ""
fi

# 3) Limpieza defensiva: detach mounts viejos del DMG (electron-builder falla si
# /Volumes/Drinking Partners Finanzas ya existe de una build previa abortada)
hdiutil detach "/Volumes/Drinking Partners Finanzas" -force 2>/dev/null || true
# Borra dist/ para evitar artefactos rancios que confunden a electron-builder
rm -rf dist/ 2>/dev/null || true

# 4) Build .app para Apple Silicon
echo "🔨 Construyendo la app (tarda ~3-5 minutos)..."
echo ""
npm run dist:mac-arm

# 4b) Cleanup post-build: detach por si quedó montado
hdiutil detach "/Volumes/Drinking Partners Finanzas" -force 2>/dev/null || true

# 5) Copiar a /Applications, reemplazando la versión vieja
APP_NAME="Drinking Partners Finanzas.app"
SOURCE="dist/mac-arm64/$APP_NAME"
DEST="/Applications/$APP_NAME"

echo ""
echo "📲 Instalando en /Applications..."

if [ ! -d "$SOURCE" ]; then
  echo "❌ No encontré la app en $SOURCE"
  echo "   El build falló. Revisa los mensajes de arriba."
  exit 1
fi

# IMPORTANTE: el siguiente paso mata la app que nos spawneó vía IPC. Esa app
# es el otro extremo de los pipes que estamos usando para stdout/stderr. Sin
# desconectar los pipes ANTES del quit, el siguiente echo recibe SIGPIPE y con
# `set -e` el script muere acá — sin alcanzar `open "$DEST"`, y la app queda
# cerrada hasta que el usuario la reabre a mano. Redirigimos a un log local
# para poder inspeccionar si algo sale mal después del cierre.
LOGFILE="$HOME/Library/Application Support/Drinking Partners Finanzas/last-update.log"
mkdir -p "$(dirname "$LOGFILE")"
echo ""
echo "→ Cerrando app actual y completando la instalación. Log: $LOGFILE"
exec >> "$LOGFILE" 2>&1
echo ""
echo "═══ continuación post-build $(date -u +%Y-%m-%dT%H:%M:%SZ) ═══"

# Cierra la app si está abierta
osascript -e 'tell application "Drinking Partners Finanzas" to quit' 2>/dev/null || true
sleep 1

# Reemplaza
if [ -d "$DEST" ]; then
  rm -rf "$DEST"
fi
cp -R "$SOURCE" "$DEST"

# Limpia cuarentena de macOS (evita el "app dañada")
xattr -cr "$DEST" 2>/dev/null || true

echo "✅ Instalada versión $NEW_VERSION en $DEST"
echo ""
echo "Abriendo app..."
sleep 1
open "$DEST"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ✅ Listo. Esta ventana se cierra en 8 segundos."
echo "  (Presiona Cmd+W o Ctrl+C para cerrarla ahora)"
echo "═══════════════════════════════════════════════════════"
sleep 8
