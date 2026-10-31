import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseAnswer, replayInterleaved, assessExperiment, budget, buildCandidateTree, chooseBlock, median, needsSquire, removalBlocks, replaySample, replaySuite, FIXED_SAMPLES, classCounts, proportion, validSchema, runNightly, scenarioResult, scenarioShell, diagnostics, pairedPValue, DEFAULT_MODELS, decideCandidate, chooseMode, floorReached, weeklyShorteningSkip, validateCandidatePatch, grantTransport, runCli } from './prompt-nightly.mjs';
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
  assert.equal(bodies[0].response_format.json_schema.strict, true);
});

test('separates format, invalid tool behavior, transport, truncation, and missing scenario facts', async () => {
  const malformed = response({ calls: [], text: '' });
  malformed.choices[0].message.content = '{broken';
  const format = await sample({ request: async () => malformed });
  assert.equal(format.status, 'format');
  assert.equal(format.pass, null);
  assert.equal((await sample({ request: async () => response({ calls: [read(9)], text: '' }) })).status, 'behavior');
  assert.equal((await sample({ rule: { call: 'Read' }, request: async () => response({ calls: [read('/missing')], text: '' }) })).terminal, 'scenario');
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
    // Both default models replay every arm under one shared ledger.
    assert.deepEqual(Object.keys(result.models), DEFAULT_MODELS);
    assert.equal(result.baseline.length, result.eligibleCount * DEFAULT_MODELS.length);
    assert.equal(result.classes.baseline.incomplete, result.eligibleCount * FIXED_SAMPLES * DEFAULT_MODELS.length);
    assert.equal(result.classes.control.incomplete, result.eligibleCount * FIXED_SAMPLES * DEFAULT_MODELS.length);
    const lines = readFileSync(history, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines[0], legacy);
    assert.equal(lines[1].schemaVersion, 3);
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
      const result = await runNightly({ out, history, models: [model], request: async body => {
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
    const result = await runNightly({ out: dir, history, models: [model], request: async body => {
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
    assert.match(readFileSync(join(dir, 'summary.txt'), 'utf8'), /1\/1 pooled behavior-scored cases passed \(100\.0%\); .*overall pass rate unavailable/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('D1 keeps a candidate only for a pooled paired gain worth its token growth', () => {
  const pooled = (gains, losses = 0) => ({ significant: true, gains, losses, pairedSamples: 400 });
  const arm = (gains, losses, after) => ({ gains, losses, before: 100, after });
  // 5 points pooled allows 10% growth; shrinking tokens is always allowed.
  assert.equal(decideCandidate(pooled(20), { small: arm(10, 0, 105), large: arm(10, 0, 95) }).outcome, 'propose prompt change');
  assert.match(decideCandidate(pooled(20, 1), { small: arm(18, 0, 100), large: arm(2, 3, 100) }).outcome, /losses exceed gains on large/);
  // 2 points pooled allows only 4% growth.
  const tooCostly = decideCandidate(pooled(8), { small: arm(4, 0, 105), large: arm(4, 0, 100) });
  assert.equal(tooCostly.accepted, false);
  assert.equal(tooCostly.tokenAllowance, 0.04);
  assert.match(tooCostly.outcome, /token growth small 5\.0% above 4\.0% allowance/);
  // 10 points would allow 20%, but growth never exceeds 10% per run.
  assert.equal(decideCandidate(pooled(40), { small: arm(20, 0, 110), large: arm(20, 0, 100) }).accepted, true);
  assert.match(decideCandidate(pooled(40), { small: arm(20, 0, 112), large: arm(20, 0, 100) }).outcome, /above 10\.0% allowance/);
  assert.equal(decideCandidate({ ...pooled(40), significant: false }, { small: arm(20, 0, 90) }).outcome, 'too little data');
});

test('D2 switches to weekly shortening only when both models reach 90%', () => {
  const models = ['small', 'large'];
  assert.equal(chooseMode({ rates: { small: 0.9, large: 0.95 }, models }), 'shorten');
  assert.equal(chooseMode({ rates: { small: 0.899, large: 0.95 }, models }), 'none');
  assert.equal(chooseMode({ rates: { small: 0.95 }, models }), 'none');
  assert.equal(chooseMode({ patch: {}, rates: { small: 1, large: 1 }, models }), 'audit');
  assert.equal(floorReached({ small: null, large: 1 }, models), false);
  const day = 24 * 3600_000, now = Date.parse('2026-11-10T08:00:00Z');
  const run = (daysAgo, small, mode = 'none') => ({ status: 'complete', startedAt: new Date(now - daysAgo * day).toISOString(),
    models: { small: { passRate: small, overallPassRate: small }, large: { passRate: 0.93, overallPassRate: 0.93 } }, experiment: { mode } });
  assert.match(weeklyShorteningSkip([run(3, 0.91, 'shorten'), run(1, 0.92)], models, now), /weekly shortening not due/);
  assert.equal(weeklyShorteningSkip([run(7, 0.91, 'shorten'), run(1, 0.92)], models, now), undefined);
  assert.equal(weeklyShorteningSkip([run(3, 0.91, 'shorten'), run(1, 0.85)], models, now), undefined);
  assert.equal(weeklyShorteningSkip([{ startedAt: '2020-01-01', passed: 1 }], models, now), undefined);
  // A partially scored entry has a behavior rate but no overall rate; it never counts as the floor.
  const partial = (daysAgo, mode) => ({ ...run(daysAgo, 1, mode), models: { small: { passRate: 1, overallPassRate: null }, large: { passRate: 1 } } });
  assert.equal(weeklyShorteningSkip([partial(1, 'shorten')], models, now), undefined);
  assert.equal(weeklyShorteningSkip([partial(3, 'shorten'), run(1, 0.92)], models, now), undefined);
});

test('a partially scored cohort never reaches the floor, selects shortening, or skips later nights', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beeline-replay-partial-floor-'));
  try {
    const history = join(dir, 'history.jsonl');
    // One passing case per model; every other case returns a malformed answer.
    const request = async body => {
      const reply = { ...response({ calls: [], text: '72' }), model: body.model };
      if (!JSON.stringify(body.messages).includes('and what is 9 times 8?')) reply.choices[0].message.content = '{broken';
      return reply;
    };
    const first = await runNightly({ out: join(dir, 'first'), history, request });
    assert.equal(first.status, 'complete');
    assert.equal(first.floorReached, false);
    assert.equal(first.experiment.mode, 'none');
    assert.equal(first.experiment.outcome, 'skipped: no audit candidate');
    assert.equal(first.candidate.length, 0);
    const saved = JSON.parse(readFileSync(history, 'utf8'));
    assert.equal(saved.floorReached, false);
    for (const id of DEFAULT_MODELS) {
      assert.equal(saved.models[id].scoredCases, 1);
      assert.equal(saved.models[id].passRate, 1);
      assert.equal(saved.models[id].overallPassRate, null);
    }
    assert.match(readFileSync(join(dir, 'first', 'summary.txt'), 'utf8'), /below 90% floor/);
    // A partial entry recorded in shorten mode by an older runner does not suppress the next night.
    writeFileSync(history, `${JSON.stringify({ ...saved, floorReached: true, experiment: { mode: 'shorten', outcome: 'no change' } })}\n`);
    const next = await runNightly({ out: join(dir, 'next'), history, request, now: Date.parse(saved.startedAt) + 3600_000 });
    assert.notEqual(next.status, 'skipped');
    assert.equal(next.experiment.mode, 'none');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function writePatch(dir, path, marker) {
  const before = join(dir, 'before'), after = join(dir, 'after');
  const text = readFileSync('apps/body/src/prompt-assembly.ts', 'utf8');
  const block = removalBlocks(text)[0];
  writeFileSync(before, text);
  writeFileSync(after, text.slice(0, block.end - 1) + ` ${marker}` + text.slice(block.end - 1));
  const diff = spawnSync('diff', ['-u', '--label', `a/${path}`, '--label', `b/${path}`, before, after], { encoding: 'utf8' }).stdout;
  const file = join(dir, `${path.replaceAll('/', '_')}.patch`);
  writeFileSync(file, diff);
  return { file, block };
}

test('an audit patch outside the prompt sources is rejected before any paid request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beeline-replay-patch-'));
  try {
    for (const path of ['scripts/prompt-cases.ts', 'apps/server/src/auth.ts', 'apps/body/src/../../server/src/x.ts']) {
      const { file } = writePatch(dir, path, 'X');
      assert.throws(() => validateCandidatePatch(file), /outside apps\/body\/src/);
      await assert.rejects(runNightly({ out: join(dir, 'out'), history: join(dir, 'history.jsonl'), candidatePatch: file,
        request: async () => { throw new Error('must not make a paid request'); } }), /outside apps\/body\/src/);
    }
    assert.deepEqual(validateCandidatePatch(writePatch(dir, 'apps/body/src/prompt-assembly.ts', 'X').file).paths, ['apps/body/src/prompt-assembly.ts']);
    assert.deepEqual(validateCandidatePatch(writePatch(dir, 'apps/server/src/free-agents.ts', 'X').file).paths, ['apps/server/src/free-agents.ts']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an audit patch replaces the removal experiment and replays the patched prompt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beeline-replay-audit-'));
  try {
    const marker = 'AUDITMARKER';
    const { file } = writePatch(dir, 'apps/body/src/prompt-assembly.ts', marker);
    let patchedRequests = 0;
    const arms = [];
    const out = join(dir, 'out');
    const result = await runNightly({ out, history: join(dir, 'history.jsonl'), models: [model], candidatePatch: file, request: async body => {
      const patched = JSON.stringify(body.messages).includes(marker);
      arms.push({ patched, seed: body.seed });
      if (patched) patchedRequests++;
      return { ...response({ calls: [], text: '72' }), model: body.model };
    } });
    assert.equal(result.experiment.mode, 'audit');
    assert.equal(result.experiment.block, undefined);
    assert.deepEqual(result.experiment.patch.paths, ['apps/body/src/prompt-assembly.ts']);
    assert.ok(patchedRequests > 0);
    assert.deepEqual(arms.slice(0, 6), [false, false, true, false, false, true].map((patched, i) => ({ patched, seed: 1000 + Math.floor(i / 3) })));
    assert.equal(result.candidate.length, result.eligibleCount);
    assert.ok(!existsSync(join(out, 'prompt-assembly.ts')));
    // Without a patch and below the floor, nothing replaces the audit.
    const idle = await runNightly({ out: join(dir, 'idle'), history: join(dir, 'idle.jsonl'), models: [model],
      request: async body => ({ ...response({ calls: [], text: 'wrong' }), model: body.model }) });
    assert.equal(idle.experiment.outcome, 'skipped: no audit candidate');
    assert.equal(idle.candidate.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('each model gets its own paired rows, and an off-model reply stays incomplete for that model only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beeline-replay-models-'));
  try {
    const [small, large] = DEFAULT_MODELS;
    const history = join(dir, 'history.jsonl');
    const sent = {};
    const result = await runNightly({ out: dir, history, request: async body => {
      sent[body.model] = { reasoning: body.reasoning, strict: body.response_format.json_schema.strict };
      return { ...response({ calls: [], text: '72' }), model: body.model === small ? 'openai/substitute' : body.model };
    } });
    // Closed string arguments enable strict output; the large model needs low reasoning.
    assert.deepEqual(sent, { [small]: { reasoning: { enabled: false }, strict: true }, [large]: { reasoning: { effort: 'low' }, strict: true } });
    const n = result.eligibleCount * FIXED_SAMPLES;
    assert.equal(result.models[small].classes.baseline.incomplete, n);
    assert.equal(result.models[large].classes.baseline.incomplete, 0);
    assert.deepEqual(result.models[large].baseline.map(r => r.samples.map(s => s.seed)), result.models[large].control.map(r => r.samples.map(s => s.seed)));
    assert.ok(result.baseline.every(r => r.id.startsWith(`${r.model}:`)));
    const saved = JSON.parse(readFileSync(history, 'utf8'));
    assert.deepEqual(Object.keys(saved.models), DEFAULT_MODELS);
    assert.equal(saved.models[small].scoredCases, 0);
    assert.equal(saved.models[large].scoredCases, result.eligibleCount);
    assert.equal(saved.passRate, saved.models[large].passRate);
    assert.equal(saved.floorReached, false);
    assert.match(readFileSync(join(dir, 'summary.txt'), 'utf8'), /baseline gpt-6-luna unscored, gpt-6\.1-sol \d+\/\d+ \(/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const TOKEN = 'grant-token-must-never-leak-7f3a';
/** Stub OpenRouter-shaped proxy; `reply(body, index)` returns a status, an answer, or 'hang'. */
async function stubProxy(reply) {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, contentType: req.headers['content-type'], body });
      const outcome = reply(body, seen.length - 1);
      if (outcome === 'hang') return;
      if (typeof outcome === 'number') { res.writeHead(outcome, { 'content-type': 'application/json' }); return res.end(`{"error":"upstream ${TOKEN}"}`); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...response(outcome), model: body.model }));
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const close = () => { server.closeAllConnections(); return new Promise(done => server.close(done)); };
  return { base: `http://127.0.0.1:${server.address().port}/proxy/grant/`, seen, close };
}
const tokenFile = (dir, mode = 0o600) => { const file = join(dir, 'grant.token'); writeFileSync(file, `${TOKEN}\n`, { mode }); chmodSync(file, mode); return file; };
const runChild = (args) => new Promise(done => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/prompt-nightly.mjs', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  child.on('exit', (code, signal) => done({ code, signal, output, child }));
  runChild.last = child;
});

test('grant transport POSTs each body with the grant bearer, and the token never reaches any output', async () => {
  const proxy = await stubProxy(() => ({ calls: [], text: '72' }));
  const dir = mkdtempSync(join(tmpdir(), 'beeline-replay-grant-'));
  try {
    const out = join(dir, 'out'), history = join(dir, 'history.jsonl');
    const run = await runChild(['--out', out, '--history', history, '--models', model,
      '--grant-base-url', proxy.base, '--grant-token-file', tokenFile(dir)]);
    assert.equal(run.code, 0, run.output);
    const first = proxy.seen[0];
    assert.equal(first.method, 'POST');
    assert.equal(first.url, '/proxy/grant/api/v1/chat/completions');
    assert.equal(first.authorization, `Bearer ${TOKEN}`);
    assert.equal(first.contentType, 'application/json');
    assert.equal(first.body.model, model);
    assert.ok(Array.isArray(first.body.messages));
    const result = readFileSync(join(out, 'result.json'), 'utf8');
    assert.equal(JSON.parse(result).status, 'complete');
    for (const text of [result, readFileSync(join(out, 'summary.txt'), 'utf8'), readFileSync(history, 'utf8'), run.output]) assert.ok(!text.includes(TOKEN));
  } finally { await proxy.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('grant HTTP errors and timeouts become redacted incomplete samples, and the run still finishes', async () => {
  const proxy = await stubProxy((body, index) => index === 0 ? 500 : index === 1 ? 'hang' : { calls: [], text: '72' });
  const dir = mkdtempSync(join(tmpdir(), 'beeline-replay-grant-errors-'));
  try {
    const out = join(dir, 'out');
    const request = grantTransport({ baseUrl: proxy.base, token: TOKEN, timeoutMs: 300 });
    const result = await runNightly({ out, history: join(dir, 'history.jsonl'), models: [model], request });
    assert.equal(result.status, 'incomplete');
    const saved = readFileSync(join(out, 'result.json'), 'utf8');
    assert.equal(JSON.parse(saved).status, 'incomplete');
    const reasons = result.diagnostics.baseline.incomplete.map(s => s.reason);
    assert.deepEqual(reasons.sort(), ['Grant request failed: HTTP 500', 'Grant request failed: timed out after 300 ms']);
    assert.ok(!saved.includes(TOKEN) && !saved.includes('upstream'));
    await assert.rejects(grantTransport({ baseUrl: 'http://127.0.0.1:1', token: TOKEN })({}), (error) => /Grant request failed/.test(error.message) && !error.message.includes(TOKEN));
  } finally { await proxy.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a controller that throws or is killed mid-run leaves a terminal result, never running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beeline-replay-terminal-'));
  try {
    const out = join(dir, 'thrown');
    const args = ['--out', out, '--history', join(dir, 'h.jsonl'), '--exchange', join(dir, 'exchange')];
    await assert.rejects(runCli(args, { run: async ({ out }) => {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'result.json'), JSON.stringify({ status: 'running', baseline: [1], experiment: { outcome: 'running' } }));
      throw new Error('injected mid-run failure');
    } }), /injected mid-run failure/);
    const thrown = JSON.parse(readFileSync(join(out, 'result.json'), 'utf8'));
    assert.deepEqual([thrown.status, thrown.error, thrown.baseline], ['failed', 'Controller error: injected mid-run failure', [1]]);

    const proxy = await stubProxy(() => 'hang');
    try {
      const killed = join(dir, 'killed');
      const exit = runChild(['--out', killed, '--history', join(dir, 'k.jsonl'), '--models', model,
        '--grant-base-url', proxy.base, '--grant-token-file', tokenFile(dir)]);
      while (!proxy.seen.length) await new Promise(done => setTimeout(done, 50));
      runChild.last.kill('SIGTERM');
      assert.equal((await exit).code, 143);
      const saved = JSON.parse(readFileSync(join(killed, 'result.json'), 'utf8'));
      assert.deepEqual([saved.status, saved.error], ['killed', 'Controller received SIGTERM']);
    } finally { await proxy.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the CLI requires exactly one transport and an owner-only grant token file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beeline-replay-cli-'));
  const never = async () => { throw new Error('must not run'); };
  try {
    const base = ['--out', join(dir, 'out'), '--history', join(dir, 'h.jsonl')];
    const grant = ['--grant-base-url', 'http://127.0.0.1:1', '--grant-token-file', tokenFile(dir)];
    await assert.rejects(runCli(base, { run: never }), /exactly one transport/);
    await assert.rejects(runCli([...base, '--exchange', join(dir, 'x'), ...grant], { run: never }), /exactly one transport/);
    await assert.rejects(runCli([...base, '--grant-base-url', 'http://127.0.0.1:1'], { run: never }), /required together/);
    tokenFile(dir, 0o644);
    await assert.rejects(runCli([...base, ...grant], { run: never }), /chmod 600/);
    const ran = [];
    await runCli([...base, '--exchange', join(dir, 'x')], { run: async (options) => { ran.push(options); return { status: 'complete' }; } });
    assert.equal(typeof ran[0].request, 'function');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R1: prose-wrapped single answers recover, conflicting objects stay format-invalid', async () => {
  const reply = response({ calls: [], text: 'done {quoted}' });
  reply.choices[0].message.content = `I'll check.\n${reply.choices[0].message.content}\nFinished.`;
  const recovered = await sample({ request: async () => reply });
  assert.equal(recovered.status, 'behavior');
  assert.equal(diagnostics([{ id: 'one', samples: [recovered] }]).recoveredSamples, 1);
  reply.choices[0].message.content += '\n{"calls":[],"text":"different"}';
  assert.equal((await sample({ request: async () => reply })).status, 'format');
  assert.throws(() => parseAnswer('before {"calls":[],"text":"ok"} {unfinished'), /one replay/);
});

test('R1: strict schema decodes JSON argument strings and retries only unsupported schemas', async () => {
  const bodies = [];
  const replies = [response({ calls: [{ name: 'Read', args: '{"file_path":"/skill"}' }], text: '' }), response({ calls: [], text: 'done' })];
  const result = await sample({ skills: { '/skill': 'body' }, request: async body => {
    bodies.push(structuredClone(body));
    if (bodies.length === 1) throw new Error('Grant request failed: HTTP 400');
    return replies.shift();
  } });
  assert.equal(result.status, 'behavior');
  assert.equal(result.transcript.calls[0].args.file_path, '/skill');
  assert.deepEqual(bodies.map(b => b.response_format.json_schema.strict), [true, false, false]);
  assert.equal(bodies[0].response_format.json_schema.schema.properties.calls.items.properties.args.type, 'string');
  let count = 0;
  await sample({ request: async () => { count++; throw new Error('HTTP 503'); } });
  assert.equal(count, 1);
});

test('R1: unrecorded exploration continues with marked empty results but graded actions need facts', async () => {
  const replies = [response({ calls: [read('/unknown')], text: '' }), response({ calls: [], text: 'finished' })];
  const result = await sample({ request: async () => replies.shift() });
  assert.equal(result.status, 'behavior');
  assert.equal(result.rounds[0].results[0].unrecorded, true);
  assert.equal(result.rounds[0].results[0].result, '');
  assert.equal(diagnostics([{ id: 'one', samples: [result] }]).unrecordedCalls, 1);
  assert.equal(scenarioResult({ pass: { all: [{ ordered: [{ call: 'Read' }, { call: 'report' }] }] } }, read('/unknown'), {}).boundary, 'missing');
  assert.deepEqual(scenarioResult({}, { name: 'Bash', args: { command: 'unrecorded' } }, {}).result, { exitCode: 0, stdout: '' });
  assert.deepEqual(scenarioResult({}, { name: 'connect', args: { mode: 'discover' } }, {}).result, { connected: false, apps: [] });
});

test('R1: all arms and both models finish a seed before the next; budget interruption keeps pairing', async () => {
  const source = await loadSource(process.cwd());
  const cases = loadCases().filter(c => ['task-answers-newest-message', 'memory-answers-from-note'].includes(c.id));
  const names = ['baseline', 'control', 'candidate'], models = ['fixture/a', 'fixture/b'];
  const sent = [], interrupted = [];
  // Stop during the second seed after one complete six-arm group.
  const ledger = budget();
  let reservations = 0;
  const rows = await replayInterleaved(Object.fromEntries(names.map(n => [n, source])), cases, {
    models, ledger: { reserve(body) { if (++reservations === 9) throw new Error('Replay budget exhausted'); return ledger.reserve(body); }, record: u => ledger.record(u) },
    onInterrupted: g => interrupted.push(g),
    request: async body => { sent.push([body.model, body.seed]); return { ...response({ calls: [], text: '72' }), model: body.model }; },
  });
  assert.deepEqual(sent.slice(0, 6), models.flatMap(m => names.map(() => [m, 1000])));
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0].attempts.length, 3);
  assert.equal(sent.length, 8);
  for (const m of models) for (const name of names) {
    assert.equal(rows[m][name][0].samples[0].status, 'behavior');
    assert.deepEqual(rows[m][name].map(r => r.samples.map(s => [s.seed, s.terminal])), rows[models[0]][names[0]].map(r => r.samples.map(s => [s.seed, s.terminal])));
  }
});
