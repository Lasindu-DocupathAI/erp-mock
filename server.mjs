/**
 * A stand-in ERP for testing Connected Data Sources locally. Node 18+, no dependencies.
 *
 *   node server.mjs            # listens on 127.0.0.1:4500
 *   PORT=4600 node server.mjs
 *
 * WHY 127.0.0.1 IS A PROBLEM AND HOW IT IS SOLVED. The executor's address guard refuses
 * loopback, link-local, private and CGNAT addresses, which is the whole point of it, so a
 * mock on localhost is refused like any other SSRF target. The capture service re-permits
 * it only when BOTH of these are set, and logs a WARN naming them on every request that
 * uses them:
 *
 *   CONNECTIONS_ALLOW_CIDRS="127.0.0.1/32"
 *   CONNECTIONS_ALLOW_HTTP=1
 *
 * Those two must be UNSET in every deployed environment. Checking that they are is a test
 * case in its own right (see the artefact, S-7).
 *
 * The data is synthetic. No real customer, price or product ever belongs in this file.
 *
 * ── Data routes ──────────────────────────────────────────────────────────────
 *   GET  /customers              page pagination   ?page=&page_size=
 *   GET  /customers/offset       offset pagination ?offset=&limit=
 *   GET  /customers/cursor       cursor pagination ?cursor=&page_size=
 *   GET  /customers/flat         no pagination, the whole list in one response
 *   GET  /customers/nested       the array buried at $.payload.result.records
 *   GET  /catalogue              FIVE tables in one response, for choosing between arrays
 *   GET  /customers/many-pages   10 records per page, 5000 records -> blows the 20-page cap
 *   GET  /prices                 a second catalogue, for a two-connection document test
 *   POST /customers/search       POST-for-query, body echoed into the filter
 *
 * ── Auth, selected by the route prefix ───────────────────────────────────────
 *   /auth/none/*                 no credential
 *   /auth/apikey-header/*        X-API-Key: <API_KEY>
 *   /auth/apikey-query/*         ?api_key=<API_KEY>
 *   /auth/bearer/*               Authorization: Bearer <BEARER_TOKEN>
 *   /auth/basic/*                Authorization: Basic base64(USER:PASS)
 *   /auth/oauth/*                Authorization: Bearer <minted token>
 *   POST /oauth/token            client_credentials, in body or HTTP Basic
 *
 * ── Failure routes, one per Figure 4 row ─────────────────────────────────────
 *   /fail/401 /fail/403 /fail/404 /fail/429 /fail/500 /fail/502 /fail/503 /fail/504
 *   /fail/429-long              Retry-After longer than the cap: reported, not slept through
 *   /fail/slow?ms=              holds the socket, for the deadline
 *   /fail/huge?mb=              oversized body, aborted mid-stream
 *   /fail/not-json              text/plain
 *   /fail/bad-json              truncated JSON
 *   /fail/deep?depth=           deeply nested JSON, for the pre-parse depth check
 *   /fail/empty-array           200 with zero records
 *   /fail/no-array              200 with an object and no array anywhere
 *   /fail/echo-key              an ERP error that quotes the API key back at you
 *   /fail/flaky?succeed_after=  fails with 503 until the nth call, then succeeds
 *   /redirect/same?n=           n same-host redirects, then the data
 *   /redirect/cross             redirects to a different host (auth must be dropped)
 *   /redirect/private           redirects to a private address (must be re-validated and refused)
 *
 * ── Introspection, for assertions ────────────────────────────────────────────
 *   GET  /_calls                 the last MAX_CALLS requests seen: method, path, headers, body
 *   POST /_reset                 clear the call log and the flaky counters
 *
 * DEPLOYED PUBLICLY, set ADMIN_TOKEN: /_calls and /_reset then need
 * `Authorization: Bearer <ADMIN_TOKEN>`. Without it anyone on the internet could read every
 * header and body sent here, including a real credential pasted into a test by mistake.
 * Unset (local use) they stay open. HOST must be 0.0.0.0 on a host that routes to the process.
 */
