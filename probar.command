#!/bin/bash
# Doble click → corre la app desde el código fuente, sin empaquetar.
# Útil para probar cambios al toque (no requiere reinstalar).
# Cierra la app con Cmd+Q cuando termines.

set -e
cd "$(dirname "$0")"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Probando Drinking Partners Finanzas (modo dev)"
echo "═══════════════════════════════════════════════════════"
echo ""

if [ ! -d "node_modules" ]; then
  echo "📦 Instalando dependencias (primera vez, ~2 min)..."
  npm install --no-audit --no-fund
  echo ""
fi

echo "🚀 Abriendo app..."
echo "  (Cierra la app con Cmd+Q cuando termines)"
echo ""
npm start
