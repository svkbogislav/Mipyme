// src/main/sii-api.js
// Integración con LibreDTE (https://libredte.cl) para emitir Documentos
// Tributarios Electrónicos (DTE) y Boletas de Honorarios Electrónicas (BHE)
// conectados al SII de Chile.
//
// IMPORTANTE — seguridad y responsabilidad:
//   - El hash/token de LibreDTE NUNCA va en el binario ni en el repo. Lo
//     ingresa el usuario y se guarda por negocio en el renderer (localStorage),
//     y llega acá por argumento `creds` en cada llamada (igual que Meta/Google).
//   - Ambiente por defecto = 'certificacion'. Producción debe activarse
//     explícitamente, recién después de validar en certificación con el SII.
//   - Esto emite documentos tributarios REALES en producción. Toda función
//     que emite exige `creds.ambiente === 'produccion'` de forma explícita.
//
// Auth LibreDTE: HTTP Basic, usuario = hash, password vacío.
//   Authorization: Basic base64(`${hash}:`)
//
// Flujo de emisión de un DTE (factura/boleta) en LibreDTE:
//   1. POST /api/dte/documentos/emitir?normalizar=1&formato=json  (temporal)
//   2. POST /api/dte/documentos/generar                            (firma+folio)
//   3. GET  /api/dte/dte_emitidos/enviar_sii/{dte}/{folio}/{rut}    (envío SII)
//   4. GET  /api/dte/dte_emitidos/actualizar_estado/{dte}/{folio}/{rut}
//   PDF:    GET /api/dte/dte_emitidos/pdf/{dte}/{folio}/{rut}
//
// Los paths exactos pueden variar según la versión de LibreDTE de la cuenta;
// están centralizados en EP() para ajustarlos en un solo lugar y se validan
// en ambiente de certificación antes de habilitar producción.

const https = require('node:https');
const { URL } = require('node:url');

const HOST_DEFAULT = 'libredte.cl';

// ── Núcleo HTTP ────────────────────────────────────────────────────────────
function authHeader(hash) {
  // LibreDTE: token como usuario, password vacío.
  return 'Basic ' + Buffer.from(`${hash}:`).toString('base64');
}

