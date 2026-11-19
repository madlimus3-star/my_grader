import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import * as store from './lib/store.js';
import { judge, detectTools, tools } from './lib/judge.js';

const ROOT = path.resolve(import.meta.dirname);
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const BODY_LIMIT = 32 * 1024 * 1024;

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

const json = (res, status, data) => {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
};

const fail = (res, status, message) => json(res, status, { error: message });

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body is too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.replace(/^\//, ''));
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) {
    return fail(res, 403, 'Forbidden');
  }
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return fail(res, 404, 'Not found');
  }
  if (stat.isDirectory()) return fail(res, 404, 'Not found');
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
  });
  createReadStream(file).pipe(res);
}

let submissionQueue = Promise.resolve();
function enqueue(task) {
  const run = submissionQueue.then(task, task);
  submissionQueue = run.catch(() => {});
  return run;
}

function pickTests(allTests, mode) {
  if (mode === 'sample') return allTests.filter((t) => t.sample);
  return allTests;
}

async function loadTestsWithContent(problemId) {
  const metas = await store.listTests(problemId);
  const tests = [];
  for (const meta of metas) {
    const full = await store.getTest(problemId, meta.id);
    if (full) tests.push(full);
  }
  return tests;
}

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method || 'GET';
  const parts = pathname.split('/').filter(Boolean); // ['api', ...]

  if (parts[1] === 'health') {
    return json(res, 200, { ok: true, tools: { gpp: tools.gpp, prlimit: tools.prlimit, unshare: tools.unshare, versions: tools.versions } });
  }

  if (parts[1] === 'meta' && method === 'GET') {
    return json(res, 200, {
      stats: await store.stats(),
      tools: { gpp: tools.gpp, prlimit: tools.prlimit, unshare: tools.unshare, versions: tools.versions },
    });
  }

  if (parts[1] === 'problems') {
    // /api/problems
    if (parts.length === 2) {
      if (method === 'GET') return json(res, 200, { problems: await store.listProblems() });
      if (method === 'POST') {
        const body = await readBody(req);
        const created = await store.createProblem(body);
        return json(res, 201, created);
      }
      return fail(res, 405, 'Method not allowed');
    }

    const id = parts[2];
    if (!store.isValidId(id)) return fail(res, 400, 'Invalid problem id');
    const base = `/api/problems/${id}`;

    // /api/problems/:id
    if (parts.length === 3) {
      if (method === 'GET') {
        const problem = await store.getProblem(id);
        if (!problem) return fail(res, 404, 'Problem not found');
        return json(res, 200, problem);
      }
      if (method === 'PATCH') {
        const updated = await store.updateProblem(id, await readBody(req));
        if (!updated) return fail(res, 404, 'Problem not found');
        return json(res, 200, updated);
      }
      if (method === 'DELETE') {
        await store.deleteProblem(id);
        return json(res, 200, { ok: true });
      }
      return fail(res, 405, 'Method not allowed');
    }

    // /api/problems/:id/statement
    if (parts[3] === 'statement' && parts.length === 4) {
      if (method === 'POST') {
        const body = await readBody(req);
        const updated = await store.setStatement(id, body);
        if (!updated) return fail(res, 404, 'Problem not found');
        return json(res, 200, updated);
      }
      if (method === 'DELETE') {
        const updated = await store.clearStatement(id);
        if (!updated) return fail(res, 404, 'Problem not found');
        return json(res, 200, updated);
      }
      if (method === 'GET') {
        const found = await store.statementPath(id);
        if (!found) return fail(res, 404, 'No statement uploaded');
        let stat;
        try {
          stat = await fs.stat(found.file);
        } catch {
          return fail(res, 404, 'Statement file missing');
        }
        const ext = path.extname(found.file).toLowerCase();
        res.writeHead(200, {
          'content-type': MIME[ext] || 'application/octet-stream',
          'content-length': stat.size,
          'content-disposition': `inline; filename="${encodeURIComponent(found.name)}"`,
          'cache-control': 'no-cache',
        });
        return createReadStream(found.file).pipe(res);
      }
      return fail(res, 405, 'Method not allowed');
    }

    // /api/problems/:id/tests
    if (parts[3] === 'tests') {
      if (parts.length === 4) {
        if (method === 'GET') return json(res, 200, { tests: await store.listTests(id) });
        if (method === 'POST') {
          const body = await readBody(req);
          const test = await store.addTest(id, body);
          return json(res, 201, test);
        }
        return fail(res, 405, 'Method not allowed');
      }

      if (parts[4] === 'bulk' && method === 'POST') {
        const body = await readBody(req);
        const pairs = Array.isArray(body.tests) ? body.tests : [];
        const added = [];
        for (const pair of pairs) added.push(await store.addTest(id, pair));
        return json(res, 201, { added });
      }

      const tid = parts[4];
      if (method === 'GET') {
        const test = await store.getTest(id, tid);
        if (!test) return fail(res, 404, 'Test not found');
        return json(res, 200, test);
      }
      if (method === 'PATCH') {
        const updated = await store.updateTest(id, tid, await readBody(req));
        if (!updated) return fail(res, 404, 'Test not found');
        return json(res, 200, updated);
      }
      if (method === 'DELETE') {
        const ok = await store.deleteTest(id, tid);
        if (!ok) return fail(res, 404, 'Test not found');
        return json(res, 200, { ok: true });
      }
      return fail(res, 405, 'Method not allowed');
    }

    // /api/problems/:id/submit
    if (parts[3] === 'submit' && method === 'POST') {
      const problem = await store.getProblem(id);
      if (!problem) return fail(res, 404, 'Problem not found');
      const body = await readBody(req);
      const code = String(body.code ?? '');
      if (!code.trim()) return fail(res, 400, 'Code is empty');
      if (Buffer.byteLength(code) > 512 * 1024) return fail(res, 413, 'Code is too large');
      const mode = body.mode === 'sample' ? 'sample' : 'all';
      const reveal = Boolean(body.reveal);
      const allTests = await loadTestsWithContent(id);
      const tests = pickTests(allTests, mode);
      if (tests.length === 0) return fail(res, 400, mode === 'sample' ? 'No sample tests yet' : 'No test cases yet');

      const result = await enqueue(() =>
        judge({
          code,
          tests,
          timeLimitMs: problem.timeLimitMs,
          memoryLimitMb: problem.memoryLimitMb,
          reveal,
        }),
      );

      const submission = {
        id: `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
        problemId: id,
        mode,
        code,
        verdict: result.verdict,
        compileOutput: result.compileOutput,
        tests: result.tests,
        passed: result.passed,
        total: result.total,
        timeMs: result.timeMs,
        createdAt: new Date().toISOString(),
      };
      await store.saveSubmission(id, submission);
      return json(res, 200, submission);
    }

    // /api/problems/:id/submissions
    if (parts[3] === 'submissions' && method === 'GET') {
      return json(res, 200, { submissions: await store.listSubmissions({ problemId: id }) });
    }

    return fail(res, 404, 'Not found');
  }

  if (parts[1] === 'submissions') {
    if (parts.length === 2 && method === 'GET') {
      const problemId = searchParams.get('problemId') || undefined;
      return json(res, 200, { submissions: await store.listSubmissions({ problemId }) });
    }
    if (parts.length === 3 && method === 'GET') {
      const problemId = searchParams.get('problemId');
      if (!problemId) return fail(res, 400, 'problemId is required');
      const submission = await store.getSubmission(problemId, parts[2]);
      if (!submission) return fail(res, 404, 'Submission not found');
      return json(res, 200, submission);
    }
    return fail(res, 405, 'Method not allowed');
  }

  return fail(res, 404, 'Not found');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return fail(res, 405, 'Method not allowed');
    }
    await serveStatic(req, res, url.pathname);
  } catch (err) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const status = err.status || 500;
    if (status >= 500) console.error('[error]', err);
    fail(res, status, err.message || 'Internal server error');
  }
});

await store.init();
await detectTools();

server.listen(PORT, HOST, () => {
  const engine = tools.versions.gpp || 'g++ not found';
  console.log(`my_grader  http://${HOST}:${PORT}`);
  console.log(`engine     ${engine}`);
  console.log(`sandbox    prlimit=${tools.prlimit ? 'on' : 'off'} unshare=${tools.unshare ? 'on' : 'off'}`);
});
