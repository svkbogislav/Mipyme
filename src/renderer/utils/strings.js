// src/renderer/utils/strings.js
// Helpers de strings: generación de IDs únicos y escape de HTML.

(function () {
  'use strict';

  // ID legible-corto, ordenable por tiempo de creación + componente aleatorio
  // para evitar colisiones cuando se generan varios en el mismo tick.
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // Escape mínimo de HTML para inyección segura en innerHTML.
  // Acepta null/undefined (los convierte a '').
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  window.uid = uid;
  window.escapeHtml = escapeHtml;
})();
