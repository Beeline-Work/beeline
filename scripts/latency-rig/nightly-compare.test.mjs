import test from 'node:test';
import assert from 'node:assert/strict';
import { compareNightly, mergedPrs } from './nightly-compare.mjs';
const row = (p95Ms) => ({ kind: 'route', name: 'room', variant: 'warm', samples: 20, p95Ms,
  budgetMs: 450, timingPass: p95Ms < 450, requestPass: true });
const report = (p95Ms) => ({ complete: true, rows: [row(p95Ms)] });
test('strict 20 percent regression and strict page budget', () => {
  assert.equal(compareNightly(report(120), report(100)).pass, true);
  assert.equal(compareNightly(report(120.01), report(100)).pass, false);
  assert.equal(compareNightly(report(450), report(449)).pass, false);
  assert.equal(compareNightly(report(449), null).pass, true);
  assert.equal(compareNightly(null, report(100)).pass, false);
  assert.equal(compareNightly({ rows: [null] }, report(100)).pass, false);
  assert.equal(compareNightly(report(100), { rows: {} }).pass, false);
  assert.equal(compareNightly({ complete: true, rows: [{ ...row(100), budgetMs: undefined }] }, null).pass, false);
  assert.equal(compareNightly({ ...report(100), complete: false }, report(100)).pass, false);
  assert.equal(compareNightly({ complete: true, rows: [{ ...row(100), samples: 19 }] }, report(100)).pass, false);
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