import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT ?? 4500);
const HOST = process.env.HOST ?? '127.0.0.1';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';
/** Bounded, so a public deployment's scanner traffic cannot grow the log without limit. */
const MAX_CALLS = 500;

export const API_KEY = 'erp-api-key-7F3A91CD';
export const BEARER_TOKEN = 'erp-bearer-5E2B88A0';
export const BASIC_USER = 'erp_service_account';
export const BASIC_PASS = 'erp-basic-pass-9D41';
export const OAUTH_CLIENT_ID = 'docupath-local-client';
export const OAUTH_CLIENT_SECRET = 'erp-oauth-secret-B72C';

/** Every call the mock has seen, so a test can assert what was actually sent. */
const calls = [];
/** Per-key counters for /fail/flaky. */
const flaky = new Map();
/** Tokens this mock has minted, with their expiry. */
const mintedTokens = new Map();

// ── synthetic data ───────────────────────────────────────────────────────────

const COUNTRIES = ['NL', 'BE', 'DE', 'FR', 'GB', 'IE', 'ES', 'IT'];

/** Deterministic, so a cache test can tell "the same data again" from "fetched again". */
function customer(i) {
  return {
    customer_code: `C${String(100000 + i)}`,
    customer_name: `Synthetic Trading ${i} BV`,
    country: COUNTRIES[i % COUNTRIES.length],
    credit_limit: String(1000 + (i % 50) * 250),
    vat_number: `NL${String(800000000 + i)}B01`,
    status: i % 17 === 0 ? 'blocked' : 'active',
  };
}

function priceRow(i) {
  return {
    product_code: `P${String(5000 + i)}`,
    description: `Synthetic Component ${i}`,
    unit_price: (10 + (i % 90) * 1.37).toFixed(2),
    currency: 'USD',
    moq: String(1 + (i % 12)),
  };
}

const TOTAL_CUSTOMERS = Number(process.env.TOTAL_CUSTOMERS ?? 237);
const TOTAL_PRICES = Number(process.env.TOTAL_PRICES ?? 64);

const CUSTOMERS = Array.from({ length: TOTAL_CUSTOMERS }, (_, i) => customer(i + 1));
const PRICES = Array.from({ length: TOTAL_PRICES }, (_, i) => priceRow(i + 1));

// ── helpers ──────────────────────────────────────────────────────────────────

function json(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

function problem(res, status, code, message, extra = {}) {
  json(res, status, { error: { code, message, ...extra } });
}

function intParam(url, name, fallback) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);

  return Number.isFinite(n) ? n : fallback;
}

/**
 * Which auth a route demands, and whether the request satisfied it.
 * Returns null when satisfied, or a {status, code, message} to answer with.
 */
function checkAuth(scheme, req, url) {
  const auth = req.headers.authorization ?? '';

  switch (scheme) {
    case 'none':
      return null;

    case 'apikey-header':
      return req.headers['x-api-key'] === API_KEY
        ? null
        : { status: 401, code: 'INVALID_API_KEY', message: 'The X-API-Key header is missing or not recognised.' };

    case 'apikey-query':
      return url.searchParams.get('api_key') === API_KEY
        ? null
        : { status: 401, code: 'INVALID_API_KEY', message: 'The api_key query parameter is missing or not recognised.' };

    case 'bearer':
      return auth === `Bearer ${BEARER_TOKEN}`
        ? null
        : { status: 401, code: 'INVALID_TOKEN', message: 'The bearer token is missing or not recognised.' };

    case 'basic': {
      const expected = 'Basic ' + Buffer.from(`${BASIC_USER}:${BASIC_PASS}`).toString('base64');

      return auth === expected
        ? null
        : { status: 401, code: 'INVALID_CREDENTIALS', message: 'Basic authentication failed.' };
    }

    case 'oauth': {
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const expiry = mintedTokens.get(token);
      if (expiry === undefined) {
        return { status: 401, code: 'INVALID_TOKEN', message: 'Unknown access token.' };
      }
      if (expiry < Date.now()) {
        return { status: 401, code: 'TOKEN_EXPIRED', message: 'The access token has expired.' };
      }

      return null;
    }

    default:
      return { status: 500, code: 'MOCK_MISCONFIGURED', message: `unknown auth scheme ${scheme}` };
  }
}

