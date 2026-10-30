/**
 * Smoke test against a running mock, local or deployed:
 *
 *   node smoke.mjs http://127.0.0.1:4500
 *   node smoke.mjs https://erp-mock.<you>.workers.dev <ADMIN_TOKEN>
 *
 * Exits non-zero on the first failed check.
 */
const base = (process.argv[2] ?? 'http://127.0.0.1:4500').replace(/\/$/, '');
const admin = process.argv[3] ?? '';

let failed = 0;
async function check(name, fn) {
  try {
    const detail = await fn();
    process.stdout.write(`  ok   ${name}${detail ? `  (${detail})` : ''}\n`);
  } catch (error) {
    failed++;
    process.stdout.write(`  FAIL ${name}: ${error.message}\n`);
  }
}
function expect(cond, message) {
  if (!cond) throw new Error(message);
}
const get = (path, init) => fetch(base + path, { redirect: 'manual', ...init });

const KEY = 'erp-api-key-7F3A91CD';
const basic = `Basic ${btoa('erp_service_account:erp-basic-pass-9D41')}`;

await check('health', async () => {
  const body = await (await get('/_health')).json();
  expect(body.ok && body.customers === 237, JSON.stringify(body));
});

for (const [name, path, init] of [
  ['none', '/auth/none/customers', {}],
  ['apikey-header', '/auth/apikey-header/customers', { headers: { 'x-api-key': KEY } }],
  ['apikey-query', `/auth/apikey-query/customers?api_key=${KEY}`, {}],
  ['bearer', '/auth/bearer/customers', { headers: { authorization: 'Bearer erp-bearer-5E2B88A0' } }],
  ['basic', '/auth/basic/customers', { headers: { authorization: basic } }],
]) {
  await check(`auth ${name}`, async () => {
    const res = await get(path, init);
    const body = await res.json();
    expect(res.status === 200 && body.data.length === 50, `${res.status}`);
  });
}

await check('wrong api key -> 401', async () => {
  const res = await get('/auth/apikey-header/customers', { headers: { 'x-api-key': 'nope' } });
  expect(res.status === 401, `${res.status}`);
});

await check('oauth: mint in body, then read', async () => {
  const res = await get('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&client_id=docupath-local-client&client_secret=erp-oauth-secret-B72C',
  });
  const { access_token: token } = await res.json();
  expect(res.status === 200 && token, `${res.status}`);
  // Several reads, so on Workers they are likely to land on more than one instance.
  for (let i = 0; i < 5; i++) {
    const read = await get('/auth/oauth/customers', { headers: { authorization: `Bearer ${token}` } });
    expect(read.status === 200, `read ${i}: ${read.status}`);
  }
});

await check('oauth: client credentials over HTTP Basic', async () => {
  const res = await get('/oauth/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${btoa('docupath-local-client:erp-oauth-secret-B72C')}`,
    },
    body: 'grant_type=client_credentials',
  });
  expect(res.status === 200, `${res.status}`);
});

await check('oauth: wrong secret -> 401', async () => {
  const res = await get('/oauth/token', {
    method: 'POST',
    body: 'grant_type=client_credentials&client_id=docupath-local-client&client_secret=wrong',
  });
  expect(res.status === 401, `${res.status}`);
});

await check('oauth: forged token -> 401', async () => {
  const res = await get('/auth/oauth/customers', {
    headers: { authorization: `Bearer mock-access-1-99999999999999-${'0'.repeat(32)}` },
  });
  expect(res.status === 401, `${res.status}`);
});

await check('oauth: expired token -> TOKEN_EXPIRED', async () => {
  const mint = await get('/oauth/token?expires_in=-10', {
    method: 'POST',
    body: 'grant_type=client_credentials&client_id=docupath-local-client&client_secret=erp-oauth-secret-B72C',
  });
  const { access_token: token } = await mint.json();
  const res = await get('/auth/oauth/customers', { headers: { authorization: `Bearer ${token}` } });
  const body = await res.json();
  expect(res.status === 401 && body.error.code === 'TOKEN_EXPIRED', `${res.status} ${body.error?.code}`);
});

await check('pagination: page walks 237', async () => {
  let total = 0;
  for (let page = 1; page <= 5; page++) total += (await (await get(`/auth/none/customers?page=${page}`)).json()).data.length;
  expect(total === 237, `${total}`);
});

