/**
 * Node entry point (Node 18+, no dependencies). All routes are in app.mjs.
 *
 *   node server.mjs            # listens on 127.0.0.1:4500
 *   PORT=4600 node server.mjs
 *   ADMIN_TOKEN=... node server.mjs   # gate /_calls and /_reset (do this behind any tunnel)
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
 * Those two must be UNSET in every deployed environment.
 */
import http from 'node:http';
import { Readable } from 'node:stream';
import {
  createApp, API_KEY, BEARER_TOKEN, BASIC_USER, BASIC_PASS, OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET,
} from './app.mjs';

const PORT = Number(process.env.PORT ?? 4500);
const HOST = process.env.HOST ?? '127.0.0.1';

const app = createApp({
  adminToken: process.env.ADMIN_TOKEN ?? '',
  totalCustomers: Number(process.env.TOTAL_CUSTOMERS ?? 237),
  totalPrices: Number(process.env.TOTAL_PRICES ?? 64),
});

/** Hop-by-hop headers belong to this socket, not to the request the app sees. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection']);

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined && !HOP_BY_HOP.has(name)) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const request = new Request(`http://${req.headers.host ?? `${HOST}:${PORT}`}${req.url}`, {
      method: req.method,
      headers,
      body: hasBody ? Buffer.concat(chunks) : undefined,
    });

    const response = await app.handle(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body === null) {
      res.end();

      return;
    }
    // A client that hangs up mid-stream (capture aborting /fail/huge) is expected, not an error.
    const body = Readable.fromWeb(response.body);
    body.on('error', () => res.destroy());
    res.on('close', () => body.destroy());
    body.pipe(res);
  } catch (error) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'MOCK_CRASHED', message: String(error) } }));
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`mock ERP listening on http://${HOST}:${PORT}\n`);
  process.stdout.write(`  ${app.customers} customers, ${app.prices} prices (synthetic)\n`);
  process.stdout.write(`  api key ${API_KEY} | bearer ${BEARER_TOKEN} | basic ${BASIC_USER}:${BASIC_PASS}\n`);
  process.stdout.write(`  oauth ${OAUTH_CLIENT_ID}:${OAUTH_CLIENT_SECRET} at POST /oauth/token\n`);
});
