import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_PAGES = 40;
const RENDER_DPI = 120;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(stderr || err.message), { code: err.code }));
      else resolve(stdout);
    });
  });
}

export async function hasPdfTools() {
  try {
    await run('pdftoppm', ['-v']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Render the first pages of a PDF next to it, as 1.png, 2.png, ...
 * Returns the page count (0 when rendering is unavailable).
 */
export async function renderPages(pdfPath, pagesDir) {
  await fs.rm(pagesDir, { recursive: true, force: true });
  await fs.mkdir(pagesDir, { recursive: true });
  const prefix = path.join(pagesDir, 'page');
  try {
    await run('pdftoppm', [
      '-png',
      '-r', String(RENDER_DPI),
      '-f', '1',
      '-l', String(MAX_PAGES),
      pdfPath,
      prefix,
    ]);
  } catch {
    await fs.rm(pagesDir, { recursive: true, force: true });
    return 0;
  }

  const produced = (await fs.readdir(pagesDir).catch(() => []))
    .filter((f) => f.endsWith('.png'))
    .map((f) => ({ file: f, n: Number((f.match(/(\d+)\.png$/) || [])[1]) || 0 }))
    .sort((a, b) => a.n - b.n);

  for (const [index, entry] of produced.entries()) {
    await fs.rename(path.join(pagesDir, entry.file), path.join(pagesDir, `${index + 1}.png`));
  }
  return produced.length;
}

export async function clearPages(pagesDir) {
  await fs.rm(pagesDir, { recursive: true, force: true });
}
