/**
 * A stand-in ERP for testing Connected Data Sources. Every route lives here, written against
 * the web-standard Request/Response so the same code runs under Node (server.mjs) and on
 * Cloudflare Workers (worker.mjs).
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
 *   /fail/slow?ms=              holds the response, for the deadline
 *   /fail/huge?mb=              oversized body (capture aborts at 10 MB; capped at 50)
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
 *   GET  /_health                liveness and record counts
 *   GET  /_calls                 the last MAX_CALLS requests seen: method, path, headers, body
 *   POST /_reset                 clear the call log and flaky counters, revoke minted tokens
 *
 * With an adminToken set, /_calls and /_reset need `Authorization: Bearer <adminToken>`.
 * Without it, anyone who can reach the mock can read every header and body sent to it,
 * including a real credential pasted into a test by mistake.
 *
 * STATE ON WORKERS IS PER ISOLATE. Cloudflare may answer consecutive requests from different
 * instances, so nothing that has to survive between requests is kept in memory:
 *   - OAuth tokens are self-validating (issue time + expiry + HMAC), so a token minted by one
 *     instance is accepted by every other one.
 *   - /_calls, /fail/flaky counters and /_reset are best-effort: they see only the instance
 *     that answered. Under Node there is one instance and they are exact.
 */

export const API_KEY = 'erp-api-key-7F3A91CD';
export const BEARER_TOKEN = 'erp-bearer-5E2B88A0';
export const BASIC_USER = 'erp_service_account';
export const BASIC_PASS = 'erp-basic-pass-9D41';
export const OAUTH_CLIENT_ID = 'docupath-local-client';
export const OAUTH_CLIENT_SECRET = 'erp-oauth-secret-B72C';

/** Bounded, so a public deployment's scanner traffic cannot grow the log without limit. */
const MAX_CALLS = 500;
const MAX_HUGE_MB = 50;

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

// ── helpers ──────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

function json(status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);

  return new Response(payload, { status, headers: { 'content-type': 'application/json', ...headers } });
}

function raw(status, contentType, text) {
  return new Response(text, { status, headers: { 'content-type': contentType } });
}

function problem(status, code, message, extra = {}) {
  return json(status, { error: { code, message, ...extra } });
}

function intParam(url, name, fallback) {
  const value = url.searchParams.get(name);
  if (value === null || value.trim() === '') return fallback;
  const n = Number(value);

  return Number.isFinite(n) ? n : fallback;
}

function base64(text) {
  return btoa(String.fromCharCode(...encoder.encode(text)));
}