await check('pagination: cursor walks 237 and stops', async () => {
  let total = 0;
  let cursor = '';
  for (let i = 0; i < 10; i++) {
    const body = await (await get(`/auth/none/customers/cursor?cursor=${cursor}`)).json();
    total += body.data.length;
    if (!body.paging.next_cursor) break;
    cursor = body.paging.next_cursor;
  }
  expect(total === 237, `${total}`);
});

await check('offset, flat, nested, catalogue, prices, many-pages', async () => {
  expect((await (await get('/auth/none/customers/offset?offset=200')).json()).data.length === 37, 'offset');
  expect((await (await get('/auth/none/customers/flat')).json()).data.length === 237, 'flat');
  expect((await (await get('/auth/none/customers/nested')).json()).payload.result.records.length === 237, 'nested');
  expect(Object.keys((await (await get('/auth/none/catalogue')).json()).data).length === 5, 'catalogue');
  expect((await (await get('/auth/none/prices')).json()).data.length === 64, 'prices');
  expect((await (await get('/auth/none/customers/many-pages?page=3')).json()).meta.total === 5000, 'many-pages');
});

await check('POST search filters', async () => {
  const res = await get('/auth/none/customers/search', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"country":"NL"}',
  });
  const body = await res.json();
  expect(body.data.length > 0 && body.data.every((c) => c.country === 'NL'), `${body.data.length}`);
});

await check('link-header, next-url, odata and has-more each walk 237 and stop', async () => {
  const walk = async (first, step) => {
    let total = 0;
    let next = first;
    for (let i = 0; next && i < 20; i++) {
      const res = await fetch(next);
      next = await step(res, (n) => { total += n; });
    }
    expect(next === null, `did not stop (${total})`);

    return total;
  };
  const linkTotal = await walk(`${base}/auth/none/customers/link-header`, async (res, add) => {
    add((await res.json()).length);

    return /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1] ?? null;
  });
  expect(linkTotal === 237, `link-header ${linkTotal}`);
  const nextTotal = await walk(`${base}/auth/none/customers/next-url`, async (res, add) => {
    const body = await res.json();
    add(body.results.length);

    return body.links.next;
  });
  expect(nextTotal === 237, `next-url ${nextTotal}`);
  const odataTotal = await walk(`${base}/auth/none/customers/odata`, async (res, add) => {
    const body = await res.json();
    add(body.value.length);

    return body['@odata.nextLink'] ?? null;
  });
  expect(odataTotal === 237, `odata ${odataTotal}`);
  const stripeTotal = await walk(`${base}/auth/none/customers/has-more`, async (res, add) => {
    const body = await res.json();
    add(body.data.length);

    return body.has_more ? `${base}/auth/none/customers/has-more?starting_after=${body.data.at(-1).customer_code}` : null;
  });
  expect(stripeTotal === 237, `has-more ${stripeTotal}`);
  expect((await get('/auth/none/customers/has-more?starting_after=nope')).status === 400, 'has-more bad cursor');
});

await check('top-level-array, updated-since, unicode, mixed-types, invoices', async () => {
  expect((await (await get('/auth/none/customers/top-level-array')).json()).length === 237, 'top-level-array');
  const since = await (await get('/auth/none/customers/updated-since?updated_since=2026-08-01T00:00:00Z')).json();
  expect(since.data.length === 25 && since.data.every((c) => c.updated_at >= '2026-08-01'), `updated-since ${since.data.length}`);
  expect((await get('/auth/none/customers/updated-since?updated_since=yesterday')).status === 400, 'updated-since bad date');
  const uni = await (await get('/auth/none/customers/unicode')).json();
  expect(uni.data.length === 16 && uni.data.some((c) => c.customer_name.includes('📦')), 'unicode');
  expect((await (await get('/auth/none/customers/mixed-types')).json()).data.length === 10, 'mixed-types');
  const inv = await (await get('/auth/none/invoices?page=5')).json();
  expect(inv.data.length === 20 && inv.meta.total === 120 && inv.data.every((i) => i.lines.length >= 1), 'invoices');
});

