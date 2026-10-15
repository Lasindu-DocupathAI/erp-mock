# erp-mock

A stand-in ERP for testing Docupath **Connected Data Sources**. One file, no dependencies, Node 18+.
Every record is synthetic: no real customer, price or product ever belongs here.

## Layout

| File | What |
|---|---|
| `app.mjs` | every route and all the data, on web-standard `Request`/`Response` |
| `server.mjs` | Node entry point (local use, or behind a tunnel) |
| `worker.mjs` | Cloudflare Workers entry point (the public deployment) |
| `smoke.mjs` | checks every route against any running copy |

## Run locally

```bash
node server.mjs                 # http://127.0.0.1:4500
PORT=4600 node server.mjs
node smoke.mjs http://127.0.0.1:4500
```

Locally the capture service refuses loopback addresses unless `CONNECTIONS_ALLOW_CIDRS="127.0.0.1/32"`
and `CONNECTIONS_ALLOW_HTTP=1` are set. Those two must stay **unset** in every deployed environment.
The public HTTPS deployment needs neither.

## Deployed (Cloudflare Workers, free plan)

Live: **https://erp-mock.erp-mock.workers.dev** — always on, no cold start, about 100,000 requests a day on the free plan.

```bash
npx wrangler@4 login                       # once, opens the browser
npx wrangler@4 deploy                      # prints https://erp-mock.<subdomain>.workers.dev
npx wrangler@4 secret put ADMIN_TOKEN      # gates /_calls and /_reset
node smoke.mjs https://erp-mock.<subdomain>.workers.dev <ADMIN_TOKEN>
```

Without `ADMIN_TOKEN`, anyone can read every header and body sent to `/_calls`.

**State is per instance on Workers.** OAuth tokens are self-validating (issue time, expiry and an
HMAC), so a token minted by one instance works on every other. `/_calls`, `/_reset` and the
`/fail/flaky` counters only see the instance that answered, so treat them as best-effort there.
`/fail/huge` is capped at 50 MB (capture aborts at 10 MB anyway).

## Credentials (synthetic, public on purpose)

| Scheme | Route prefix | Credential |
|---|---|---|
| none | `/auth/none/*` | — |
| API key header | `/auth/apikey-header/*` | `X-API-Key: erp-api-key-7F3A91CD` |
| API key query | `/auth/apikey-query/*` | `?api_key=erp-api-key-7F3A91CD` |
| Bearer | `/auth/bearer/*` | `erp-bearer-5E2B88A0` |
| Basic | `/auth/basic/*` | `erp_service_account` / `erp-basic-pass-9D41` |
| OAuth2 client credentials | `/auth/oauth/*` | `POST /oauth/token` with `docupath-local-client` / `erp-oauth-secret-B72C` (body or HTTP Basic) |

## Routes

Append a data route to an auth prefix, e.g. `/auth/apikey-header/customers`.

| Data route | Shape |
|---|---|
| `/customers` | page pagination `?page=&page_size=`, records at `$.data` (237 total) |
| `/customers/offset` | offset pagination `?offset=&limit=` |
| `/customers/cursor` | cursor pagination `?cursor=&page_size=`, `next_cursor` absent on the last page |
| `/customers/flat` | everything in one response |
| `/customers/nested` | records at `$.payload.result.records` |
| `/catalogue` | five tables in one response |
| `/customers/many-pages` | 5,000 records, 10 per page — exceeds the 20-page cap |
| `/prices` | a second catalogue (64 rows) |
| `POST /customers/search` | JSON body `{"country":"NL"}` filters |
| `/customers/link-header` | bare array, next page only in the `Link` header (`?page=&per_page=`) |
| `/customers/next-url` | records at `$.results`, next page as an absolute URL in `$.links.next`, `null` at the end |
| `/customers/odata` | OData v4: `$.value`, `$top`/`$skip`, `@odata.nextLink` absent at the end |
| `/customers/has-more` | Stripe style `?starting_after=<customer_code>&limit=`, `has_more`, no total |
| `/customers/top-level-array` | no envelope: the root is the array |
| `/customers/updated-since` | incremental `?updated_since=<ISO 8601>`; 400 on a bad date |
| `/customers/unicode` | 16 names that break encoding, CSV quoting and trimming |
| `/customers/mixed-types` | one field, many types: strings, numbers, null, missing, objects |
| `/invoices` | 120 invoices, numeric amounts, nulls, a `lines` array in each (`?page=&page_size=`) |

Failure routes (no auth prefix): `/fail/401` `/403` `/404` `/429` `/429-long` `/500` `/502` `/503` `/504`,
`/fail/slow?ms=`, `/fail/huge?mb=`, `/fail/not-json`, `/fail/bad-json`, `/fail/deep?depth=`,
`/fail/empty-array`, `/fail/no-array`, `/fail/echo-key`, `/fail/flaky?succeed_after=&key=`,
`/fail/html-login`, `/fail/error-in-200`, `/fail/json-as-html`, `/fail/bom`, `/fail/xml`,
`/fail/cursor-loop`, `/fail/page-ignored`, `/fail/total-lies`,
`/redirect/same?n=`, `/redirect/cross`, `/redirect/private`.
