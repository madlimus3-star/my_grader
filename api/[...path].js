import { createApiHandler, json } from '../lib/api.js';
import { createDefaultStore } from '../lib/cloud-store.js';
import { judge, engine } from '../lib/judge0.js';

const store = createDefaultStore();
const handleApi = createApiHandler({ store, judge, engine });

/**
 * Catch-all Vercel Function: every /api/* request is handled here.
 * Storage is Vercel Blob, execution is Judge0 (see lib/judge0.js).
 */
export default async function handler(req, res) {
  try {
    const url = new URL(req.url || '/', `https://${req.headers.host || 'mygrader.local'}`);
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
