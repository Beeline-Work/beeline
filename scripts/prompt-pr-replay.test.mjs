import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replay, markdown } from './prompt-pr-replay.mjs';
const head = 'a'.repeat(40);
const cases = [{ id: 'ok' }, { id: 'broken' },
  { id: 'browser', tools: ['operate_drive'], pass: { call: 'operate_drive' } }];
async function fixture(t, overrides = {}) {
  const out = mkdtempSync(join(tmpdir(), 'prompt-pr-test-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const samples = [], posts = [];
  const result = await replay({ repository: 'Beeline-Work/beeline', number: 1, head, agent: 'baby', out }, {
    liveHead: () => ({ state: 'open', head }), checkout: () => head,
    loadCases: () => cases, loadSource: async () => ({}),
    executeSample: async args => { samples.push(args); return { status: 'behavior', pass: true, exitCode: 0 }; },
    publish: () => posts.push(readFileSync(join(out, 'verdict.md'), 'utf8')), ...overrides,
  });
  return { result, samples, posts, out };
}
test('replays every eligible case in fresh subscription sessions and publishes exact-head table', async t => {
  const { result, samples, posts } = await fixture(t);
  assert.equal(result.status, 'pass');
  assert.equal(samples.length, 2);
  assert.equal(samples[0].model, 'gpt-6-luna');
  assert.notEqual(samples[0].directory, samples[1].directory);
  assert.match(posts[0], /Prompt replay: PASS/);
  assert.match(posts[0], new RegExp(head));
  assert.match(posts[0], /browser \| SKIP/);
});
test('a behavior failure is FAIL with per-case reason', async t => {
  const { result, posts } = await fixture(t, { executeSample: async () => ({ status: 'behavior', pass: false, reason: 'Wrong call', exitCode: 0 }) });
  assert.equal(result.status, 'fail');
  assert.match(posts[0], /broken \| FAIL \| Wrong call/);
});
test('subscription refusal fails every remaining case without making more calls', async t => {
  let count = 0;
  const { result, posts } = await fixture(t, { executeSample: async () => { count++; throw new Error('Subscription unavailable'); } });
  assert.equal(count, 1);
  assert.equal(result.status, 'fail');
  assert.match(posts[0], /broken \| FAIL \| Subscription unavailable/);
});
test('incomplete and timed-out samples never pass', async t => {
  for (const sample of [{ status: 'incomplete', pass: true, exitCode: 0 }, { status: 'behavior', pass: true, timedOut: true, exitCode: 0 }]) {
    const { result } = await fixture(t, { executeSample: async () => sample });
    assert.equal(result.status, 'fail');
  }
});
test('source preparation failures still publish all case rows', async t => {
  const { result, posts } = await fixture(t, { loadSource: async () => { throw new Error('Cannot assemble'); } });
  assert.equal(result.status, 'fail');
  for (const c of cases) assert.match(posts[0], new RegExp(`${c.id} \\| FAIL`));
});
test('stale event never starts a replay', async t => {
  const { result, samples, posts } = await fixture(t, { liveHead: () => ({ state: 'open', head: 'b'.repeat(40) }) });
  assert.equal(result.status, 'superseded');
  assert.equal(samples.length, 0);
  assert.equal(posts.length, 0);
});
test('new head during replay suppresses old-head publication', async t => {
  let reads = 0;
  const { result, posts } = await fixture(t, { liveHead: () => ({ state: 'open', head: reads++ ? 'b'.repeat(40) : head }) });
  assert.equal(result.status, 'superseded');
  assert.equal(posts.length, 0);
});
test('wrong checkout cannot spend tokens or publish', async t => {
  await assert.rejects(fixture(t, { checkout: () => 'b'.repeat(40) }), /Checkout/);
});
test('unknown agent and repository are refused', async () => {
  await assert.rejects(replay({ repository: 'other/repo', number: 1, head, agent: 'baby', out: '/unused' }), /Expected Beeline/);
});
test('an empty or partially completed replay cannot pass', () => {
  assert.match(markdown({ head, agent: 'baby', model: 'gpt-6-luna', expected: 2, rows: [] }), /Prompt replay: FAIL/);
});
