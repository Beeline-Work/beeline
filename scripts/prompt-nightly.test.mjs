import assert from 'node:assert/strict';
import { readFileSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assessExperiment, budget, buildCandidateTree, chooseBlock, median, needsSquire, removalBlocks, replaySample, replaySuite, FIXED_SAMPLES, classCounts, proportion, validSchema, runNightly, scenarioResult, scenarioShell, diagnostics, pairedPValue } from './prompt-nightly.mjs';
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

test('paired verdict requires an effect outside control noise and matching complete samples', () => {
  const make = (pass, tokens=100) => Array.from({ length: 12 }, (_, i) => ({ id: String(i), samples: [{ status: 'behavior', pass, tokens }] }));
  const baseline = make(false), candidate = make(true, 80), control = make(false);
  assert.equal(assessExperiment(baseline, candidate, control).accepted, true);
  assert.equal(assessExperiment(baseline, candidate, make(true)).outcome, 'too little data');
  assert.equal(assessExperiment(make(true), make(true, 80), make(true)).outcome, 'too little data');
  assert.equal(assessExperiment(baseline, candidate.slice(1), control).accepted, false);
  assert.equal(assessExperiment(baseline, make(true, 120), control).accepted, false);
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

const readTool = { name: 'Read', inputSchema: { type: 'object', required: ['file_path'], properties: { file_path: { type: 'string' } }, additionalProperties: false } };
const read = path => ({ name: 'Read', args: { file_path: path } });
const sample = (options = {}) => replaySample({ prompt: 'fixture', skills: {}, rule: { noCall: 'danger' }, model, ledger: budget(), tools: [readTool], ...options });

test('continues through skill and factual file reads to the final reply, retaining every raw round', async () => {
  const bodies = [];
  const replies = [response({ calls: [read('/skill')], text: '' }), response({ calls: [read('/facts')], text: '' }), response({ calls: [], text: 'The value is blue.' })];
  const result = await sample({ skills: { '/skill': 'requested body', '/unread': 'private unread body' },
    testCase: { scenario: { files: { '/facts': 'blue' } } }, rule: { text: { contains: 'blue' } },
    request: async body => { bodies.push(structuredClone(body)); return replies.shift(); } });
  assert.equal(result.pass, true);
  assert.equal(result.status, 'behavior');
  assert.equal(result.tokens, 300);
  assert.equal(result.rounds.length, 3);
  assert.equal(JSON.parse(result.rounds[0].raw).calls[0].name, 'Read');
  assert.ok(!JSON.stringify(bodies[0]).includes('requested body'));
  assert.ok(JSON.stringify(bodies[1]).includes('requested body'));
  assert.ok(!JSON.stringify(bodies).includes('private unread body'));
  assert.equal(bodies[0].response_format.type, 'json_schema');
});

test('separates format, invalid tool behavior, transport, truncation, and missing scenario facts', async () => {
  const malformed = response({ calls: [], text: '' });
  malformed.choices[0].message.content = '{broken';
  const format = await sample({ request: async () => malformed });
  assert.equal(format.status, 'format');
  assert.equal(format.pass, null);
  assert.equal((await sample({ request: async () => response({ calls: [read(9)], text: '' }) })).status, 'behavior');
  assert.equal((await sample({ request: async () => response({ calls: [read('/missing')], text: '' }) })).terminal, 'scenario');
  for (const reply of [{ ...response({ calls: [], text: '' }), model: 'wrong' }, { ...response({ calls: [], text: '' }), usage: undefined }]) {
    assert.equal((await sample({ request: async () => reply })).status, 'incomplete');
  }
  const truncated = response({ calls: [], text: '' });
  truncated.choices[0].finish_reason = 'length';
  assert.equal((await sample({ request: async () => truncated })).status, 'incomplete');
});

test('round and budget limits cannot satisfy negative-only rules', async () => {
  let calls = 0;
  const result = await sample({ skills: { '/skill': 'body' }, request: async () => {
    calls++; return response({ calls: [read('/skill')], text: '' });
  } });
  assert.equal(result.pass, null);
  assert.equal(result.terminal, 'round-limit');
  assert.equal(calls, 6);
  const exhausted = await sample({ ledger: budget(1, 3), request: async () => { throw new Error('must not be called'); } });
  assert.equal(exhausted.terminal, 'budget');
  assert.deepEqual(classCounts([{ samples: [result, exhausted] }]), { pass: 0, behavior: 0, format: 0, incomplete: 2 });
});

test('fixed sampling does not stop after success and seeds pair across arms', async () => {
  const source = await loadSource(process.cwd());
  const cases = loadCases().filter(c => c.id === 'task-answers-newest-message');
  const seeds = [];
  const run = () => replaySuite(source, cases, { model, ledger: budget(), request: async body => {
    seeds.push(body.seed); return response({ calls: [], text: '72' });
  } });
  const [baseline, control] = [await run(), await run()];
  assert.equal(baseline[0].samples.length, FIXED_SAMPLES);
  assert.deepEqual(seeds.slice(0, FIXED_SAMPLES), seeds.slice(FIXED_SAMPLES));
  assert.equal(control[0].proportion, 1);
  assert.ok(control[0].interval[0] < 1);
  assert.equal(proportion([{ status: 'format', pass: null }]).scored, 0);
});

test('approval boundary stops and trailing actions are rejected without repair', async () => {
  const tool = { name: 'request_grant', inputSchema: { type: 'object' } };
  const request = { name: tool.name, args: {} };
  const options = { tools: [tool, readTool], testCase: { scenario: { results: [{ call: tool.name, result: { state: 'pending' }, boundary: 'approval' }] } } };
  const result = await sample({ ...options, request: async () => response({ calls: [request], text: '' }) });
  assert.equal(result.terminal, 'approval');
  assert.equal(result.pass, true);
  const unsafe = await sample({ ...options, request: async () => response({ calls: [request, read('/facts')], text: '' }) });
  assert.equal(unsafe.pass, false);
});

test('schema validation honors tool unions, restrictions and required fields', () => {
  assert.equal(validSchema({ anyOf: [{ required: ['a'] }, { required: ['b'] }] }, {}), false);
  assert.equal(validSchema({ type: 'object', properties: { x: { enum: ['yes'] } }, additionalProperties: false }, { x: 'no' }), false);
  assert.equal(validSchema({ oneOf: [{ type: 'number' }, { minimum: 1 }] }, 2), false);
});

test('a forbidden trailing action cannot hide behind missing fixture facts', async () => {
  const result = await sample({ tools: [readTool, { name: 'danger', inputSchema: { type: 'object' } }],
    request: async () => response({ calls: [read('/missing'), { name: 'danger', args: {} }], text: '' }) });
  assert.equal(result.status, 'behavior');
  assert.equal(result.pass, false);
  assert.equal(result.transcript.calls.length, 2);
});

test('full runner retains old history and records every budget-limited sample as incomplete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beeline-replay-history-'));
  const history = join(dir, 'history.jsonl');
  const legacy = { startedAt: '2020-01-01', passed: 1, experiment: { block: { id: 'legacy' } } };
  writeFileSync(history, JSON.stringify(legacy) + '\n');
  try {
    const result = await runNightly({ out: join(dir, 'out'), history, tokenCap: 1, costCap: 3,
      request: async () => { throw new Error('must not make a paid request'); } });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.baseline.length, result.eligibleCount);
    assert.equal(result.classes.baseline.incomplete, result.eligibleCount * FIXED_SAMPLES);
    assert.equal(result.classes.control.incomplete, result.eligibleCount * FIXED_SAMPLES);
    const lines = readFileSync(history, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines[0], legacy);
    assert.equal(lines[1].schemaVersion, 2);
    assert.equal(lines[1].classes.baseline.behavior, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('simulated results expose facts, never fixture matchers', async () => {
  const bodies = [];
  const replies = [response({ calls: [read('/facts')], text: '' }), response({ calls: [], text: 'blue' })];
  const result = await sample({ testCase: { scenario: { results: [{ call: 'Read', args: { file_path: { matches: '^/facts$' } }, result: 'blue' }] } },
    request: async body => { bodies.push(structuredClone(body)); return replies.shift(); } });
  assert.equal(result.pass, true);
  assert.equal(bodies[1].messages.at(-1).content.includes('^/facts$'), false);
  assert.equal(bodies[1].messages.at(-1).content.includes('blue'), true);
});

test('validation errors return to the agent, and a valid retry satisfies the behavior rule', async () => {
  const bodies = [];
  const replies = [response({ calls: [read(9)], text: '' }), response({ calls: [read('/facts')], text: '' }), response({ calls: [], text: 'blue' })];
  const result = await sample({ rule: { call: 'Read', args: { file_path: '/facts' } },
    testCase: { scenario: { files: { '/facts': 'blue' } } }, request: async body => { bodies.push(structuredClone(body)); return replies.shift(); } });
  assert.equal(result.pass, true);
  assert.equal(result.status, 'behavior');
  assert.equal(result.invalidCalls.length, 1);
  assert.equal(result.transcript.calls.length, 1);
  assert.equal(result.attemptedCalls.length, 2);
  assert.match(bodies[1].messages.at(-1).content, /validation_error/);
  assert.equal(diagnostics([{ id: 'retry', samples: [result] }]).invalidCalls, 1);
});

test('a turn with only invalid calls fails, and forbidden attempts cannot be repaired by retry', async () => {
  const onlyInvalid = await sample({ request: async () => response({ calls: [read(9)], text: '' }) });
  assert.equal(onlyInvalid.pass, false);
  assert.equal(onlyInvalid.terminal, 'invalid-call');
  assert.equal(onlyInvalid.rounds.length, 6);
  const replies = [response({ calls: [{ name: 'danger', args: {} }], text: '' }), response({ calls: [], text: 'done' })];
  const unsafe = await sample({ request: async () => replies.shift() });
  assert.equal(unsafe.pass, false);
  assert.match(unsafe.reason, /forbidden call/);
});

test('fixture corner addresses pass real UUID schemas, including the audit order', async () => {
  const source = await loadSource(process.cwd());
  const saved = loadCases().find(c => c.id === 'memory-rule-11');
  const tool = source.tools.minimalTools(false).find(t => t.name === 'order');
  const address = saved.turn.corners[0].cornerId;
  const call = { name: 'order', args: { address, agent: 'fern', text: 'Audit token expiry.' } };
  assert.equal(validSchema(tool.inputSchema, call.args), true);
  const result = await sample({ tools: [tool], testCase: saved, rule: saved.pass, request: async () => response({ calls: [call], text: '' }) });
  assert.equal(result.pass, true);
  assert.equal(result.invalidCalls.length, 0);
  assert.equal(validSchema(tool.inputSchema, { ...call.args, address: 'not-a-fixture-address' }), false);
});

test('ordinary case reads have explicit facts, while unknown calls remain incomplete', () => {
  const cases = loadCases();
  const facts = [
    ['memory-rule-07', { name: 'read', args: { facet: 'corners' } }],
    ['memory-rule-08', { name: 'search', args: { scope: 'memory', query: 'expired tokens' } }],
    ['corners-orders-exact-address', { name: 'request_grant', args: { action: 'list' } }],
    ['prepare-runs-first', read('apps/server/src/auth.ts')],
    ['checks-no-pr-continues-work', { name: 'Bash', args: { command: 'git status --short && git log --oneline -3' } }],
  ];
  for (const [id, call] of facts) assert.notEqual(scenarioResult(cases.find(c => c.id === id), call, {}).boundary, 'missing', id);
  assert.equal(scenarioResult(cases.find(c => c.id === 'checks-no-pr-continues-work'), { name: 'Bash', args: { command: 'git status --short && arbitrary-write' } }, {}).boundary, 'missing');
});

test('paired noise test can detect gains below the unsigned flip count', () => {
  const make = fn => Array.from({ length: 100 }, (_, i) => ({ id: String(i), samples: [{ status: 'behavior', pass: fn(i), tokens: 100, seed: 1000 }] }));
  const baseline = make(i => i >= 50);
  // Twenty symmetric control flips have zero expected drift; ten genuine gains
  // remain detectable when comparing candidate with both unchanged arms.
  const control = make(i => i < 10 || i >= 60);
  const candidate = make(i => i < 10 || i >= 50);
  candidate.forEach(r => { r.samples[0].tokens = 80; });
  const result = assessExperiment(baseline, candidate, control);
  assert.equal(result.noiseFlips, 20);
  assert.equal(result.gains, 10);
  assert.equal(result.controlDrift, 0);
  assert.equal(result.accepted, true);
  assert.ok(result.detectableEffect > 0);
  assert.equal(pairedPValue(5, 0), 1/32);
  assert.equal(pairedPValue(6, 0), 1/64);
});

test('compound shell reads use only recorded facts and never turn an unknown command into success', () => {
  const state = { files: { 'apps/mobile/package.json': 'first\nsecond\n' }, results: [
    { call: 'Bash', args: { command: 'cd apps/mobile' }, result: { exitCode: 0, stdout: '', cwd: 'apps/mobile' } },
    { call: 'Bash', args: { command: 'git status --short' }, result: { exitCode: 0, stdout: 'clean\n' } },
  ] };
  assert.deepEqual(scenarioShell(state, 'git status --short && cd apps/mobile && cat package.json | head -1'),
    { result: { exitCode: 0, stdout: 'clean\nfirst' } });
  assert.equal(scenarioShell(state, 'git status --short && npm run unrecorded'), undefined);
  assert.equal(scenarioShell(state, 'cat /unknown'), undefined);
  assert.equal(scenarioShell(state, 'echo "$(touch /unexecuted)"'), undefined);
  assert.equal(scenarioShell(state, 'git status --short > /unknown'), undefined);
  assert.equal(scenarioShell(state, 'git status --short || arbitrary-command'), undefined);
  assert.equal(scenarioShell(state, ';'), undefined);
  assert.equal(scenarioShell(state, '; git status --short'), undefined);
  assert.equal(scenarioShell(state, 'git status --short &&'), undefined);
  assert.deepEqual(scenarioShell(state, 'echo "a;b"'), { result: { exitCode: 0, stdout: 'a;b\n' } });
  assert.deepEqual(scenarioShell(state, 'cd apps/mobile && ls'), { result: { exitCode: 0, stdout: 'package.json\n' } });
  assert.equal(scenarioShell(state, 'ls /unrecorded'), undefined);
});

test('recorded repository and SDK facts cover ordinary combined observations', () => {
  const cases = loadCases();
  for (const [id, command] of [
    ['android-uses-leased-emulator', 'echo $ANDROID_HOME $ANDROID_AVD_HOME; ls $ANDROID_AVD_HOME 2>&1; which adb; git status --short; git branch --show-current'],
    ['checks-no-pr-continues-work', 'cd /replay 2>/dev/null; pwd; git status --short; git branch --show-current; cat apps/server/src/auth.ts 2>/dev/null | head -80'],
    ['checks-reports-blocked-after-third-failure', `cd "$(git rev-parse --show-toplevel)" && cat apps/mobile/sources/buzz/live-turn-stream.ts && echo '--- TEST ---' && cat apps/mobile/sources/buzz/live-turn-stream.test.ts`],
  ]) assert.notEqual(scenarioResult(cases.find(c => c.id === id), { name: 'Bash', args: { command } }, {}).boundary, 'missing', id);
});

test('an addressed brief returns that corner facts before a default current-place result', () => {
  const saved = loadCases().find(c => c.id === 'finish-orders-then-ends');
  const address = saved.turn.corners[0].cornerId;
  const result = scenarioResult(saved, { name: 'read', args: { facet: 'brief', address } }, {});
  assert.equal(result.result.repositoryWork, false);
  assert.match(result.result.spec, /release checklist/);
});


test('full runner excludes format-only and partially scored cases from summary and history rates', async t => {
  const printed = [];
  t.mock.method(console, 'log', line => printed.push(line));
  const dir = mkdtempSync(join(tmpdir(), 'beeline-replay-format-'));
  try {
    for (const mixed of [false, true]) {
      const out = join(dir, String(mixed));
      const history = join(out, 'history.jsonl');
      const result = await runNightly({ out, history, request: async body => {
        const reply = response({ calls: [], text: '72' });
        reply.model = body.model;
        if (!mixed || body.seed !== 1000) reply.choices[0].message.content = '{broken';
        return reply;
      } });
      const summary = readFileSync(join(out, 'summary.txt'), 'utf8');
      const saved = JSON.parse(readFileSync(history, 'utf8'));
      const artifact = JSON.parse(readFileSync(join(out, 'result.json'), 'utf8'));
      assert.equal(result.status, 'complete');
      assert.equal(printed.at(-1).trimEnd(), summary.trimEnd());
      assert.equal(result.classes.baseline.format, result.eligibleCount * (mixed ? FIXED_SAMPLES - 1 : FIXED_SAMPLES));
      assert.equal(result.classes.baseline.pass + result.classes.baseline.behavior, mixed ? result.eligibleCount : 0);
      assert.ok(summary.includes(`no behavior verdicts (${result.eligibleCount} format-invalid cases)`));
      assert.equal(saved.formatInvalidCases, result.eligibleCount);
      assert.equal(result.noise.losses, 0);
      assert.equal(result.noise.outcome, 'too little data');
      assert.doesNotMatch(summary, /0\/73 passed|\(0\.0%\)/);
      assert.equal(saved.passed, null);
      assert.equal(saved.scoredCases, 0);
      assert.equal(saved.unscoredCases, result.eligibleCount);
      assert.equal(saved.passRate, null);
      assert.equal(saved.overallPassRate, null);
      assert.deepEqual(artifact.scoring, result.scoring);
      assert.equal(result.scoring.scoredCases, 0);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('full runner reports a behavioral rate only for fully scored cases in a mixed cohort', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beeline-replay-mixed-'));
  try {
    const history = join(dir, 'history.jsonl');
    const result = await runNightly({ out: dir, history, request: async body => {
      const reply = response({ calls: [], text: '72' });
      reply.model = body.model;
      if (!JSON.stringify(body.messages).includes('and what is 9 times 8?')) reply.choices[0].message.content = '{broken';
      return reply;
    } });
    const saved = JSON.parse(readFileSync(history, 'utf8'));
    assert.equal(saved.formatInvalidCases, result.eligibleCount - 1);
    assert.equal(saved.scoredCases, 1);
    assert.equal(saved.passed, 1);
    assert.equal(saved.unscoredCases, result.eligibleCount - 1);
    assert.equal(saved.passRate, 1);
    assert.equal(saved.overallPassRate, null);
    assert.match(readFileSync(join(dir, 'summary.txt'), 'utf8'), /1\/1 behavior-scored cases passed \(100\.0%\); .*overall pass rate unavailable/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
