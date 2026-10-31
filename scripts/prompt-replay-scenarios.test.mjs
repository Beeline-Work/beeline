import test from 'node:test';
import assert from 'node:assert/strict';
import { replayScenarioResult } from './prompt-replay-scenarios.mjs';
import { CAPABILITY_TOOLS } from '../apps/body/src/minimal-tool-surface.ts';
import { createStub } from './prompt-replay-stub.mjs';
import { gradeNative } from './prompt-subscription-replay.mjs';

test('canonical local app discovery is read-only and operations use only recorded aliases', () => {
  for (const app of ['corner_app', 'workflow', 'onboarding']) {
    const discovered = replayScenarioResult({}, { name: 'app_tool', args: { app: `beeline:${app}` } }, {});
    assert.deepEqual(discovered.result.tools, Object.values(CAPABILITY_TOOLS[app]));
    assert.equal(discovered.boundary, undefined);
  }
  const c = { scenario: { results: [{ call: 'post_repository_card', args: {}, result: { state: 'recorded-only' } }] } };
  assert.equal(replayScenarioResult(c, { name: 'app_tool', args: { app: 'beeline:onboarding', tool: 'repository', args: {} } }, {}).result.state, 'recorded-only');
  const unsupported = replayScenarioResult({}, { name: 'app_tool', args: { app: 'beeline:onboarding', tool: 'repository', args: {} } }, {});
  assert.equal(unsupported.boundary, 'unsupported-operation');
  assert.ok(unsupported.result.error);
});

test('PR reads use recorded facts; merge decisions and arbitrary commands never invent successful writes', () => {
  assert.deepEqual(replayScenarioResult({ scenario: { pr: { number: 42 } } }, { name: 'read', args: { facet: 'pr' } }, {}).result, { number: 42 });
  for (const call of [{ name: 'record_merge_yes', args: { address: 'corner' } }, { name: 'Bash', args: { command: 'touch /tmp/must-not-run' } }]) {
    const result = replayScenarioResult({}, call, {});
    assert.equal(result.boundary, 'unsupported-operation');
    assert.ok(result.result.error);
    assert.equal(result.result.success, undefined);
  }
});

test('unsupported operation is explicitly refused and completed traces use the original rule, including safety assertions', () => {
  const tools = [{ name: 'record_merge_yes', description: 'Record yes', inputSchema: { type: 'object' } }];
  const variant = { mode: 'full' };
  const stub = createStub({ tools, skills: {}, variant, testCase: {} });
  stub.call('record_merge_yes', {});
  const events = [{ type: 'turn.completed' }];
  const allowed = gradeNative({ pass: { call: 'record_merge_yes' } }, stub.trace, events, variant, tools);
  assert.equal(allowed.status, 'behavior');
  assert.equal(allowed.pass, true);
  assert.equal(allowed.results[0].result.recorded, false);
  assert.equal(gradeNative({ pass: { noCall: 'record_merge_yes' } }, stub.trace, events, variant, tools).pass, false);
});
