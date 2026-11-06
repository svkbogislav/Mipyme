// src/renderer/domain/categorias.js
// Catálogos de categorías de gastos por tipo de negocio.
// Usado por el onboarding wizard para sembrar categorías relevantes según el
// rubro del usuario, y por la vista Configuración para ofrecer "reset al
// default de mi tipo".
//
// Estructura:
//   TIPOS_NEGOCIO     — lista de tipos para el selector (label + key)
//   CATEGORIAS_POR_TIPO — { [key]: string[] }
//   PRESUPUESTO_POR_TIPO — { [key]: { categoria: %, ... } }

(function () {
  'use strict';

  // Tipos ofrecidos en el wizard. Mantener corto (4-5) para no fatigar la
  // elección. Cada uno tiene categorías y % de presupuesto típicos.
  const TIPOS_NEGOCIO = [
    {
      key: 'servicios',
      label: 'Servicios',
      desc: 'Consultoría, freelance, salud, oficios, profesional'
    },
    {
      key: 'retail',
      label: 'Retail / Local físico',
      desc: 'Tienda, almacén, restaurante, peluquería'
    },
    {
      key: 'ecommerce',
      label: 'E-commerce / Online',
      desc: 'Venta por internet, Shopify, redes sociales'
    },
    {
      key: 'otro',
      label: 'Otro',
      desc: 'Mixto o no encaja en los anteriores'
    }
  ];

  // Categorías sugeridas por tipo. Cualquier usuario puede editarlas después
  // en Configuración → Categorías.
  const CATEGORIAS_POR_TIPO = {
    servicios: [
      'Proveedores',
      'Honorarios pagados',
      'Arriendo oficina',
      'Internet / Telefonía',
      'Marketing',
      'Apps / Software',
      'Movilización',
      'Impuestos',
      'Bancarios',
      'Otros'
    ],
    retail: [
      'Proveedores',
      'Insumos / Mercadería',
      'Arriendo local',
      'Sueldos',
      'Servicios básicos',
      'Marketing',
      'Logística',
      'Impuestos',
      'Bancarios',
      'Otros'
    ],
    ecommerce: [
      'Proveedores',
      'Insumos / Mercadería',
      'Logística',
      'Marketing',
      'Comisiones plataforma',
      'Apps / Software',
      'Honorarios',
      'Impuestos',
      'Bancarios',
      'Otros'
    ],
    otro: [
      // Mismas que el defaultState legacy
      'Proveedores',
      'Insumos / Mercadería',
      'Logística',
      'Marketing',
      'Sueldos',
      'Honorarios',
      'Arriendo',
      'Servicios básicos',
      'Apps / Software',
      'Impuestos',
      'Bancarios',
      'Otros'
    ],
    personal: [
      'Vivienda (arriendo/dividendo)',
      'Alimentación',
      'Restaurantes y delivery',
      'Transporte',
      'Servicios (luz/agua/internet)',
      'Suscripciones y apps',
      'Compras (tiendas y online)',
      'Salud',
      'Seguros',
      'Educación',
      'Ocio / Entretención',
      'Deudas / Créditos',
      'Pago tarjeta de crédito',
      'Comisiones e intereses bancarios',
      'Transferencias a personas',
      'Traspasos a tus otras cuentas',
      'Ahorro',
      'Otros'
    ]
  };

  // Tipos de gasto (perfil personal): agrupan las categorías en lo que
  // importa para decidir. Inspirado en 50/30/20: lo esencial, los gustos,
  // lo que se va en deudas y lo que ahorras. "noGasto": plata que no se
  // consume (sigue siendo tuya en otra cuenta), se muestra aparte.
  const TIPOS_GASTO_PERSONAL = [
    { key: 'esencial', label: 'Lo esencial', desc: 'vivienda, comida, transporte, cuentas, salud y educación',
      cats: ['Vivienda (arriendo/dividendo)', 'Alimentación', 'Transporte', 'Servicios (luz/agua/internet)', 'Salud', 'Seguros', 'Educación'] },
    { key: 'gustos', label: 'Gustos y estilo de vida', desc: 'restaurantes, compras, panoramas y suscripciones',
      cats: ['Restaurantes y delivery', 'Compras (tiendas y online)', 'Ocio / Entretención', 'Suscripciones y apps'] },
    { key: 'deudas', label: 'Deudas y costos del banco', desc: 'cuotas de créditos, intereses y comisiones',
      cats: ['Deudas / Créditos', 'Comisiones e intereses bancarios'] },
    { key: 'tarjetas', label: 'Pagos de tarjeta', desc: 'lo que compraste con tarjeta de crédito; el detalle está en el estado de cuenta',
      cats: ['Pago tarjeta de crédito'] },
    { key: 'personas', label: 'Transferencias a personas', desc: 'plata que le mandaste a otras personas',
      cats: ['Transferencias a personas'] },
    { key: 'ahorro', label: 'Ahorro', desc: 'depósitos, fondos e inversiones',
      cats: ['Ahorro'] },
    { key: 'sin', label: 'Sin clasificar', desc: 'el banco no dice en qué fue: clasifícalos',
      cats: ['Por clasificar', 'Otros', 'Sin categoría', ''] },
    { key: 'propias', label: 'A tus otras cuentas', desc: 'traspasos a cuentas tuyas que no están en la app: no es gasto', noGasto: true,
      cats: ['Traspasos a tus otras cuentas'] },
  ];
  // Una categoría que creaste tú (no está en ningún tipo) se muestra en
  // "Otras categorías tuyas", sin adivinar si es esencial o gusto.
  const TIPO_OTRAS = { key: 'otras', label: 'Otras categorías tuyas', desc: 'categorías que creaste tú', cats: [] };
  function tipoDeCategoria(cat) {
    const c = String(cat || '');
    return TIPOS_GASTO_PERSONAL.find(t => t.cats.includes(c)) || TIPO_OTRAS;
  }
  function getTiposGasto() { return TIPOS_GASTO_PERSONAL.concat([TIPO_OTRAS]); }

  // % de presupuesto recomendado por categoría según rubro. La suma puede no
  // llegar a 100 — lo que sobra es la utilidad esperada. Son referencias, no
  // reglas duras; el usuario las puede editar en Presupuesto.
  const PRESUPUESTO_POR_TIPO = {
    servicios: {
      'Honorarios pagados': 15,
      'Arriendo oficina': 8,
      'Internet / Telefonía': 3,
      'Marketing': 8,
      'Apps / Software': 4,
      'Movilización': 4,
      'Impuestos': 10,
      'Bancarios': 1,
      'Otros': 3
    },
    retail: {
      'Insumos / Mercadería': 40,
      'Arriendo local': 10,
      'Sueldos': 15,
      'Servicios básicos': 4,
      'Marketing': 5,
      'Logística': 3,
      'Impuestos': 8,
      'Bancarios': 1,
      'Otros': 2
    },
    ecommerce: {
      'Insumos / Mercadería': 30,
      'Logística': 10,
      'Marketing': 18,
      'Comisiones plataforma': 5,
      'Apps / Software': 3,
      'Honorarios': 5,
      'Impuestos': 8,
      'Bancarios': 1,
      'Otros': 2
    },
    otro: {
      'Insumos / Mercadería': 25,
      'Logística': 10,
      'Marketing': 12,
      'Sueldos': 0,
      'Honorarios': 4,
      'Arriendo': 6,
      'Servicios básicos': 3,
      'Apps / Software': 2,
      'Impuestos': 5,
      'Bancarios': 1,
      'Otros': 2
    },
    // Referencia tipo 50/30/20 adaptado (necesidades/gustos/ahorro+deuda).
    personal: {
      'Vivienda (arriendo/dividendo)': 28,
      'Alimentación': 16,
      'Transporte': 10,
      'Servicios (luz/agua/internet)': 7,
      'Salud': 6,
      'Educación': 5,
      'Ocio / Entretención': 10,
      'Deudas / Créditos': 8,
      'Ahorro': 8,
      'Otros': 2
    }
  };

  function getCategoriasPorTipo(tipo) {
    return (CATEGORIAS_POR_TIPO[tipo] || CATEGORIAS_POR_TIPO.otro).slice();
  }

  function getPresupuestoPorTipo(tipo) {
    return { ...(PRESUPUESTO_POR_TIPO[tipo] || PRESUPUESTO_POR_TIPO.otro) };
  }

  function getTipoLabel(tipo) {
    const found = TIPOS_NEGOCIO.find(t => t.key === tipo);
    return found ? found.label : 'Negocio';
  }

  window.Categorias = {
    TIPOS_NEGOCIO,
    TIPOS_GASTO_PERSONAL,
    tipoDeCategoria,
    getTiposGasto,
    getCategoriasPorTipo,
    getPresupuestoPorTipo,
    getTipoLabel,
  };
})();
