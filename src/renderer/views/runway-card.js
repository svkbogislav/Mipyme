// src/renderer/views/runway-card.js
// Render del widget de runway en el dashboard. Lee la composición de runway
// vía window.Runway (módulo de dominio) y pinta los elementos del DOM.
//
// Patrón de extracción de view:
//   - Función top-level expuesta como window.renderRunwayCard
//   - Lee state/shopify del lexical scope global (definidos en el inline)
//   - Llama wrappers ya existentes (computarRunway → Runway.computar)
//   - Llama helpers de utils (clp, fmtNum) desde window
//
// Para llamarse correctamente, este archivo se carga ANTES del script inline
// del renderer. La función referencia state/shopify por nombre — se resuelven
// al call-time, momento en el que el inline ya las inicializó.

(function () {
  'use strict';

  function renderRunwayCard() {
    const card = document.getElementById('runwayCard');
    if (!card) return;
    const cuentas = state.config.cuentas || [];
    const hayDatos = cuentas.length > 0 && cuentas.some(c => Number(c.saldo_inicial || 0) !== 0);
    const tieneVentasOGastos = (state.gastos.length > 0) || (obtenerVentas().length > 0);
    if (!hayDatos && !tieneVentasOGastos) { card.style.display = 'none'; return; }

    const r = computarRunway();
    card.style.display = '';

    // ============ HEADLINE: número + frase contextual según situación ============
    // Cuando GENERA caja: el número grande es el rate (+$143k/mes); runway es ∞ y se omite.
    // Cuando QUEMA caja: el número grande es runway (X días); el rate va al sub.
    const colores = {
      critico:  { bg: '#fee2e2', fg: '#b91c1c', label: 'Crítico' },
      alerta:   { bg: '#fef3c7', fg: '#b45309', label: 'Atención' },
      ok:       { bg: '#dcfce7', fg: '#15803d', label: 'Saludable' },
      positivo: { bg: '#dbeafe', fg: '#1d4ed8', label: 'Genera caja' }
    };
    const c = colores[r.status] || colores.ok;
    document.getElementById('runwayStatusIcon').style.background = c.bg;
    document.getElementById('runwayStatusIcon').style.color = c.fg;
    document.getElementById('runwayBadge').innerHTML = `<span style="display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; background:${c.bg}; color:${c.fg}; border:1px solid ${c.fg}33">${c.label}</span>`;

    const headlineNum = document.getElementById('runwayHeadlineNumber');
    const headlineSub = document.getElementById('runwayHeadlineSub');

    // Helper: pintar el número grande con la unidad "/mes" o "días" en un
    // tamaño menor y gris muted, para que el monto sea el ancla visual.
    const unidadStyle = 'font-size:16px; color:var(--text-muted); font-weight:600; margin-left:4px';

    if (r.quemaNetaDiaria <= 0) {
      // Genera caja → el monto mensual es la noticia
      const generaMes = -r.quemaNetaDiaria * 30;
      headlineNum.innerHTML = `+${clp(generaMes)}<span style="${unidadStyle}">/mes</span>`;
      headlineNum.style.color = '#15803d';
      headlineSub.textContent = `Promedio de los últimos ${r.diasMuestra} días. Tu plata sube sola al ritmo actual.`;
    } else {
      // Quema caja → días de caja restantes
      if (r.runway === 0) {
        headlineNum.textContent = 'Caja agotada';
        headlineNum.style.color = '#b91c1c';
        headlineSub.textContent = 'Sin caja líquida disponible.';
      } else {
        headlineNum.innerHTML = `${fmtNum.format(r.runway)}<span style="${unidadStyle}">días de caja</span>`;
        headlineNum.style.color = c.fg;
        const semSinCaja = (r.runway / 7).toFixed(1);
        const mesSinCaja = (r.runway / 30.4).toFixed(1);
        const tiempo = r.runway >= 60 ? `≈ ${mesSinCaja} meses` : (r.runway >= 14 ? `≈ ${semSinCaja} semanas` : 'menos de 2 semanas');
        headlineSub.textContent = `Gastas ${clp(r.quemaNetaDiaria * 30)}/mes. Te quedas sin plata en ${tiempo} si nada cambia.`;
      }
    }

    // ============ FILA DE 4 MÉTRICAS PARALELAS ============
    const cajaEl = document.getElementById('runwayCaja');
    cajaEl.textContent = clp(r.cajaLiquida);
    // Verde si hay plata, rojo si está negativo, gris si cero — el color es
    // señal visual inmediata del estado de la caja.
    cajaEl.style.color = r.cajaLiquida < 0
      ? 'var(--danger)'
      : (r.cajaLiquida > 0 ? 'var(--success)' : 'var(--text-muted)');

    const flujoEl = document.getElementById('runwayFlujo');
    const flujoNeto = r.ventasPeriodo - r.gastosPeriodo;
    flujoEl.textContent = (flujoNeto >= 0 ? '+' : '') + clp(flujoNeto);
    flujoEl.style.color = flujoNeto > 0 ? '#15803d' : (flujoNeto < 0 ? '#b91c1c' : 'var(--text-muted)');
    document.getElementById('runwayFlujoSub').textContent = `${clp(r.ventasPeriodo)} − ${clp(r.gastosPeriodo)}`;

    document.getElementById('runwayCxP').textContent = clp(r.deudaPendiente);
    document.getElementById('runwayCxP').style.color = r.deudaPendiente > 0 ? '#b91c1c' : 'var(--text-muted)';
    document.getElementById('runwayCxPSub').textContent = r.deudaPendiente > 0 ? 'a proveedores' : 'sin deudas';

    document.getElementById('runwayCxC').textContent = clp(r.cobrosPendientes || 0);
    document.getElementById('runwayCxC').style.color = (r.cobrosPendientes || 0) > 0 ? '#15803d' : 'var(--text-muted)';
    document.getElementById('runwayCxCSub').textContent = (r.cobrosPendientes || 0) > 0 ? 'de clientes' : 'sin facturas pendientes';

    // ============ POSICIÓN NETA (caja − CxP + CxC) ============
    const posNeta = r.cajaLiquida - r.deudaPendiente + (r.cobrosPendientes || 0);
    const posEl = document.getElementById('runwayPosicionValue');
    posEl.textContent = clp(posNeta);
    posEl.style.color = posNeta < 0 ? '#b91c1c' : (posNeta > 0 ? '#15803d' : 'var(--text)');

    // ============ INTERPRETACIÓN HUMANA ============
    const interp = document.getElementById('runwayInterpretation');
    const tieneGenera = r.quemaNetaDiaria <= 0;
    const cajaNeg = r.cajaLiquida < 0;
    let texto = '';

    if (tieneGenera && cajaNeg) {
      texto = `<strong>Lectura mixta:</strong> tu día a día genera plata (${clp(r.ventasPeriodo)} entraron vs ${clp(r.gastosPeriodo)} salieron en 60d), pero tu caja disponible está negativa. Probablemente el saldo inicial de alguna cuenta no está actualizado o quedaron pagos vencidos sin registrar. Revisa: <strong>Cuentas</strong> → saldo inicial; o ejecuta cobros pendientes en <strong>Por cobrar</strong>.`;
    } else if (tieneGenera && r.cajaLiquida === 0) {
      texto = `Generas caja en el flujo (+${clp(-r.quemaNetaDiaria)}/día) pero tu cuenta declarada arranca en cero. Actualiza el saldo inicial de tu cuenta principal en <strong>Cuentas</strong> para ver el panorama real.`;
    } else if (tieneGenera) {
      texto = `<strong>✓ Saludable:</strong> generas ${clp(-r.quemaNetaDiaria * 30)}/mes y tu caja líquida positiva crece sola. Posición neta consolidada: ${clp(posNeta)}.`;
    } else if (r.status === 'critico') {
      const breakeven = (r.gastosPeriodo / r.diasMuestra) * 30;
      texto = `<strong style="color:#b91c1c">🚨 Acción urgente:</strong> tu caja se agota en ${fmtNum.format(r.runway)} días al ritmo actual. Necesitas <strong>vender ${clp(breakeven)}/mes</strong> para empatar gastos, o cortar gastos fijos. ${r.cobrosPendientes > 0 ? `Tienes ${clp(r.cobrosPendientes)} por cobrar — cobrarlos te da aire.` : ''}`;
    } else if (r.status === 'alerta') {
      texto = `Caja apretada: cubre ${fmtNum.format(r.runway)} días al ritmo actual. ${r.cobrosPendientes > 0 ? `Cobrar los ${clp(r.cobrosPendientes)} pendientes te da más días de caja. ` : ''}Reduce gastos no críticos o acelera ventas — el colchón es chico.`;
    } else {
      texto = `Caja cubre ${(r.runway / 30.4).toFixed(1)} meses al ritmo actual. Saludable. Posición neta: ${clp(posNeta)}.`;
    }
    interp.innerHTML = texto;
  }

  window.renderRunwayCard = renderRunwayCard;
})();
