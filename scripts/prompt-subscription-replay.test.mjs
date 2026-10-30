import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createStub } from './prompt-replay-stub.mjs';
import { loadSplit, gradeNative, summarize, frontier, codexArgs, nativePrompt, runSubscription } from './prompt-subscription-replay.mjs';
import { loadCases, loadSource, toolsFor } from './prompt-cases.ts';

const tools = [
  { name: 'read', description: 'Read scenario facts', inputSchema: { type: 'object' } },
  { name: 'Bash', description: 'Run a shell command', inputSchema: { type: 'object', required: ['command'], properties: { command: { type: 'string' } } } },
  { name: 'order', description: 'Assign one agent', inputSchema: { type: 'object', required: ['address', 'text'], properties: { address: { type: 'string' }, text: { type: 'string' } } } },
];
const variant = { mode: 'deferred', core: ['read'] };

test('split is frozen, disjoint, exhaustive, and held-out execution requires final selection', async () => {
  const split = loadSplit(loadCases());
  assert.equal(split.tune.length, 54);
  assert.equal(split.heldout.length, 23);
  assert.equal(split.tune.some(id => split.heldout.includes(id)), false);
  await assert.rejects(runSubscription(['--model', 'gpt-6-luna', '--partition', 'heldout']), /frozen --selection/);
});

test('stub loads definitions, keeps them per sample, and never executes a proposed shell command', () => {
  const folder = mkdtempSync(join(tmpdir(), 'replay-stub-test-'));
  try {
    const marker = join(folder, 'must-not-exist');
    const command = `touch ${marker}`;
    const fixture = { tools, skills: {}, variant, testCase: { scenario: { results: [{ call: 'Bash', args: { command }, result: { exitCode: 0, stdout: 'recorded only' } }] } } };
    const stub = createStub(fixture);
    assert.deepEqual(stub.listing().map(t => t.name), ['read', 'find_tools']);
    assert.equal(stub.call('find_tools', { query: 'Bash' }).definitions[0].name, 'Bash');
    assert.equal(stub.listing().some(t => t.name === 'Bash'), true);
    assert.equal(stub.call('Bash', { command }).stdout, 'recorded only');
    assert.equal(existsSync(marker), false);
    const fresh = createStub(fixture);
    assert.equal(fresh.call('Bash', { command }).error, 'Called an unloaded tool');
    assert.equal(fresh.trace.calls.length, 0);
    assert.ok(stub.listing().every(t => t.annotations.readOnlyHint && !t.annotations.openWorldHint));
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('stub respects terminal actions and native grading preserves safety failures and incomplete facts', () => {
  const fixture = { tools, skills: {}, variant, testCase: { scenario: {} } };
  const stub = createStub(fixture);
  stub.call('find_tools', { query: 'order' });
  stub.call('order', { address: 'corner', text: 'Do it' });
  assert.equal(stub.trace.terminal, 'order');
  stub.call('read', {});
  assert.equal(stub.trace.failure, 'Call after terminal boundary');
  const events = [{ type: 'turn.completed', usage: { input_tokens: 50 } }];
  assert.equal(gradeNative({ pass: { call: 'order' } }, stub.trace, events, variant, tools).pass, false);
  const fresh = createStub(fixture);
  fresh.call('read', {});
  assert.equal(gradeNative({ pass: { call: 'read' } }, fresh.trace, events, variant, tools).status, 'incomplete');
  const forbidden = createStub(fixture);
  forbidden.call('Bash', { command: 'do not run' });
  assert.equal(gradeNative({ pass: { noCall: 'Bash' } }, forbidden.trace, events, variant, tools).pass, false);
});

test('all native prompts preserve the scenario but contain neither rule expectations nor JSON call instructions', async () => {
  const source = await loadSource(process.cwd());
  const split = loadSplit(loadCases());
  const config = JSON.parse(readFileSync('scripts/prompt-variants/r0-deferred.json'));
  for (const c of loadCases().filter(c => split.tune.includes(c.id))) {
    const prompt = nativePrompt(source, c, config, toolsFor(source, c), 1000);
    assert.ok(prompt.includes('## System prompt'));
    assert.ok(prompt.includes(c.turn.task.body));
    assert.equal(prompt.includes('Return only the next batch'), false);
    assert.equal(prompt.includes('input_schema'), false);
  }
});

test('usage and frontier exclude unscored samples and reject per-model regressions', () => {
  const result = summarize([{ status: 'behavior', pass: true, inputTokens: 10, searchCalls: 1 }, { status: 'incomplete', pass: null, inputTokens: null, searchCalls: 0 }]);
  assert.equal(result.passRate, 1);
  assert.equal(result.unscored, 1);
  assert.equal(result.p90InputTokens, 10);
  const a = { name: 'a', complete: true, regressionModels: [], meanPassRate: .8, medianInputTokens: 100 };
  const b = { ...a, name: 'b', meanPassRate: .9, medianInputTokens: 90 };
  const c = { ...b, name: 'c', medianInputTokens: 80, regressionModels: ['luna'] };
  assert.deepEqual(frontier([a, b, c]).map(v => v.name), ['b']);
  const args = codexArgs('gpt-6-luna', '/tmp/cwd', '/tmp/fixture', '/tmp/trace');
  assert.ok(args.includes('forced_login_method="chatgpt"'));
  assert.ok(args.includes('shell_tool'));
  assert.equal(args.some(a => /grant-token|api.key/i.test(a)), false);
});

test('real stdio MCP handshake advertises only core tools then refreshes after search', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'replay-protocol-'));
  const fixture = join(folder, 'fixture.json');
  writeFileSync(fixture, JSON.stringify({ tools, skills: {}, variant, testCase: {} }));
  const child = spawn('node', ['--import', 'tsx', 'scripts/prompt-replay-stub.mjs', fixture, join(folder, 'trace.json')]);
  const lines = createInterface({ input: child.stdout });
  const responses = [];
  lines.on('line', line => { const message = JSON.parse(line); if (message.id !== undefined) responses.push(message); });
  child.stdin.end([
    { id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { id: 1, method: 'tools/list' },
    { id: 2, method: 'tools/call', params: { name: 'find_tools', arguments: { query: 'order' } } },
    { id: 3, method: 'tools/list' },
  ].map(q => JSON.stringify(q)).join('\n') + '\n');
  try {
    assert.equal(await new Promise(resolve => child.on('close', resolve)), 0);
    assert.equal(responses[0].result.capabilities.tools.listChanged, true);
    assert.equal(responses[1].result.tools.some(t => t.name === 'order'), false);
    assert.equal(responses[3].result.tools.some(t => t.name === 'order'), true);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