await check('customer versions: same people, fields changed as documented', async () => {
  const fieldsOf = async (path) => {
    const body = await (await get(`/auth/none${path}`)).json();
    expect(body.data.length === 237, `${path} returned ${body.data.length}`);
    expect(body.data[0].customer_code === 'C100001', `${path} first row`);

    return Object.keys(body.data[0]);
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const v1 = ['customer_code', 'customer_name', 'country', 'status'];
  expect(same(await fieldsOf('/customers/v1'), v1), 'v1');
  expect(same(await fieldsOf('/customers/v2-added-fields'), [...v1, 'email', 'payment_terms']), 'v2');
  expect(same(await fieldsOf('/customers/v3-dropped-field'), ['customer_code', 'customer_name', 'country']), 'v3');
  expect(same(await fieldsOf('/customers/v4-renamed-case'), ['customer_code', 'Customer_Name', 'country', 'status']), 'v4');
  expect(same(await fieldsOf('/customers/v5-renamed-field'), ['customer_code', 'name', 'country', 'status']), 'v5');
  const v6 = await fieldsOf('/customers/v6-reordered');
  expect(!same(v6, v1) && same([...v6].sort(), [...v1].sort()), 'v6');
});

await check('apikey-v2: the v2 key opens it, the original key does not', async () => {
  const withV2 = await get('/auth/apikey-v2/customers/v2-added-fields', { headers: { 'x-api-key': 'erp-api-key-v2-4C19E7AB' } });
  expect(withV2.status === 200 && (await withV2.json()).data.length === 237, `v2 key: ${withV2.status}`);
  const withV1 = await get('/auth/apikey-v2/customers/v2-added-fields', { headers: { 'x-api-key': KEY } });
  expect(withV1.status === 401, `original key: ${withV1.status}`);
  const v2OnOld = await get('/auth/apikey-header/customers/v1', { headers: { 'x-api-key': 'erp-api-key-v2-4C19E7AB' } });
  expect(v2OnOld.status === 401, `v2 key on the original route: ${v2OnOld.status}`);
});

await check('available-until: up before the moment, 503 after it, any auth prefix', async () => {
  const soon = Math.floor(Date.now() / 1000) + 3600;
  const up = await get(`/auth/apikey-header/customers/available-until/${soon}`, { headers: { 'x-api-key': KEY } });
  const upBody = await up.json();
  expect(up.status === 200 && upBody.data.length === 237 && upBody.meta.available_until === soon, `before: ${up.status}`);

  const past = Math.floor(Date.now() / 1000) - 1;
  const down = await get(`/auth/apikey-header/customers/available-until/${past}`, { headers: { 'x-api-key': KEY } });
  expect(down.status === 503 && down.headers.get('retry-after') === '3600', `after: ${down.status}`);
  expect((await down.json()).error.code === 'UNAVAILABLE', 'after: code');

  const gateway = await get(`/auth/none/customers/available-until/${past}?fail_status=502`);
  expect(gateway.status === 502, `fail_status=502: ${gateway.status}`);
  const unknown = await get(`/auth/none/customers/available-until/${past}?fail_status=418`);
  expect(unknown.status === 503, `fail_status=418 falls back to 503: ${unknown.status}`);

  const wrongKey = await get(`/auth/apikey-header/customers/available-until/${soon}`, { headers: { 'x-api-key': 'nope' } });
  expect(wrongKey.status === 401, `wrong key still refused: ${wrongKey.status}`);
});

await check('down-between: up before the window, down inside it, back up after it', async () => {
  const now = Math.floor(Date.now() / 1000);
  const before = await get(`/auth/apikey-header/customers/down-between/${now + 600}/${now + 1200}`, { headers: { 'x-api-key': KEY } });
  const beforeBody = await before.json();
  expect(before.status === 200 && beforeBody.data.length === 237, `before: ${before.status}`);

  const inside = await get(`/auth/apikey-header/customers/down-between/${now - 60}/${now + 600}`, { headers: { 'x-api-key': KEY } });
  const retryAfter = Number(inside.headers.get('retry-after'));
  expect(inside.status === 503 && retryAfter > 0 && retryAfter <= 600, `inside: ${inside.status}, retry-after ${retryAfter}`);
  expect((await inside.json()).error.code === 'UNAVAILABLE', 'inside: code');

  const after = await get(`/auth/none/customers/down-between/${now - 600}/${now - 60}`);
  expect(after.status === 200 && (await after.json()).data.length === 237, `after: ${after.status}`);

  const gateway = await get(`/auth/none/customers/down-between/${now - 60}/${now + 600}?fail_status=504`);
  expect(gateway.status === 504, `fail_status=504: ${gateway.status}`);
  const reversed = await get(`/auth/none/customers/down-between/${now + 600}/${now}`);
  expect(reversed.status === 400, `a window that ends before it starts: ${reversed.status}`);

  const wrongKey = await get(`/auth/apikey-header/customers/down-between/${now + 600}/${now + 1200}`, { headers: { 'x-api-key': 'nope' } });
  expect(wrongKey.status === 401, `wrong key still refused: ${wrongKey.status}`);
});

await check('html-login, error-in-200, json-as-html, bom, xml', async () => {
  expect((await get('/fail/html-login')).headers.get('content-type').startsWith('text/html'), 'html-login');
  expect((await (await get('/fail/error-in-200')).json()).success === false, 'error-in-200');
  const asHtml = await get('/fail/json-as-html');
  expect(asHtml.headers.get('content-type') === 'text/html' && JSON.parse(await asHtml.text()).data.length === 5, 'json-as-html');
  const bom = new Uint8Array(await (await get('/fail/bom')).arrayBuffer());
  expect(bom[0] === 0xef && bom[1] === 0xbb && bom[2] === 0xbf, 'bom');
  expect((await (await get('/fail/xml')).text()).startsWith('<?xml'), 'xml');
});

await check('cursor-loop, page-ignored, total-lies', async () => {
  const a = await (await get('/fail/cursor-loop')).json();
  const b = await (await get(`/fail/cursor-loop?cursor=${a.paging.next_cursor}`)).json();
  expect(a.paging.next_cursor === b.paging.next_cursor, 'cursor-loop');
  const p1 = await (await get('/fail/page-ignored?page=1')).json();
  const p3 = await (await get('/fail/page-ignored?page=3')).json();
  expect(p1.data[0].customer_code === p3.data[0].customer_code && p3.meta.total_pages === 5, 'page-ignored');
  const lies = await (await get('/fail/total-lies?page=4')).json();
  expect(lies.data.length === 0 && lies.meta.total === 500, 'total-lies');
});

await check('failure statuses', async () => {
  for (const s of [401, 403, 404, 429, 500, 502, 503, 504]) {
    expect((await get(`/fail/${s}`)).status === s, `${s}`);
  }
  expect((await get('/fail/429-long')).headers.get('retry-after') === '600', 'retry-after');
});

await check('not-json, bad-json, deep, empty-array, no-array, echo-key', async () => {
  expect((await get('/fail/not-json')).headers.get('content-type').startsWith('text/plain'), 'not-json');
  const bad = await (await get('/fail/bad-json')).text();
  expect(bad.startsWith('{"data":[') && !bad.endsWith('}'), 'bad-json');
  const deep = await (await get('/fail/deep?depth=500')).text();
  let d = 0;
  let o = JSON.parse(deep);
  while (o.n) { o = o.n; d++; }
  expect(d === 500, `deep ${d}`);
  expect((await (await get('/fail/empty-array')).json()).data.length === 0, 'empty');
  expect(!('data' in (await (await get('/fail/no-array')).json())), 'no-array');
  expect((await (await get('/fail/echo-key')).text()).includes(KEY), 'echo-key');
});

await check('slow holds the response', async () => {
  const t = Date.now();
  await (await get('/fail/slow?ms=1500')).json();
  expect(Date.now() - t >= 1400, `${Date.now() - t}ms`);
});

await check('huge streams valid JSON of the size asked', async () => {
  const text = await (await get('/fail/huge?mb=2')).text();
  const parsed = JSON.parse(text);
  expect(text.length >= 2 * 1024 * 1024 && parsed.data.length > 1000, `${text.length}`);

  return `${(text.length / 1024 / 1024).toFixed(1)} MB, ${parsed.data.length} rows`;
});

await check('redirects', async () => {
  expect((await get('/redirect/same?n=1')).headers.get('location') === '/redirect/same?n=0', 'same');
  expect((await get('/redirect/cross')).headers.get('location').startsWith('https://example.invalid'), 'cross');
  expect((await get('/redirect/private')).headers.get('location').startsWith('http://169.254.169.254'), 'private');
});

await check('introspection gate', async () => {
  const open = await get('/_calls');
  if (admin === '') return `/_calls answered ${open.status} with no admin token supplied`;
  expect(open.status === 401, `without token: ${open.status}`);
  const withToken = await get('/_calls', { headers: { authorization: `Bearer ${admin}` } });
  expect(withToken.status === 200, `with token: ${withToken.status}`);

  return 'closed without the token, open with it';
});

process.stdout.write(failed === 0 ? '\nall checks passed\n' : `\n${failed} check(s) failed\n`);
process.exit(failed === 0 ? 0 : 1);
