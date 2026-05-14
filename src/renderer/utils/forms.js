// src/renderer/utils/forms.js
// Helpers de validación visual para los formularios de los modales.
// Marca los inputs inválidos con clase CSS .input-invalid (definida en index.html)
// y devuelve un array de errores para mostrar como toast.
//
// Uso típico desde un handler de guardar:
//
//   const errors = Forms.validar({
//     gastoFecha: { requerido: true, etiqueta: 'fecha' },
//     gastoMonto: { requerido: true, positivo: true, etiqueta: 'monto' }
//   });
//   if (errors.length) {
//     toast(errors[0], 'error');
//     return;
//   }
//
// Cuando todo está OK, los inputs vuelven a su estilo normal automáticamente.

(function () {
  'use strict';

  // Reglas soportadas:
  //   requerido: true        — el valor (trim) no puede estar vacío
  //   positivo: true         — el valor numérico debe ser > 0
  //   noNegativo: true       — el valor numérico debe ser >= 0
  //   etiqueta: string       — nombre legible para el mensaje de error
  function validar(reglasPorId) {
    const errors = [];
    Object.entries(reglasPorId).forEach(([id, reglas]) => {
      const el = document.getElementById(id);
      if (!el) return;
      const raw = (el.value || '').trim();
      const etiqueta = reglas.etiqueta || id;
      let problema = null;

      if (reglas.requerido && !raw) {
        problema = `Falta ${etiqueta}`;
      } else if (reglas.positivo) {
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) problema = `${capitalize(etiqueta)} debe ser mayor a 0`;
      } else if (reglas.noNegativo) {
        const n = Number(raw);
        if (Number.isFinite(n) && n < 0) problema = `${capitalize(etiqueta)} no puede ser negativo`;
      }

      if (problema) {
        el.classList.add('input-invalid');
        errors.push(problema);
      } else {
        el.classList.remove('input-invalid');
      }
    });
    return errors;
  }

  // Quita la marca de inválido de uno o varios campos (útil para reset al abrir).
  function limpiar(ids) {
    (Array.isArray(ids) ? ids : [ids]).forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.remove('input-invalid');
    });
  }

  function capitalize(s) {
    return String(s || '').replace(/^./, c => c.toUpperCase());
  }

  // ---------------------------------------------------------------------------
  // Formato CLP en vivo (mientras el usuario escribe)
  //
  // El locale es-CL usa "." como separador de miles y no usa decimales para
  // pesos chilenos. Estos helpers:
  //   1. formatearCLPInput(el)  → reformatea el value del input con dots
  //      mientras el usuario tipea. Preserva la posición del cursor.
  //   2. parsearCLP(str)         → quita todos los no-dígitos para volver al
  //      número crudo (al momento de guardar).
  //   3. setearMontoCLP(el, n)   → setea el value del input ya formateado
  //      (al abrir modal de edición con un valor existente).
  //   4. bindCLPInputs(root)     → cablea todos los inputs con data-clp en
  //      root (default: document). Idempotente: marca con data-clp-bound.
  //
  // Patrón de uso:
  //   - HTML: <input type="text" inputmode="numeric" data-clp="true" />
  //   - Init: Forms.bindCLPInputs(); una vez en boot.
  //   - Editar valor existente: Forms.setearMontoCLP(el, valor);
  //   - Leer en guardar*: const n = Forms.parsearCLP(el.value);
  // ---------------------------------------------------------------------------
  const fmtMiles = new Intl.NumberFormat('es-CL');

  function formatearCLPInput(el) {
    if (!el) return;
    const valor = el.value;
    const pos = el.selectionStart != null ? el.selectionStart : valor.length;
    // Cuántos puntos había antes del cursor (para reposicionar después)
    const dotsAntes = (valor.slice(0, pos).match(/\./g) || []).length;
    // Quedarse solo con dígitos. Limitar a 12 (999 mil millones — más que CLP necesita).
    const digitos = valor.replace(/\D/g, '').slice(0, 12);
    if (!digitos) {
      el.value = '';
      return;
    }
    const formateado = fmtMiles.format(Number(digitos));
    el.value = formateado;
    // Reposicionar cursor: contar dots a la izquierda del cursor en el nuevo
    // string. La diff entre dots antes/después es el shift que necesitamos.
    const corteAprox = pos + (formateado.length - valor.length);
    const dotsDespues = (formateado.slice(0, corteAprox).match(/\./g) || []).length;
    const nuevoPos = Math.max(0, Math.min(formateado.length, pos + (dotsDespues - dotsAntes)));
    try { el.setSelectionRange(nuevoPos, nuevoPos); } catch {}
  }

  function parsearCLP(str) {
    if (typeof str === 'number') return str;
    if (str === null || str === undefined || str === '') return 0;
    // Quita todo lo no-dígito (dots, espacios, $, comas, etc).
    const limpio = String(str).replace(/[^\d]/g, '');
    if (!limpio) return 0;
    const n = Number(limpio);
    return Number.isFinite(n) ? n : 0;
  }

  function setearMontoCLP(el, n) {
    if (!el) return;
    if (n === null || n === undefined || n === '' || n === 0) {
      el.value = '';
      return;
    }
    const num = Number(n);
    if (!Number.isFinite(num) || num === 0) {
      el.value = '';
      return;
    }
    el.value = fmtMiles.format(num);
  }

  function bindCLPInputs(root) {
    const r = root || document;
    const inputs = r.querySelectorAll('input[data-clp]:not([data-clp-bound])');
    inputs.forEach(input => {
      input.setAttribute('data-clp-bound', 'true');
      input.addEventListener('input', () => formatearCLPInput(input));
      input.addEventListener('blur', () => formatearCLPInput(input));
      // Si trae valor inicial al cargar, formatearlo.
      if (input.value) formatearCLPInput(input);
    });
  }

  window.Forms = {
    validar,
    limpiar,
    formatearCLPInput,
    parsearCLP,
    setearMontoCLP,
    bindCLPInputs,
  };
})();
