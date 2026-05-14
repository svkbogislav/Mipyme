// src/renderer/utils/format.js
// Formateadores numéricos y de fecha para el locale es-CL.
// Clásico (no ES module): se carga vía <script src> y registra los símbolos
// como globales para que el script inline del renderer los siga consumiendo.
// Cuando migremos el renderer a ES modules, este archivo se convierte trivial.

(function () {
  'use strict';

  const fmtCLP = new Intl.NumberFormat('es-CL', {
    style: 'currency',
    currency: 'CLP',
    maximumFractionDigits: 0
  });
  const fmtNum = new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 });
  const fmtPct = new Intl.NumberFormat('es-CL', {
    style: 'percent',
    maximumFractionDigits: 1
  });
  const fmtFechaCorta = new Intl.DateTimeFormat('es-CL', {
    day: '2-digit', month: 'short', year: 'numeric'
  });
  const fmtMes = new Intl.DateTimeFormat('es-CL', {
    month: 'long', year: 'numeric'
  });

  // CLP con redondeo a peso entero. Acepta null/undefined sin reventar.
  function clp(n) { return fmtCLP.format(Math.round(n || 0)); }

  // Exponemos en window para el script inline. Cuando todo sea ES module,
  // estas líneas pasan a ser `export { ... }`.
  window.fmtCLP = fmtCLP;
  window.fmtNum = fmtNum;
  window.fmtPct = fmtPct;
  window.fmtFechaCorta = fmtFechaCorta;
  window.fmtMes = fmtMes;
  window.clp = clp;
})();
