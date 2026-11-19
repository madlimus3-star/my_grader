import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_STDOUT = 1 << 20; // 1 MB
const MAX_STDERR = 1 << 16; // 64 KB
const COMPILE_TIMEOUT_MS = 20000;

export const tools = {
  gpp: false,
  prlimit: false,
  unshare: false,
  versions: {},
};

function run(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err.message || err) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export async function detectTools() {
  const which = async (bin) => {
    const res = await run('sh', ['-c', `command -v ${bin}`]);
    return res.code === 0 && res.stdout.trim() ? res.stdout.trim() : null;
  };
  const gpp = await which('g++');
  tools.gpp = Boolean(gpp);
  tools.gppPath = gpp || 'g++';
  tools.prlimit = Boolean(await which('prlimit'));
  const unsharePath = await which('unshare');
  if (unsharePath) {
    const probe = await run(unsharePath, ['-rn', 'true']);
    tools.unshare = probe.code === 0;
  }
  if (tools.gpp) {
    const v = await run(tools.gppPath, ['--version']);
    tools.versions.gpp = v.stdout.split('\n')[0].trim();
  }
  return tools;
}

function normalize(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n+$/g, '');
}

function limitArgs({ timeLimitMs, memoryLimitMb }) {
  const memBytes = Math.round(Math.max(32, memoryLimitMb) * 1024 * 1024);
  const cpuSeconds = Math.max(1, Math.ceil(timeLimitMs / 1000) + 1);
  return [
    `--as=${memBytes}`,
    `--cpu=${cpuSeconds}`,
    '--nproc=64',
    '--nofile=256',
    '--fsize=33554432',
    '--core=0',
    '--stack=67108864',
  ];
}

function runProgram({ program, workDir, input, timeLimitMs, memoryLimitMb }) {
  return new Promise((resolve) => {
    const args = [
      ...(tools.unshare ? ['unshare', '-rn', '--'] : []),
      'prlimit',
      ...limitArgs({ timeLimitMs, memoryLimitMb }),
      '--',
      program,
    ];
    const cmd = args.shift();
    const wallLimit = Math.max(500, timeLimitMs + 1200);
    const started = process.hrtime.bigint();
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;

    const child = spawn(cmd, args, {
      cwd: workDir,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const finish = (verdictExtra) => {
      const timeMs = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({
        timeMs: Math.round(timeMs),
        stdout,
        stderr,
        truncated,
        timedOut,
        signal: child.killed ? 'SIGKILL' : null,
        exitCode: child.exitCode,
        ...verdictExtra,
      });
    };

    const kill = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, wallLimit);

    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_STDOUT) stdout += chunk.toString('utf8');
      if (stdout.length > MAX_STDOUT) {
        stdout = stdout.slice(0, MAX_STDOUT);
        truncated = true;
        kill();
      }
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      stderr += String(err.message || err);
      finish({ spawnError: true });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      finish({ spawnError: false, exitCode: code, signal });
    });

    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

function testVerdict(result, expected) {
  if (result.truncated) return 'OLE';
  if (result.timedOut) return 'TLE';
  if (result.spawnError) return 'RE';
  if (result.exitCode !== 0) return result.signal === 'SIGKILL' ? 'TLE' : 'RE';
  if (normalize(result.stdout) !== normalize(expected)) return 'WA';
  return 'AC';
}

export async function judge({
  code,
  tests,
  timeLimitMs = 1000,
  memoryLimitMb = 256,
  reveal = false,
}) {
  if (!tools.gpp) {
    throw Object.assign(new Error('g++ was not found on this machine'), { status: 500 });
  }
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'my-grader-'));
  const startedAt = Date.now();
  try {
    const source = path.join(workDir, 'main.cpp');
    const program = path.join(workDir, 'main');
    await fs.writeFile(source, String(code ?? ''));

    const compile = await run(
      tools.gppPath,
      ['-std=c++17', '-O2', '-pipe', '-o', program, source],
      { cwd: workDir, maxBuffer: 1 << 20 },
    );

    if (compile.code !== 0) {
      return {
        verdict: 'CE',
        compileOutput: (compile.stderr || compile.stdout || 'Compilation failed').slice(0, MAX_STDERR),
        tests: [],
        timeMs: Date.now() - startedAt,
        passed: 0,
        total: tests.length,
      };
    }

    const results = [];
    let passed = 0;
    let stopped = false;
    for (const test of tests) {
      if (stopped) {
        // A program that overruns the limit once will overrun it again; skip the rest.
        results.push({ id: test.id, sample: Boolean(test.sample), verdict: 'TLE', timeMs: 0, skipped: true });
        continue;
      }
      const result = await runProgram({
        program,
        workDir,
        input: test.input,
        timeLimitMs,
        memoryLimitMb,
      });
      const verdict = testVerdict(result, test.expected);
      if (verdict === 'AC') passed += 1;
      if (verdict === 'TLE') stopped = true;
      results.push({
        id: test.id,
        sample: Boolean(test.sample),
        verdict,
        timeMs: result.timeMs,
        ...(reveal || test.sample
          ? {
              input: test.input,
              expected: test.expected,
              stdout: result.stdout,
              stderr: result.stderr,
              truncated: result.truncated,
            }
          : {}),
      });
    }

    let verdict = 'AC';
    if (results.length === 0) verdict = 'NO_TESTS';
    else {
      const failing = results.find((r) => r.verdict !== 'AC');
      if (failing) verdict = failing.verdict;
    }

    return {
      verdict,
      compileOutput: compile.stderr.slice(0, MAX_STDERR),
      tests: results,
      timeMs: Date.now() - startedAt,
      passed,
      total: results.length,
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
