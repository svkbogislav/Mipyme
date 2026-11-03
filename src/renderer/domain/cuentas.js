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
    // "Hoy" en hora local (no UTC) para no excluir/incluir de más por zona horaria.
    const ahora = new Date();
    const hoyYMD = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}-${String(ahora.getDate()).padStart(2, '0')}`;
    const hoyYM = hoyYMD.slice(0, 7);
    const incluirEnSaldo = (fechaStr) => {
      if (!fechaStr) return true;
      const ymd = String(fechaStr).slice(0, 10);
      // Movimiento con fecha futura: la plata aún no se movió → no cuenta
      // para la caja ACTUAL.
      if (ymd > hoyYMD) return false;
      const ym = ymd.slice(0, 7);
      return ym >= desdeYM;
    };

    // Restar gastos asignados a esta cuenta.
    //   - Comisión estimada (auto_estimado:'comision'): SÍ baja la caja —
    //     la pasarela (Shopify/Mercado Pago) descuenta su comisión ANTES
    //     de depositarte; la venta entra bruta pero te llega neta.
    //   - IVA estimado (auto_estimado:'iva'): NO baja la caja — esa plata
    //     sí la recibes; es una provisión para el F29 que pagas después.
    (state.gastos || []).forEach(g => {
      if (g.auto_estimado === 'iva') return;
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

    // Sumar ventas Shopify a la cuenta de depósito y cada venta/ingreso
    // manual a SU cuenta (la que eligió el usuario; sin cuenta → depósito).
    // ventasPorMes() del caller trae Shopify + manuales juntos, así que a la
    // cuenta de depósito se le resta la parte manual y se vuelve a sumar
    // ingreso por ingreso según su account_id.
    const depositoId = getCuentaDepositoVentasId(state);
    const manualesPorMes = {};
    (state.ventasManuales || []).forEach(v => {
      const ym = String(v.fecha || '').slice(0, 7);
      if (!ym) return;
      manualesPorMes[ym] = (manualesPorMes[ym] || 0) + Number(v.monto || 0);
    });
    if (cuentaId === depositoId) {
      Object.entries(ventasPorMes || {}).forEach(([ym, monto]) => {
        // Excluye meses futuros: esas ventas aún no entran a la caja actual.
        if (ym >= desdeYM && ym <= hoyYM) saldo += Number(monto || 0) - (manualesPorMes[ym] || 0);
      });
    }
    (state.ventasManuales || []).forEach(v => {
      const accId = v.account_id || depositoId;
      if (accId === cuentaId && incluirEnSaldo(v.fecha)) saldo += Number(v.monto || 0);
    });

    // Transferencias internas: la cuenta origen baja y la destino sube. NO
    // afectan ventas/gastos (no entran al P&L), solo mueven plata. Respetan
    // las mismas reglas de fecha (no contar futuras ni anteriores al saldo
    // inicial declarado).
    (state.transferencias || []).forEach(t => {
      if (!incluirEnSaldo(t.fecha)) return;
      const monto = Number(t.monto || 0);
      if (!monto) return;
      if (t.cuenta_origen === cuentaId)  saldo -= monto;
      if (t.cuenta_destino === cuentaId) saldo += monto;
    });
    return saldo;
  }

  // Suma el saldo de todas las cuentas líquidas (excluye tarjetas y
  // cuentas que el usuario marcó como "no sumar al total" — útil para
  // cuentas administradas a nombre de terceros o que quieres ver aparte).
  function calcularCajaLiquidaTotal(state, ventasPorMes) {
    return ((state && state.config && state.config.cuentas) || [])
      .filter(c => TIPOS_LIQUIDOS.has(c.tipo) && !c.excluir_del_total)
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
