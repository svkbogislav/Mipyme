// src/renderer/domain/cargos-regulares.js
// Detecta cargos que se repiten cada mes (suscripciones, cuotas, servicios)
// mirando los gastos reales: mismo comercio, monto parecido (±12 %) y fecha
// parecida (±5 días), en al menos 2 meses distintos y a lo más una vez por
// mes. No usa listas de comercios: aprende de lo que el usuario ya pagó.
//
// API: window.CargosRegulares = { detectar(state), sugerirCategoria(glosa, monto, state), nombreLegible(gasto) }

(function () {
  'use strict';

  const MESES_MIN = 2;
  const TOLERANCIA_MONTO = 0.12;
  const TOLERANCIA_DIAS = 5;

  function clave(g) {
    const s = g.descripcion || g.proveedor || '';
    return window.Categorizador ? window.Categorizador.claveComercio(s) : String(s).toUpperCase().slice(0, 20);
  }
  function mediana(a) {
    const s = a.slice().sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function diffMeses(a, b) {
    return (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7)));
  }
  function proximaFecha(ultima, dia) {
    const d = new Date(ultima + 'T12:00:00');
    d.setDate(1); d.setMonth(d.getMonth() + 1);
    const y = d.getFullYear(), m = d.getMonth();
    const ultimoDia = new Date(y, m + 1, 0).getDate();
    return `${y}-${String(m + 1).padStart(2, '0')}-${String(Math.min(dia, ultimoDia)).padStart(2, '0')}`;
  }
  // "PAGO:APPLE.COM/BILL 12345" → "APPLE.COM/BILL"
  function nombreLegible(g) {
    let s = String((g && (g.descripcion || g.proveedor)) || '');
    s = s.replace(/^(PAGO|COMPRA|PAC|PAT|PAGO AUTOMATICO|PAGO AUTOMÁTICO|CARGO|TRASPASO INTERNET)[:\s]+/i, '');
    s = s.replace(/\b\d[\d.\-\/:]*\b/g, ' ').replace(/[*#]+/g, ' ').replace(/\s+/g, ' ').trim();
    return s.slice(0, 40) || 'Cargo';
  }

  function detectar(state) {
    const hoy = new Date();
    const limite = `${hoy.getFullYear() - 1}-${String(hoy.getMonth() + 1).padStart(2, '0')}-01`;
    const gastos = ((state && state.gastos) || []).filter(g =>
      g && !g.auto_estimado && !g.recurring_id && typeof g.fecha === 'string' && g.fecha >= limite && Number(g.monto) > 0);
    const porClave = {};
    gastos.forEach(g => { const k = clave(g); if (!k) return; (porClave[k] = porClave[k] || []).push(g); });
    const out = [];
    Object.entries(porClave).forEach(([k, lista]) => {
      // Un comercio puede tener varias suscripciones: se separa por monto.
      const clusters = [];
      lista.slice().sort((a, b) => Number(a.monto) - Number(b.monto)).forEach(g => {
        const m = Number(g.monto);
        const c = clusters.find(x => Math.abs(m - x.ref) <= x.ref * TOLERANCIA_MONTO);
        if (c) { c.items.push(g); c.ref = mediana(c.items.map(x => Number(x.monto))); }
        else clusters.push({ ref: m, items: [g] });
      });
      clusters.forEach(c => {
        const items = c.items.slice().sort((a, b) => a.fecha.localeCompare(b.fecha));
        const meses = {};
        items.forEach(g => { const ym = g.fecha.slice(0, 7); meses[ym] = (meses[ym] || 0) + 1; });
        const ymList = Object.keys(meses).sort();
        if (ymList.length < MESES_MIN) return;
        if (items.length > ymList.length * 1.5) return; // varias veces al mes: no es cuota fija
        let huecos = 0;
        for (let i = 1; i < ymList.length; i++) {
          const d = diffMeses(ymList[i - 1], ymList[i]);
          if (d > 2) return;
          if (d === 2) huecos++;
        }
        if (huecos > 1) return;
        const dias = items.map(g => Number(g.fecha.slice(8, 10)));
        const diaMed = Math.round(mediana(dias));
        const cerca = dias.filter(d => Math.min(Math.abs(d - diaMed), 31 - Math.abs(d - diaMed)) <= TOLERANCIA_DIAS).length;
        if (cerca / dias.length < 0.6) return;
        const monto = Math.round(mediana(items.map(g => Number(g.monto))));
        const cats = {};
        items.forEach(g => { const cat = g.categoria || ''; if (cat && cat !== 'Por clasificar') cats[cat] = (cats[cat] || 0) + 1; });
        const top = Object.entries(cats).sort((a, b) => b[1] - a[1])[0];
        const ultimo = items[items.length - 1];
        out.push({
          clave: k, nombre: nombreLegible(ultimo), monto, diaMes: diaMed, veces: items.length, meses: ymList.length,
          ultima: ultimo.fecha, proxima: proximaFecha(ultimo.fecha, diaMed), categoria: top ? top[0] : '',
          ids: items.map(g => g.id), account_id: ultimo.account_id || '', glosa: ultimo.descripcion || ultimo.proveedor || ''
        });
      });
    });
    out.sort((a, b) => b.monto - a.monto);
    return out;
  }

  // Categoría para una glosa nueva que calza con un cargo regular conocido:
  // la que ya tiene ese cargo; si no tiene, en perfil personal "Suscripciones y apps".
  function sugerirCategoria(glosa, monto, state) {
    if (!window.Categorizador) return null;
    const k = window.Categorizador.claveComercio(glosa);
    if (!k) return null;
    const abs = Math.abs(Number(monto) || 0);
    const lista = detectar(state).filter(c => c.clave === k && (!abs || Math.abs(abs - c.monto) <= c.monto * TOLERANCIA_MONTO));
    if (!lista.length) return null;
    const con = lista.find(c => c.categoria);
    if (con) return { categoria: con.categoria, fuente: 'regular' };
    const personal = !!(state && state.config && state.config.perfil === 'personal');
    return personal ? { categoria: 'Suscripciones y apps', fuente: 'regular' } : null;
  }

  window.CargosRegulares = { detectar, sugerirCategoria, nombreLegible };
})();