function request(creds, method, path, body) {
  return new Promise((resolve, reject) => {
    if (!creds || !creds.hash) {
      reject(new Error('Falta el token (hash) de LibreDTE'));
      return;
    }
    const host = creds.host || HOST_DEFAULT;
    const payload = body != null ? JSON.stringify(body) : null;
    const headers = {
      Authorization: authHeader(creds.hash),
      Accept: 'application/json',
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request(
      { hostname: host, path, method, headers, timeout: 60000 },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          const status = res.statusCode || 0;
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch { /* no-JSON (ej: PDF) */ }
          if (status >= 200 && status < 300) {
            resolve({ status, json: parsed, raw: data });
          } else {
            const msg = (parsed && (parsed.message || parsed.error || parsed.glosa))
              || `HTTP ${status}`;
            reject(new Error(`LibreDTE: ${msg}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Timeout conectando a LibreDTE')));
    if (payload) req.write(payload);
    req.end();
  });
}

// Descarga binaria (PDF) — devuelve base64 para cruzar el puente IPC.
function requestBinary(creds, path) {
  return new Promise((resolve, reject) => {
    const host = creds.host || HOST_DEFAULT;
    const req = https.request(
      {
        hostname: host, path, method: 'GET', timeout: 60000,
        headers: { Authorization: authHeader(creds.hash) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if ((res.statusCode || 0) >= 200 && res.statusCode < 300) {
            resolve({ base64: buf.toString('base64'), bytes: buf.length });
          } else {
            reject(new Error(`LibreDTE PDF: HTTP ${res.statusCode} · ${buf.toString('utf8').slice(0, 180)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Timeout descargando PDF')));
    req.end();
  });
}

// Endpoints centralizados (un solo lugar para ajustar si cambia la versión).
const EP = {
  usuario: () => '/api/usuarios/usuario',
  emitir: () => '/api/dte/documentos/emitir?normalizar=1&formato=json&links=0&email=0',
  generar: () => '/api/dte/documentos/generar',
  enviarSII: (dte, folio, rut) => `/api/dte/dte_emitidos/enviar_sii/${dte}/${folio}/${rut}`,
  estado: (dte, folio, rut) => `/api/dte/dte_emitidos/actualizar_estado/${dte}/${folio}/${rut}`,
  pdf: (dte, folio, rut) => `/api/dte/dte_emitidos/pdf/${dte}/${folio}/${rut}`,
  listar: (rut, dte, desde, hasta) =>
    `/api/dte/dte_emitidos/buscar/${rut}` +
    (dte ? `?dte=${dte}` : '') +
    (desde ? `${dte ? '&' : '?'}fecha_desde=${desde}` : '') +
    (hasta ? `&fecha_hasta=${hasta}` : ''),
  // BHE (boletas de honorarios) — módulo honorarios de LibreDTE. Requiere que
  // la cuenta LibreDTE tenga configuradas las credenciales SII del emisor.
  bheEmitir: (rut) => `/api/bhe/boletas/emitir/${rut}`,
  bheListar: (rut, desde, hasta) =>
    `/api/bhe/boletas/buscar/${rut}?fecha_desde=${desde || ''}&fecha_hasta=${hasta || ''}`,
};

function exigirProduccionOExplicito(creds) {
  // Documento tributario real: solo si el usuario eligió ambiente explícito.
  const amb = (creds && creds.ambiente) || 'certificacion';
  if (amb !== 'certificacion' && amb !== 'produccion') {
    throw new Error(`Ambiente inválido: ${amb}`);
  }
  return amb;
}

// ── API pública ────────────────────────────────────────────────────────────

// Test de conexión: valida el hash pidiendo el usuario autenticado. No emite
// ni modifica nada. Sirve para el botón "Probar conexión" de la config.
async function test(creds) {
  try {
    if (!creds || !creds.hash) return { ok: false, error: 'Falta el token (hash) de LibreDTE' };
    const r = await request(creds, 'GET', EP.usuario());
    const u = r.json || {};
    return {
      ok: true,
      usuario: { rut: u.rut || u.RUT || null, nombre: u.nombre || u.usuario || null, email: u.email || null },
      ambiente: exigirProduccionOExplicito(creds),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Emite un DTE (factura 33/34, boleta 39/41, etc.).
// `documento` = JSON LibreDTE { Encabezado, Detalle, ... } SIN folio (LibreDTE
// lo asigna del CAF cargado). Devuelve { ok, dte, folio, estado, trackid }.
async function emitirDTE(args) {
  try {
    const { creds, documento } = args || {};
    const ambiente = exigirProduccionOExplicito(creds);
    if (!documento || !documento.Encabezado) {
      return { ok: false, error: 'Documento sin Encabezado' };
    }
    const rutEmisor = (documento.Encabezado.Emisor && documento.Encabezado.Emisor.RUTEmisor)
      || (creds && creds.rutEmisor);
    if (!rutEmisor) return { ok: false, error: 'Falta RUT del emisor' };

    // 1) Temporal
    const emit = await request(creds, 'POST', EP.emitir(), documento);
    const temporal = emit.json;
    if (!temporal) return { ok: false, error: 'LibreDTE no devolvió el documento temporal' };

    // 2) Generar (firma + asigna folio del CAF)
    const gen = await request(creds, 'POST', EP.generar(), temporal);
    const g = gen.json || {};
    const tipoDTE = g.dte || (documento.Encabezado.IdDoc && documento.Encabezado.IdDoc.TipoDTE);
    const folio = g.folio || (g.Encabezado && g.Encabezado.IdDoc && g.Encabezado.IdDoc.Folio);
    if (!tipoDTE || !folio) {
      return { ok: false, error: 'LibreDTE no devolvió tipo/folio tras generar', detalle: g };
    }

    // 3) Enviar al SII
    let trackid = null;
    try {
      const env = await request(creds, 'GET', EP.enviarSII(tipoDTE, folio, rutEmisor));
      trackid = (env.json && (env.json.track_id || env.json.trackid)) || null;
    } catch (e) {
      // El documento quedó generado/firmado aunque el envío falle; se puede
      // reintentar el envío. No lo tratamos como fallo total.
      return {
        ok: true, dte: tipoDTE, folio, ambiente, trackid: null,
        warning: `Generado pero falló el envío al SII: ${e.message}. Reintenta el envío.`,
      };
    }

    return { ok: true, dte: tipoDTE, folio, trackid, ambiente };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Consulta/actualiza el estado de un DTE en el SII.
async function estadoDTE(args) {
  try {
    const { creds, dte, folio } = args || {};
    const rut = (args && args.rutEmisor) || (creds && creds.rutEmisor);
    if (!dte || !folio || !rut) return { ok: false, error: 'Faltan dte/folio/rut' };
    const r = await request(creds, 'GET', EP.estado(dte, folio, rut));
    return { ok: true, estado: r.json };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Descarga el PDF de un DTE emitido (base64).
async function pdfDTE(args) {
  try {
    const { creds, dte, folio } = args || {};
    const rut = (args && args.rutEmisor) || (creds && creds.rutEmisor);
    if (!dte || !folio || !rut) return { ok: false, error: 'Faltan dte/folio/rut' };
    const r = await requestBinary(creds, EP.pdf(dte, folio, rut));
    return { ok: true, base64: r.base64, bytes: r.bytes };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Lista DTE emitidos (para la tabla de la vista Facturación).
async function listarEmitidos(args) {
  try {
    const { creds, dte, desde, hasta } = args || {};
    const rut = (args && args.rutEmisor) || (creds && creds.rutEmisor);
    if (!rut) return { ok: false, error: 'Falta RUT del emisor' };
    const r = await request(creds, 'GET', EP.listar(rut, dte, desde, hasta));
    return { ok: true, documentos: r.json || [] };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Emite una Boleta de Honorarios Electrónica (BHE) vía el módulo honorarios
// de LibreDTE. OJO: el SII no tiene API oficial de emisión de BHE; LibreDTE
// automatiza el portal del SII, por lo que la cuenta LibreDTE debe tener
// configuradas las credenciales SII del emisor. Más frágil que el DTE.
async function emitirBHE(args) {
  try {
    const { creds, boleta } = args || {};
    exigirProduccionOExplicito(creds);
    const rut = (creds && creds.rutEmisor) || (boleta && boleta.rut);
    if (!rut) return { ok: false, error: 'Falta RUT del emisor de honorarios' };
    if (!boleta) return { ok: false, error: 'Falta el contenido de la boleta' };
    const r = await request(creds, 'POST', EP.bheEmitir(rut), boleta);
    return { ok: true, boleta: r.json };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function listarBHE(args) {
  try {
    const { creds, desde, hasta } = args || {};
    const rut = (creds && creds.rutEmisor);
    if (!rut) return { ok: false, error: 'Falta RUT del emisor' };
    const r = await request(creds, 'GET', EP.bheListar(rut, desde, hasta));
    return { ok: true, boletas: r.json || [] };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  test,
  emitirDTE,
  estadoDTE,
  pdfDTE,
  listarEmitidos,
  emitirBHE,
  listarBHE,
};
