/**
 * Offline test for the cloud store, using an in-memory driver in place of Vercel Blob.
 *   node scripts/test-cloud-store.mjs
 */
import assert from 'node:assert/strict';
import { createCloudStore, seedFromDisk } from '../lib/cloud-store.js';

let database = null;
const driver = {
  kind: 'test-blob',
  async read() {
    return database;
  },
  async write(text) {
    database = text;
  },
};

const store = createCloudStore({ driver, seed: seedFromDisk });
await store.init();

const problems = await store.listProblems();
assert.equal(problems.length, 2, 'seeded problems');
assert.ok(problems.every((problem) => problem.statementPages === 0), 'no page renders in cloud mode');

const created = await store.createProblem({ title: 'Cloud Test', tags: ['Array', 'array', ' Easy '], difficulty: 'Hard' });
assert.equal(created.id, 'cloud-test');
assert.deepEqual(created.tags, ['Array', 'Easy']);
assert.equal(created.difficulty, 'Hard');

const pdf = Buffer.from('%PDF-1.4\n% test\n');
await store.setStatement('cloud-test', { base64: pdf.toString('base64'), name: 'x.pdf' });
const statement = await store.readStatement('cloud-test');
assert.equal(statement.name, 'x.pdf');
assert.equal(statement.buffer.length, pdf.length);

await store.addTest('cloud-test', { input: '1 2\n', expected: '2\n', sample: true });
await store.addTest('cloud-test', { input: '3 4\n', expected: '4\n' });
assert.equal((await store.listTests('cloud-test')).length, 2);
await store.updateTest('cloud-test', '002', { expected: '5\n' });
assert.equal((await store.getTest('cloud-test', '002')).expected, '5\n');

await store.updateProblem('cloud-test', { title: 'Cloud Test 2', tags: ['Math'] });
assert.equal((await store.getProblem('cloud-test')).title, 'Cloud Test 2');
assert.deepEqual((await store.getProblem('cloud-test')).tags, ['Math']);

await store.saveSubmission('cloud-test', {
  id: 's1',
  problemId: 'cloud-test',
  verdict: 'AC',
  mode: 'sample',
  timeMs: 12,
  passed: 1,
  total: 1,
  createdAt: new Date().toISOString(),
});
const list = await store.listSubmissions({ problemId: 'cloud-test' });
assert.equal(list.length, 1);
assert.equal((await store.getSubmission('cloud-test', 's1')).verdict, 'AC');
assert.equal((await store.getSubmission('cloud-test', 'nope')), null);

// Reload from the persisted database: data must survive a cold start.
const reloaded = createCloudStore({ driver, seed: seedFromDisk });
await reloaded.init();
const after = await reloaded.getProblem('cloud-test');
assert.equal(after.title, 'Cloud Test 2');
assert.equal(after.testCount, 2);
assert.equal(after.statementFile, 'statement.pdf');
assert.equal((await reloaded.getSubmission('cloud-test', 's1')).verdict, 'AC');

const stats = await reloaded.stats();
assert.equal(stats.problems, 3);
assert.equal(stats.submissions, 1);

// Seeding merge: a problem present on disk but not in the blob is imported.
const merged = JSON.parse(database);
delete merged.problems['reverse-sequence'];
database = JSON.stringify(merged);
const cold = createCloudStore({ driver, seed: seedFromDisk });
await cold.init();
assert.ok(await cold.getProblem('reverse-sequence'), 'disk problems merge into an existing blob db');

await store.deleteTest('cloud-test', '001');
assert.equal((await store.listTests('cloud-test')).length, 1);
await store.deleteProblem('cloud-test');
assert.equal(await store.getProblem('cloud-test'), null);
assert.equal((await store.listSubmissions({ problemId: 'cloud-test' })).length, 0);

console.log('cloud store: all assertions passed');
