/**
 * Problem/submission storage for serverless deployments.
 *
 * The whole database lives in one JSON blob (Vercel Blob). When no Blob store is
 * connected the deployment is read-only: problems are seeded from the data/
 * directory that ships with the repo and submissions are graded but not saved.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { SEED } from './seed-data.js';

// Vercel Functions accept at most ~4.5 MB per request, and uploads are base64
// encoded (+33%), so the cloud limit is lower than the local 20 MB.
export const MAX_STATEMENT_BYTES = 3 * 1024 * 1024;
export const MAX_TEST_BYTES = 8 * 1024 * 1024;
export const MAX_TESTS_PER_PROBLEM = 60;
const MAX_SUBMISSIONS = 200;
const DB_PATH = 'mygrader/db.json';
// Match the access mode of the connected Blob store (private by default).
const BLOB_ACCESS = process.env.BLOB_ACCESS === 'public' ? 'public' : 'private';
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function assertId(id) {
  if (!isValidId(id)) throw Object.assign(new Error('Invalid problem id'), { status: 400 });
  return id;
}

function slugify(title) {
  const base = String(title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || 'problem';
}

function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const out = [];
  for (const tag of tags) {
    const t = String(tag || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.slice(0, 12);
}

function cleanLimits(input = {}) {
  const time = Number(input.timeLimitMs);
  const mem = Number(input.memoryLimitMb);
  return {
    timeLimitMs: Number.isFinite(time) ? Math.min(20000, Math.max(200, Math.round(time))) : 1000,
    memoryLimitMb: Number.isFinite(mem) ? Math.min(4096, Math.max(16, Math.round(mem))) : 256,
  };
}

const emptyDb = () => ({ version: 1, problems: {}, submissions: [] });

function hasBlobCredentials() {
  return Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);
}

async function blobRead() {
  const { get } = await import('@vercel/blob');
  let result;
  try {
    result = await get(DB_PATH, { access: BLOB_ACCESS, useCache: false });
  } catch (err) {
    if (/not.?found/i.test(String(err && (err.name || err.message)))) return null;
    throw err;
  }
  if (!result || result.statusCode === 404 || !result.stream) return null;
  const buffer = Buffer.from(await new Response(result.stream).arrayBuffer());
  return buffer.toString('utf8');
}

async function blobWrite(text) {
  const { put } = await import('@vercel/blob');
  await put(DB_PATH, text, {
    access: BLOB_ACCESS,
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
  });
}

const memoryDriver = {
  kind: 'memory',
  async read() {
    return null;
  },
  async write() {
    throw Object.assign(
      new Error('Read-only deployment: connect a Vercel Blob store to edit problems and keep submissions'),
      { status: 503 },
    );
  },
};

const blobDriver = {
  kind: 'vercel-blob',
  read: blobRead,
  write: blobWrite,
};

async function readJsonFile(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Load the data/ directory that is committed to the repository. */
export async function seedFromDisk(dir = path.join(process.cwd(), 'data', 'problems')) {
  const db = emptyDb();
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return db;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidId(entry.name)) continue;
    const id = entry.name;
    const problemDir = path.join(dir, id);
    const meta = await readJsonFile(path.join(problemDir, 'problem.json'));
    if (!meta) continue;

    const testsIndex = (await readJsonFile(path.join(problemDir, 'tests', 'index.json'))) || { tests: [] };
    const tests = [];
    for (const test of Array.isArray(testsIndex.tests) ? testsIndex.tests : []) {
      let input = '';
      let expected = '';
      try {
        input = await fs.readFile(path.join(problemDir, 'tests', `${test.id}.in`), 'utf8');
      } catch {
        /* optional */
      }
      try {
        expected = await fs.readFile(path.join(problemDir, 'tests', `${test.id}.out`), 'utf8');
      } catch {
        /* optional */
      }
      tests.push({ ...test, input, expected });
    }

    let statement = null;
    if (meta.statementFile) {
      try {
        const buffer = await fs.readFile(path.join(problemDir, meta.statementFile));
        statement = {
          name: meta.statementName || meta.statementFile,
          bytes: buffer.length,
          base64: buffer.toString('base64'),
        };
      } catch {
        statement = null;
      }
    }

    db.problems[id] = {
      // Pages are rendered on demand locally; serverless deployments use the
      // browser PDF viewer instead, so statementPages is always 0 here.
      meta: { ...meta, statementPages: 0, updatedAt: meta.updatedAt || new Date().toISOString() },
      statement,
      tests: tests.map((test) => ({
        id: test.id,
        sample: Boolean(test.sample),
        createdAt: test.createdAt || new Date().toISOString(),
        input: String(test.input ?? ''),
        expected: String(test.expected ?? ''),
      })),
    };
  }
  return db;
}

