import crypto from 'node:crypto';

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

export const mimeFor = (name) => MIME[String(name || '').toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || ''] || 'application/octet-stream';

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

const bodyFromPreParsed = (req) => {
  const body = req.body;
  if (body === undefined || body === null) return undefined;
  if (Buffer.isBuffer(body)) {
    const raw = body.toString('utf8');
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
    }
  }
  if (typeof body === 'string') {
    if (!body) return {};
    try {
      return JSON.parse(body);
    } catch {
      throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
    }
  }
  if (typeof body === 'object') return body;
  return {};
};

export function readBody(req, limit = BODY_LIMIT) {
  // Vercel's Node runtime may hand us an already-parsed body.
  const preParsed = bodyFromPreParsed(req);
  if (preParsed !== undefined) return Promise.resolve(preParsed);

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

function pickTests(allTests, mode) {
  if (mode === 'sample') return allTests.filter((t) => t.sample);
  return allTests;
}

/**
 * Shared JSON API used by both the local Node server and the Vercel function.
 *
 * store:  problems/tests/submissions/statement backend (filesystem or Vercel Blob)
 * judge:  ({ code, tests, timeLimitMs, memoryLimitMb, reveal }) => result
 * engine: () => { gpp, prlimit, unshare, versions, provider, label }
 */
export function createApiHandler({ store, judge, engine }) {
  const engineInfo = () => {
    const info = engine ? engine() : {};
    return {
      gpp: Boolean(info.gpp),
      prlimit: Boolean(info.prlimit),
      unshare: Boolean(info.unshare),
      versions: info.versions || {},
      provider: info.provider || 'local',
      label: info.label || '',
    };
  };

  let submissionQueue = Promise.resolve();
  const enqueue = (task) => {
    const run = submissionQueue.then(task, task);
    submissionQueue = run.catch(() => {});
    return run;
  };

  const loadTestsWithContent = async (problemId) => {
    const metas = await store.listTests(problemId);
    const tests = [];
    for (const meta of metas) {
      const full = await store.getTest(problemId, meta.id);
      if (full) tests.push(full);
    }
    return tests;
  };

  return async function handleApi(req, res, url) {
    const { pathname, searchParams } = url;
    const method = req.method || 'GET';
    const parts = pathname.split('/').filter(Boolean); // ['api', ...]

    if (parts[1] === 'health') {
      return json(res, 200, { ok: true, tools: engineInfo() });
    }

    const capabilities = () => ({
      writable: store.writable !== false,
      storage: store.storageKind || 'filesystem',
      engine: engineInfo().provider,
    });

    if (parts[1] === 'meta' && method === 'GET') {
      return json(res, 200, {
        stats: await store.stats(),
        tools: engineInfo(),
        capabilities: capabilities(),
      });
    }

    // One round trip for the first paint: a page load otherwise reads the
    // remote database three times.
    if (parts[1] === 'bootstrap' && method === 'GET') {
      const [stats, problems, submissions] = await Promise.all([
        store.stats(),
        store.listProblems(),
        store.listSubmissions({ limit: 200 }),
      ]);
      return json(res, 200, {
        stats,
        problems,
        submissions,
        tools: engineInfo(),
        capabilities: capabilities(),
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
          const found = await store.readStatement(id);
          if (!found) return fail(res, 404, 'No statement uploaded');
          res.writeHead(200, {
            'content-type': mimeFor(found.name),
            'content-length': found.buffer.length,
            'content-disposition': `inline; filename="${encodeURIComponent(found.name)}"`,
            'cache-control': 'no-cache',
          });
          return res.end(found.buffer);
        }
        return fail(res, 405, 'Method not allowed');
      }

      // /api/problems/:id/pages/:n
      if (parts[3] === 'pages' && parts.length === 5 && method === 'GET') {
        const page = await store.readStatementPage(id, parts[4]);
        if (!page) return fail(res, 404, 'Page not found');
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': page.buffer.length,
          'cache-control': 'public, max-age=3600',
        });
        return res.end(page.buffer);
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
          ...(result.engine ? { engine: result.engine } : {}),
        };
        if (store.writable !== false) await store.saveSubmission(id, submission);
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
  };
}

export { json, fail };
