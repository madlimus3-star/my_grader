import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';

import * as store from './lib/store.js';
import { judge, detectTools, tools } from './lib/judge.js';
import { createApiHandler, json } from './lib/api.js';

const ROOT = path.resolve(import.meta.dirname);
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.replace(/^\//, ''));
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) {
    return json(res, 403, { error: 'Forbidden' });
  }
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return json(res, 404, { error: 'Not found' });
  }
  if (stat.isDirectory()) return json(res, 404, { error: 'Not found' });
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

const engine = () => ({
  gpp: tools.gpp,
  prlimit: tools.prlimit,
  unshare: tools.unshare,
  versions: tools.versions,
  provider: 'local',
  label: tools.versions.gpp || '',
});

const handleApi = createApiHandler({ store, judge, engine });

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { error: 'Method not allowed' });
    }
    await serveStatic(req, res, url.pathname);
  } catch (err) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const status = err.status || 500;
    if (status >= 500) console.error('[error]', err);
    json(res, status, { error: err.message || 'Internal server error' });
  }
});

await store.init();
await detectTools();

server.listen(PORT, HOST, () => {
  const engineLabel = tools.versions.gpp || 'g++ not found';
  console.log(`my_grader  http://${HOST}:${PORT}`);
  console.log(`engine     ${engineLabel}`);
  console.log(`sandbox    prlimit=${tools.prlimit ? 'on' : 'off'} unshare=${tools.unshare ? 'on' : 'off'}`);
});