export function createCloudStore({ driver = blobDriver, seed = seedFromDisk } = {}) {
  let db = null;
  let loading = null;
  const writable = Boolean(driver) && driver.kind !== 'memory';
  const storageKind = writable ? driver.kind : 'memory';

  const assertWritable = () => {
    if (!writable) {
      throw Object.assign(
        new Error('Read-only deployment: connect a Vercel Blob store to edit problems and keep submissions'),
        { status: 503 },
      );
    }
  };

  async function load() {
    if (db) return db;
    if (!loading) {
      loading = (async () => {
        let stored = null;
        if (writable) {
          try {
            stored = await driver.read();
          } catch (err) {
            console.error('[blob] read failed:', err.message);
          }
        }
        if (stored) {
          try {
            const parsed = JSON.parse(stored);
            if (parsed && typeof parsed === 'object' && parsed.problems) {
              parsed.submissions = Array.isArray(parsed.submissions) ? parsed.submissions : [];
              // Pick up problems that were added (or updated) in the repo since the
              // database was created, without touching newer edits made online.
              const disk = await seed();
              const catalog = disk && Object.keys(disk.problems).length ? disk : SEED;
              let changed = false;
              for (const [id, record] of Object.entries(catalog.problems)) {
                const current = parsed.problems[id];
                if (!current) {
                  parsed.problems[id] = record;
                  changed = true;
                } else if (String(record.meta.updatedAt) > String(current.meta.updatedAt)) {
                  parsed.problems[id] = record;
                  changed = true;
                }
              }
              if (changed && writable) {
                try {
                  await driver.write(JSON.stringify(parsed));
                } catch (err) {
                  console.error('[blob] merge write failed:', err.message);
                }
              }
              return parsed;
            }
          } catch {
            console.error('[blob] database is not valid JSON, reseeding');
          }
        }
        const seeded = await seed();
        const base = Object.keys(seeded.problems).length ? seeded : JSON.parse(JSON.stringify(SEED));
        if (writable) {
          try {
            await driver.write(JSON.stringify(base));
          } catch (err) {
            console.error('[blob] seed write failed:', err.message);
          }
        }
        return base;
      })();
    }
    db = await loading;
    return db;
  }

  async function persist() {
    assertWritable();
    await driver.write(JSON.stringify(db));
  }

  const problems = () => Object.values(db.problems);

  function counts(record) {
    return { testCount: record.tests.length, sampleCount: record.tests.filter((t) => t.sample).length };
  }

  const publicProblem = (record) => ({ ...record.meta, ...counts(record) });

  return {
    storageKind,
    writable,
    isValidId,

    async init() {
      await load();
    },

    async listProblems() {
      await load();
      return problems()
        .map(publicProblem)
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    },

    async getProblem(id) {
      if (!isValidId(id)) return null;
      await load();
      const record = db.problems[id];
      return record ? publicProblem(record) : null;
    },

    async createProblem(input = {}) {
      await load();
      assertWritable();
      const title = String(input.title || '').trim().slice(0, 160) || 'Untitled problem';
      let id = slugify(title);
      let n = 2;
      while (db.problems[id]) {
        id = `${slugify(title)}-${n++}`;
        if (n > 999) throw new Error('Could not allocate a problem id');
      }
      const now = new Date().toISOString();
      db.problems[id] = {
        meta: {
          id,
          title,
          tags: cleanTags(input.tags),
          difficulty: ['Easy', 'Medium', 'Hard'].includes(input.difficulty) ? input.difficulty : 'Easy',
          ...cleanLimits(input),
          statementFile: null,
          statementName: null,
          statementBytes: 0,
          statementPages: 0,
          createdAt: now,
          updatedAt: now,
        },
        statement: null,
        tests: [],
      };
      await persist();

      if (input.statement && input.statement.base64) await this.setStatement(id, input.statement);
      if (Array.isArray(input.tests)) {
        for (const test of input.tests) await this.addTest(id, test);
      }
      return this.getProblem(id);
    },

    async updateProblem(id, patch = {}) {
      if (!isValidId(id)) return null;
      await load();
      const record = db.problems[id];
      if (!record) return null;
      assertWritable();
      const { meta } = record;
      if (typeof patch.title === 'string' && patch.title.trim()) meta.title = patch.title.trim().slice(0, 160);
      if (Array.isArray(patch.tags)) meta.tags = cleanTags(patch.tags);
      if (['Easy', 'Medium', 'Hard'].includes(patch.difficulty)) meta.difficulty = patch.difficulty;
      if (patch.timeLimitMs !== undefined || patch.memoryLimitMb !== undefined) {
        Object.assign(meta, cleanLimits({ ...meta, ...patch }));
      }
      meta.updatedAt = new Date().toISOString();
      await persist();
      return this.getProblem(id);
    },

    async deleteProblem(id) {
      if (!isValidId(id)) return;
      await load();
      if (!db.problems[id]) return;
      assertWritable();
      delete db.problems[id];
      db.submissions = db.submissions.filter((submission) => submission.problemId !== id);
      await persist();
    },

    async setStatement(id, { base64, name } = {}) {
      if (!isValidId(id)) return null;
      await load();
      const record = db.problems[id];
      if (!record) return null;
      assertWritable();
      if (!base64) throw Object.assign(new Error('Missing statement data'), { status: 400 });
      const buffer = Buffer.from(String(base64), 'base64');
      if (!buffer.length) throw Object.assign(new Error('Empty file'), { status: 400 });
      if (buffer.length > MAX_STATEMENT_BYTES) {
        throw Object.assign(new Error('Statement is larger than 20 MB'), { status: 413 });
      }
      const safeName =
        String(name || 'statement.pdf').replace(/[^\w.\-() ]+/g, '').slice(0, 120) || 'statement.pdf';
      const ext = (path.extname(safeName) || '.pdf').toLowerCase();
      if (!['.pdf', '.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
        throw Object.assign(new Error('Only PDF or image statements are supported'), { status: 400 });
      }
      record.statement = { name: safeName, bytes: buffer.length, base64: buffer.toString('base64') };
      record.meta.statementFile = `statement${ext}`;
      record.meta.statementName = safeName;
      record.meta.statementBytes = buffer.length;
      record.meta.statementPages = 0;
      record.meta.updatedAt = new Date().toISOString();
      await persist();
      return this.getProblem(id);
    },

    async clearStatement(id) {
      if (!isValidId(id)) return null;
      await load();
      const record = db.problems[id];
      if (!record) return null;
      assertWritable();
      record.statement = null;
      record.meta.statementFile = null;
      record.meta.statementName = null;
      record.meta.statementBytes = 0;
      record.meta.statementPages = 0;
      record.meta.updatedAt = new Date().toISOString();
      await persist();
      return this.getProblem(id);
    },

    async readStatement(id) {
      if (!isValidId(id)) return null;
      await load();
      const statement = db.problems[id] && db.problems[id].statement;
      if (!statement) return null;
      return { buffer: Buffer.from(statement.base64, 'base64'), name: statement.name };
    },

    async readStatementPage() {
      return null;
    },

    async listTests(id) {
      if (!isValidId(id)) return [];
      await load();
      const record = db.problems[id];
      if (!record) return [];
      return record.tests.map(({ id: tid, sample, createdAt }) => ({ id: tid, sample, createdAt }));
    },

    async getTest(id, tid) {
      if (!isValidId(id)) return null;
      await load();
      const record = db.problems[id];
      if (!record) return null;
      return record.tests.find((test) => test.id === tid) || null;
    },

    async addTest(id, input = {}) {
      if (!isValidId(id)) throw Object.assign(new Error('Invalid problem id'), { status: 400 });
      await load();
      const record = db.problems[id];
      if (!record) throw Object.assign(new Error('Problem not found'), { status: 404 });
      assertWritable();
      if (record.tests.length >= MAX_TESTS_PER_PROBLEM) {
        throw Object.assign(new Error(`A problem can hold at most ${MAX_TESTS_PER_PROBLEM} test cases`), {
          status: 400,
        });
      }
      const inText = String(input.input ?? '');
      const outText = String(input.expected ?? input.output ?? '');
      if (Buffer.byteLength(inText) > MAX_TEST_BYTES || Buffer.byteLength(outText) > MAX_TEST_BYTES) {
        throw Object.assign(new Error('A test file is larger than 8 MB'), { status: 413 });
      }
      const next = record.tests.reduce((max, test) => Math.max(max, Number(test.id) || 0), 0) + 1;
      const meta = {
        id: String(next).padStart(3, '0'),
        sample: Boolean(input.sample),
        createdAt: new Date().toISOString(),
        input: inText,
        expected: outText,
      };
      record.tests.push(meta);
      record.meta.updatedAt = new Date().toISOString();
      await persist();
      return { ...meta };
    },

    async updateTest(id, tid, patch = {}) {
      if (!isValidId(id)) return null;
      await load();
      const record = db.problems[id];
      if (!record) return null;
      const test = record.tests.find((entry) => entry.id === tid);
      if (!test) return null;
      assertWritable();
      if (typeof patch.input === 'string') test.input = patch.input;
      if (typeof patch.expected === 'string') test.expected = patch.expected;
      if (patch.sample !== undefined) test.sample = Boolean(patch.sample);
      record.meta.updatedAt = new Date().toISOString();
      await persist();
      return { ...test };
    },

    async deleteTest(id, tid) {
      if (!isValidId(id)) return false;
      await load();
      const record = db.problems[id];
      if (!record) return false;
      const before = record.tests.length;
      record.tests = record.tests.filter((test) => test.id !== tid);
      if (record.tests.length === before) return false;
      assertWritable();
      record.meta.updatedAt = new Date().toISOString();
      await persist();
      return true;
    },

    async saveSubmission(problemId, submission) {
      if (!isValidId(problemId)) throw Object.assign(new Error('Invalid problem id'), { status: 400 });
      await load();
      assertWritable();
      db.submissions.push(submission);
      if (db.submissions.length > MAX_SUBMISSIONS) {
        db.submissions = db.submissions.slice(-MAX_SUBMISSIONS);
      }
      await persist();
      return submission;
    },

    async listSubmissions({ problemId, limit = 200 } = {}) {
      await load();
      const list = problemId ? db.submissions.filter((submission) => submission.problemId === problemId) : db.submissions;
      return list
        .map((submission) => ({
          id: submission.id,
          problemId: submission.problemId,
          verdict: submission.verdict,
          mode: submission.mode,
          timeMs: submission.timeMs,
          passed: submission.passed,
          total: submission.total,
          createdAt: submission.createdAt,
        }))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, Math.max(1, Math.min(1000, Number(limit) || 200)));
    },

    async getSubmission(problemId, submissionId) {
      if (!isValidId(problemId)) return null;
      await load();
      return (
        db.submissions.find(
          (submission) => submission.problemId === problemId && submission.id === submissionId,
        ) || null
      );
    },

    async stats() {
      await load();
      const all = problems();
      const submissions = await this.listSubmissions({ limit: 1000 });
      const solved = new Set(submissions.filter((submission) => submission.verdict === 'AC').map((s) => s.problemId));
      const tags = new Map();
      for (const record of all) {
        for (const tag of record.meta.tags || []) tags.set(tag, (tags.get(tag) || 0) + 1);
      }
      return {
        problems: all.length,
        tests: all.reduce((sum, record) => sum + record.tests.length, 0),
        solved: solved.size,
        submissions: submissions.length,
        tags: [...tags.entries()]
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    },
  };
}

export const createDefaultStore = () =>
  createCloudStore({ driver: hasBlobCredentials() ? blobDriver : memoryDriver });
