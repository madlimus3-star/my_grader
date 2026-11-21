import { createApiHandler, json } from './api.js';
import { createDefaultStore } from './cloud-store.js';
import { judge, engine } from './judge0.js';

/**
 * Runs the shared JSON API for one Vercel Function route.
 *
 * Vercel Functions only match one dynamic path segment per file, so each file
 * under api/ passes its own canonical pathname here. Query parameters from the
 * incoming request are preserved.
 *
 * The store is created per request: Blob is the source of truth, and a cached
 * copy inside a warm lambda would otherwise hide submissions saved by another
 * instance (or overwrite them with stale data).
 */
export async function route(req, res, pathname) {
  try {
    const url = new URL(req.url || '/', `https://${req.headers.host || 'mygrader.local'}`);
    url.pathname = pathname;
    const store = createDefaultStore();
    const handleApi = createApiHandler({ store, judge, engine });
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
