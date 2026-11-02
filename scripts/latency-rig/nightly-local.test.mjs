import test from 'node:test';
import assert from 'node:assert/strict';
import { assessNight } from './nightly-local.mjs';
const row = (p95Ms) => ({ kind: 'route', name: 'room', variant: 'warm', samples: 20,
  budgetMs: 450, p95Ms, timingPass: p95Ms < 450, requestPass: true });
const report = (p95Ms, commit = 'head') => ({ commit, complete: true, clockCalibrated: true, maxClockUncertaintyMs: 8, rows: [row(p95Ms)] });
const commits = [{ sha: 'head', subject: 'new (#12)' }, { sha: 'bad', subject: 'failed night (#11)' }, { sha: 'base', subject: 'old (#10)' }];
const hostLoad = [{ load: [2, 3, 4], cpus: 20 }, { load: [4, 3, 4], cpus: 20 }];
const input = { hostLoad, night: '2026-10-20', head: 'head', commits, baseline: report(100, 'base') };
test('one rerun precedes an alert, including skipped captures', () => {
  const first = assessNight({ ...input, current: undefined });
  assert.equal(first.needsRerun, true);
  assert.equal(first.shouldAlert, false);
  const failed = assessNight({ ...input, current: undefined, rerunAttempted: true });
  assert.equal(failed.shouldAlert, true);
  assert.deepEqual(failed.prs, [12, 11]);
  assert.equal(failed.passingReport, undefined);
});
test('a passing rerun settles host noise without alerting or keeping the failed baseline', () => {
  const rerun = report(110);
  const result = assessNight({ ...input, current: report(450), rerun, rerunAttempted: true, hostLoad, firstHostLoad: [{ load: [23, 0, 0], cpus: 20 }] });
  assert.equal(result.pass, true);
  assert.equal(result.shouldAlert, false);
  assert.equal(result.passingReport, rerun);
  assert.deepEqual(result.hostLoad, hostLoad);
  assert.equal(result.firstAttempt.contended, true);
  assert.equal(result.contended, false);
});
test('strict budget and regression boundaries survive rerun', () => {
  for (const p95 of [120.01, 450]) {
    const result = assessNight({ ...input, current: report(p95), rerun: report(p95), rerunAttempted: true });
    assert.equal(result.shouldAlert, true);
  }
  assert.equal(assessNight({ ...input, current: report(110) }).pass, true);
});
test('stale captures and incomplete PR ranges fail the overall verdict', () => {
  assert.equal(assessNight({ ...input, current: report(100, 'yesterday') }).pass, false);
  assert.equal(assessNight({ ...input, current: report(100, 'yesterday'), rerun: report(100), rerunAttempted: true }).pass, true);
  const incomplete = assessNight({ ...input, current: report(100), commits: commits.slice(0, 1) });
  assert.equal(incomplete.pass, false);
  assert.equal(incomplete.capture.pass, true);
  assert.match(incomplete.text, /PR range.*unavailable/);
});

