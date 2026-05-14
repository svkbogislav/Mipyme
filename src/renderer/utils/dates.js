// src/renderer/utils/dates.js
// Helpers de fechas para el formato que usa el estado:
//   - fechas como strings 'YYYY-MM-DD' (a veces 'YYYY-MM-DDTHH:MM:SSZ' de Shopify)
//   - meses como 'YYYY-MM'
// Mantenerlo como strings (no Date objects) evita problemas de timezone.

(function () {
  'use strict';

  // Extrae 'YYYY-MM' del string ISO o vacío si no aplica.
  function ymOf(dateStr) { return (dateStr || '').slice(0, 7); }

  // Extrae 'YYYY-MM-DD' del string ISO o vacío si no aplica.
  function ymdOf(dateStr) { return (dateStr || '').slice(0, 10); }

  // 'YYYY-MM' del mes calendario actual (zona horaria local).
  function nuevoMesActualYM() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  window.ymOf = ymOf;
  window.ymdOf = ymdOf;
  window.nuevoMesActualYM = nuevoMesActualYM;
})();