function base64url(text) {
  return base64(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');

  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

function fromBase64(text) {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));
  } catch {
    return '';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── the app ──────────────────────────────────────────────────────────────────

/**
 * @param {{ adminToken?: string, tokenSecret?: string, totalCustomers?: number, totalPrices?: number }} options
 * @returns {{ handle: (request: Request) => Promise<Response>, customers: number, prices: number }}
 */
export function createApp(options = {}) {
  const adminToken = options.adminToken ?? '';
  const totalCustomers = options.totalCustomers ?? 237;
  const totalPrices = options.totalPrices ?? 64;

  const CUSTOMERS = Array.from({ length: totalCustomers }, (_, i) => customer(i + 1));
  const PRICES = Array.from({ length: totalPrices }, (_, i) => priceRow(i + 1));

  /** Every call this instance has seen, so a test can assert what was actually sent. */
  const calls = [];
  /** Per-key counters for /fail/flaky. */
  const flaky = new Map();
  /** Tokens issued before this instant are refused: what /_reset revokes. */
  let revokedBefore = 0;

  const hmacKey = crypto.subtle.importKey(
    'raw',
    encoder.encode(options.tokenSecret ?? `erp-mock-token-key|${OAUTH_CLIENT_SECRET}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  async function sign(text) {
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey, encoder.encode(text)));

    return Array.from(mac.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function mintToken(expiresIn) {
    const issued = Date.now();
    const claims = `${issued}-${issued + expiresIn * 1000}`;

    return `mock-access-${claims}-${await sign(claims)}`;
  }

  /** null when valid, else the refusal. */
  async function checkToken(token) {
    const m = /^mock-access-(\d+)-(\d+)-([0-9a-f]{32})$/.exec(token);
    if (m === null || (await sign(`${m[1]}-${m[2]}`)) !== m[3] || Number(m[1]) < revokedBefore) {
      return { status: 401, code: 'INVALID_TOKEN', message: 'Unknown access token.' };
    }
    if (Number(m[2]) < Date.now()) {
      return { status: 401, code: 'TOKEN_EXPIRED', message: 'The access token has expired.' };
    }

    return null;
  }

  /**
   * Which auth a route demands, and whether the request satisfied it.
   * Returns null when satisfied, or a {status, code, message} to answer with.
   */
  async function checkAuth(scheme, request, url) {
    const auth = request.headers.get('authorization') ?? '';

    switch (scheme) {
      case 'none':
        return null;

      case 'apikey-header':
        return request.headers.get('x-api-key') === API_KEY
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

      case 'basic':
        return auth === `Basic ${base64(`${BASIC_USER}:${BASIC_PASS}`)}`
          ? null
          : { status: 401, code: 'INVALID_CREDENTIALS', message: 'Basic authentication failed.' };

      case 'oauth':
        return checkToken(auth.startsWith('Bearer ') ? auth.slice(7) : '');

      default:
        return { status: 500, code: 'MOCK_MISCONFIGURED', message: `unknown auth scheme ${scheme}` };
    }
  }

  // ── data routes ────────────────────────────────────────────────────────────

  function serveData(path, url, body) {
    switch (path) {
      case '/customers': {
        const size = Math.max(1, Math.min(intParam(url, 'page_size', 50), 500));
        const page = Math.max(1, intParam(url, 'page', 1));
        const slice = CUSTOMERS.slice((page - 1) * size, page * size);

        return json(200, {
          data: slice,
          meta: { page, page_size: size, total: CUSTOMERS.length, total_pages: Math.ceil(CUSTOMERS.length / size) },
        });
      }

      case '/customers/offset': {
        const limit = Math.max(1, Math.min(intParam(url, 'limit', 50), 500));
        const offset = Math.max(0, intParam(url, 'offset', 0));

        return json(200, {
          data: CUSTOMERS.slice(offset, offset + limit),
          meta: { offset, limit, total: CUSTOMERS.length },
        });
      }

      case '/customers/cursor': {
        const size = Math.max(1, Math.min(intParam(url, 'page_size', 50), 500));
        const cursor = url.searchParams.get('cursor');
        const start = cursor === null || cursor === '' ? 0 : Number(fromBase64url(cursor)) || 0;
        const slice = CUSTOMERS.slice(start, start + size);
        const next = start + size;

        return json(200, {
          data: slice,
          paging: {
            // A cursor is absent, not empty, on the last page: "absent" is the stop
            // condition most ERPs actually use and the one most likely to be got wrong.
            ...(next < CUSTOMERS.length ? { next_cursor: base64url(String(next)) } : {}),
            returned: slice.length,
          },
        });
      }

      case '/customers/flat':
        return json(200, { data: CUSTOMERS });

      case '/customers/nested':
        return json(200, {
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

        return json(200, {
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

        return json(200, { data: rows, meta: { page, page_size: size, total } });
      }

      case '/prices':
        return json(200, { data: PRICES, meta: { total: PRICES.length } });

      case '/customers/search': {
        const country = (body && typeof body === 'object' ? body.country : null) ?? null;
        const rows = country === null ? CUSTOMERS : CUSTOMERS.filter((c) => c.country === country);

        return json(200, { data: rows, meta: { total: rows.length, filtered_by: country } });
      }

      default:
        return problem(404, 'NOT_FOUND', `No such resource: ${path}`);
    }
  }

  // ── failure routes ─────────────────────────────────────────────────────────

  async function serveFailure(path, url) {
    const plain = path.replace('/fail', '');

    switch (plain) {
      case '/401': return problem(401, 'UNAUTHORIZED', 'Authentication failed.');
      case '/403': return problem(403, 'FORBIDDEN', 'This account may not read customers.');
      case '/404': return problem(404, 'NOT_FOUND', 'No such endpoint.');
      case '/500': return problem(500, 'INTERNAL', 'The ERP had an internal error.');
      case '/502': return problem(502, 'BAD_GATEWAY', 'Upstream refused.');
      case '/503': return problem(503, 'UNAVAILABLE', 'The ERP is down for maintenance.');
      case '/504': return problem(504, 'GATEWAY_TIMEOUT', 'Upstream timed out.');

      case '/429':
        return problem(429, 'RATE_LIMITED', 'Too many requests.');

      case '/429-long':
        // Longer than CONNECTIONS_MAX_RETRY_AFTER_MS. Must be reported, never slept through.
        return json(429, { error: { code: 'RATE_LIMITED', message: 'Too many requests.' } }, { 'retry-after': '600' });

      case '/slow':
        await sleep(Math.max(0, Math.min(intParam(url, 'ms', 30000), 120000)));

        return json(200, { data: [] });

      case '/huge': {
        // One pre-encoded block enqueued over and over: the bytes are what is being tested,
        // and re-serialising each record would spend a Worker's CPU budget for nothing.
        const target = Math.max(1, Math.min(intParam(url, 'mb', 20), MAX_HUGE_MB)) * 1024 * 1024;
        const unit = JSON.stringify(customer(1));
        const head = encoder.encode(`{"data":[${unit}`);
        const block = encoder.encode(`,${unit}`.repeat(Math.ceil(65536 / (unit.length + 1))));
        let sent = 0;

        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(head);
            sent = head.length;
          },
          pull(controller) {
            if (sent >= target) {
              controller.enqueue(encoder.encode(']}'));
              controller.close();

              return;
            }
            controller.enqueue(block);
            sent += block.length;
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }

      case '/not-json':
        return raw(200, 'text/plain', 'customer_code,customer_name\nC100001,Synthetic Trading 1 BV\n');

      case '/bad-json':
        return raw(200, 'application/json', '{"data":[{"customer_code":"C100001","customer_name":"Synthetic');

      case '/deep': {
        const depth = Math.min(Math.max(intParam(url, 'depth', 200), 1), 20000);

        return raw(200, 'application/json', `${'{"n":'.repeat(depth)}{"data":[]}${'}'.repeat(depth)}`);
      }

      case '/empty-array':
        return json(200, { data: [], meta: { total: 0 } });

      case '/no-array':
        return json(200, { status: 'ok', customer: { code: 'C100001', name: 'Synthetic Trading 1 BV' } });

      case '/echo-key':
        // An ERP that quotes the credential back in its own error text. sanitiseForModel
        // has to strip this before any regeneration prompt is built.
        return problem(400, 'BAD_REQUEST', `The key '${API_KEY}' is not valid for this endpoint.`);

      case '/flaky': {
        const key = url.searchParams.get('key') ?? 'default';
        const succeedAfter = intParam(url, 'succeed_after', 2);
        const seen = (flaky.get(key) ?? 0) + 1;
        flaky.set(key, seen);
        if (seen <= succeedAfter) {
          return problem(503, 'UNAVAILABLE', `Attempt ${seen} of ${succeedAfter + 1}; still warming up.`);
        }

        return json(200, { data: CUSTOMERS.slice(0, 5), meta: { attempts: seen } });
      }

      default:
        return problem(404, 'NOT_FOUND', `No such failure route: ${plain}`);
    }
  }

  // ── router ─────────────────────────────────────────────────────────────────

  async function handle(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    const text = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
    let body = null;
    if (text !== '') {
      try { body = JSON.parse(text); } catch { body = text; }
    }

    calls.push({
      at: new Date().toISOString(),
      method: request.method,
      path,
      query: Object.fromEntries(url.searchParams),
      headers: Object.fromEntries(request.headers),
      body,
    });
    if (calls.length > MAX_CALLS) calls.splice(0, calls.length - MAX_CALLS);

    // ── introspection ──
    if (path === '/_health') return json(200, { ok: true, customers: CUSTOMERS.length, prices: PRICES.length });
    if (path === '/_calls' || path === '/_reset') {
      if (adminToken !== '' && request.headers.get('authorization') !== `Bearer ${adminToken}`) {
        return problem(401, 'ADMIN_ONLY', 'Introspection needs the admin token.');
      }
      if (path === '/_calls') return json(200, { count: calls.length, calls });
      calls.length = 0;
      flaky.clear();
      revokedBefore = Date.now() + 1;

      return json(200, { ok: true });
    }

    // ── OAuth token endpoint ──
    if (path === '/oauth/token') {
      if (request.method !== 'POST') return problem(405, 'METHOD_NOT_ALLOWED', 'POST only.');

      const form = new URLSearchParams(typeof body === 'string' ? body : '');
      const authHeader = request.headers.get('authorization') ?? '';
      const fromHeader = authHeader.startsWith('Basic ') ? fromBase64(authHeader.slice(6)).split(':') : null;
      const id = form.get('client_id') ?? fromHeader?.[0] ?? '';
      const secret = form.get('client_secret') ?? fromHeader?.[1] ?? '';

      if (form.get('grant_type') !== 'client_credentials') {
        return problem(400, 'UNSUPPORTED_GRANT_TYPE', 'Only client_credentials is supported.');
      }
      if (id !== OAUTH_CLIENT_ID || secret !== OAUTH_CLIENT_SECRET) {
        return problem(401, 'INVALID_CLIENT', 'Client authentication failed.');
      }

      const expiresIn = intParam(url, 'expires_in', 3600);

      return json(200, {
        access_token: await mintToken(expiresIn),
        token_type: 'Bearer',
        expires_in: expiresIn,
        scope: form.get('scope') ?? '',
      });
    }

    // ── redirects ──
    if (path === '/redirect/same') {
      const n = intParam(url, 'n', 1);

      return n <= 0
        ? json(302, {}, { location: '/auth/none/customers/flat' })
        : json(302, {}, { location: `/redirect/same?n=${n - 1}` });
    }
    if (path === '/redirect/cross') return json(302, {}, { location: 'https://example.invalid/customers' });
    if (path === '/redirect/private') return json(302, {}, { location: 'http://169.254.169.254/latest/meta-data/' });

    // ── failures ──
    if (path.startsWith('/fail/')) return serveFailure(path, url);

    // ── authenticated data ──
    const m = /^\/auth\/([a-z-]+)(\/.*)$/.exec(path);
    if (m !== null) {
      const [, scheme, rest] = m;
      const refusal = await checkAuth(scheme, request, url);
      if (refusal !== null) return problem(refusal.status, refusal.code, refusal.message);

      return serveData(rest, url, body);
    }

    return problem(404, 'NOT_FOUND', `No such route: ${path}. See the README for the route list.`);
  }

  return { handle, customers: CUSTOMERS.length, prices: PRICES.length };
}
