// src/renderer/domain/cuentas.js
// Multi-cuenta bancaria. Lógica para calcular el saldo de cada cuenta a partir
// del saldo inicial declarado + movimientos (gastos, cobros recibidos, ventas).
//
// Convención de "deposito_ventas": una sola cuenta puede estar marcada con la
// flag `deposito_ventas: true` y a ella van las ventas (Shopify + manuales).
// Si ninguna está marcada, se usa la cuenta default.
//
// Tipos de cuenta soportados:
//   caja, banco, tarjeta, webpay, mercadopago, stripe, otro
//
// Función `calcularSaldoCuenta` recibe ventasPorMes COMO ARGUMENTO (no la
// recomputa) para que sea pura y barata cuando se llama N veces (una por cuenta).

(function () {
  'use strict';

  // Tipos de cuenta que cuentan como "líquidos" para runway/cashflow. Las
  // tarjetas de crédito se excluyen porque son pasivos, no activos.
  const TIPOS_LIQUIDOS = new Set(['caja', 'banco', 'webpay', 'mercadopago', 'stripe', 'otro']);

  function getCuenta(state, cuentaId) {
    return ((state && state.config && state.config.cuentas) || []).find(c => c.id === cuentaId);
  }

  // Garantiza que existe al menos una cuenta ("Caja" default) y que está marcada
  // como default. Mutación in-place; devuelve true si tuvo que crear algo.
  // El caller debe llamar saveState() cuando esto devuelve true.
  function asegurarCuentaDefault(state) {
    if (!state) return false;
    if (!state.config.cuentas) state.config.cuentas = [];
    if (state.config.cuentas.length > 0) return false;

    const id = 'acc_' + Date.now().toString(36);
    state.config.cuentas.push({
      id,
      nombre: 'Caja',
      tipo: 'caja',
      currency: 'CLP',
      saldo_inicial: Number(state.config.saldoInicial || 0),
      color: '#4f46e5'
    });
    state.config.cuenta_default_id = id;
    return true;
  }

  function getCuentaDefault(state) {
    asegurarCuentaDefault(state);
    const cuentas = (state && state.config && state.config.cuentas) || [];
    return cuentas.find(c => c.id === state.config.cuenta_default_id) || cuentas[0];
  }

  // ID de la cuenta donde caen las ventas (Shopify + manuales).
  function getCuentaDepositoVentasId(state) {
    const cuentas = (state && state.config && state.config.cuentas) || [];
    const deposito = cuentas.find(c => c.deposito_ventas);
    return (deposito && deposito.id) || (state && state.config && state.config.cuenta_default_id);
  }

  // Calcula el saldo actual de UNA cuenta.
  //
  // Argumentos:
  //   state         — el state completo (lee gastos, cobros, cuentas, config).
  //   cuentaId      — qué cuenta queremos saldear.
  //   ventasPorMes  — mapa { 'YYYY-MM': monto } ya calculado (típicamente
  //                   Ventas.ventasPorMes(state, shopify, testPatterns)).
  //                   Lo recibimos como input para no recalcularlo por cuenta.
  //
  // Lógica del "saldo inicial":
  //   La cuenta puede declarar `saldo_inicial_mes: 'YYYY-MM'`. Eso significa que
  //   el saldo declarado corresponde al PRIMER DÍA de ese mes. Movimientos
  //   anteriores NO se computan (ya están "incluidos" en el saldo inicial).
  //   Si no se declara, se usa state.config.mesInicial como fallback global.
  function calcularSaldoCuenta(state, cuentaId, ventasPorMes) {
    const cuenta = getCuenta(state, cuentaId);
    if (!cuenta) return 0;
    let saldo = Number(cuenta.saldo_inicial || 0);

    const desdeYM = cuenta.saldo_inicial_mes || state.config.mesInicial || '0000-00';
    const incluirEnSaldo = (fechaStr) => {
      if (!fechaStr) return true;
      const ym = (fechaStr.length >= 7) ? fechaStr.slice(0, 7) : fechaStr;
      return ym >= desdeYM;
    };

    // Restar gastos asignados a esta cuenta
    (state.gastos || []).forEach(g => {
      const accId = g.account_id || state.config.cuenta_default_id;
      if (accId === cuentaId && incluirEnSaldo(g.fecha)) saldo -= Number(g.monto || 0);
    });

    // Sumar pagos recibidos de cobros (CxC) asignados a esta cuenta
    (state.cobros || []).forEach(cobro => {
      (cobro.pagos || []).forEach(p => {
        const accId = p.account_id || state.config.cuenta_default_id;
        if (accId === cuentaId && incluirEnSaldo(p.fecha)) saldo += Number(p.monto || 0);
      });
    });

    // Sumar ventas (Shopify + manuales) a la cuenta de depósito.
    // Usa ventasPorMes() del caller — combina aggregates históricos con
    // detallados recientes + ventas manuales.
    if (cuentaId === getCuentaDepositoVentasId(state)) {
      Object.entries(ventasPorMes || {}).forEach(([ym, monto]) => {
        if (ym >= desdeYM) saldo += Number(monto || 0);
      });
    }
    return saldo;
  }

  // Suma el saldo de todas las cuentas líquidas (excluye tarjetas).
  // Conveniencia para cuando solo te importa el total líquido disponible.
  function calcularCajaLiquidaTotal(state, ventasPorMes) {
    return ((state && state.config && state.config.cuentas) || [])
      .filter(c => TIPOS_LIQUIDOS.has(c.tipo))
      .reduce((s, c) => s + calcularSaldoCuenta(state, c.id, ventasPorMes), 0);
  }

  window.Cuentas = {
    TIPOS_LIQUIDOS,
    getCuenta,
    asegurarCuentaDefault,
    getCuentaDefault,
    getCuentaDepositoVentasId,
    calcularSaldoCuenta,
    calcularCajaLiquidaTotal,
  };
})();
