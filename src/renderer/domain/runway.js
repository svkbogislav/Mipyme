// src/renderer/domain/runway.js
// Runway de caja: cuántos días aguanta el negocio al ritmo actual de quema.
// Es el indicador más importante del dashboard.
//
// Composición de módulos:
//   Ventas    — para obtenerVentas() y ventasPorMes()
//   Cuentas   — para calcularCajaLiquidaTotal()
//   Deudas    — para saldoPendiente() de CxP
//   Cobros    — para saldoPendiente() de CxC
//
// Recibe state, shopify y testPatterns por argumento. NO toca DOM ni globals.

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Runway snapshot
  //
  // Retorna:
  //   {
  //     cajaLiquida,       suma de saldos de cuentas líquidas
  //     deudaPendiente,    suma de CxP pendientes
  //     cobrosPendientes,  suma de CxC pendientes
  //     cajaNeta,          cajaLiquida - deuda + cobros (posición consolidada)
  //     quemaNetaDiaria,   (gastos60d - ventas60d) / 60
  //     ventasPeriodo,     suma ventas últimos 60d
  //     gastosPeriodo,     suma gastos últimos 60d
  //     diasMuestra,       60 (constante; se podría parametrizar)
  //     runway,            días hasta agotar caja (Infinity si genera caja)
  //     status,            'critico' | 'alerta' | 'ok' | 'positivo'
  //   }
  //
  // Umbrales del status:
  //   < 14 días        → 'critico'  (alerta roja en UI)
  //   < 30 días        → 'alerta'   (amarillo)
  //   >= 30 días       → 'ok'       (verde)
  //   genera caja      → 'positivo' (azul, quema diaria <= 0)
  // ---------------------------------------------------------------------------
  function computarRunway(state, shopify, testPatterns) {
    const Ventas = window.Ventas;
    const Cuentas = window.Cuentas;
    const Deudas = window.Deudas;
    const Cobros = window.Cobros;

    // Caja líquida = saldo agregado de cuentas tipo caja/banco/webpay/mercadopago/stripe.
    // Las tarjetas de crédito quedan fuera (son pasivos, no activos).
    const vpm = Ventas.ventasPorMes(state, shopify, testPatterns);
    const cajaLiquida = Cuentas.calcularCajaLiquidaTotal(state, vpm);

    // Deuda CxP pendiente: la restamos de caja para tener "caja neta de obligaciones".
    // Cobros CxC pendientes: los sumamos como entradas comprometidas.
    const deudaPendiente = (state.deudas || []).reduce((s, d) => s + Deudas.saldoPendiente(d), 0);
    const cobrosPendientes = (state.cobros || []).reduce((s, c) => s + Cobros.saldoPendiente(c), 0);
    const cajaNeta = cajaLiquida - deudaPendiente + cobrosPendientes;

    // Quema neta diaria = (gastos - ventas) últimos 60 días, dividido 60.
    // Ventana de 60d suaviza la varianza semanal típica del e-commerce.
    const dias = 60;
    const cutoff = new Date(Date.now() - dias * 24 * 3600 * 1000);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const gastosPeriodo = (state.gastos || [])
      .filter(g => g.fecha && g.fecha >= cutoffStr)
      .reduce((s, g) => s + Number(g.monto || 0), 0);
    const ventasPeriodo = Ventas.obtenerVentas(state, shopify, testPatterns)
      .filter(v => v.fecha && v.fecha.slice(0, 10) >= cutoffStr)
      .reduce((s, v) => s + Number(v.total || 0), 0);
    const quemaNetaDiaria = (gastosPeriodo - ventasPeriodo) / dias;

    let runway, status;
    if (quemaNetaDiaria <= 0) {
      runway = Infinity;
      status = 'positivo';
    } else if (cajaLiquida <= 0) {
      runway = 0;
      status = 'critico';
    } else {
      runway = Math.floor(cajaLiquida / quemaNetaDiaria);
      if (runway < 14) status = 'critico';
      else if (runway < 30) status = 'alerta';
      else status = 'ok';
    }

    return {
      cajaLiquida,
      deudaPendiente,
      cobrosPendientes,
      cajaNeta,
      quemaNetaDiaria,
      ventasPeriodo,
      gastosPeriodo,
      diasMuestra: dias,
      runway,
      status
    };
  }

  // ---------------------------------------------------------------------------
  // Drivers de la proyección a 12 semanas
  //
  // Calcula valores default (basados en histórico) para los inputs que el
  // usuario puede editar en la vista Cashflow → Proyección.
  //
  //   ventasSemana:    promedio de las últimas 8 semanas
  //   variablesSemana: gastos no-recurrentes últimos 60d, dividido por (60/7 semanas)
  //   fijosMes:        suma de gastos recurrentes activos en el mes actual
  //   cajaInicial:     suma de saldos de cuentas líquidas
  // ---------------------------------------------------------------------------
  function calcularDriversProyDefault(state, shopify, testPatterns) {
    const Ventas = window.Ventas;
    const Cuentas = window.Cuentas;

    // ventasSemana: promedio últimas 8 semanas (56 días)
    const ventas = Ventas.obtenerVentas(state, shopify, testPatterns);
    const hoy = new Date();
    const cutoff = new Date(hoy.getTime() - 56 * 24 * 3600 * 1000);
    const ventasUlt = ventas.filter(v => v.fecha && new Date(v.fecha) >= cutoff);
    const ventasSemana = ventasUlt.length > 0
      ? ventasUlt.reduce((s, v) => s + Number(v.total || 0), 0) / 8
      : 0;

    // variablesSemana: gastos NO recurrentes últimos 60 días, prorrateado
    const cutoff60 = new Date(hoy.getTime() - 60 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const gastosVar = (state.gastos || [])
      .filter(g => g.fecha && g.fecha >= cutoff60 && !g.recurring_id)
      .reduce((s, g) => s + Number(g.monto || 0), 0);
    const variablesSemana = gastosVar / (60 / 7);

    // fijosMes: suma de recurrentes activos en el mes actual
    const ymHoy = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}`;
    const fijosMes = ((state.config && state.config.recurrentes) || [])
      .filter(r => r.desde && r.desde <= ymHoy && (!r.hasta || r.hasta >= ymHoy))
      .reduce((s, r) => s + Number(r.monto || 0), 0);

    // cajaInicial: saldo agregado de cuentas líquidas (reusa la lógica de Cuentas)
    const vpm = Ventas.ventasPorMes(state, shopify, testPatterns);
    const cajaInicial = Cuentas.calcularCajaLiquidaTotal(state, vpm);

    return {
      ventasSemana: Math.round(ventasSemana),
      variablesSemana: Math.round(variablesSemana),
      fijosMes: Math.round(fijosMes),
      cajaInicial: Math.round(cajaInicial)
    };
  }

  window.Runway = {
    computar: computarRunway,
    calcularDriversProyDefault,
  };
})();
