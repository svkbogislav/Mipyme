// src/renderer/domain/mp-retiros.js
// Retiros de Mercado Pago → cuenta bancaria de destino en la app.
//
// El informe "Todas las transacciones" de MP dice que hubo un retiro (PAYOUTS)
// pero no a qué banco fue. El informe de actividades "Retiros"
// (activities_withdraw) sí trae `bank_account`: un texto con los datos de la
// cuenta de destino. Este módulo cruza ambos informes y ubica la cuenta de la
// app cuyo número termina igual (y, si hay más de una, la del mismo banco).
//
// Lógica pura, sin DOM ni state global: se usa en el renderer
// (window.MpRetiros), en el main process y en los tests (module.exports).

(function () {
  'use strict';

  // Palabra clave por banco, de la más específica a la más genérica ("chile"
  // va al final porque "Santander Chile" o "Scotiabank Chile" también lo dicen).
  const BANCOS = [
    ['bice', 'bice'], ['santander', 'santander'],
    ['bancoestado', 'estado'], ['banco estado', 'estado'], ['banco del estado', 'estado'],
    ['bci', 'bci'], ['scotia', 'scotiabank'], ['itau', 'itau'], ['security', 'security'],
    ['falabella', 'falabella'], ['ripley', 'ripley'], ['consorcio', 'consorcio'],
    ['internacional', 'internacional'], ['btg', 'btg'], ['tenpo', 'tenpo'], ['mach', 'mach'],
    ['coopeuch', 'coopeuch'], ['mercado pago', 'mercadopago'], ['mercadopago', 'mercadopago'],
    ['edwards', 'chile'], ['banco de chile', 'chile'], ['bancochile', 'chile'], ['chile', 'chile'],
  ];
  function _plano(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }
  // Clave del banco que menciona un texto ('bice', 'santander', …) o ''.
  function bancoClave(texto) {
    const t = _plano(texto);
    if (!t) return '';
    for (const [k, v] of BANCOS) if (t.includes(k)) return v;
    return '';
  }

  // Últimos 4 dígitos del número de cuenta que aparece en un texto como
  // "Banco BICE · Cuenta corriente ···2713" o "BICE 12345678". Ignora el RUT
  // (con guion) y se queda con el último grupo de 4 o más dígitos.
  function ultimos4Cuenta(texto) {
    let t = String(texto || '');
    if (!t.trim()) return '';
    t = t.replace(/\b\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]\b/g, ' ');
    const tokens = t.split(/[\s·•|,;\/]+/).map(x => x.replace(/\D/g, '')).filter(x => x.length >= 4);
    return tokens.length ? tokens[tokens.length - 1].slice(-4) : '';
  }

  // Números (últimos 4 dígitos) con los que se reconoce una cuenta de la app:
  // el de Fintoc (links[].cuentas[].numero), un campo numero propio y el
  // "···NNNN" con que se nombran las cuentas conectadas.
  function numerosDeCuenta(cta, links) {
    const nums = [];
    (links || []).forEach(l => ((l && l.cuentas) || []).forEach(fc => {
      if (!fc || !fc.numero) return;
      if ((cta.fintoc_acc && fc.accId === cta.fintoc_acc) || (fc.appCuentaId && fc.appCuentaId === cta.id)) nums.push(String(fc.numero));
    }));
    if (cta.numero) nums.push(String(cta.numero));
    const m = String(cta.nombre || '').match(/(?:[·•*.\-#°º]|n[°º]?|\s)\s*(\d{4,})\s*$/i);
    if (m) nums.push(m[1]);
    return Array.from(new Set(nums.map(n => n.replace(/\D/g, '')).filter(n => n.length >= 4).map(n => n.slice(-4))));
  }

  // Id de la cuenta de la app a la que fue un retiro, según el texto
  // bank_account del informe de MP. null si no calza con ninguna o con varias.
  function cuentaDestino(bank_account, cuentas, links, excluirId) {
    const u4 = ultimos4Cuenta(bank_account);
    if (!u4) return null;
    let cands = (cuentas || []).filter(c => c && c.id && c.id !== excluirId && numerosDeCuenta(c, links).includes(u4));
    if (cands.length > 1) {
      const banco = bancoClave(bank_account);
      if (banco) {
        const mismoBanco = cands.filter(c => bancoClave(`${c.banco || ''} ${c.nombre || ''}`) === banco);
        if (mismoBanco.length) cands = mismoBanco;
      }
    }
    return cands.length === 1 ? cands[0].id : null;
  }

  function _dias(a, b) {
    const x = new Date(String(a).slice(0, 10) + 'T12:00:00Z');
    const y = new Date(String(b).slice(0, 10) + 'T12:00:00Z');
    return Math.round((y - x) / 86400000);
  }
  // Para cada movimiento de retiro (mov._raw.retiro) busca su fila en el
  // informe de retiros (misma plata ±1%, ±1 día) y le anota:
  //   mov._raw.destino      → id de la cuenta de la app (null si no calza)
  //   mov._raw.bank_account → texto tal cual vino de MP
  //   mov._raw.retiro_id    → operation_id del retiro
  // Cada fila del informe se usa una sola vez. Devuelve cuántos quedaron con destino.
  function ligarRetiros(movs, retiros, cuentas, links, excluirId) {
    const usados = new Set();
    let n = 0;
    (movs || []).forEach(mov => {
      if (!mov || !mov._raw || !mov._raw.retiro) return;
      const monto = Math.abs(Math.round(Number(mov.monto) || 0));
      if (!monto) return;
      const tol = Math.max(1, Math.round(monto * 0.01));
      const difMonto = (r) => Math.min(Math.abs((Number(r.monto) || 0) - monto), Math.abs((Number(r.neto) || 0) - monto));
      const cand = (retiros || []).map((r, i) => ({ r, i }))
        .filter(({ r, i }) => r && !usados.has(i) && Math.abs(_dias(r.fecha, mov.fecha)) <= 1 && difMonto(r) <= tol)
        .sort((a, b) => (Math.abs(_dias(a.r.fecha, mov.fecha)) - Math.abs(_dias(b.r.fecha, mov.fecha))) || (difMonto(a.r) - difMonto(b.r)))[0];
      if (!cand) return;
      usados.add(cand.i);
      mov._raw.bank_account = cand.r.bank_account || '';
      mov._raw.retiro_id = cand.r.operation_id || '';
      mov._raw.destino = cuentaDestino(cand.r.bank_account, cuentas, links, excluirId);
      if (mov._raw.destino) n++;
    });
    return n;
  }

  const api = { bancoClave, ultimos4Cuenta, numerosDeCuenta, cuentaDestino, ligarRetiros };
  if (typeof window !== 'undefined') window.MpRetiros = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