// ── data routes ──────────────────────────────────────────────────────────────

function serveData(res, path, url, body) {
  switch (path) {
    case '/customers': {
      const size = Math.max(1, Math.min(intParam(url, 'page_size', 50), 500));
      const page = Math.max(1, intParam(url, 'page', 1));
      const slice = CUSTOMERS.slice((page - 1) * size, page * size);

      return json(res, 200, {
        data: slice,
        meta: { page, page_size: size, total: CUSTOMERS.length, total_pages: Math.ceil(CUSTOMERS.length / size) },
      });
    }

    case '/customers/offset': {
      const limit = Math.max(1, Math.min(intParam(url, 'limit', 50), 500));
      const offset = Math.max(0, intParam(url, 'offset', 0));

      return json(res, 200, {
        data: CUSTOMERS.slice(offset, offset + limit),
        meta: { offset, limit, total: CUSTOMERS.length },
      });
    }

    case '/customers/cursor': {
      const size = Math.max(1, Math.min(intParam(url, 'page_size', 50), 500));
      const cursor = url.searchParams.get('cursor');
      const start = cursor === null || cursor === '' ? 0 : Number(Buffer.from(cursor, 'base64url').toString('utf8'));
      const slice = CUSTOMERS.slice(start, start + size);
      const next = start + size;

      return json(res, 200, {
        data: slice,
        paging: {
          // A cursor is absent, not empty, on the last page: "absent" is the stop
          // condition most ERPs actually use and the one most likely to be got wrong.
          ...(next < CUSTOMERS.length ? { next_cursor: Buffer.from(String(next)).toString('base64url') } : {}),
          returned: slice.length,
        },
      });
    }

    case '/customers/flat':
      return json(res, 200, { data: CUSTOMERS });

    case '/customers/nested':
      return json(res, 200, {
        status: 'ok',
        payload: {
          summary: { count: CUSTOMERS.length },
          // Two arrays in one response, so array discovery has a real choice to make.
          result: { records: CUSTOMERS, warnings: [] },
        },
      });

    case '/catalogue': {
      // Five tables in one answer, which is the case the array picker exists for: different
      // widths, different lengths, one array of scalars and one empty, so a reader has to
      // actually choose rather than take the only thing on offer. Deliberately nested at
      // different depths, because a real ERP does not put them all side by side.
      const warehouses = ['AMS-01', 'RTM-02', 'EIN-03', 'GRQ-04'];

      return json(res, 200, {
        status: 'ok',
        generated_at: '2026-10-08T00:00:00Z',
        data: {
          customers: CUSTOMERS,
          prices: PRICES,
          // A short, wide one: the whole row fits on screen, unlike the two above.
          warehouses: warehouses.map((code, i) => ({
            warehouse_code: code,
            city: ['Amsterdam', 'Rotterdam', 'Eindhoven', 'Groningen'][i],
            country: 'NL',
            bays: String(12 + i * 4),
          })),
          // Scalars, not objects: becomes a one-column table named `value`.
          currencies: ['EUR', 'USD', 'GBP'],
          // Empty on purpose: it must still be offered, and must not read as "no data".
          embargoes: [],
        },
        meta: { tables: 5, note: 'synthetic' },
      });
    }

    case '/customers/many-pages': {
      // 10 per page over 5,000 records = 500 pages. The 20-page cap stops the walk long
      // before the 100,000-record cap, which is the tension §3.2 flags: the remedy is a
      // bigger page size, and the message has to say so.
      const size = 10;
      const page = Math.max(1, intParam(url, 'page', 1));
      const total = 5000;
      const rows = [];
      for (let i = (page - 1) * size; i < Math.min(page * size, total); i++) rows.push(customer(i + 1));

      return json(res, 200, { data: rows, meta: { page, page_size: size, total } });
    }

    case '/prices':
      return json(res, 200, { data: PRICES, meta: { total: PRICES.length } });

    case '/customers/search': {
      const country = (body && typeof body === 'object' ? body.country : null) ?? null;
      const rows = country === null ? CUSTOMERS : CUSTOMERS.filter((c) => c.country === country);

      return json(res, 200, { data: rows, meta: { total: rows.length, filtered_by: country } });
    }

    default:
      return problem(res, 404, 'NOT_FOUND', `No such resource: ${path}`);
  }
}

