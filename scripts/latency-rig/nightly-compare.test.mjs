import test from 'node:test';
import assert from 'node:assert/strict';
import { compareNightly, mergedPrs } from './nightly-compare.mjs';
const row = (p95Ms) => ({ kind: 'route', name: 'room', variant: 'warm', samples: 20, p95Ms,
  budgetMs: 450, timingPass: p95Ms < 450, requestPass: true });
const report = (p95Ms) => ({ complete: true, clockCalibrated: true, maxClockUncertaintyMs: 8, rows: [row(p95Ms)] });
test('strict page budget and complete calibrated coverage', () => {
  assert.equal(compareNightly(report(120)).pass, true);
  assert.equal(compareNightly(report(450)).pass, false);
  assert.equal(compareNightly(report(449)).pass, true);
  assert.equal(compareNightly(null).pass, false);
  assert.equal(compareNightly({ rows: [null] }).pass, false);
  assert.equal(compareNightly({ complete: true, rows: [{ ...row(100), budgetMs: undefined }] }).pass, false);
  assert.equal(compareNightly({ ...report(100), complete: false }).pass, false);
  assert.equal(compareNightly({ complete: true, rows: [{ ...row(100), samples: 19 }] }).pass, false);
});
test('uncalibrated or excessively uncertain reports never pass', () => {
  assert.equal(compareNightly({ ...report(100), clockCalibrated: undefined }).pass, false);
  assert.equal(compareNightly({ ...report(100), maxClockUncertaintyMs: 26 }).pass, false);
});
test('PR range includes head, excludes last pass, and spans failed nights', () => {
  const commits = [
    { sha: 'head', subject: 'fix a regression mentioned in (#99) (#5)' }, { sha: 'failed-night', subject: 'Merge pull request #4 from branch' },
    { sha: 'passing', subject: 'old fix (#3)' }, { sha: 'older', subject: 'old (#2)' },
  ];
  assert.deepEqual(mergedPrs(commits, 'passing', 'head'), [5, 4]);
  assert.deepEqual(mergedPrs(commits, 'head', 'head'), []);
  assert.throws(() => mergedPrs(commits.slice(0, 2), 'passing', 'head'));
  assert.throws(() => mergedPrs(commits, 'head', 'passing'));
});
test('over-budget and request failures do not invalidate completed calibrated capture', () => {
  const current = report(500); current.rows[0].requestPass = false;
  const result = compareNightly(current);
  assert.equal(result.capture.pass, true);
  assert.equal(result.budget.pass, false);
  assert.equal(result.contract.pass, false);
  assert.equal(result.pass, false);
  for (const bad of [{ ...current, setupError: 'setup failed' },
    { ...current, rows: [{ ...current.rows[0], timedOutSamples: 1 }] },
    { ...current, rows: [{ ...current.rows[0], samples: undefined }] }])
    assert.equal(compareNightly(bad).capture.pass, false);
});
