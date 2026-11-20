import { createApiHandler, json } from './api.js';
import { createDefaultStore } from './cloud-store.js';
import { judge, engine } from './judge0.js';

const store = createDefaultStore();
const handleApi = createApiHandler({ store, judge, engine });

/**
 * Runs the shared JSON API for one Vercel Function route.
 *
 * Vercel Functions only match one dynamic path segment per file, so each file
 * under api/ passes its own canonical pathname here. Query parameters from the
 * incoming request are preserved.
 */
export async function route(req, res, pathname) {
  try {
    const url = new URL(req.url || '/', `https://${req.headers.host || 'mygrader.local'}`);
    url.pathname = pathname;
    await store.init();
    await handleApi(req, res, url);
  } catch (err) {
    if (res.headersSent) {
      res.end();
      return;
    }
    const status = err.status || 500;
    if (status >= 500) console.error('[api]', err);
    json(res, status, { error: err.message || 'Internal server error' });
  }
}
