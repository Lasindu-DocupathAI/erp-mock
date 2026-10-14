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