// ── failure routes ───────────────────────────────────────────────────────────

function serveFailure(res, path, url) {
  const plain = path.replace('/fail', '');

  switch (plain) {
    case '/401': return problem(res, 401, 'UNAUTHORIZED', 'Authentication failed.');
    case '/403': return problem(res, 403, 'FORBIDDEN', 'This account may not read customers.');
    case '/404': return problem(res, 404, 'NOT_FOUND', 'No such endpoint.');
    case '/500': return problem(res, 500, 'INTERNAL', 'The ERP had an internal error.');
    case '/502': return problem(res, 502, 'BAD_GATEWAY', 'Upstream refused.');
    case '/503': return problem(res, 503, 'UNAVAILABLE', 'The ERP is down for maintenance.');
    case '/504': return problem(res, 504, 'GATEWAY_TIMEOUT', 'Upstream timed out.');

    case '/429':
      return problem(res, 429, 'RATE_LIMITED', 'Too many requests.', {}, );

    case '/429-long':
      // Longer than CONNECTIONS_MAX_RETRY_AFTER_MS. Must be reported, never slept through.
      return json(res, 429, { error: { code: 'RATE_LIMITED', message: 'Too many requests.' } }, { 'retry-after': '600' });

    case '/slow': {
      const ms = Math.min(intParam(url, 'ms', 30000), 120000);
      setTimeout(() => {
        if (!res.writableEnded) json(res, 200, { data: [] });
      }, ms);

      return;
    }

    case '/huge': {
      const mb = Math.min(intParam(url, 'mb', 20), 200);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"data":[');
      const chunk = JSON.stringify(customer(1));
      const per = Buffer.byteLength(chunk) + 1;
      const n = Math.ceil((mb * 1024 * 1024) / per);
      let i = 0;
      const pump = () => {
        while (i < n) {
          i++;
          if (!res.write((i === 1 ? '' : ',') + chunk)) return res.once('drain', pump);
        }
        res.end(']}');
      };
      pump();

      return;
    }

    case '/not-json': {
      const text = 'customer_code,customer_name\nC100001,Synthetic Trading 1 BV\n';
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(text) });

      return res.end(text);
    }

    case '/bad-json': {
      const broken = '{"data":[{"customer_code":"C100001","customer_name":"Synthetic';
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(broken) });

      return res.end(broken);
    }

    case '/deep': {
      const depth = Math.min(Math.max(intParam(url, 'depth', 200), 1), 20000);
      let payload = '{"data":[]}';
      for (let i = 0; i < depth; i++) payload = `{"n":${payload}}`;
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });

      return res.end(payload);
    }

    case '/empty-array':
      return json(res, 200, { data: [], meta: { total: 0 } });

    case '/no-array':
      return json(res, 200, { status: 'ok', customer: { code: 'C100001', name: 'Synthetic Trading 1 BV' } });

    case '/echo-key':
      // An ERP that quotes the credential back in its own error text. sanitiseForModel
      // has to strip this before any regeneration prompt is built.
      return problem(res, 400, 'BAD_REQUEST', `The key '${API_KEY}' is not valid for this endpoint.`);

    case '/flaky': {
      const key = url.searchParams.get('key') ?? 'default';
      const succeedAfter = intParam(url, 'succeed_after', 2);
      const seen = (flaky.get(key) ?? 0) + 1;
      flaky.set(key, seen);
      if (seen <= succeedAfter) {
        return problem(res, 503, 'UNAVAILABLE', `Attempt ${seen} of ${succeedAfter + 1}; still warming up.`);
      }

      return json(res, 200, { data: CUSTOMERS.slice(0, 5), meta: { attempts: seen } });
    }

    default:
      return problem(res, 404, 'NOT_FOUND', `No such failure route: ${plain}`);
  }
}

