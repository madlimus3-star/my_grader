import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { renderPages, clearPages } from './pdf.js';

const ROOT = path.resolve(import.meta.dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const PROBLEMS_DIR = path.join(DATA_DIR, 'problems');
export const SUBMISSIONS_DIR = path.join(DATA_DIR, 'submissions');

export const MAX_STATEMENT_BYTES = 20 * 1024 * 1024;
export const MAX_TEST_BYTES = 8 * 1024 * 1024;
export const MAX_TESTS_PER_PROBLEM = 60;

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

export function assertId(id) {
  if (!isValidId(id)) {
    const err = new Error('Invalid problem id');
    err.status = 400;
    throw err;
  }
  return id;
}

export async function init() {
  await fs.mkdir(PROBLEMS_DIR, { recursive: true });
  await fs.mkdir(SUBMISSIONS_DIR, { recursive: true });
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJson(file, value) {
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
  await fs.rename(tmp, file);
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

async function problemDir(id) {
  return path.join(PROBLEMS_DIR, assertId(id));
}

const TESTS_DIR = (dir) => path.join(dir, 'tests');
const TESTS_INDEX = (dir) => path.join(TESTS_DIR(dir), 'index.json');

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

async function readProblem(id) {
  const dir = await problemDir(id);
  const meta = await readJson(path.join(dir, 'problem.json'));
  if (!meta) return null;
  return { dir, meta };
}

export async function listProblems() {
  let entries = [];
  try {
    entries = await fs.readdir(PROBLEMS_DIR, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const problems = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidId(entry.name)) continue;
    const found = await readProblem(entry.name);
    if (!found) continue;
    const tests = await listTests(entry.name);
    problems.push({
      ...found.meta,
      testCount: tests.length,
      sampleCount: tests.filter((t) => t.sample).length,
    });
  }
  problems.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return problems;
}

export async function getProblem(id) {
  const found = await readProblem(id);
  if (!found) return null;
  await ensurePages(found.dir, found.meta).catch(() => {});
  const tests = await listTests(id);
  return {
    ...found.meta,
    testCount: tests.length,
    sampleCount: tests.filter((t) => t.sample).length,
  };
}

async function pagesDirOf(dir) {
  return path.join(dir, 'pages');
}

async function ensurePages(dir, meta) {
  if (!meta.statementFile || !/\.pdf$/i.test(meta.statementFile)) return;
  const pagesDir = await pagesDirOf(dir);
  const has = await fs
    .stat(pagesDir)
    .then((s) => s.isDirectory())
    .catch(() => false);
  if (has && meta.statementPages > 0) return;
  const count = await renderPages(path.join(dir, meta.statementFile), pagesDir);
  meta.statementPages = count;
  await writeJson(path.join(dir, 'problem.json'), meta);
}

export async function createProblem(input = {}) {
  const title = String(input.title || '').trim().slice(0, 160) || 'Untitled problem';
  let id = slugify(title);
  let n = 2;
  while (await readJson(path.join(PROBLEMS_DIR, id, 'problem.json'))) {
    id = `${slugify(title)}-${n++}`;
    if (n > 999) throw new Error('Could not allocate a problem id');
  }
  const dir = path.join(PROBLEMS_DIR, id);
  await fs.mkdir(TESTS_DIR(dir), { recursive: true });

  const now = new Date().toISOString();
  const meta = {
    id,
    title,
    tags: cleanTags(input.tags),
    difficulty: ['Easy', 'Medium', 'Hard'].includes(input.difficulty) ? input.difficulty : 'Easy',
    ...cleanLimits(input),
    statementFile: null,
    statementName: null,
    statementBytes: 0,
    createdAt: now,
    updatedAt: now,
  };
  await writeJson(path.join(dir, 'problem.json'), meta);
  await writeJson(TESTS_INDEX(dir), { tests: [] });

  if (input.statement && input.statement.base64) {
    await setStatement(id, input.statement);
  }
  if (Array.isArray(input.tests)) {
    for (const t of input.tests) {
      await addTest(id, t);
    }
  }
  return getProblem(id);
}

export async function updateProblem(id, patch = {}) {
  const found = await readProblem(id);
  if (!found) return null;
  const { meta, dir } = found;
  if (typeof patch.title === 'string' && patch.title.trim()) {
    meta.title = patch.title.trim().slice(0, 160);
  }
  if (Array.isArray(patch.tags)) meta.tags = cleanTags(patch.tags);
  if (['Easy', 'Medium', 'Hard'].includes(patch.difficulty)) meta.difficulty = patch.difficulty;
  if (patch.timeLimitMs !== undefined || patch.memoryLimitMb !== undefined) {
    Object.assign(meta, cleanLimits({ ...meta, ...patch }));
  }
  meta.updatedAt = new Date().toISOString();
  await writeJson(path.join(dir, 'problem.json'), meta);
  return getProblem(id);
}

export async function deleteProblem(id) {
  const dir = await problemDir(id);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(path.join(SUBMISSIONS_DIR, id), { recursive: true, force: true });
}

export async function setStatement(id, { base64, name } = {}) {
  const found = await readProblem(id);
  if (!found) return null;
  if (!base64) throw Object.assign(new Error('Missing statement data'), { status: 400 });
  const buf = Buffer.from(String(base64), 'base64');
  if (!buf.length) throw Object.assign(new Error('Empty file'), { status: 400 });
  if (buf.length > MAX_STATEMENT_BYTES) {
    throw Object.assign(new Error('Statement is larger than 20 MB'), { status: 413 });
  }
  const safeName = String(name || 'statement.pdf').replace(/[^\w.\-() ]+/g, '').slice(0, 120) || 'statement.pdf';
  const ext = (path.extname(safeName) || '.pdf').toLowerCase();
  if (!['.pdf', '.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
    throw Object.assign(new Error('Only PDF or image statements are supported'), { status: 400 });
  }
  const file = `statement${ext}`;
  const dir = found.dir;
  for (const old of ['statement.pdf', 'statement.png', 'statement.jpg', 'statement.jpeg', 'statement.webp']) {
    if (old !== file) await fs.rm(path.join(dir, old), { force: true });
  }
  await fs.writeFile(path.join(dir, file), buf);
  found.meta.statementFile = file;
  found.meta.statementName = safeName;
  found.meta.statementBytes = buf.length;
  const pagesDir = await pagesDirOf(dir);
  if (ext === '.pdf') {
    found.meta.statementPages = await renderPages(path.join(dir, file), pagesDir);
  } else {
    await clearPages(pagesDir);
    found.meta.statementPages = 0;
  }
  found.meta.updatedAt = new Date().toISOString();
  await writeJson(path.join(dir, 'problem.json'), found.meta);
  return getProblem(id);
}

export async function clearStatement(id) {
  const found = await readProblem(id);
  if (!found) return null;
  if (found.meta.statementFile) {
    await fs.rm(path.join(found.dir, found.meta.statementFile), { force: true });
  }
  await clearPages(path.join(found.dir, 'pages'));
  found.meta.statementFile = null;
  found.meta.statementName = null;
  found.meta.statementBytes = 0;
  found.meta.statementPages = 0;
  found.meta.updatedAt = new Date().toISOString();
  await writeJson(path.join(found.dir, 'problem.json'), found.meta);
  return getProblem(id);
}

export async function statementPath(id) {
  const found = await readProblem(id);
  if (!found || !found.meta.statementFile) return null;
  return {
    file: path.join(found.dir, found.meta.statementFile),
    name: found.meta.statementName || found.meta.statementFile,
  };
}

export async function statementPagePath(id, page) {
  const n = Number(page);
  if (!Number.isInteger(n) || n < 1 || n > 200) return null;
  const found = await readProblem(id);
  if (!found) return null;
  const file = path.join(found.dir, 'pages', `${n}.png`);
  try {
    await fs.access(file);
    return file;
  } catch {
    return null;
  }
}

async function readTestsIndex(dir) {
  const index = await readJson(TESTS_INDEX(dir), { tests: [] });
  if (!Array.isArray(index.tests)) index.tests = [];
  return index;
}

export async function listTests(id) {
  const dir = await problemDir(id);
  const index = await readTestsIndex(dir);
  return index.tests;
}

export async function getTest(id, tid) {
  const dir = await problemDir(id);
  const index = await readTestsIndex(dir);
  const test = index.tests.find((t) => t.id === tid);
  if (!test) return null;
  const base = path.join(TESTS_DIR(dir), tid);
  const [input, expected] = await Promise.all([
    fs.readFile(`${base}.in`, 'utf8').catch(() => ''),
    fs.readFile(`${base}.out`, 'utf8').catch(() => ''),
  ]);
  return { ...test, input, expected };
}

export async function addTest(id, input = {}) {
  const dir = await problemDir(id);
  const index = await readTestsIndex(dir);
  if (index.tests.length >= MAX_TESTS_PER_PROBLEM) {
    throw Object.assign(new Error(`A problem can hold at most ${MAX_TESTS_PER_PROBLEM} test cases`), { status: 400 });
  }
  const inText = String(input.input ?? '');
  const outText = String(input.expected ?? input.output ?? '');
  if (Buffer.byteLength(inText) > MAX_TEST_BYTES || Buffer.byteLength(outText) > MAX_TEST_BYTES) {
    throw Object.assign(new Error('A test file is larger than 8 MB'), { status: 413 });
  }
  const next = index.tests.reduce((max, t) => Math.max(max, Number(t.id) || 0), 0) + 1;
  const tid = String(next).padStart(3, '0');
  const base = path.join(TESTS_DIR(dir), tid);
  await fs.writeFile(`${base}.in`, inText);
  await fs.writeFile(`${base}.out`, outText);
  const meta = { id: tid, sample: Boolean(input.sample), createdAt: new Date().toISOString() };
  index.tests.push(meta);
  await writeJson(TESTS_INDEX(dir), index);
  await touch(id);
  return { ...meta, input: inText, expected: outText };
}

export async function updateTest(id, tid, patch = {}) {
  const dir = await problemDir(id);
  const index = await readTestsIndex(dir);
  const test = index.tests.find((t) => t.id === tid);
  if (!test) return null;
  const base = path.join(TESTS_DIR(dir), tid);
  if (typeof patch.input === 'string') await fs.writeFile(`${base}.in`, patch.input);
  if (typeof patch.expected === 'string') await fs.writeFile(`${base}.out`, patch.expected);
  if (patch.sample !== undefined) test.sample = Boolean(patch.sample);
  await writeJson(TESTS_INDEX(dir), index);
  await touch(id);
  return getTest(id, tid);
}

export async function deleteTest(id, tid) {
  const dir = await problemDir(id);
  const index = await readTestsIndex(dir);
  const before = index.tests.length;
  index.tests = index.tests.filter((t) => t.id !== tid);
  if (index.tests.length === before) return false;
  const base = path.join(TESTS_DIR(dir), tid);
  await fs.rm(`${base}.in`, { force: true });
  await fs.rm(`${base}.out`, { force: true });
  await writeJson(TESTS_INDEX(dir), index);
  await touch(id);
  return true;
}

async function touch(id) {
  const found = await readProblem(id);
  if (!found) return;
  found.meta.updatedAt = new Date().toISOString();
  await writeJson(path.join(found.dir, 'problem.json'), found.meta);
}

export async function saveSubmission(problemId, submission) {
  const dir = path.join(SUBMISSIONS_DIR, assertId(problemId));
  await fs.mkdir(dir, { recursive: true });
  await writeJson(path.join(dir, `${submission.id}.json`), submission);
  return submission;
}

export async function listSubmissions({ problemId, limit = 200 } = {}) {
  const dirs = [];
  if (problemId) {
    dirs.push([assertId(problemId), path.join(SUBMISSIONS_DIR, assertId(problemId))]);
  } else {
    const entries = await fs.readdir(SUBMISSIONS_DIR, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && isValidId(entry.name)) {
        dirs.push([entry.name, path.join(SUBMISSIONS_DIR, entry.name)]);
      }
    }
  }
  const out = [];
  for (const [pid, dir] of dirs) {
    const files = await fs.readdir(dir).catch(() => []);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const sub = await readJson(path.join(dir, file));
      if (!sub) continue;
      out.push({
        id: sub.id,
        problemId: pid,
        verdict: sub.verdict,
        mode: sub.mode,
        timeMs: sub.timeMs,
        passed: sub.passed,
        total: sub.total,
        createdAt: sub.createdAt,
      });
    }
  }
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return out.slice(0, Math.max(1, Math.min(1000, Number(limit) || 200)));
}

export async function getSubmission(problemId, submissionId) {
  const file = path.join(SUBMISSIONS_DIR, assertId(problemId), `${submissionId}.json`);
  return readJson(file);
}

export async function stats() {
  const problems = await listProblems();
  const subs = await listSubmissions({ limit: 1000 });
  const solved = new Set(subs.filter((s) => s.verdict === 'AC').map((s) => s.problemId));
  const tags = new Map();
  for (const p of problems) {
    for (const tag of p.tags) tags.set(tag, (tags.get(tag) || 0) + 1);
  }
  const testCount = problems.reduce((sum, p) => sum + (p.testCount || 0), 0);
  return {
    problems: problems.length,
    tests: testCount,
    solved: solved.size,
    submissions: subs.length,
    tags: [...tags.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
