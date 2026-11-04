import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { parse } from 'yaml';
const workflow = name => parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
test('only declared calendar deliverables may retain Actions schedules', () => {
  const calendars = new Set(['nightly-checks.yml', 'log-walk.yml']);
  for (const file of readdirSync(new URL('../.github/workflows/', import.meta.url))) {
    if (!file.endsWith('.yml')) continue;
    const document = workflow(file.slice(0, -4));
    if (document.on?.schedule) assert.ok(calendars.has(file), `${file} needs a real event or explicit demand, not observation cron`);
  }
});
test('upstream and release observations require explicit audit demand', () => {
  for (const name of ['acp-adapters', 'reason-upstream', 'release-preflight']) {
    const trigger = workflow(name).on;
    assert.ok(Object.hasOwn(trigger, 'workflow_dispatch'));
    assert.equal(trigger.schedule, undefined);
  }
});
test('live association audit follows a completed successful main release', () => {
  const document = workflow('app-association-drift');
  assert.deepEqual(document.on.workflow_run, { workflows: ['Unified production release'], types: ['completed'], branches: ['main'] });
  assert.match(document.jobs.compare.if, /conclusion == 'success'/);
});
test('nightly results are driven by completion and serialize duplicate run events', () => {
  const document = workflow('nightly-checks-result');
  assert.deepEqual(document.on.workflow_run, { workflows: ['Checks'], types: ['completed'], branches: ['main'] });
  assert.equal(document.concurrency.group, 'nightly-result-${{ github.event.workflow_run.id }}');
  assert.equal(document.concurrency['cancel-in-progress'], false);
  assert.equal(document.jobs.result.steps[0].with.ref, '${{ github.event.repository.default_branch }}');
  assert.match(document.jobs.result.if, /workflow_dispatch/);
  assert.match(document.jobs.result.if, /Nightly Checks /);
});
