/**
 * Cloudflare Workers entry point. All routes are in app.mjs.
 *
 * ADMIN_TOKEN is a Worker secret (`npx wrangler secret put ADMIN_TOKEN`); unset, /_calls and
 * /_reset are open to anyone. The app is built on the first request, not at module scope,
 * because Workers refuse crypto work outside a request handler.
 */
import { createApp } from './app.mjs';

let app;

export default {
  async fetch(request, env) {
    app ??= createApp({ adminToken: env.ADMIN_TOKEN ?? '' });

    return app.handle(request);
  },
};