import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
test('CLI preserves last-pass on skipped runs and records malformed inputs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-nightly-'));
  try {
    const base = join(dir, 'base.json');
    const current = join(dir, 'current.json');
    const output = join(dir, 'night.json');
    const range = join(dir, 'range.json'), load = join(dir, 'load.json');
    await writeFile(load, JSON.stringify(hostLoad));
    const head = 'a'.repeat(40), old = 'b'.repeat(40);
    const original = JSON.stringify(report(100, old));
    await writeFile(base, original);
    await writeFile(range, JSON.stringify([{ sha: head, subject: 'new (#12)' }, { sha: old, subject: 'base (#11)' }]));
    let invocation = 0;
    const run = (...extra) => spawnSync(process.execPath, [fileURLToPath(new URL('./nightly-local.mjs', import.meta.url)),
      '--load', load, '--run-id', `test-${++invocation}`, '--baseline', base, '--current', current, '--commits', range, '--head', head, '--out', output, ...extra], { encoding: 'utf8' });
    assert.equal(run().status, 2);
    assert.equal(run('--rerun', 'missing.json').status, 1);
    assert.equal(await readFile(base, 'utf8'), original);
    assert.equal(JSON.parse(await readFile(output)).shouldAlert, true);
    await writeFile(current, '{invalid');
    assert.equal(run('--rerun', 'missing.json').status, 1);
    assert.match(JSON.parse(await readFile(output)).text, /New report could not be read/);
    assert.equal(await readFile(base, 'utf8'), original);
    await writeFile(current, JSON.stringify(report(100, head)));
    const passing = run();
    assert.equal(passing.status, 0);
    assert.match(passing.stdout, /route\/room\/warm: PASS n=20 .*p95=100ms target<450ms/);
    assert.equal(JSON.parse(await readFile(base)).commit, head);
    await writeFile(current, JSON.stringify(report(450, head)));
    const failing = run('--rerun', current);
    assert.equal(failing.status, 1);
    assert.match(failing.stdout, /route\/room\/warm: FAIL n=20 .*p95=450ms target<450ms/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('nightly verdict carries the chosen capture push measurement limits', () => {
  const result = assessNight({ current: { rows: [{ variant: 'push-unseen-1' }],
    pushMeasurement: { measured: 'Activity entry to target text native frame commit',
      nativeResponsePhase: 'absent', excluded: 'foreground JS in-app notice' } }, head: 'abc', night: 'test' });
  assert.match(result.text, /native-response phase absent/);
  assert.match(result.text, /Unmeasured: foreground JS in-app notice/);
});
test('capture, budget, contract and regression stay independent and noisy captures are not compared', () => {
  const overBudget = assessNight({ ...input, baseline: undefined, current: report(500) });
  assert.equal(overBudget.capture.pass, true);
  assert.equal(overBudget.budget.pass, false);
  assert.equal(overBudget.contract.pass, true);
  assert.equal(overBudget.regression.pass, true);
  assert.deepEqual(overBudget.load, { mean: 3, max: 4, cpus: 20 });
  for (const [current, load, status] of [
    [report(500), [{ load: [23, 0, 0], cpus: 20 }], 'contended'],
    [{ ...report(500), complete: false }, hostLoad, 'invalid'],
    [{ ...report(500), clockCalibrated: false }, hostLoad, 'invalid'],
    [report(500), [], 'missing-load'],
  ]) {
    const result = assessNight({ ...input, current, hostLoad: load });
    assert.equal(result.regression.pass, null);
    assert.equal(result.regression.status, status);
    assert.deepEqual(result.regression.rows, []);
    assert.equal(result.pass, false);
  }
  const edge = assessNight({ ...input, current: report(100), hostLoad: [{ load: [10, 0, 0], cpus: 20 }] });
  assert.equal(edge.contended, false);
});
test('contract failure creates a fix order without waiting for consecutive regression', () => {
  const current = report(100); current.rows[0].requestPass = false;
  const result = assessNight({ ...input, current, rerun: current, rerunAttempted: true });
  assert.equal(result.capture.pass, true);
  assert.equal(result.budget.pass, true);
  assert.equal(result.contract.pass, false);
  assert.equal(result.regression.pass, true);
  assert.deepEqual(result.fixOrder.reasons, ['request-contract']);
  assert.equal(result.fixOrder.cases[0].key, 'route/room/warm');
  assert.deepEqual(result.fixOrder.range, { base: 'base', head: 'head', prs: [12, 11], available: true });
});
test('two consecutive eligible regressions write exactly one replayable fix order across failed budgets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fix-order-'));
  const base = 'b'.repeat(40), bad = 'c'.repeat(40), head = 'a'.repeat(40);
  const capture = (value, commit) => ({ ...report(value, commit), rows: [row(value),
    { ...row(value / 5), kind: 'tap', name: 'send-text', budgetMs: 150, timingPass: value / 5 < 150, slowestPhase: 'native-frame' }] });
  const journal = [];
  const record = (day, current, load = hostLoad) => {
    const night = `2026-10-${day}`, runId = `run-${day}`;
    const result = assessNight({ current, rerun: current, rerunAttempted: true, head: current.commit,
      hostLoad: load, night, runId, history: journal,
      commits: [{ sha: head, subject: 'new (#12)' }, { sha: bad, subject: 'first regression (#11)' }, { sha: base, subject: 'base (#10)' }] });
    journal.push({ ...result, final: true, runId, report: current });
    return result;
  };
  try {
    record('01', capture(500, base)); // Valid, already over budget, with no passing baseline.
    assert.equal(record('02', capture(700, bad)).fixOrder, undefined);
    record('03', capture(2000, bad), [{ load: [23, 0, 0], cpus: 20 }]);
    record('04', { ...capture(2000, bad), complete: false });
    await writeFile(join(dir, 'history.jsonl'), journal.map((item) => JSON.stringify(item)).join('\n') + '\n');
    const current = capture(710, head);
    current.rows[0].requestPass = false; // Both triggers still produce just one order.
    const capturePath = join(dir, 'report.json'), load = join(dir, 'load.json'), range = join(dir, 'commits.json');
    await writeFile(capturePath, JSON.stringify(current));
    await writeFile(load, JSON.stringify(hostLoad));
    await writeFile(range, JSON.stringify([{ sha: head, subject: 'new (#12)' }, { sha: bad, subject: 'regression (#11)' }, { sha: base, subject: 'old (#10)' }]));
    const run = (rerun = true) => spawnSync(process.execPath, [fileURLToPath(new URL('./nightly-local.mjs', import.meta.url)),
      '--current', capturePath, ...(rerun ? ['--rerun', capturePath] : []), '--load', load, '--commits', range,
      '--baseline', join(dir, 'last-pass.json'), '--out', join(dir, 'nightly.json'), '--head', head,
      '--run-id', 'regressed', '--night', '2026-10-05'], { encoding: 'utf8' });
    assert.equal(run(false).status, 2);
    await assert.rejects(readFile(join(dir, 'fix-order.json')), { code: 'ENOENT' });
    assert.equal(run().status, 1);
    const order = JSON.parse(await readFile(join(dir, 'fix-order.json')));
    assert.deepEqual(order.reasons, ['request-contract', 'consecutive-regression']);
    assert.deepEqual(order.range, { base, head, prs: [12, 11], available: true });
    assert.equal(order.cases.length, 2);
    assert.equal(order.cases[0].p95Ms, 710);
    assert.equal(order.cases[0].firstP95Ms, 500);
    assert.equal(order.cases[0].medianP95Ms, 600);
    assert.equal(order.cases[1].slowestPhase, 'native-frame');
    const history = await readFile(join(dir, 'history.jsonl'), 'utf8');
    await rm(join(dir, 'fix-order.json')); // Replay repairs a lost artifact without another order/journal entry.
    assert.equal(run().status, 1);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'fix-order.json'))), order);
    assert.equal(await readFile(join(dir, 'history.jsonl'), 'utf8'), history);
    assert.equal(run(false).status, 2); // A replay of the provisional attempt retains the final order.
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'fix-order.json'))), order);
    assert.equal((await readdir(dir)).filter((name) => name.startsWith('fix-order')).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
