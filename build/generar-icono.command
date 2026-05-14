#!/bin/bash
# Doble click → convierte build/logo-app.svg en build/icon.icns + build/icon.png
# Usa solo herramientas nativas de macOS (sips, iconutil, qlmanage). Sin dependencias.

set -e
cd "$(dirname "$0")"

SVG="logo-app.svg"
ICNS_OUT="icon.icns"
PNG_OUT="icon.png"
ICONSET="icon.iconset"

if [ ! -f "$SVG" ]; then
  echo "❌ No encuentro $SVG en $(pwd)"
  read -p "Presiona enter para cerrar..."
  exit 1
fi

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Generando icono de la app desde $SVG"
echo "═══════════════════════════════════════════════════════"
echo ""

# Paso 1: SVG → PNG 1024px usando qlmanage (Quick Look) que renderiza SVG nativo
TMPDIR=$(mktemp -d)
echo "🎨 Renderizando SVG a PNG 1024px..."
qlmanage -t -s 1024 -o "$TMPDIR" "$SVG" >/dev/null 2>&1
RAW_PNG=$(ls "$TMPDIR"/*.png 2>/dev/null | head -1)

if [ -z "$RAW_PNG" ]; then
  echo "❌ qlmanage no pudo renderizar el SVG."
  echo "   Como alternativa, abre $SVG en Safari/Preview, exporta a PNG 1024px y guarda como build/icon-1024.png"
  read -p "Presiona enter para cerrar..."
  exit 1
fi

cp "$RAW_PNG" "icon-1024.png"
cp "$RAW_PNG" "$PNG_OUT"
echo "✅ icon.png (1024×1024) generado"

# Paso 2: Construir iconset con todos los tamaños que macOS pide
echo "📐 Generando iconset multi-resolución..."
rm -rf "$ICONSET"
mkdir -p "$ICONSET"

# Tamaños requeridos por iconutil (con sus @2x retina)
declare -a SIZES=("16:icon_16x16.png"
                  "32:icon_16x16@2x.png"
                  "32:icon_32x32.png"
                  "64:icon_32x32@2x.png"
                  "128:icon_128x128.png"
                  "256:icon_128x128@2x.png"
                  "256:icon_256x256.png"
                  "512:icon_256x256@2x.png"
                  "512:icon_512x512.png"
                  "1024:icon_512x512@2x.png")

for entry in "${SIZES[@]}"; do
  SIZE="${entry%%:*}"
  NAME="${entry##*:}"
  sips -z "$SIZE" "$SIZE" "icon-1024.png" --out "$ICONSET/$NAME" >/dev/null
done

# Paso 3: Convertir iconset a .icns
echo "📦 Empaquetando como $ICNS_OUT..."
iconutil -c icns "$ICONSET" -o "$ICNS_OUT"
rm -rf "$ICONSET"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ✅ Listo:"
echo "    • build/icon.icns  ← úsalo en electron-builder (mac.icon)"
echo "    • build/icon.png   ← versión 1024px standalone"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "Próximo paso: actualiza package.json para apuntar a este icono"
echo "y rebuild la app con actualizar.command. Esta ventana se cierra en 6s."
sleep 6
