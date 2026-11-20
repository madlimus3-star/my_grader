/**
 * Judge backend for deployments where g++/prlimit are not available (Vercel).
 *
 * Submissions are compiled and executed by a Judge0 instance. The default is the
 * public Judge0 CE instance; point JUDGE0_URL at your own instance for privacy or
 * higher limits, and set JUDGE0_TOKEN if that instance requires authentication.
 */

const JUDGE0_URL = (process.env.JUDGE0_URL || 'https://ce.judge0.com').replace(/\/+$/, '');
const JUDGE0_TOKEN = process.env.JUDGE0_TOKEN || '';
const LANGUAGE_ID = Number(process.env.JUDGE0_LANGUAGE_ID) || 54; // C++ (GCC 9.2.0)
const MAX_STDOUT = 1 << 20;
const POLL_INTERVAL_MS = 900;
const POLL_TIMEOUT_MS = 120000;
const BATCH_SIZE = Math.max(1, Math.min(20, Number(process.env.JUDGE0_BATCH_SIZE) || 20));

const b64 = (value) => Buffer.from(String(value ?? ''), 'utf8').toString('base64');
const unb64 = (value) => (value == null ? '' : Buffer.from(String(value), 'base64').toString('utf8'));

const headers = (extra = {}) => ({
  'content-type': 'application/json',
  ...(JUDGE0_TOKEN ? { 'x-auth-token': JUDGE0_TOKEN } : {}),
  ...extra,
});

function normalize(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n+$/g, '');
}

async function api(path, options = {}) {
  const res = await fetch(`${JUDGE0_URL}${path}`, {
    ...options,
    headers: headers(options.headers),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message =
      (data && (data.error || data.message)) ||
      `Judge0 returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`;
    throw Object.assign(new Error(message), { status: res.status === 429 ? 503 : 502 });
  }
  return data;
}

async function createBatch(submissions) {
  const data = await api('/submissions/batch?base64_encoded=true', {
    method: 'POST',
    body: JSON.stringify({ submissions }),
  });
  if (!Array.isArray(data)) throw Object.assign(new Error('Judge0 rejected the batch'), { status: 502 });
  return data.map((entry) => (entry && entry.token) || null);
}

async function fetchBatch(tokens) {
  const query = tokens.map(encodeURIComponent).join(',');
  const data = await api(`/submissions/batch?base64_encoded=true&tokens=${query}`);
  return (data && Array.isArray(data.submissions) ? data.submissions : []) || [];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry(task, attempts = 4) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await task();
    } catch (err) {
      lastError = err;
      if (err.status !== 502 && err.status !== 503) throw err;
      await sleep(600 * (attempt + 1));
    }
  }
  throw lastError;
}

function verdictFor(entry, expected) {
  const status = entry.status && Number(entry.status.id);
  const stdout = unb64(entry.stdout);
  const stderr = unb64(entry.stderr);
  const compileOutput = unb64(entry.compile_output);

  if (status === 6) return { verdict: 'CE', compileOutput, stdout, stderr };
  if (status === 5) return { verdict: 'TLE', stdout, stderr };
  if (status === 4) return { verdict: 'WA', stdout, stderr };
  if (status >= 7 && status <= 12) return { verdict: 'RE', stdout, stderr };
  if (status === 13 || status === 14) return { verdict: 'RE', stdout, stderr };
  if (status !== 3) return { verdict: 'RE', stdout, stderr: stderr || 'Judge0 did not finish this test' };
  if (normalize(stdout) !== normalize(expected)) return { verdict: 'WA', stdout, stderr };
  return { verdict: 'AC', stdout, stderr };
}

