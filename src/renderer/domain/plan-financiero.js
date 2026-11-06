// src/renderer/domain/plan-financiero.js
// Diagnóstico y plan financiero personal (tarjeta "Tu salud financiera" del
// dashboard en modo personal). Funciones puras: todo lo que necesitan llega
// por parámetro, así se pueden probar con datos reales fuera de la app.
//
// API: window.PlanFinanciero = {
//   calcular(input) → { meses, ingresoMes, gastoMes, resultadoMes, liquidez,
//     tarjetas, deudas, proximos, pasos, alertasGasto, datos, indicadores,
//     score, diagnostico },
//   ingresosRegulares(state, hoy), firmaPasivos(state, saldoCuenta, saldoDeuda),
//   sumarDias(ymd, n), diasEntre(a, b)
// }
//
// input = {
//   state, hoy: 'YYYY-MM-DD',
//   saldoCuenta(id) → número          (calcularSaldoCuenta del renderer)
//   saldoDeuda(d) → número            (Deudas.saldoPendiente)
//   proximoPago(d, hoy) → 'YYYY-MM-DD' (Deudas.proximoPago)
//   ingresosPorMes: { 'YYYY-MM': monto }  (ventasPorMes del renderer)
//   cargos: CargosRegulares.detectar(state)
//   creditoSinCuotaPara(cargo) → deuda | null
//   patrimonio: { neto, activos, pasivos }, snaps: [{ ym, neto, firma }]
// }

