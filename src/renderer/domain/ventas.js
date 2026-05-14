// src/renderer/domain/ventas.js
// Domain logic para ventas — fusión de Shopify orders + ventas manuales en un
// modelo unificado, filtros estándar (test/cancelado/no-pagado) y agregados
// mensuales que sostienen cashflow, runway y dashboard.
//
// Módulo FUNCIONAL: todas las funciones reciben state/shopify/testPatterns
// por argumento. NO lee window globals. Eso lo hace fácil de testear y deja
// la política de qué cuenta como "test" en el caller (el inline aplica la
// regla DPCL-aware ahí).

(function () {
  'use strict';

  // Financial statuses de Shopify que consideramos "venta válida".
  const OK_STATUSES = new Set(['paid', 'partially_paid', 'authorized']);

  // ---------------------------------------------------------------------------
  // Normalización al shape interno de "venta"
  // ---------------------------------------------------------------------------

  // Convierte una venta manual (state.ventasManuales[*]) al shape común.
  function normalizarVentaManual(v) {
    const monto = Number(v.monto || 0);
    return {
      fecha: v.fecha,
      total: monto,
      cliente: v.cliente || '—',
      num: (v.id || '').slice(-6) || '—',
      estado: 'paid',
      cancelado: false,
      test: false,
      items: v.descripcion
        ? [{ title: v.descripcion, quantity: 1, price: monto }]
        : [],
      manual: true,
      _id: v.id,
      metodo: v.metodo,
      account_id: v.account_id
    };
  }

  // Convierte un Shopify order al shape interno + marca flags (test/cancelado).
  function normalizarShopifyOrder(o, testPatterns) {
    return {
      fecha: o.created_at || o.fecha,
      total: Number(o.total_price ?? o.total ?? 0),
      cliente: o.customer || o.cliente || '—',
      num: o.order_number || o.name || o.num || o.id || '—',
      estado: o.financial_status || o.estado || '',
      cancelado: !!o.cancelled_at,
      test: esPedidoTest(o, testPatterns),
      items: o.line_items || o.items || [],
      manual: false
    };
  }

  // ---------------------------------------------------------------------------
  // Detección de test orders
  //
  // Recibe los patterns por argumento (no decide qué es "test"). La política
  // de defaults vive en el caller — típicamente DPCL-aware en el inline.
  // ---------------------------------------------------------------------------
  function esPedidoTest(order, testPatterns) {
    if (!Array.isArray(testPatterns) || testPatterns.length === 0) return false;
    const haystack = (
      String(order.customer || order.cliente || '') + ' ' +
      String(order.email || '') + ' ' +
      String((order.customer && order.customer.email) || '')
    ).toLowerCase();
    return testPatterns.some(p => p && haystack.includes(p));
  }

  // ---------------------------------------------------------------------------
  // Filtros
  // ---------------------------------------------------------------------------
  // Devuelve true si la venta normalizada cuenta para análisis/revenue.
  // Si trae estado, exigir uno de los OK_STATUSES. Si no trae estado (datos
  // viejos sin financial_status), no descartar por eso — tolerancia legacy.
  function _esVentaValida(v) {
    if (v.cancelado) return false;
    if (v.test) return false;
    if (v.estado && !OK_STATUSES.has(String(v.estado).toLowerCase())) return false;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Vistas sobre las ventas
  // ---------------------------------------------------------------------------

  // Ventas válidas para análisis: Shopify filtradas + manuales (siempre válidas).
  function obtenerVentas(state, shopify, testPatterns) {
    const shopifyVentas = ((shopify && shopify.orders) || [])
      .map(o => normalizarShopifyOrder(o, testPatterns))
      .filter(_esVentaValida);
    const manuales = ((state && state.ventasManuales) || []).map(normalizarVentaManual);
    return shopifyVentas.concat(manuales);
  }

  // Como obtenerVentas pero clasifica TODOS los pedidos sin filtrar, anotando
  // _filterReason ∈ { null | 'test' | 'cancelado' | 'no_pagado' }. Útil para
  // la vista Ventas que muestra el toggle "Mostrar filtrados".
  function obtenerVentasClasificadas(state, shopify, testPatterns) {
    const shopifyVentas = ((shopify && shopify.orders) || []).map(o => {
      const norm = normalizarShopifyOrder(o, testPatterns);
      let reason = null;
      if (norm.cancelado) reason = 'cancelado';
      else if (norm.test) reason = 'test';
      else {
        const estado = String(norm.estado || '').toLowerCase();
        if (estado && !OK_STATUSES.has(estado)) reason = 'no_pagado';
      }
      return { ...norm, _filterReason: reason };
    });
    const manuales = ((state && state.ventasManuales) || []).map(v => ({
      ...normalizarVentaManual(v),
      _filterReason: null
    }));
    return shopifyVentas.concat(manuales);
  }

  // ---------------------------------------------------------------------------
  // Agregados por mes (cashflow / dashboard / runway dependen de estos)
  //
  // Tres fuentes con reglas distintas:
  //   1. Agregados Shopify (3 años hacia atrás)        → base.
  //   2. Pedidos detallados Shopify (últimos 60 días)  → OVERRIDE base
  //      (más preciso: el agg cuenta órdenes que pueden estar canceladas).
  //   3. Ventas manuales                                → SUMAN al resultado
  //      (no son parte del agg Shopify; nunca lo pisan).
  // ---------------------------------------------------------------------------

  // Itera orders Shopify detallados que pasan filtros, llamando al accumulator
  // (ym, order) por cada uno. Reusado por ventasPorMes y pedidosPorMes.
  function _forEachShopifyDetalladoValido(shopify, testPatterns, fn) {
    ((shopify && shopify.orders) || []).forEach(o => {
      if (!!o.cancelled_at) return;
      if (esPedidoTest(o, testPatterns)) return;
      const estado = String(o.financial_status || '').toLowerCase();
      if (estado && !OK_STATUSES.has(estado)) return;
      const ym = (o.created_at || o.fecha || '').slice(0, 7);
      if (!ym) return;
      fn(ym, o);
    });
  }

  function ventasPorMes(state, shopify, testPatterns) {
    const map = {};
    ((shopify && shopify.monthly_aggregates) || []).forEach(a => {
      map[a.month] = a.net_sales;
    });

    // (2) override con detallados Shopify
    const detallado = {};
    _forEachShopifyDetalladoValido(shopify, testPatterns, (ym, o) => {
      detallado[ym] = (detallado[ym] || 0) + Number(o.total_price ?? o.total ?? 0);
    });
    Object.keys(detallado).forEach(ym => { map[ym] = detallado[ym]; });

    // (3) suma manuales (nunca pisa, suma)
    ((state && state.ventasManuales) || []).forEach(v => {
      const ym = (v.fecha || '').slice(0, 7);
      if (!ym) return;
      map[ym] = (map[ym] || 0) + Number(v.monto || 0);
    });

    return map;
  }

  function pedidosPorMes(state, shopify, testPatterns) {
    const map = {};
    ((shopify && shopify.monthly_aggregates) || []).forEach(a => {
      map[a.month] = a.orders;
    });

    const detallado = {};
    _forEachShopifyDetalladoValido(shopify, testPatterns, (ym) => {
      detallado[ym] = (detallado[ym] || 0) + 1;
    });
    Object.keys(detallado).forEach(ym => { map[ym] = detallado[ym]; });

    ((state && state.ventasManuales) || []).forEach(v => {
      const ym = (v.fecha || '').slice(0, 7);
      if (!ym) return;
      map[ym] = (map[ym] || 0) + 1;
    });

    return map;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  window.Ventas = {
    OK_STATUSES,
    normalizarVentaManual,
    esPedidoTest,
    obtenerVentas,
    obtenerVentasClasificadas,
    ventasPorMes,
    pedidosPorMes,
  };
})();
