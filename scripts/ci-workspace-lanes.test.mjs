import assert from 'node:assert/strict';
import test from 'node:test';
import { runWorkspaceChecks, workspaceChecks } from './run-ci-workspace-checks.mjs';

test('workspace lanes run at most two checks and preserve failures independently', async () => {
  const active = new Set();
  let maximum = 0;
  const starts = [];
  const results = await runWorkspaceChecks(Object.fromEntries(Object.keys(workspaceChecks).map(name => [name, true])), async name => {
    active.add(name);
    starts.push(name);
    maximum = Math.max(maximum, active.size);
    if (active.size === 2) assert.ok(active.has('mobile-suite'), 'only mobile may overlap another check');
    await new Promise(resolve => setTimeout(resolve, name === 'mobile-suite' ? 30 : 5));
    active.delete(name);
    return name === 'dead-code' ? 1 : 0;
  });
  assert.equal(maximum, 2);
  assert.deepEqual(starts, ['mobile-suite', 'typecheck', 'dead-code', 'native-fingerprint', 'mobile-export-reachability']);
  assert.equal(results['dead-code'], 'failure');
  assert.equal(results['mobile-export-reachability'], 'success', 'a failed check cannot hide later checks');
  assert.equal(results['mobile-suite'], 'success');
});

test('disabled checks never execute and runner exceptions fail their verdict closed', async () => {
  const calls = [];
  const results = await runWorkspaceChecks({ typecheck: true }, async name => {
    calls.push(name);
    throw new Error('command unavailable');
  });
  assert.deepEqual(calls, ['typecheck']);
  assert.equal(results.typecheck, 'failure');
  for (const name of Object.keys(workspaceChecks).filter(name => name !== 'typecheck')) assert.equal(results[name], 'skipped');
});
