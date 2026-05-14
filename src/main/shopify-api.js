// src/main/shopify-api.js
// Cliente Shopify Admin API: GraphQL + REST + funciones de alto nivel para
// traer pedidos detallados, agregados mensuales (ShopifyQL) y catálogo.

const https = require('node:https');
const { getShopifyConfig } = require('./env');

// ---------------------------------------------------------------------------
// Wrappers de transporte
// ---------------------------------------------------------------------------
function shopifyGraphQL(query, variables = {}, creds) {
  return new Promise((resolve, reject) => {
    const { host, token, apiVersion, configured } = getShopifyConfig(creds);
    if (!configured) {
      reject(new Error('Falta configurar tienda Shopify y access token. Edita la conexión en Configuración → Conexión Shopify.'));
      return;
    }
    const body = JSON.stringify({ query, variables });
    const req = https.request({
      hostname: host,
      path: `/admin/api/${apiVersion}/graphql.json`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.errors) reject(new Error('GraphQL: ' + JSON.stringify(parsed.errors)));
          else resolve(parsed.data);
        } catch (err) {
          reject(new Error('Parse error: ' + err.message + '\n' + data.slice(0, 300)));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

// REST con paginación cursor-based via header Link (lo usa /orders.json).
function shopifyREST(pathname, creds) {
  return new Promise((resolve, reject) => {
    const { host, token, apiVersion, configured } = getShopifyConfig(creds);
    if (!configured) {
      reject(new Error('Falta configurar tienda Shopify y access token'));
      return;
    }
    const fullPath = pathname.startsWith('/admin') ? pathname : `/admin/api/${apiVersion}/${pathname}`;
    const req = https.request({
      hostname: host,
      path: fullPath,
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
          return;
        }
        try { resolve({ data: JSON.parse(data), headers: res.headers }); }
        catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Timeout')); });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Funciones de alto nivel
// ---------------------------------------------------------------------------
async function fetchShopInfo(creds) {
  const data = await shopifyGraphQL(
    `query { shop { name myshopifyDomain primaryDomain { url } currencyCode } }`,
    {}, creds
  );
  const shop = data.shop || {};
  return {
    name: shop.name,
    domain: (shop.primaryDomain && shop.primaryDomain.url)
      ? shop.primaryDomain.url.replace('https://', '')
      : shop.myshopifyDomain,
    currency: shop.currencyCode,
  };
}

// El scope read_orders restringe la profundidad histórica a ~60 días.
async function fetchOrdersDetailed(diasAtras = 60, creds) {
  const desdeDate = new Date(Date.now() - diasAtras * 24 * 3600 * 1000).toISOString();
  const all = [];
  let cursor = null;
  while (true) {
    const cursorParam = cursor
      ? `&page_info=${encodeURIComponent(cursor)}`
      : `&created_at_min=${encodeURIComponent(desdeDate)}&financial_status=any&status=any`;
    const r = await shopifyREST(`orders.json?limit=250${cursorParam}`, creds);
    const orders = (r.data && r.data.orders) || [];
    all.push(...orders);
    const link = r.headers.link || r.headers.Link || '';
    const next = link.split(',').find(p => /rel="next"/.test(p));
    if (!next) break;
    const m = next.match(/page_info=([^&>]+)/);
    if (!m) break;
    cursor = decodeURIComponent(m[1]);
  }
  return all.map(o => ({
    id: o.id,
    order_number: o.order_number || o.name,
    name: o.name,
    created_at: o.created_at,
    cancelled_at: o.cancelled_at,
    financial_status: o.financial_status,
    fulfillment_status: o.fulfillment_status,
    currency: o.currency,
    total_price: Number(o.total_price || 0),
    subtotal_price: Number(o.subtotal_price || 0),
    total_tax: Number(o.total_tax || 0),
    total_discounts: Number(o.total_discounts || 0),
    customer: ((o.customer && (`${o.customer.first_name || ''} ${o.customer.last_name || ''}`).trim()) || o.email || '—'),
    line_items: (o.line_items || []).map(li => ({
      title: li.title,
      quantity: li.quantity,
      price: Number(li.price || 0),
      sku: li.sku || '',
    })),
  }));
}

// ShopifyQL: agregados mensuales (gross/net sales + orders) hasta 3 años atrás.
// El endpoint analytics_query.json no existe en algunas versiones API; devolvemos
// array vacío en ese caso para que el caller no se rompa.
async function fetchMonthlyAggregates(yearsBack = 3, creds) {
  const sinceDays = Math.round(yearsBack * 365);
  const { host, token, apiVersion, configured } = getShopifyConfig(creds);
  if (!configured) throw new Error('No configurado');
  const body = JSON.stringify({
    query: `FROM sales SHOW orders, gross_sales, net_sales TIMESERIES month SINCE -${sinceDays}d UNTIL today`,
  });
  const result = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host,
      path: `/admin/api/${apiVersion}/analytics_query.json`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 404 || res.statusCode === 405) {
          resolve(null); // endpoint no disponible en esta versión
          return;
        }
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  if (!result || !result.rows) return [];
  return result.rows.map(r => ({
    month: r[0].slice(0, 7),
    orders: Number(r[1] || 0),
    gross_sales: Number(r[2] || 0),
    net_sales: Number(r[3] || 0),
  }));
}

// Catálogo de productos activos (paginación GraphQL).
async function fetchCatalog(creds) {
  const all = [];
  let cursor = null;
  while (true) {
    const data = await shopifyGraphQL(`
      query Catalog($first: Int!, $after: String) {
        products(first: $first, after: $after, sortKey: TITLE) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id title status productType
              priceRangeV2 { minVariantPrice { amount } maxVariantPrice { amount } }
            }
          }
        }
      }
    `, { first: 50, after: cursor }, creds);
    const products = (data.products && data.products.edges) || [];
    products.forEach(({ node }) => {
      if (node.status !== 'ACTIVE') return;
      all.push({
        title: node.title,
        type: node.productType || '',
        minPrice: Number((node.priceRangeV2 && node.priceRangeV2.minVariantPrice && node.priceRangeV2.minVariantPrice.amount) || 0),
        maxPrice: Number((node.priceRangeV2 && node.priceRangeV2.maxVariantPrice && node.priceRangeV2.maxVariantPrice.amount) || 0),
      });
    });
    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
  }
  return all;
}

// Trae todo en paralelo. Fallos individuales caen a array vacío para no romper
// el sync entero por una falla aislada.
async function refreshAll(creds) {
  const shop = await fetchShopInfo(creds);
  const [orders, monthly, catalog] = await Promise.all([
    fetchOrdersDetailed(60, creds).catch(() => []),
    fetchMonthlyAggregates(3, creds).catch(() => []),
    fetchCatalog(creds).catch(() => []),
  ]);
  return {
    source: `shopify:${shop.domain}`,
    shop,
    updated_at: new Date().toISOString(),
    count: orders.length,
    orders,
    monthly_aggregates: monthly,
    catalog,
  };
}

// ---------------------------------------------------------------------------
// Handlers IPC (envueltos en try/catch donde corresponde)
// ---------------------------------------------------------------------------
function status(creds) {
  const cfg = getShopifyConfig(creds);
  return { configured: cfg.configured, envPath: cfg.envPath, host: cfg.host };
}

async function test(creds) {
  try {
    const shop = await fetchShopInfo(creds);
    return { ok: true, shop };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  // Bajo nivel (por si algún módulo futuro necesita custom queries)
  shopifyGraphQL,
  shopifyREST,
  // Alto nivel
  fetchShopInfo,
  fetchOrdersDetailed,
  fetchMonthlyAggregates,
  fetchCatalog,
  refreshAll,
  // IPC
  status,
  test,
};
