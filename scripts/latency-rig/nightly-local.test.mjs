import test from 'node:test';
import assert from 'node:assert/strict';
import { assessNight } from './nightly-local.mjs';
const row = (p95Ms) => ({ kind: 'route', name: 'room', variant: 'warm', samples: 20,
  budgetMs: 450, p95Ms, timingPass: p95Ms < 450, requestPass: true });
const report = (p95Ms, commit = 'head') => ({ commit, complete: true, clockCalibrated: true, maxClockUncertaintyMs: 8, rows: [row(p95Ms)] });
const commits = [{ sha: 'head', subject: 'new (#12)' }, { sha: 'bad', subject: 'failed night (#11)' }, { sha: 'base', subject: 'old (#10)' }];
const input = { night: '2026-10-20', head: 'head', commits, baseline: report(100, 'base') };
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
  const rerun = report(120);
  const result = assessNight({ ...input, current: report(450), rerun, rerunAttempted: true, hostLoad: [8, 4, 3] });
  assert.equal(result.pass, true);
  assert.equal(result.shouldAlert, false);
  assert.equal(result.passingReport, rerun);
  assert.deepEqual(result.hostLoad, [8, 4, 3]);
});
test('strict budget and regression boundaries survive rerun', () => {
  for (const p95 of [120.01, 450]) {
    const result = assessNight({ ...input, current: report(p95), rerun: report(p95), rerunAttempted: true });
    assert.equal(result.shouldAlert, true);
  }
  assert.equal(assessNight({ ...input, current: report(120) }).pass, true);
});
test('a stale capture or incomplete PR range cannot advance the baseline', () => {
  assert.equal(assessNight({ ...input, current: report(100, 'yesterday') }).pass, false);
  assert.equal(assessNight({ ...input, current: report(100, 'yesterday'), rerun: report(100), rerunAttempted: true }).pass, true);
  const incomplete = assessNight({ ...input, current: report(100), commits: commits.slice(0, 1) });
  assert.equal(incomplete.pass, false);
  assert.match(incomplete.text, /PR range.*unavailable/);
});

import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
test('CLI retains the last pass on skipped runs, advances only on pass, and records malformed inputs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-nightly-'));
  try {
    const base = join(dir, 'base.json');
    const current = join(dir, 'current.json');
    const output = join(dir, 'night.json');
    const range = join(dir, 'range.json');
    const head = 'a'.repeat(40), old = 'b'.repeat(40);
    const original = JSON.stringify(report(100, old));
    await writeFile(base, original);
    await writeFile(range, JSON.stringify([{ sha: head, subject: 'new (#12)' }, { sha: old, subject: 'base (#11)' }]));
    const run = (...extra) => spawnSync(process.execPath, [fileURLToPath(new URL('./nightly-local.mjs', import.meta.url)),
      '--baseline', base, '--current', current, '--commits', range, '--head', head, '--out', output, ...extra], { encoding: 'utf8' });
    assert.equal(run().status, 2);
    assert.equal(run('--rerun', 'missing.json').status, 1);
    assert.equal(await readFile(base, 'utf8'), original);
    assert.equal(JSON.parse(await readFile(output)).shouldAlert, true);
    await writeFile(current, '{invalid');
    assert.equal(run('--rerun', 'missing.json').status, 1);
    assert.match(JSON.parse(await readFile(output)).text, /New report could not be read/);
    assert.equal(await readFile(base, 'utf8'), original);
    await writeFile(current, JSON.stringify(report(100, head)));
    assert.equal(run().status, 0);
    assert.equal(JSON.parse(await readFile(base)).commit, head);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
