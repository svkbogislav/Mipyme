# Drinking Partners — App Mac (Electron)

App Mac nativa con la misma funcionalidad de la versión web, pero con **sincronización directa con Shopify** (sin tener que pedirle a Claude que actualice). El token de Shopify vive seguro en un archivo local; el HTML nunca lo ve.

## Setup completo (una sola vez)

### 1) Instalar Node.js

Si nunca lo usaste, descarga la versión LTS desde <https://nodejs.org/>. Elige el instalador para macOS y dale next-next-next. Tarda ~3 minutos.

Verifica en Terminal:

```bash
node --version
# debería mostrar v18, v20 o superior
```

### 2) Configurar Shopify

a. En Shopify Admin: **Settings → Apps and sales channels → Develop apps → Create an app**.
b. Ponle nombre "App Finanzas Local". En **Configuration → Admin API access scopes** marca:
   - `read_orders`
   - `read_products`
   - `read_customers` (opcional)
c. **Save → Install app → API credentials → copia el Admin API access token** (empieza con `shpat_`).

### 3) Configurar el archivo `.env`

En la carpeta `App Financiera Mac/`:

```bash
cd "App Financiera Mac"
cp .env.example .env
```

Abre `.env` con TextEdit y completa los dos valores:

```
SHOPIFY_STORE=drinkingpartners
SHOPIFY_ACCESS_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 4) Instalar dependencias

> **Importante:** la carpeta puede tener un `node_modules/` que dejé de mi instalación de prueba. Bórralo primero — los paquetes son específicos de cada plataforma y vas a tener que reinstalar de cualquier forma:

```bash
cd "App Financiera Mac"
rm -rf node_modules package-lock.json
npm install
```

Tarda ~2 minutos (descarga Electron, ~400MB).

### 5) Probar la app

```bash
npm start
```

Se abre una ventana con la app. Click en **"Actualizar datos"** → debería conectarse a Shopify y traer todo en ~10 segundos.

Si todo se ve bien, sigue al paso 6.

### 6) Generar el `.app` final

```bash
# Si tu Mac es Apple Silicon (M1/M2/M3/M4):
npm run dist:mac-arm

# Si tu Mac es Intel:
npm run dist:mac-intel

# Si no estás seguro: hace ambas (más lento)
npm run dist:mac
```

Tarda ~5 minutos. El resultado queda en `dist/`:
- `Drinking Partners Finanzas-1.0.0-arm64.dmg` (o x64.dmg)
- `mac-arm64/Drinking Partners Finanzas.app`

### 7) Instalar la app

a. Abre el `.dmg` con doble click.
b. Arrastra el ícono de la app a la carpeta **Applications**.
c. Primera vez que la abras: macOS dirá "App de un desarrollador no identificado" → ve a **System Settings → Privacy & Security → Open anyway**.
d. Ya está. Aparece en Launchpad y Spotlight como **Drinking Partners Finanzas**.

> **Nota sobre el .env:** electron-builder copia tu `.env` dentro del `.app` (en `Resources`). Si cambias el token después, edita `.env` y rebuilda con `npm run dist:mac`.

---

## Uso diario

1. Abre la app (Cmd+Space → "Drinking Partners").
2. Click en **"Actualizar datos"** en el dashboard. Trae lo último de Shopify directo.
3. Registra gastos, mira presupuesto, etc. Igual que la versión web.

---

## Cuando quieras actualizar el código

Hay dos scripts de **doble click** en la carpeta del proyecto:

### `actualizar.command`

Hace todo en un solo doble click:
1. Sube la versión (1.0.0 → 1.0.1 → 1.0.2…)
2. Empaqueta el `.app` (~5 minutos)
3. Cierra la versión vieja si está abierta
4. Reemplaza `/Applications/Drinking Partners Finanzas.app`
5. Abre la nueva versión

### `probar.command`

Solo corre la app desde el código fuente, sin empaquetar. Útil para probar cambios rápido sin esperar 5 minutos. Cierras con `Cmd+Q` cuando termines.

### Setup una sola vez (permisos)

Para que los scripts sean ejecutables al doble click, abre Terminal y corre **una sola vez**:

```bash
cd "/Users/sebastianvonkoeller/Library/CloudStorage/GoogleDrive-sebavonkoeller@gmail.com/My Drive/Business/Drinking Partners Chile CLD/02 — Financiero/App Financiera Mac"
chmod +x actualizar.command probar.command
```

Después de eso, en Finder le haces doble click a cualquiera de los dos scripts y se abre Terminal automáticamente y ejecuta lo correspondiente.

> **Si Mac dice "no se puede abrir":** click derecho en el script → Open → Open. Solo la primera vez.

---

## Troubleshooting

**"npm: command not found"** → Falta instalar Node.js (paso 1).

**"Error al actualizar: ENOTFOUND ..."** → Sin internet, o el subdominio en `.env` está mal escrito.

**"Error al actualizar: HTTP 401"** → El token está mal o caducó. Genera uno nuevo en Shopify Admin.

**"La app no abre / dice 'damaged'"** → macOS bloqueó la app sin firmar. En Terminal:
```bash
xattr -cr "/Applications/Drinking Partners Finanzas.app"
```
y vuelve a intentar abrirla.

**"Necesito ejecutar la app en otro Mac"** → El `.dmg` lo puedes copiar a otro Mac. Pero el `.env` con el token vive adentro del `.app`; si quieres rebuilear con un token distinto, copia toda la carpeta del proyecto (no solo el .dmg).

---

## Estructura del proyecto

```
App Financiera Mac/
├── package.json          # Dependencias y config de electron-builder
├── main.js               # Proceso main (Node) — token de Shopify y llamadas API
├── preload.js            # Puente seguro main↔renderer
├── renderer/             # Lo que se muestra en pantalla
│   ├── index.html        # La app (HTML/JS/CSS)
│   └── chart.umd.min.js  # Librería de gráficos
├── .env                  # TUS credenciales (NO subir a la nube)
├── .env.example          # Plantilla
└── dist/                 # Lo que genera npm run dist:mac (.dmg, .app)
```

---

## Por qué Electron y no web?

| Web | Electron |
|---|---|
| Token nunca puede vivir en el HTML (riesgo de exposición) | Token vive en proceso main (Node), nunca cruza al HTML |
| CORS bloquea llamadas a Shopify desde file:// | Electron no tiene CORS — llamadas directas a la API |
| Necesitas pedirle a Claude que actualice | Botón "Actualizar datos" funciona en 10s |
| Se abre en pestaña del navegador | Ventana propia, ícono en dock, Cmd+Tab |
