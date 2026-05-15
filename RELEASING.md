# Release flow — Mac + Windows + auto-update

Esta app se distribuye como **ZIP (Mac)** y **EXE (Windows)** con **auto-update remoto vía GitHub Releases**. El usuario final descarga el instalador una vez; futuras versiones se actualizan automáticamente desde dentro de la app.

---

## 🚀 Flujo automático (recomendado — GitHub Actions)

**Sacar una versión nueva = UN solo comando:**

```bash
cd ~/Documents/mipyme
npm run ship          # patch: 1.0.79 → 1.0.80   (o npm run ship:minor)
```

Eso hace `npm version patch` + `git push --follow-tags`. Al subir el tag `v*.*.*`, **GitHub Actions compila y publica solo** en sus servidores limpios:

- ✅ Mac (zip arm64 + x64) — runner macOS limpio, **sin los errores de hdiutil/Google Drive/volúmenes**
- ✅ Windows (.exe NSIS) — runner Windows real, **sin Wine**
- ✅ `latest-mac.yml` / `latest.yml` generados → auto-update funcional
- ⏱️ ~10-15 min, sin tu Mac involucrado

**Ver el progreso:** GitHub → repo → pestaña **Actions** → el run "Release". Cuando termina (✓ verde), el release aparece en **Releases** con todos los archivos.

No necesitas `GH_TOKEN` local ni que tu Mac esté prendido. El workflow usa el `GITHUB_TOKEN` que GitHub provee solo.

> El workflow vive en `.github/workflows/release.yml`. Se dispara con cualquier tag `vX.Y.Z`, o a mano desde la pestaña Actions (botón "Run workflow").

---

## 🛠️ Flujo manual (fallback, compila en tu Mac)

Solo si Actions falla o quieres compilar local. Requiere `GH_TOKEN` exportado:

```bash
cd ~/Documents/mipyme
npm version patch
git push --follow-tags
npm run release:mac     # solo Mac, ~3 min (zip-only)
```

---

## Notas de arquitectura

## Setup inicial (una sola vez)

### 1. Crear el repo en GitHub
Crea un repo (puede ser privado) en tu cuenta de GitHub. Anótate `OWNER` y `REPO`.

### 2. Configurar el publish target
Edita `package.json` y reemplaza los placeholders en `build.publish`:

```json
"publish": {
  "provider": "github",
  "owner": "TU_USER",
  "repo": "NOMBRE_DEL_REPO",
  "releaseType": "release"
}
```

### 3. Generar un Personal Access Token (PAT)
- GitHub → **Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token**.
- Scopes mínimos: `repo` (todo).
- Copia el token (empieza con `ghp_`).

### 4. Exportar el token al ambiente
Antes de cada release, exporta el token (no lo commitees nunca):

```bash
export GH_TOKEN="ghp_tu_token_aqui"
```

Opcional: ponerlo en `~/.zshrc` para que sea permanente en tu Mac.

## Hacer un release

### Mac + Windows en un solo comando
```bash
# 1. Bumpear versión en package.json
npm version patch     # o minor / major
# 2. Build + upload a GitHub Releases (crea el release, sube los archivos)
npm run release
```

Esto genera y publica:
- `Mipyme-{version}-arm64.dmg` (Mac Apple Silicon)
- `Mipyme-{version}.dmg` (Mac Intel)
- `Mipyme-Setup-{version}.exe` (Windows)
- `latest-mac.yml`, `latest.yml` (manifiestos que electron-updater lee)

> **Nota:** para builds de Windows desde un Mac, necesitas tener `wine` instalado:
> ```bash
> brew install --cask --no-quarantine wine-stable
> ```

### Solo Mac
```bash
npm run dist:mac           # build local (sin publicar)
npm run release            # ⚠️ esto sube TODO; usar dist:mac si solo querés probar
```

### Solo Windows
```bash
npm run dist:win
```

### Build local sin publicar
```bash
npm run pack               # sin instalador, solo el .app empaquetado
npm run dist:mac           # con DMG pero sin upload
```

## Cómo funciona el auto-update para el usuario final

1. Usuario descarga el `.dmg` o `.exe` desde el GitHub Release inicial y lo instala.
2. Cada vez que abre la app, electron-updater consulta `https://github.com/{OWNER}/{REPO}/releases/latest`.
3. Si hay versión nueva → la app muestra "Hay una actualización disponible" cuando el usuario abre **Configuración → App y datos → Actualización**.
4. Click → confirma → descarga el nuevo `.dmg`/`.exe` en background.
5. Al terminar, ofrece reiniciar para aplicar.

## Code signing (recomendado antes de comercializar)

### Mac — Apple Developer ID (US$99/año)
Sin firma, los usuarios ven el warning "app de desarrollador no identificado" y tienen que ir a **Sistema → Seguridad → Abrir igual**.

Cuando tengas el cert, agrega a `package.json > build.mac`:
```json
"identity": "Developer ID Application: Tu Nombre (TEAMID)",
"hardenedRuntime": true,
"gatekeeperAssess": false,
"notarize": {
  "teamId": "TU_TEAM_ID"
}
```

Y exporta:
```bash
export APPLE_ID="tu@email.com"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"
export APPLE_TEAM_ID="TU_TEAM_ID"
```

### Windows — Code signing certificate (US$200-500/año)
Sin firma, Windows SmartScreen advierte la primera vez. La mayoría de apps chicas viven con esto al empezar.

Cuando tengas el cert, agrega a `package.json > build.win`:
```json
"certificateFile": "ruta/al/cert.pfx",
"certificatePassword": "..."
```

## Workflow de versionado

- **`npm version patch`** → 1.0.70 → 1.0.71 (bugfixes)
- **`npm version minor`** → 1.0.70 → 1.1.0 (features nuevas, compatible)
- **`npm version major`** → 1.0.70 → 2.0.0 (breaking changes en datos/UI)

Cada `npm version` crea un commit + tag automáticamente. Pushea con:
```bash
git push && git push --tags
```

## Troubleshooting

**"electron-builder cannot publish: no GH_TOKEN"**
→ Olvidaste exportar `GH_TOKEN`. Hazlo con `export GH_TOKEN="ghp_..."`.

**"Error: Cannot find module 'app-builder-bin'"**
→ `npm install` faltante. Ejecutá `npm install`.

**El auto-update no detecta versión nueva en el feed**
→ Verifica que `package.json > build.publish > owner/repo` sea correcto.
→ Verifica que la release esté **publicada** (no draft) en GitHub.
→ El tag de la release debe coincidir con `package.json > version` prefijado con `v` (ej: `v1.0.71`).

**Wine no compila el .exe desde Mac**
→ Brew install wine-stable, y considera usar GitHub Actions con runner Windows si el problema persiste.
