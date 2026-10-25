import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { assessExperiment, budget, buildCandidateTree, chooseBlock, median, needsSquire, removalBlocks, replaySample } from './prompt-nightly.mjs';
import { loadCases, loadSource } from './prompt-cases.ts';

const model = 'fixture/model';
const response = (answer, tokens = 100) => ({ id: 'fixture', model, usage: { total_tokens: tokens, cost: 0.0001 },
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }] });
const row = (id, pass, tokens) => ({ id, pass, samples: [{ tokens }] });

test('browser-session cases are skipped while a text-only case with browser tools stays eligible', () => {
  const cases = loadCases();
  assert.deepEqual(cases.filter(needsSquire).map(({ id }) => id), [
    'squire-busy-request-capability', 'squire-drive-starts-drive', 'squire-long-history-host-recovery',
  ]);
  assert.equal(needsSquire(cases.find(({ id }) => id === 'long-incident-shipped-status')), false);
});

test('candidate tree holds every file loadSource reads', async () => {
  const temp = buildCandidateTree(process.cwd());
  try {
    const guide = 'apps/server/src/free-agents.ts';
    assert.deepEqual(readFileSync(join(temp, guide)), readFileSync(guide));
    const [candidate, root] = await Promise.all([loadSource(temp), loadSource(process.cwd())]);
    assert.equal(candidate.freeAgentRepositoryGuide, root.freeAgentRepositoryGuide);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('removal requires the same cases, no passing-case regression, and lower measured tokens', () => {
  const baseline = [row('a', true, 100), row('b', false, 200)];
  assert.equal(assessExperiment(baseline, [row('a', true, 80), row('b', false, 150)]).accepted, true);
  assert.equal(assessExperiment(baseline, [row('a', false, 80), row('b', true, 150)]).accepted, false);
  assert.equal(assessExperiment(baseline, [row('a', true, 80)]).accepted, false);
  assert.equal(assessExperiment(baseline, [row('a', true, 120), row('b', false, 220)]).accepted, false);
  assert.equal(median([1, 3, 2, 4]), 2.5);
});

test('protects every failing-case section and rotates the next experiment', () => {
  const blocks = [{ id: 'a', section: 'protected' }, { id: 'b', section: 'other' }, { id: 'c', section: 'other' }];
  const baseline = [row('failure', false, 100)];
  const cases = [{ id: 'failure', section: 'protected' }];
  assert.equal(chooseBlock(blocks, baseline, cases)?.id, 'b');
  assert.equal(chooseBlock(blocks, baseline, cases, 'b')?.id, 'c');
  assert.equal(chooseBlock(blocks.slice(0, 1), baseline, cases), undefined);
  assert.equal(chooseBlock(blocks, [], cases, undefined, [{ id: 'failure', status: 'skipped:squire' }])?.id, 'b');
});

test('extracts actual render paragraphs, never rationale or arbitrary source text', () => {
  const text = readFileSync('apps/body/src/prompt-assembly.ts', 'utf8');
  const blocks = removalBlocks(text);
  assert.ok(blocks.length > 5);
  for (const block of blocks) {
    assert.equal(eval(text.slice(block.start, block.end)), block.text);
    assert.ok(block.section && block.text.length >= 70);
  }
  assert.ok(!blocks.some((block) => block.text.includes('Agents on harnesses with their own default persona')));
});

test('budget reserves concurrent requests and stops before another paid request', () => {
  const ledger = budget(100, 1);
  const body = { messages: [], max_tokens: 60 };
  const release = ledger.reserve(body);
  assert.throws(() => ledger.reserve(body), /budget/);
  ledger.record({ total_tokens: 50, cost: 0.01 });
  release();
  assert.throws(() => ledger.reserve(body), /budget/);
  assert.throws(() => ledger.record({}), /accounting/);
});

test('loads only requested skills and resumes the same simulated turn', async () => {
  const bodies = [];
  const replies = [response({ calls: [{ name: 'Read', args: { file_path: '/skill' } },
    { name: 'unsafe_after_pause', args: {} }], text: '' }), response({ calls: [{ name: 'fixed', args: {} }], text: '' }, 120)];
  const result = await replaySample({ prompt: 'fixture', skills: { '/skill': 'requested body', '/unread': 'private unread body' },
    rule: { all: [{ call: 'fixed' }, { noCall: 'unsafe_after_pause' }] }, model, ledger: budget(),
    request: async (body) => { bodies.push(structuredClone(body)); return replies.shift(); } });
  assert.equal(result.pass, true);
  assert.equal(result.tokens, 220);
  assert.equal(bodies.length, 2);
  assert.ok(!JSON.stringify(bodies[0]).includes('requested body'));
  assert.ok(JSON.stringify(bodies[1]).includes('requested body'));
  assert.ok(!JSON.stringify(bodies).includes('private unread body'));
});

test('refuses off-model, unaccounted and truncated answers', async () => {
  const run = (reply) => replaySample({ prompt: 'fixture', skills: {}, rule: { noCall: 'danger' }, model,
    ledger: budget(), request: async () => reply });
  await assert.rejects(run({ ...response({ calls: [], text: '' }), model: 'wrong' }), /Off-model/);
  await assert.rejects(run({ ...response({ calls: [], text: '' }), usage: undefined }), /accounting/);
  const truncated = response({ calls: [], text: '' });
  truncated.choices[0].finish_reason = 'length';
  assert.equal((await run(truncated)).pass, false);
});

test('unfinished skill loops cannot satisfy negative-only grading rules', async () => {
  let calls = 0;
  const result = await replaySample({ prompt: 'fixture', skills: { '/skill': 'body' }, rule: { noCall: 'danger' },
    model, ledger: budget(), request: async () => {
      calls++;
      return response({ calls: [{ name: 'Read', args: { file_path: '/skill' } }], text: '' });
    } });
  assert.equal(result.pass, false);
  assert.equal(calls, 6);
});