export async function judge({
  code,
  tests,
  timeLimitMs = 1000,
  memoryLimitMb = 256,
  reveal = false,
}) {
  if (!tests.length) {
    return { verdict: 'NO_TESTS', compileOutput: '', tests: [], timeMs: 0, passed: 0, total: 0 };
  }

  const startedAt = Date.now();
  const cpuLimit = Math.max(0.5, timeLimitMs / 1000);
  const submissions = tests.map((test) => ({
    source_code: b64(code),
    language_id: LANGUAGE_ID,
    stdin: b64(test.input),
    cpu_time_limit: cpuLimit,
    cpu_extra_time: 0.5,
    wall_time_limit: Math.max(2, Math.ceil(cpuLimit) + 3),
    memory_limit: Math.max(16, Math.round(memoryLimitMb)) * 1024,
    stack_limit: 65536,
    max_processes_and_or_threads: 64,
    max_file_size: 20480,
    enable_network: false,
  }));

  const chunks = [];
  for (let index = 0; index < submissions.length; index += BATCH_SIZE) {
    chunks.push(submissions.slice(index, index + BATCH_SIZE));
  }

  const tokenChunks = [];
  for (const chunk of chunks) {
    const tokens = await withRetry(() => createBatch(chunk));
    if (tokens.some((token) => !token)) {
      throw Object.assign(new Error('Judge0 did not return submission tokens'), { status: 502 });
    }
    tokenChunks.push(tokens);
  }

  const tokenCount = tokenChunks.reduce((sum, tokens) => sum + tokens.length, 0);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let entryChunks = tokenChunks.map(() => []);
  while (Date.now() < deadline) {
    entryChunks = await Promise.all(
      tokenChunks.map((tokens) => withRetry(() => fetchBatch(tokens)).catch(() => [])),
    );
    const finished = entryChunks.every((entries, chunkIndex) => {
      const tokens = tokenChunks[chunkIndex];
      if (entries.length < tokens.length) return false;
      return entries.every(
        (entry) => entry && entry.status && entry.status.id !== 1 && entry.status.id !== 2,
      );
    });
    if (finished) break;
    await sleep(POLL_INTERVAL_MS);
  }
  const entries = entryChunks.flat();
  if (entries.length < tokenCount) entries.length = tokenCount;

  const results = [];
  let passed = 0;
  let firstCompileError = '';
  let compileError = false;

  tests.forEach((test, index) => {
    const entry = entries[index];
    const outcome = entry
      ? verdictFor(entry, test.expected)
      : { verdict: 'TLE', stdout: '', stderr: 'Judge0 did not finish this test in time' };
    if (outcome.verdict === 'AC') passed += 1;
    if (outcome.verdict === 'CE' && !compileError) {
      compileError = true;
      firstCompileError = outcome.compileOutput || 'Compilation failed';
    }
    results.push({
      id: test.id,
      sample: Boolean(test.sample),
      verdict: outcome.verdict,
      timeMs: entry && entry.time ? Math.round(Number(entry.time) * 1000) : 0,
      ...(reveal || test.sample
        ? {
            input: test.input,
            expected: test.expected,
            stdout: String(outcome.stdout || '').slice(0, MAX_STDOUT),
            stderr: String(outcome.stderr || '').slice(0, 65536),
            truncated: String(outcome.stdout || '').length > MAX_STDOUT,
          }
        : {}),
    });
  });

  if (compileError) {
    return {
      verdict: 'CE',
      compileOutput: firstCompileError.slice(0, 65536),
      tests: [],
      timeMs: Date.now() - startedAt,
      passed: 0,
      total: tests.length,
      engine: 'judge0',
    };
  }

  let verdict = 'AC';
  const failing = results.find((result) => result.verdict !== 'AC');
  if (failing) verdict = failing.verdict;

  return {
    verdict,
    compileOutput: '',
    tests: results,
    timeMs: Date.now() - startedAt,
    passed,
    total: results.length,
    engine: 'judge0',
  };
}

export function engine() {
  return {
    gpp: true,
    prlimit: false,
    unshare: false,
    versions: { gpp: 'Judge0 CE · C++17 (GCC 9.2)' },
    provider: 'judge0',
    label: 'Judge0 CE',
  };
}

export const judgeConfig = { url: JUDGE0_URL, languageId: LANGUAGE_ID };
