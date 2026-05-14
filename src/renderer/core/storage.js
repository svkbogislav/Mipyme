// src/renderer/core/storage.js
// Capa de persistencia del renderer. Encapsula localStorage para que el
// resto de la app no toque las keys directamente.
//
// Responsabilidades:
//   1. Definir la forma canónica del state (defaultState) y la shape de Shopify.
//   2. Cargar/guardar por business (multi-tenant via key prefix).
//   3. Detectar corrupción y respaldar sin perder datos.
//   4. Versionar el schema y correr migraciones forward al cargar.
//   5. Migrar el schema viejo (single-business) al multi-business actual.
//
// Clásico (no ES module): expone `window.Storage` para que el script inline
// del renderer lo consuma sin cambiar su modelo de carga.
//
// Convenciones de keys en localStorage:
//   dp_businesses_v1                    → lista de negocios
//   dp_active_business_v1               → id del negocio activo
//   dp_finanzas_v1__{businessId}        → state por negocio
//   dp_shopify_v1__{businessId}         → datos Shopify por negocio
//   dp_finanzas_v1__{businessId}__corrupt_{ts} → backup automático si hubo corrupción
//   dp_shopify_v1__{businessId}__corrupt_{ts}  → idem para Shopify

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Keys
  // ---------------------------------------------------------------------------
  const KEYS = Object.freeze({
    BUSINESSES: 'dp_businesses_v1',
    ACTIVE_BUSINESS: 'dp_active_business_v1',
    LEGACY_FINANZAS: 'dp_finanzas_v1',
    LEGACY_SHOPIFY: 'dp_shopify_v1',
  });

  function lsKey(businessId)      { return `dp_finanzas_v1__${businessId}`; }
  function shopifyKey(businessId) { return `dp_shopify_v1__${businessId}`; }

  // ---------------------------------------------------------------------------
  // Default state (template canónico). NUNCA se muta el objeto exportado:
  // cloneDefault() devuelve copia fresca para cada uso.
  // ---------------------------------------------------------------------------
  const defaultState = {
    config: {
      nombre: 'Mi negocio',
      saldoInicial: 0,
      mesInicial: '', // YYYY-MM
      categorias: [
        'Insumos / Mercadería',
        'Logística',
        'Marketing',
        'Sueldos',
        'Honorarios',
        'Arriendo',
        'Servicios básicos',
        'Comisiones Shopify',
        'Apps / Software',
        'Impuestos',
        'Bancarios',
        'Otros'
      ],
      // {id, descripcion, categoria, monto, proveedor, frecuencia, dia,
      //  diaSemana?, desde, hasta?, metodo}
      recurrentes: [],
      // Porcentajes recomendados por categoría (referencia industria PyME
      // e-commerce/retail Chile). Editable por usuario.
      presupuesto: {
        'Insumos / Mercadería': 25,
        'Logística': 10,
        'Marketing': 12,
        'Sueldos': 0,
        'Honorarios': 4,
        'Arriendo': 6,
        'Servicios básicos': 3,
        'Comisiones Shopify': 3,
        'Apps / Software': 2,
        'Impuestos': 5,
        'Bancarios': 1,
        'Otros': 2
      },
      productCosts: {},        // {tituloProducto: costoUnitarioCLP}
      productTypes: {},        // {tituloProducto: 'consumible'|'reutilizable'}
      activos: [],             // {id, nombre, cantidad, costo_unitario, fecha_compra, vida_util_meses, descripcion}
      cuentas: [],             // {id, nombre, tipo, currency, saldo_inicial, color, deposito_ventas?}
      cuenta_default_id: null,
      proveedores: [],         // {id, nombre, rut, email, telefono, notas}
      clientes: [],            // idem proveedores
      dashboard: {
        mensualPeriod: 24,
        mensualYoY: false,
        diarioPeriod: 'period',
        topProductosPeriod: 'period',
        categoriasPeriod: 'period',
        widgets: {
          kpis: true,
          chartMensual: true,
          accountBalance: true,
          chartCategorias: true,
          chartDiario: true,
          topProductos: true
        }
      }
    },
    gastos: [],          // {id, fecha, monto, categoria, proveedor|proveedor_id, metodo, descripcion, recurring_id?, account_id, attachments?}
    deudas: [],          // {id, acreedor, descripcion, monto_total, fecha_*, notas, pagos: [{id, fecha, monto, account_id, gasto_id?}], created_at}
    cobros: [],          // espejo de deudas pero invertido (cliente nos debe)
    ventasManuales: []   // {id, fecha, monto, descripcion, cliente?, cliente_id?, account_id?, metodo, created_at}
  };

  function cloneDefault() {
    return JSON.parse(JSON.stringify(defaultState));
  }

  const defaultShopify = Object.freeze({ orders: [], updated_at: null, source: null });
  function cloneDefaultShopify() {
    return { orders: [], updated_at: null, source: null };
  }

  // ---------------------------------------------------------------------------
  // Schema versioning + migraciones forward
  //
  // Cuando cambies el shape del state de manera que datos viejos podrían
  // romperse, agrega una entrada nueva a SCHEMA_MIGRATIONS y bumpea CURRENT.
  // Las migraciones se aplican en orden al cargar el state guardado.
  //
  // Reglas para escribir una migración:
  //   - Mutar el objeto in-place o devolver uno nuevo (ambos válidos).
  //   - Idempotente: correrla dos veces no debe romper nada.
  //   - Conservadora con los datos: agregar campos nuevos con defaults
  //     sensatos; nunca borrar info del usuario.
  //   - Comentar qué motivó la migración (link a issue/feature).
  // ---------------------------------------------------------------------------
  const CURRENT_SCHEMA_VERSION = 2;

  const SCHEMA_MIGRATIONS = [
    null, // index 0 — placeholder, las migraciones empiezan en index 1

    // v0 → v1: garantiza el array ventasManuales (introducido cuando agregamos
    // soporte para PyME offline / sin Shopify). Negocios anteriores no tenían
    // este campo; lo creamos vacío para que el resto de la app no rompa al
    // hacer `state.ventasManuales.map(...)`.
    function v0_to_v1(s) {
      if (!Array.isArray(s.ventasManuales)) s.ventasManuales = [];
      return s;
    },

    // v1 → v2: agrega `state.config._onboardingDone`. Usuarios EXISTENTES
    // (los que ya tienen gastos, ventas o Shopify configurado) se marcan
    // como onboarded para no verles el wizard al actualizar la app.
    // Usuarios nuevos arrancan en false → ven el wizard la primera vez.
    function v1_to_v2(s) {
      if (!s.config) s.config = {};
      if (s.config._onboardingDone === undefined) {
        const tieneDatos = (s.gastos && s.gastos.length > 0)
                        || (s.ventasManuales && s.ventasManuales.length > 0)
                        || (s.config.recurrentes && s.config.recurrentes.length > 0)
                        || (s.config.cuentas && s.config.cuentas.length > 1)
                        || (s.config.testCustomers && s.config.testCustomers.length > 0);
        s.config._onboardingDone = !!tieneDatos;
      }
      return s;
    },
  ];

  function runSchemaMigrations(parsed) {
    const from = Number(parsed._schemaVersion || 0);
    let s = parsed;
    for (let v = from + 1; v <= CURRENT_SCHEMA_VERSION; v++) {
      const mig = SCHEMA_MIGRATIONS[v];
      if (typeof mig === 'function') s = mig(s) || s;
    }
    s._schemaVersion = CURRENT_SCHEMA_VERSION;
    return s;
  }

  // Merge superficial con defaultState; deep-merge solo a nivel de `config`.
  // Lo más profundo (config.dashboard.widgets) se resuelve en sus get*Cfg
  // helpers a la hora del uso, lo cual es más tolerante a cambios futuros.
  function mergeWithDefault(parsed) {
    return {
      ...cloneDefault(),
      ...parsed,
      config: { ...cloneDefault().config, ...(parsed.config || {}) }
    };
  }

  // ---------------------------------------------------------------------------
  // Businesses
  // ---------------------------------------------------------------------------
  function loadBusinesses() {
    try {
      const raw = localStorage.getItem(KEYS.BUSINESSES);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  function saveBusinesses(businesses) {
    localStorage.setItem(KEYS.BUSINESSES, JSON.stringify(businesses || []));
  }

  function getActiveBusinessId() {
    return localStorage.getItem(KEYS.ACTIVE_BUSINESS) || null;
  }

  function setActiveBusinessId(id) {
    if (id) localStorage.setItem(KEYS.ACTIVE_BUSINESS, id);
    else localStorage.removeItem(KEYS.ACTIVE_BUSINESS);
  }

  // ---------------------------------------------------------------------------
  // State por negocio
  //
  // Convención: { state, corruption } — corruption es null en happy path o
  // un objeto { tipo, businessId, backupKey, mensaje } cuando localStorage
  // contenía JSON inválido. La app NUNCA pierde silenciosamente; respaldamos
  // el raw bajo otra key y dejamos que el caller decida cómo avisar.
  // ---------------------------------------------------------------------------
  function loadState(businessId) {
    if (!businessId) return { state: cloneDefault(), corruption: null };
    const raw = localStorage.getItem(lsKey(businessId));
    if (!raw) return { state: cloneDefault(), corruption: null };
    try {
      const parsed = JSON.parse(raw);
      const merged = mergeWithDefault(parsed);
      const migrated = runSchemaMigrations(merged);
      return { state: migrated, corruption: null };
    } catch (err) {
      const backupKey = `${lsKey(businessId)}__corrupt_${Date.now()}`;
      try { localStorage.setItem(backupKey, raw); } catch {}
      console.error('[Storage.loadState] datos corruptos. Backup en', backupKey, err);
      return {
        state: cloneDefault(),
        corruption: { tipo: 'state', businessId, backupKey, mensaje: err && err.message }
      };
    }
  }

  function saveState(businessId, state) {
    if (!businessId || !state) return false;
    // Estampar la versión actual del schema en cada save. Asegura que el
    // próximo loadState no re-ejecute migraciones ya aplicadas.
    const out = { ...state, _schemaVersion: CURRENT_SCHEMA_VERSION };
    localStorage.setItem(lsKey(businessId), JSON.stringify(out));
    return true;
  }

  // ---------------------------------------------------------------------------
  // Shopify cache por negocio
  // ---------------------------------------------------------------------------
  function loadShopify(businessId) {
    if (!businessId) return { shopify: cloneDefaultShopify(), corruption: null };
    const raw = localStorage.getItem(shopifyKey(businessId));
    if (!raw) return { shopify: cloneDefaultShopify(), corruption: null };
    try {
      return { shopify: JSON.parse(raw), corruption: null };
    } catch (err) {
      const backupKey = `${shopifyKey(businessId)}__corrupt_${Date.now()}`;
      try { localStorage.setItem(backupKey, raw); } catch {}
      console.error('[Storage.loadShopify] datos corruptos. Backup en', backupKey, err);
      return {
        shopify: cloneDefaultShopify(),
        corruption: { tipo: 'shopify', businessId, backupKey, mensaje: err && err.message }
      };
    }
  }

  function saveShopify(businessId, shopify) {
    if (!businessId || !shopify) return false;
    localStorage.setItem(shopifyKey(businessId), JSON.stringify(shopify));
    return true;
  }

  // ---------------------------------------------------------------------------
  // Migración del schema viejo (single-business legacy → multi-business)
  //
  // Si el usuario instaló versiones <= 1.0.20 (aprox), tendría datos en las
  // keys legacy `dp_finanzas_v1` / `dp_shopify_v1` sin sufijo. Esta función
  // los re-keya bajo un nuevo business creado on-the-fly. Idempotente: si
  // ya hay businesses, no hace nada.
  //
  // Devuelve el business creado, o null si no había nada que migrar.
  // ---------------------------------------------------------------------------
  function migrarBusinessesLegacy() {
    const existing = loadBusinesses();
    if (existing.length > 0) return null;

    const oldFinanzas = localStorage.getItem(KEYS.LEGACY_FINANZAS);
    const oldShopify = localStorage.getItem(KEYS.LEGACY_SHOPIFY);

    let nombre = 'Mi negocio';
    if (oldFinanzas) {
      try {
        const parsed = JSON.parse(oldFinanzas);
        if (parsed && parsed.config && parsed.config.nombre) nombre = parsed.config.nombre;
      } catch {}
    }
    const id = 'b_' + Date.now().toString(36);
    const initials = nombre.split(/\s+/)
      .filter(Boolean).slice(0, 2)
      .map(w => w[0]).join('').toUpperCase().slice(0, 2) || 'MN';
    const business = {
      id, nombre, initials, color: 'indigo',
      created_at: new Date().toISOString()
    };

    saveBusinesses([business]);
    setActiveBusinessId(id);

    if (oldFinanzas) localStorage.setItem(lsKey(id), oldFinanzas);
    if (oldShopify)  localStorage.setItem(shopifyKey(id), oldShopify);

    return business;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  window.Storage = {
    // Constants
    KEYS,
    CURRENT_SCHEMA_VERSION,

    // Defaults / helpers
    cloneDefault,
    cloneDefaultShopify,

    // Businesses
    loadBusinesses,
    saveBusinesses,
    getActiveBusinessId,
    setActiveBusinessId,
    lsKey,
    shopifyKey,

    // State
    loadState,
    saveState,

    // Shopify cache
    loadShopify,
    saveShopify,

    // Migraciones
    runSchemaMigrations,
    migrarBusinessesLegacy,
  };
})();