// ── server ───────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
  const path = url.pathname;

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    if (raw !== '') {
      try { body = JSON.parse(raw); } catch { body = raw; }
    }

    calls.push({
      at: new Date().toISOString(),
      method: req.method,
      path,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body,
    });
    if (calls.length > MAX_CALLS) calls.splice(0, calls.length - MAX_CALLS);

    // ── introspection ──
    if ((path === '/_calls' || path === '/_reset') && ADMIN_TOKEN !== ''
      && req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) {
      return problem(res, 401, 'ADMIN_ONLY', 'Introspection needs the admin token.');
    }
    if (path === '/_calls') return json(res, 200, { count: calls.length, calls });
    if (path === '/_reset') {
      calls.length = 0;
      flaky.clear();
      mintedTokens.clear();

      return json(res, 200, { ok: true });
    }
    if (path === '/_health') return json(res, 200, { ok: true, customers: CUSTOMERS.length, prices: PRICES.length });

    // ── OAuth token endpoint ──
    if (path === '/oauth/token') {
      if (req.method !== 'POST') return problem(res, 405, 'METHOD_NOT_ALLOWED', 'POST only.');

      const form = new URLSearchParams(typeof body === 'string' ? body : '');
      const authHeader = req.headers.authorization ?? '';
      const fromHeader = authHeader.startsWith('Basic ')
        ? Buffer.from(authHeader.slice(6), 'base64').toString('utf8').split(':')
        : null;
      const id = form.get('client_id') ?? fromHeader?.[0] ?? '';
      const secret = form.get('client_secret') ?? fromHeader?.[1] ?? '';

      if (form.get('grant_type') !== 'client_credentials') {
        return problem(res, 400, 'UNSUPPORTED_GRANT_TYPE', 'Only client_credentials is supported.');
      }
      if (id !== OAUTH_CLIENT_ID || secret !== OAUTH_CLIENT_SECRET) {
        return problem(res, 401, 'INVALID_CLIENT', 'Client authentication failed.');
      }

      const expiresIn = intParam(url, 'expires_in', 3600);
      const token = `mock-access-${Math.random().toString(36).slice(2)}-${Date.now()}`;
      mintedTokens.set(token, Date.now() + expiresIn * 1000);

      return json(res, 200, { access_token: token, token_type: 'Bearer', expires_in: expiresIn, scope: form.get('scope') ?? '' });
    }

    // ── redirects ──
    if (path === '/redirect/same') {
      const n = intParam(url, 'n', 1);

      return n <= 0
        ? json(res, 302, {}, { location: '/auth/none/customers/flat' })
        : json(res, 302, {}, { location: `/redirect/same?n=${n - 1}` });
    }
    if (path === '/redirect/cross') {
      return json(res, 302, {}, { location: 'https://example.invalid/customers' });
    }
    if (path === '/redirect/private') {
      return json(res, 302, {}, { location: 'http://169.254.169.254/latest/meta-data/' });
    }

    // ── failures ──
    if (path.startsWith('/fail/')) return serveFailure(res, path, url);

    // ── authenticated data ──
    const m = /^\/auth\/([a-z-]+)(\/.*)$/.exec(path);
    if (m !== null) {
      const [, scheme, rest] = m;
      const refusal = checkAuth(scheme, req, url);
      if (refusal !== null) return problem(res, refusal.status, refusal.code, refusal.message);

      return serveData(res, rest, url, body);
    }

    return problem(res, 404, 'NOT_FOUND', `No such route: ${path}. GET /_health for a route list.`);
  });
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`mock ERP listening on http://${HOST}:${PORT}\n`);
  process.stdout.write(`  ${TOTAL_CUSTOMERS} customers, ${TOTAL_PRICES} prices (synthetic)\n`);
  process.stdout.write(`  api key ${API_KEY} | bearer ${BEARER_TOKEN} | basic ${BASIC_USER}:${BASIC_PASS}\n`);
  process.stdout.write(`  oauth ${OAUTH_CLIENT_ID}:${OAUTH_CLIENT_SECRET} at POST /oauth/token\n`);
});