(function () {
  'use strict';

  const DIA = 86400000;
  const CAT_TARJETA = 'Pago tarjeta de crédito';
  const CAT_DEUDAS = 'Deudas / Créditos';
  const RX_CREDITO = /PRESTAMO|PRÉSTAMO|CREDITO|CRÉDITO|LINEA DE CRED|LÍNEA DE CRÉD|HIPOTEC|DIVIDENDO|AMORTIZACION/i;
  const RX_NO_CUOTA = /IMPUESTO|INTERES|INTERÉS|COMISION|COMISIÓN/i;
  const LIQUIDAS = new Set(['caja', 'banco', 'webpay', 'mercadopago', 'stripe', 'otro']);

  function n(x) { const v = Number(x); return isFinite(v) ? v : 0; }
  function sumarDias(ymd, k) {
    const d = new Date(ymd + 'T12:00:00');
    d.setDate(d.getDate() + k);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function diasEntre(a, b) { return Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / DIA); }
  function sumarMes(ymd, dia) {
    const y = Number(ymd.slice(0, 4)), m = Number(ymd.slice(5, 7)); // m: 1-12 → mes siguiente
    const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
    const ult = new Date(ny, nm, 0).getDate();
    return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(dia, ult)).padStart(2, '0')}`;
  }
  // Nombre legible de un crédito detectado por su glosa.
  function nombreCredito(c) {
    const t = `${c.glosa || ''} ${c.nombre || ''}`;
    if (/LINEA DE CRED|LÍNEA DE CRÉD/i.test(t)) return 'línea de crédito';
    if (/HIPOTEC|DIVIDENDO/i.test(t)) return 'crédito hipotecario';
    if (/PRESTAMO|PRÉSTAMO|CREDITO|CRÉDITO/i.test(t)) return 'crédito';
    return String(c.nombre || 'crédito').replace(/[:\s]+$/, '').toLowerCase();
  }
  function mediana(a) {
    const s = a.slice().sort((x, y) => x - y);
    if (!s.length) return 0;
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  // Próxima fecha de algo que se repite cada mes. Si la fecha esperada ya
  // pasó hace poco (≤ 3 días) se muestra como "por estos días"; si pasó hace
  // más, se corre al mes siguiente.
  function proximaDesde(fecha, dia, hoy) {
    let f = fecha;
    let guard = 0;
    while (f && f < hoy && diasEntre(f, hoy) > 3 && guard++ < 24) f = sumarMes(f, dia || Number(f.slice(8, 10)));
    return f;
  }

  // Ingresos que se repiten cada mes (sueldo, arriendo, mesada…): monto
  // parecido (±25 %) y día del mes parecido (±6) en al menos 2 meses de los
  // últimos 4. Solo estos cuentan como "plata que va a entrar".
  function ingresosRegulares(state, hoy) {
    const limite = sumarDias(hoy, -125);
    const ingresos = (state.ventasManuales || []).filter(v => v && typeof v.fecha === 'string'
      && v.fecha >= limite && v.fecha <= hoy && n(v.monto) >= 50000 && v.tipo_ingreso !== 'negocio');
    const grupos = [];
    ingresos.slice().sort((a, b) => n(b.monto) - n(a.monto)).forEach(v => {
      const m = n(v.monto);
      const g = grupos.find(x => Math.abs(m - x.ref) <= x.ref * 0.25);
      if (g) { g.items.push(v); g.ref = mediana(g.items.map(x => n(x.monto))); }
      else grupos.push({ ref: m, items: [v] });
    });
    const out = [];
    grupos.forEach(g => {
      const porMes = {};
      g.items.forEach(v => { const ym = v.fecha.slice(0, 7); (porMes[ym] = porMes[ym] || []).push(v); });
      const meses = Object.keys(porMes);
      if (meses.length < 2) return;
      if (g.items.length > meses.length * 1.5) return; // varias veces al mes: no es un ingreso fijo
      const dias = g.items.map(v => Number(v.fecha.slice(8, 10)));
      const diaMed = Math.round(mediana(dias));
      const cerca = dias.filter(d => Math.abs(d - diaMed) <= 6).length;
      if (cerca / dias.length < 0.6) return;
      const ultimo = g.items.slice().sort((a, b) => a.fecha.localeCompare(b.fecha)).pop();
      const monto = Math.round(mediana(g.items.map(v => n(v.monto))));
      const proxima = proximaDesde(sumarMes(ultimo.fecha, diaMed), diaMed, hoy);
      const desc = String(ultimo.descripcion || ultimo.cliente || '').replace(/^Mercado Pago · /, '').slice(0, 40);
      out.push({ monto, diaMes: diaMed, meses: meses.length, ultima: ultimo.fecha, proxima, nombre: desc || 'Ingreso que se repite', tipo: ultimo.tipo_ingreso || '' });
    });
    return out.sort((a, b) => b.monto - a.monto);
  }

  // Firma de los pasivos registrados: si cambia (registraste una deuda o una
  // tarjeta nueva), comparar el patrimonio contra una foto anterior mentiría.
  function firmaPasivos(state, saldoCuenta, saldoDeuda) {
    const ids = [];
    (state.deudas || []).forEach(d => { if (saldoDeuda(d) > 0) ids.push('d:' + d.id); });
    ((state.config && state.config.cuentas) || []).forEach(c => { if (c.tipo === 'tarjeta' && !c.otra_entidad) ids.push('t:' + c.id); });
    return ids.sort().join('|');
  }

  function calcular(input) {
    const st = input.state;
    const hoy = input.hoy;
    const hoyYM = hoy.slice(0, 7);
    const cfg = st.config || {};
    const cuentas = cfg.cuentas || [];
    const saldoCuenta = input.saldoCuenta;
    const saldoDeuda = input.saldoDeuda;

    // ── Últimos 3 meses completos: lo que entró, lo que salió ──
    const ingPM = Object.assign({}, input.ingresosPorMes || {});
    const gasPM = {}, tarjPM = {}, catPM = {};
    (st.gastos || []).forEach(g => {
      const ym = String(g.fecha || '').slice(0, 7);
      if (!ym) return;
      const m = n(g.monto);
      gasPM[ym] = (gasPM[ym] || 0) + m;
      if (g.categoria === CAT_TARJETA) tarjPM[ym] = (tarjPM[ym] || 0) + m;
      const c = g.categoria || 'Por clasificar';
      (catPM[ym] = catPM[ym] || {})[c] = (catPM[ym][c] || 0) + m;
    });
    const conIngreso = Object.keys(ingPM).filter(ym => ingPM[ym] > 0).sort();
    const primerMes = conIngreso[0] || null;
    const meses = [...new Set([...Object.keys(ingPM), ...Object.keys(gasPM)])]
      .filter(ym => ym < hoyYM && (!primerMes || ym >= primerMes) && (n(ingPM[ym]) || n(gasPM[ym])))
      .sort().slice(-3)
      .map(ym => ({ ym, ingreso: n(ingPM[ym]), gasto: n(gasPM[ym]), resultado: n(ingPM[ym]) - n(gasPM[ym]) }));
    const prom = (f) => meses.length ? meses.reduce((s, x) => s + f(x), 0) / meses.length : 0;
    const ingresoMes = prom(x => x.ingreso);
    const gastoMes = prom(x => x.gasto);
    const resultadoMes = ingresoMes - gastoMes;
    const tarjetasMes = prom(x => n(tarjPM[x.ym]));

    // ── Plata disponible hoy ──
    const liquidas = cuentas.filter(c => LIQUIDAS.has(c.tipo) && !c.excluir_del_total && !c.otra_entidad);
    const descuadradas = [];
    let disponible = 0;
    liquidas.forEach(c => {
      const s = n(saldoCuenta(c.id));
      const delBanco = c.saldo_banco !== undefined && c.saldo_banco !== null && c.saldo_banco !== '';
      // Una cuenta calculada (sin saldo del banco) no puede quedar bajo cero:
      // si pasa, el cálculo perdió algún movimiento. Cuenta como 0 y se avisa.
      if (!delBanco && s < 0) { descuadradas.push({ id: c.id, nombre: c.nombre, tipo: c.tipo, saldo: s }); return; }
      disponible += s;
    });
    const diasColchon = gastoMes > 0 ? Math.max(0, disponible) / (gastoMes / 30) : null;
    const mesesColchon = gastoMes > 0 ? Math.max(0, disponible) / gastoMes : null;

    // ── Tarjetas ──
    const tarjetas = cuentas.filter(c => c.tipo === 'tarjeta' && !c.otra_entidad).map(c => {
      const deuda = Math.max(0, -n(saldoCuenta(c.id)));
      const cupo = n(c.cupo);
      const tasaM = (c.tasa_mensual !== undefined && c.tasa_mensual !== null && c.tasa_mensual !== '') ? n(c.tasa_mensual) : null;
      return { id: c.id, nombre: c.nombre, banco: c.banco || '', deuda, cupo, uso: cupo > 0 ? deuda / cupo : null, tasaM, interesMes: tasaM != null ? deuda * tasaM / 100 : null };
    });
    const conTasa = tarjetas.filter(t => t.deuda > 0).every(t => t.tasaM != null);
    const ordenTarjetas = tarjetas.filter(t => t.deuda > 0).sort((a, b) => conTasa
      ? ((b.tasaM - a.tasaM) || (a.deuda - b.deuda))
      : ((n(b.uso > 1) - n(a.uso > 1)) || (n(b.uso) - n(a.uso)) || (a.deuda - b.deuda)));
    const deudaTarjetas = tarjetas.reduce((s, t) => s + t.deuda, 0);
    const cupoConocido = tarjetas.filter(t => t.cupo > 0);
    const usoTarjetas = cupoConocido.length ? cupoConocido.reduce((s, t) => s + t.deuda, 0) / cupoConocido.reduce((s, t) => s + t.cupo, 0) : null;
    const interesTarjetasMes = conTasa && tarjetas.some(t => t.deuda > 0) ? tarjetas.reduce((s, t) => s + n(t.interesMes), 0) : null;

    // ── Créditos y cuotas ──
    const pendientes = (st.deudas || []).filter(d => saldoDeuda(d) > 0);
    const cargos = input.cargos || [];
    const esCredito = (c) => c.monto >= 5000 && !RX_NO_CUOTA.test(`${c.glosa || ''} ${c.nombre || ''}`)
      && (c.categoria === CAT_DEUDAS || RX_CREDITO.test(c.glosa || '') || RX_CREDITO.test(c.nombre || ''));
    const cubiertoPorDeuda = (c) => pendientes.some(d => n(d.cuota_mensual) > 0 && Math.abs(n(d.cuota_mensual) - c.monto) <= c.monto * 0.05);
    const creditosDet = cargos.filter(c => esCredito(c) && !cubiertoPorDeuda(c)).map(c => ({
      cargo: c, deuda: input.creditoSinCuotaPara ? input.creditoSinCuotaPara(c) : null,
    }));
    // Cada crédito recibe una sola cuota detectada (la más grande, que llega
    // primero): las demás son otros créditos todavía sin registrar.
    const deudaUsada = new Set();
    creditosDet.forEach(x => {
      if (!x.deuda) return;
      if (deudaUsada.has(x.deuda.id)) x.deuda = null; else deudaUsada.add(x.deuda.id);
    });
    const deudas = pendientes.map(d => {
      const det = creditosDet.find(x => x.deuda && x.deuda.id === d.id);
      const tasa = (d.tasa_anual !== undefined && d.tasa_anual !== null && d.tasa_anual !== '') ? n(d.tasa_anual) : null;
      return { id: d.id, acreedor: d.acreedor || 'Deuda', saldo: saldoDeuda(d), cuota: n(d.cuota_mensual), cuotaDetectada: det ? det.cargo.monto : null, diaDetectado: det ? det.cargo.diaMes : null, tasa, d };
    });
    const cuotasMes = deudas.reduce((s, x) => s + (x.cuota || x.cuotaDetectada || 0), 0)
      + creditosDet.filter(x => !x.deuda).reduce((s, x) => s + x.cargo.monto, 0);
    const deudaCreditos = deudas.reduce((s, x) => s + x.saldo, 0);
    const deudaTotal = deudaCreditos + deudaTarjetas;

    // ── Próximos 30 días: lo que vence y lo que entra ──
    const hasta = sumarDias(hoy, 30);
    const proximos = [];
    deudas.forEach(x => {
      if (!(x.cuota > 0) || !input.proximoPago) return;
      const f = input.proximoPago(x.d, hoy);
      if (!f || f > hasta) return;
      proximos.push({ fecha: f < hoy ? hoy : f, atrasada: f < hoy && diasEntre(f, hoy) > 3, nombre: `Cuota ${x.acreedor}`, monto: -Math.min(x.cuota, x.saldo), tipo: 'cuota' });
    });
    creditosDet.forEach(x => {
      const f = proximaDesde(x.cargo.proxima, x.cargo.diaMes, hoy);
      if (!f || f > hasta) return;
      proximos.push({ fecha: f, nombre: x.deuda ? `Cuota ${x.deuda.acreedor}` : `Cuota ${nombreCredito(x.cargo)}`, monto: -x.cargo.monto, tipo: 'cuota', detectada: true });
    });
    const usados = new Set(creditosDet.map(x => x.cargo));
    cargos.filter(c => !usados.has(c) && !esCredito(c) && c.categoria !== CAT_TARJETA && c.monto >= 1000).forEach(c => {
      const f = proximaDesde(c.proxima, c.diaMes, hoy);
      if (!f || f > hasta) return;
      proximos.push({ fecha: f, nombre: c.nombre, monto: -c.monto, tipo: 'regular', categoria: c.categoria || '' });
    });
    const ingresosReg = ingresosRegulares(st, hoy);
    ingresosReg.forEach(r => {
      if (!r.proxima || r.proxima > hasta) return;
      proximos.push({ fecha: r.proxima, nombre: r.nombre, monto: r.monto, tipo: 'ingreso', diaMes: r.diaMes });
    });
    proximos.sort((a, b) => a.fecha.localeCompare(b.fecha) || (a.monto - b.monto));
    // Saldo corrido: el punto más bajo dice si alcanza antes de que entre plata.
    let corrido = disponible, minimo = disponible, fechaMinimo = null;
    proximos.forEach(p => { corrido += p.monto; p.saldo = corrido; if (corrido < minimo) { minimo = corrido; fechaMinimo = p.fecha; } });
    const pagosFijos30 = -proximos.filter(p => p.monto < 0).reduce((s, p) => s + p.monto, 0);
    const entra30 = proximos.filter(p => p.monto > 0).reduce((s, p) => s + p.monto, 0);
    const quedaria = corrido - tarjetasMes; // y además lo que sueles pagar a tus tarjetas
    const hayAtrasadas = proximos.some(p => p.atrasada);

    // ── Dónde se te está yendo la plata este mes ──
    const alertasGasto = [];
    const ymsProm = meses.map(x => x.ym);
    Object.entries(catPM[hoyYM] || {}).forEach(([cat, monto]) => {
      if (cat === CAT_TARJETA || cat === CAT_DEUDAS) return;
      const promCat = ymsProm.length ? ymsProm.reduce((s, ym) => s + n((catPM[ym] || {})[cat]), 0) / ymsProm.length : 0;
      if (monto > promCat * 1.5 && monto - promCat > 100000) alertasGasto.push({ categoria: cat, monto, promedio: promCat, veces: promCat > 0 ? monto / promCat : null });
    });
    alertasGasto.sort((a, b) => (b.monto - b.promedio) - (a.monto - a.promedio));

    // ── Datos que faltan para que los números sean exactos ──
    const datos = [];
    const mp = cfg.mercadopago || {};
    const hayEntidad = cuentas.some(c => c.otra_entidad);
    if (mp.token && mp.cuenta && mp.cuenta.nombre && !hayEntidad && !mp.destinoRetiros && !mp.todoPersonal) {
      datos.push({ clave: 'negocio', titulo: `¿Parte de lo que entra a Mercado Pago es de tu emprendimiento?`, detalle: `Tu Mercado Pago está a nombre de ${mp.cuenta.nombre}. Si esa plata pasa a una cuenta del negocio, créala como "de otra entidad" y deja de contarse como ingreso tuyo.`, afecta: true });
    }
    descuadradas.forEach(c => datos.push({ clave: 'saldo', cuentaId: c.id, tipo: c.tipo, titulo: `El saldo de ${c.nombre} no calza`, detalle: `La app calcula ${Math.round(c.saldo).toLocaleString('es-CL')} pesos bajo cero. Escribe el saldo real y queda exacto.`, afecta: true }));
    deudas.filter(x => !(x.cuota > 0) && x.cuotaDetectada).forEach(x => datos.push({ clave: 'cuota', deudaId: x.id, monto: x.cuotaDetectada, dia: x.diaDetectado, titulo: `Asigna la cuota de ${x.acreedor}`, detalle: `En tus movimientos se repite un pago de ${Math.round(x.cuotaDetectada).toLocaleString('es-CL')} pesos cerca del día ${x.diaDetectado}.`, afecta: true }));
    creditosDet.filter(x => !x.deuda).forEach(x => datos.push({ clave: 'credito', cargo: x.cargo, titulo: `Registra tu ${nombreCredito(x.cargo)}`, detalle: `Pagas ${Math.round(x.cargo.monto).toLocaleString('es-CL')} pesos cerca del día ${x.cargo.diaMes}, pero no sé cuánto debes ahí.`, afecta: true }));
    tarjetas.filter(t => t.deuda > 0 && !(t.cupo > 0)).forEach(t => datos.push({ clave: 'cupo', cuentaId: t.id, titulo: `Pon el cupo de ${t.nombre}`, detalle: 'Sin cupo no puedo decirte qué tan al límite está.', afecta: false }));
    const sinTasaT = tarjetas.filter(t => t.deuda > 0 && t.tasaM == null);
    if (sinTasaT.length) datos.push({ clave: 'tasaTarjeta', cuentaId: sinTasaT[0].id, titulo: `Pon el interés mensual de ${sinTasaT.length === 1 ? sinTasaT[0].nombre : `tus ${sinTasaT.length} tarjetas`}`, detalle: 'Sale en el estado de cuenta como "tasa de interés mensual". Con eso calculo cuánto te cuestan al mes y cuál pagar primero.', afecta: false });
    const sinTasaD = deudas.filter(x => x.tasa == null);
    if (sinTasaD.length) datos.push({ clave: 'tasaDeuda', titulo: `Pon el interés anual de ${sinTasaD.length === 1 ? sinTasaD[0].acreedor : `tus ${sinTasaD.length} créditos`}`, detalle: 'Sale en la hoja de tu crédito como "tasa de interés" o "CAE".', afecta: false });
    const desde3 = sumarDias(hoy, -90);
    const porClasificar = (st.gastos || []).filter(g => (g.categoria === 'Por clasificar' || !g.categoria) && String(g.fecha || '') >= desde3).length;
    if (porClasificar) datos.push({ clave: 'clasificar', titulo: `${porClasificar} gasto${porClasificar === 1 ? '' : 's'} sin clasificar`, detalle: 'Clasifícalos para saber en qué se te va la plata.', afecta: false });

    // ── Indicadores con semáforo (puntos por indicador) ──
    const ind = {};
    if (ingresoMes > 0) {
      const r = resultadoMes / ingresoMes;
      ind.resultado = { r, nivel: r >= 0.2 ? 'ok' : (r >= 0.1 ? 'warn' : 'bad'), pts: r >= 0.2 ? 25 : (r >= 0.1 ? 18 : (r >= 0 ? 10 : 0)), max: 25 };
    } else ind.resultado = { nivel: 'na', pts: null, max: 25 };
    if (gastoMes > 0) {
      const m = mesesColchon;
      ind.colchon = { meses: m, dias: diasColchon, nivel: m >= 3 ? 'ok' : (m >= 1 ? 'warn' : 'bad'), pts: m >= 3 ? 20 : (m >= 1 ? 12 : (m >= 0.5 ? 6 : 0)), max: 20 };
    } else ind.colchon = { nivel: 'na', pts: null, max: 20 };
    if (deudaTotal <= 0) ind.deuda = meses.length ? { nivel: 'ok', pts: 25, max: 25, carga: 0, stock: 0 } : { nivel: 'na', pts: null, max: 25 };
    else if (ingresoMes > 0) {
      const carga = cuotasMes / ingresoMes;
      const stock = deudaTotal / (ingresoMes * 12);
      const nC = carga < 0.2 ? 0 : (carga <= 0.35 ? 1 : 2);
      const nS = stock < 0.3 ? 0 : (stock < 0.6 ? 1 : 2);
      const peor = Math.max(nC, nS);
      ind.deuda = { carga, stock, nivel: ['ok', 'warn', 'bad'][peor], pts: [25, 14, 4][peor], max: 25 };
    } else ind.deuda = { nivel: 'na', pts: null, max: 25 };
    if (!tarjetas.some(t => t.deuda > 0)) ind.tarjetas = { nivel: tarjetas.length ? 'ok' : 'na', pts: tarjetas.length && meses.length ? 20 : null, max: 20, uso: 0 };
    else if (usoTarjetas == null) ind.tarjetas = { nivel: 'na', pts: null, max: 20 };
    else {
      const u = usoTarjetas;
      const sobre = tarjetas.some(t => t.uso != null && t.uso > 1);
      ind.tarjetas = { uso: u, sobre, nivel: (u >= 0.7 || sobre) ? 'bad' : (u >= 0.3 ? 'warn' : 'ok'), pts: sobre || u >= 0.9 ? 0 : (u >= 0.7 ? 5 : (u >= 0.3 ? 12 : 20)), max: 20 };
    }
    const firma = firmaPasivos(st, saldoCuenta, saldoDeuda);
    const pat = input.patrimonio || { neto: 0 };
    const prevYM = (() => { const y = Number(hoyYM.slice(0, 4)), m = Number(hoyYM.slice(5, 7)); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; })();
    const prev = (input.snaps || []).find(s => s && s.ym === prevYM) || null;
    if (prev && prev.firma && prev.firma === firma) {
      const delta = n(pat.neto) - n(prev.neto);
      ind.patrimonio = { delta, comparable: true, nivel: delta > 0 ? 'ok' : (delta === 0 ? 'warn' : 'bad'), pts: delta > 0 ? 10 : (delta === 0 ? 6 : 2), max: 10 };
    } else ind.patrimonio = { comparable: false, motivo: prev ? 'cambio' : 'sinFoto', nivel: 'na', pts: null, max: 10 };

    const conPts = Object.values(ind).filter(i => i.pts != null);
    // Sin un mes completo con ingresos o gastos no hay diagnóstico posible.
    const score = conPts.length && meses.length ? Math.round(conPts.reduce((s, i) => s + i.pts, 0) / conPts.reduce((s, i) => s + i.max, 0) * 100) : null;
    const aprox = datos.some(x => x.afecta);

    // ── Plan paso a paso (orden clásico: no atrasarse → colchón → deuda cara → fondo → créditos) ──
    const deudaCreditosVivos = deudas.filter(x => x.saldo > 0);
    const pasos = [
      { clave: 'mes', titulo: 'Cubrir los pagos de los próximos 30 días', hecho: minimo >= 0 && !hayAtrasadas,
        detalle: minimo >= 0 ? 'Con lo que tienes y lo que te entra, alcanza para tus pagos fijos.' : `Te faltan ${Math.round(-minimo).toLocaleString('es-CL')} pesos${fechaMinimo ? ` hacia el ${Number(fechaMinimo.slice(8, 10))}` : ''}.` },
      // Colchón inicial chico (2 semanas de gastos): lo justo para no volver
      // a la tarjeta ante un imprevisto, y después todo a la deuda cara.
      { clave: 'colchon', titulo: 'Juntar un colchón de 2 semanas de gastos', meta: Math.round(gastoMes / 2), actual: Math.max(0, disponible), hecho: gastoMes > 0 && disponible >= gastoMes / 2 },
      { clave: 'tarjetas', titulo: 'Salir de las tarjetas', hecho: deudaTarjetas <= 0, orden: ordenTarjetas, conTasa, deuda: deudaTarjetas, interesMes: interesTarjetasMes },
      { clave: 'fondo', titulo: 'Fondo de emergencia de 3 meses', meta: Math.round(gastoMes * 3), actual: Math.max(0, disponible), hecho: gastoMes > 0 && disponible >= gastoMes * 3 },
      { clave: 'creditos', titulo: deudaCreditosVivos.length ? 'Terminar los créditos y empezar a invertir' : 'Invertir lo que te sobra', hecho: false, creditos: deudaCreditosVivos },
    ];
    const iActual = pasos.findIndex(p => !p.hecho);
    pasos.forEach((p, i) => { p.estado = p.hecho ? 'hecho' : (i === iActual ? 'ahora' : 'despues'); });

    // ── Diagnóstico en una frase ──
    const frases = [];
    let nivelDx = 'ok';
    if (minimo < 0) { frases.push(`tus pagos de los próximos 30 días superan lo que tienes y lo que te va a entrar`); nivelDx = 'bad'; }
    if (usoTarjetas != null && (usoTarjetas >= 0.9 || ind.tarjetas.sobre)) { frases.push(`tus tarjetas están al tope (${Math.round(usoTarjetas * 100)}% del cupo)`); nivelDx = 'bad'; }
    if (ind.resultado.r != null && ind.resultado.r < 0) { frases.push('gastas más de lo que te entra'); nivelDx = 'bad'; }
    if (ind.colchon.meses != null && ind.colchon.meses < 1 && frases.length < 2) { const d = Math.max(0, Math.round(diasColchon)); frases.push(`tu plata disponible alcanza para ${d} día${d === 1 ? '' : 's'} de gastos`); if (nivelDx === 'ok') nivelDx = 'warn'; }
    if (deudaTotal > 0 && ind.deuda.nivel !== 'ok' && frases.length < 2) { frases.push(`debes el equivalente a ${Math.round(ind.deuda.stock * 12 * 10) / 10} meses de lo que te entra`); if (nivelDx === 'ok') nivelDx = 'warn'; }
    const pasoActual = pasos[iActual] || null;
    const diagnostico = !meses.length
      ? { nivel: 'na', texto: 'Todavía no tengo un mes completo de datos para diagnosticarte. Conecta tus bancos o registra lo que te entra y lo que gastas.', foco: null }
      : {
        nivel: nivelDx,
        texto: frases.length ? frases.slice(0, 2).join(' y ').replace(/^./, c => c.toUpperCase()) + '.' : 'Vas bien: tus números están sanos.',
        foco: pasoActual ? pasoActual.titulo : null,
      };

    return {
      hoy, meses, ingresoMes, gastoMes, resultadoMes, tarjetasMes,
      liquidez: { disponible, descuadradas, diasColchon, mesesColchon },
      tarjetas, ordenTarjetas, deudaTarjetas, usoTarjetas, interesTarjetasMes,
      deudas, creditosDet, cuotasMes, deudaCreditos, deudaTotal,
      proximos, minimo, fechaMinimo, pagosFijos30, entra30, quedaria, hayAtrasadas, ingresosReg,
      alertasGasto, datos, indicadores: ind, score, aprox, pasos, pasoActual, diagnostico, firma,
    };
  }

  window.PlanFinanciero = { calcular, ingresosRegulares, firmaPasivos, sumarDias, diasEntre };
})();
