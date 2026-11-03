// src/renderer/domain/categorizador.js
// Sistema híbrido de detección de categoría para movimientos de cartola.
//
//   1. Aprende de ti: si ya asignaste una categoría a una glosa parecida,
//      la reusa (state.config.reglasCategorias, por negocio).
//   2. Reglas base curadas para Chile: diccionario glosa→categoría con
//      comercios y conceptos típicos (Copec, Enel, Previred, SII, etc.).
//
// 100% offline y determinista — no se envía ninguna glosa bancaria afuera.
//
// API: window.Categorizador = { sugerir, aprender, normalizar, claveComercio }

(function () {
  'use strict';

  // Quita tildes, mayúsculas, colapsa espacios.
  function normalizar(s) {
    return String(s || '')
      .toUpperCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Prefijos de transferencia/medios que NO identifican al comercio.
  const PREFIJOS = /\b(TEF|TRANSFERENCIA|TRANSF|TRASPASO|PAGO|PAC|PAT|COMPRA|GIRO|ABONO|CARGO|DEPOSITO|DEPOSITO EN EFECTIVO|REDCOMPRA|WEBPAY|PAGO AUTOMATICO|PAGO DE CUENTA|PAGO ELECTRONICO|N\/C|N\/D|RECAUDACION)\b/g;

  // Extrae una "clave de comercio" estable de la glosa: saca prefijos,
  // números/fechas/RUTs y deja las primeras palabras significativas.
  function claveComercio(glosa) {
    let s = normalizar(glosa);
    s = s.replace(PREFIJOS, ' ');
    s = s.replace(/\b\d[\d.\-\/]*\b/g, ' '); // números, fechas, RUTs
    s = s.replace(/[^A-Z\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const palabras = s.split(' ').filter(w => w.length >= 3);
    return palabras.slice(0, 2).join(' ');
  }

  // tipo: 'gasto' | 'venta' | 'ambos'. Para abonos (monto>=0) se consideran
  // reglas 'venta'/'ambos'; para cargos (monto<0) reglas 'gasto'/'ambos'.
  const REGLAS_BASE = [
    // Combustible / movilización
    { re: /\b(COPEC|SHELL|ENEX|PETROBRAS|TERPEL|ABASTIBLE)\b/, cat: 'Combustible', tipo: 'gasto' },
    { re: /\b(UBER|CABIFY|DIDI|BEAT)\b/, cat: 'Movilización', tipo: 'gasto' },
    { re: /\b(CHILEXPRESS|STARKEN|CORREOS DE CHILE|BLUEEXPRESS|BLUE EXPRESS|PULLMAN CARGO)\b/, cat: 'Despacho', tipo: 'gasto' },
    { re: /\b(PEDIDOSYA|RAPPI|UBER EATS|JUSTO|CORNERSHOP)\b/, cat: 'Despacho', tipo: 'gasto' },
    // Servicios básicos
    { re: /\b(ENEL|CGE|SAESA|FRONTEL|CHILQUINTA|GRUPO SAESA)\b/, cat: 'Servicios básicos', tipo: 'gasto' },
    { re: /\b(AGUAS ANDINAS|ESVAL|ESSBIO|NUEVOSUR|AGUAS DEL|SMAPA)\b/, cat: 'Servicios básicos', tipo: 'gasto' },
    { re: /\b(METROGAS|LIPIGAS|ABASTIBLE GAS|GASCO|GAS\b)\b/, cat: 'Servicios básicos', tipo: 'gasto' },
    // Internet / telefonía
    { re: /\b(ENTEL|MOVISTAR|CLARO|WOM|VTR|GTD|MUNDO PACIFICO|TELSUR)\b/, cat: 'Internet / Telefonía', tipo: 'gasto' },
    // Sueldos / leyes sociales
    { re: /\b(PREVIRED|AFP|ISAPRE|FONASA|CAJA LOS ANDES|CCAF|MUTUAL|ACHS|IST)\b/, cat: 'Sueldos / Leyes sociales', tipo: 'gasto' },
    { re: /\b(REMUNERACION|SUELDO|FINIQUITO|HONORARIOS?)\b/, cat: 'Sueldos / Leyes sociales', tipo: 'gasto' },
    // Impuestos
    { re: /\b(SII|TESORERIA|TGR|IMPUESTO|F29|FORMULARIO 29|PAGO TESORERIA|IVA\b|PPM)\b/, cat: 'Impuestos', tipo: 'gasto' },
    // Insumos / materiales / mercadería
    { re: /\b(SODIMAC|CONSTRUMART|EASY|IMPERIAL|PRISA|MTS\b|CONSTRUCTOR)\b/, cat: 'Insumos / Materiales', tipo: 'gasto' },
    { re: /\b(LIDER|JUMBO|SANTA ISABEL|UNIMARC|TOTTUS|MAYORISTA|ALVI|CENCOSUD|ACUENTA|ERBI)\b/, cat: 'Mercadería / Insumos', tipo: 'gasto' },
    // Marketing / publicidad / software
    { re: /\b(GOOGLE|META PLATFORMS|FACEBK|FACEBOOK|FB ADS|INSTAGRAM|MAILCHIMP|TIKTOK)\b/, cat: 'Marketing', tipo: 'gasto' },
    { re: /\b(SHOPIFY|NUBOX|DEFONTANA|BSALE|JUMPSELLER|CANVA|NOTION|ZOOM|MICROSOFT|GOOGLE WORKSPACE|ADOBE|DROPBOX|SLACK)\b/, cat: 'Apps / Software', tipo: 'gasto' },
    // Arriendo
    { re: /\b(ARRIENDO|ARRENDAMIENTO|INMOBILIARIA|CANON DE ARRIENDO)\b/, cat: 'Arriendo', tipo: 'gasto' },
    // Gastos bancarios / financieros
    { re: /\b(COMISION|MANTENCION|CARGO POR|COSTO MANTENCION|INTERES|LINEA DE CREDITO|SOBREGIRO|ITE\b|IMPUESTO AL CREDITO)\b/, cat: 'Gastos bancarios', tipo: 'gasto' },
    // Recaudadores: cargo = comisión, abono = venta
    { re: /\b(TRANSBANK|GETNET|MERCADO ?PAGO|FLOW|KHIPU|WEBPAY|KLAP|SUMUP|FPAY|MACH|PAGO FACIL)\b/, cat: 'Comisiones de venta', tipo: 'gasto' },
    { re: /\b(TRANSBANK|GETNET|MERCADO ?PAGO|FLOW|KHIPU|WEBPAY|KLAP|SUMUP|FPAY|MACH|SHOPIFY PAYMENTS)\b/, cat: 'Ventas', tipo: 'venta' },
  ];

  // Reglas para el perfil personal: glosas típicas de cartolas chilenas
  // (BICE, Santander, Banco de Chile, tarjetas) → categorías personales.
  // El orden importa: "Cargo por pago TC" es pago de tarjeta, no comisión;
  // "Intereses línea de crédito" es comisión/interés, no cuota de deuda.
  const REGLAS_PERSONAL = [
    { re: /\b(PAGO ?TC|CARGO POR PAGO TC|T\.? ?CREDITO|TARJ\.? ?(DE )?CREDITO|TARJETA DE CREDITO|PAGO TARJETA|PAGO TARJ|CMR|TARJETA)\b/, cat: 'Pago tarjeta de crédito', tipo: 'gasto' },
    { re: /\b(COMISION|COMISIONES|MANTENCION|COSTO MANTENCION|INTERES|INTERESES|IMPUESTO|ITE|SOBREGIRO|CARGO POR|COBRO SERVICIO)\b/, cat: 'Comisiones e intereses bancarios', tipo: 'gasto' },
    { re: /\b(PRESTAMO|PAGO PRESTAMO|CREDITO DE CONSUMO|CRED CONSUMO|CUOTA|LINEA DE CRED\w*|AMORTIZACION|CREDITO AUTOMOTRIZ)\b/, cat: 'Deudas / Créditos', tipo: 'gasto' },
    { re: /\b(DIVIDENDO|HIPOTECARI[OA]|ARRIENDO|ARRENDAMIENTO|GASTOS COMUNES|GGCC|CONDOMINIO|COMUNIDAD EDIFICIO|ADMINISTRACION EDIFICIO)\b/, cat: 'Vivienda (arriendo/dividendo)', tipo: 'gasto' },
    { re: /\b(SEGURO|SEGUROS|SEG\b|SOAP|HDI|MAPFRE|LIBERTY|SURA|CHILENA CONSOLIDADA|METLIFE|CONSORCIO|ZURICH|BCI SEGUROS|BICE VIDA|CENTINELA)\b/, cat: 'Seguros', tipo: 'gasto' },
    { re: /\b(APPLE|ITUNES|ICLOUD|NETFLIX|SPOTIFY|DISNEY|HBO|MAX\b|AMAZON PRIME|PRIME VIDEO|YOUTUBE|GOOGLE|ANTHROPIC|CLAUDE|OPENAI|CHATGPT|MICROSOFT|ADOBE|CANVA|NOTION|DROPBOX|GITHUB|PLAYSTATION|XBOX|NINTENDO|PATREON|TWITCH|CRUNCHYROLL|PARAMOUNT|STAR\+?|DEEZER|TIDAL|STRAVA|DUOLINGO|MIDJOURNEY|CURSOR|VERCEL|FLY\.IO|HEROKU|GODADDY|NAMECHEAP|NIC CHILE)\b/, cat: 'Suscripciones y apps', tipo: 'gasto' },
    { re: /\b(UBER EATS|PEDIDOSYA|PEDIDOS YA|RAPPI|JUSTO|STARBUCKS|MCDONALD|MC DONALD|BURGER KING|DOMINO|PAPA JOHN|SUBWAY|KFC|WENDY|DUNKIN|JUAN MAESTRO|DOGGIS|SUSHI|PIZZA|RESTAURANT|RESTAURANTE|RESTORAN|CAFE|CAFETERIA|BAR\b|PUB\b|FUENTE ALEMANA|TELEPIZZA|NIU SUSHI)\b/, cat: 'Restaurantes y delivery', tipo: 'gasto' },
    { re: /\b(LIDER|JUMBO|SANTA ISABEL|UNIMARC|TOTTUS|ACUENTA|A CUENTA|MAYORISTA 10|ALVI|OK MARKET|OXXO|SPID|CORNERSHOP|SUPERMERCADO|SUPER BODEGA|ALMACEN|MINIMARKET|PANADERIA|CARNICERIA|VERDULERIA|FERIA|LA VEGA|EMPORIO)\b/, cat: 'Alimentación', tipo: 'gasto' },
    { re: /\b(UBER|CABIFY|DIDI|BEAT|COPEC|SHELL|ENEX|PETROBRAS|ARAMCO|TERPEL|BIP!?|METRO\b|RED MOVILIDAD|AUTOPISTA|COSTANERA NORTE|VESPUCIO|TAG\b|PEAJE|ESTACIONAMIENTO|PARKING|SABA|SAFERPARK|EFE\b|TURBUS|PULLMAN|LATAM|SKY AIRLINE|JETSMART|AUTOMOVIL CLUB|PERMISO CIRCULACION|REVISION TECNICA)\b/, cat: 'Transporte', tipo: 'gasto' },
    { re: /\b(ENEL|CGE|SAESA|FRONTEL|CHILQUINTA|AGUAS ANDINAS|ESVAL|ESSBIO|NUEVOSUR|AGUAS DEL|SMAPA|METROGAS|LIPIGAS|ABASTIBLE|GASCO|ENTEL|MOVISTAR|CLARO|WOM|VTR|GTD|MUNDO PACIFICO|TELSUR|DIRECTV|ONECLICK)\b/, cat: 'Servicios (luz/agua/internet)', tipo: 'gasto' },
    { re: /\b(FARMACIA|CRUZ VERDE|AHUMADA|SALCOBRAND|DR SIMI|DR\. SIMI|CLINICA|HOSPITAL|ISAPRE|FONASA|DENTAL|DENTISTA|LABORATORIO|MEDICO|REDSALUD|INTEGRAMEDICA|BUPA|COLMENA|CONSALUD|BANMEDICA|VIDA TRES|CRUZ BLANCA|NUEVA MASVIDA|OPTICA|KINESIOLOG|PSICOLOG|VETERINARI)\b/, cat: 'Salud', tipo: 'gasto' },
    { re: /\b(UNIVERSIDAD|COLEGIO|UDD|PUC\b|UC\b|USACH|UCHILE|DUOC|INACAP|INSTITUTO|CURSO|UDEMY|COURSERA|PLATZI|MATRICULA|ARANCEL|JARDIN INFANTIL|PREUNIVERSITARIO|LIBRERIA|ANTARTICA)\b/, cat: 'Educación', tipo: 'gasto' },
    { re: /\b(CINE|CINEMARK|HOYTS|CINEPLANET|PUNTOTICKET|TICKETMASTER|PASSLINE|TEATRO|GIMNASIO|GYM|SMARTFIT|SMART FIT|SPORTLIFE|PACIFIC|ENERGY|STEAM|EPIC GAMES|RIOT|BOTILLERIA|DISCO|CLUB|MOVISTAR ARENA|ESTADIO|VIAJE|HOTEL|AIRBNB|BOOKING|DESPEGAR)\b/, cat: 'Ocio / Entretención', tipo: 'gasto' },
    { re: /\b(FALABELLA|PARIS|RIPLEY|LA POLAR|HITES|ABCDIN|MERCADOLIBRE|MERCADO LIBRE|MERCADOPAGO|AMAZON|ALIEXPRESS|SHEIN|TEMU|ZARA|H&M|NIKE|ADIDAS|SODIMAC|EASY|HOMECENTER|PC FACTORY|CASAIDEAS|CASA IDEAS|IKEA|DAFITI|LINIO|DECATHLON|CORONA|TRICOT|SPARTA|LIPPI|DOITE|FERRETERIA|LIBRERIA NACIONAL|MAC ONLINE|REIFSTORE)\b/, cat: 'Compras (tiendas y online)', tipo: 'gasto' },
    { re: /\b(DEPOSITO A PLAZO|DAP\b|FONDO MUTUO|FONDOS MUTUOS|FFMM|APV|INVERSION|FINTUAL|RACIONAL|BTG|SOYFOCUS|TENPO INVERSION|AHORRO)\b/, cat: 'Ahorro', tipo: 'gasto' },
    { re: /\b(TRANSF|TRANSFERENCIA|TRASPASO|TEF) A\b|\bTRANSF A:|\bTRASPASO A:|\bTRANSFERENCIA A:/, cat: 'Transferencias a personas', tipo: 'gasto' }
  ];

  function reglasPara(state) {
    const personal = !!(state && state.config && state.config.perfil === 'personal');
    return personal ? REGLAS_PERSONAL : REGLAS_BASE;
  }

  // Devuelve { categoria, fuente: 'aprendido'|'regla' } o null.
  function sugerir(glosa, monto, state) {
    const esIngreso = Number(monto) >= 0;
    const clave = claveComercio(glosa);

    // 1) Aprendido (lo que el usuario ya corrigió antes en este negocio)
    const aprendidas = (state && state.config && state.config.reglasCategorias) || {};
    if (clave && aprendidas[clave]) {
      return { categoria: aprendidas[clave], fuente: 'aprendido' };
    }

    // 2) Reglas base
    const norm = normalizar(glosa);
    for (const r of reglasPara(state)) {
      const aplicaTipo = r.tipo === 'ambos'
        || (esIngreso && r.tipo === 'venta')
        || (!esIngreso && r.tipo === 'gasto');
      if (aplicaTipo && r.re.test(norm)) {
        return { categoria: r.cat, fuente: 'regla' };
      }
    }
    // 3) Cargo que se repite cada mes (mismo comercio, monto y fecha parecidos)
    if (!esIngreso && window.CargosRegulares) {
      const r = window.CargosRegulares.sugerirCategoria(glosa, monto, state);
      if (r) return r;
    }
    return null;
  }

  // Guarda la corrección del usuario para reusarla en glosas parecidas.
  // No aprende 'Por clasificar' ni categorías vacías.
  function aprender(glosa, categoria, state) {
    if (!state || !state.config) return;
    const cat = String(categoria || '').trim();
    if (!cat || cat === 'Por clasificar') return;
    const clave = claveComercio(glosa);
    if (!clave) return;
    if (!state.config.reglasCategorias) state.config.reglasCategorias = {};
    state.config.reglasCategorias[clave] = cat;
  }

  window.Categorizador = { sugerir, aprender, normalizar, claveComercio, REGLAS_BASE, REGLAS_PERSONAL };
})();
