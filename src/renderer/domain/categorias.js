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
    ]
  };

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
    getCategoriasPorTipo,
    getPresupuestoPorTipo,
    getTipoLabel,
  };
})();
