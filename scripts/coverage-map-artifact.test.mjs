import assert from 'node:assert/strict';
import test from 'node:test';
import { newestCoverageMap, trustedMapRun } from '../apps/server/scripts/coverage-map-artifact.mjs';

const release = id => ({ id, event: 'workflow_dispatch', path: '.github/workflows/unified-release.yml', head_branch: 'main', head_sha: 'dispatch-head' });
const artifact = id => ({ id, workflow_run: { id } });
const map = (id, commit) => ({ commit, provenance: { kind: 'release', runId: String(id), commit } });

test('newest release map uses embedded release commit, even when dispatch head differs', async () => {
  const downloaded = [];
  const selected = await newestCoverageMap({ artifacts: [artifact(1), artifact(3), artifact(2)],
    run: release, download: a => { downloaded.push(a.id); return map(a.id, 'promoted-rc'); },
    usable: m => m.commit === 'promoted-rc' });
  assert.equal(selected.artifact.id, 3);
  assert.deepEqual(downloaded, [3]);
});

test('ignore PR artifacts, expired maps, foreign provenance and stale maps', async () => {
  const selected = await newestCoverageMap({ artifacts: [artifact(1), artifact(2), artifact(3), artifact(4), { ...artifact(5), expired: true }],
    run: id => id === 4 ? { ...release(id), event: 'pull_request' } : release(id),
    download: a => a.id === 3 ? map(999, 'good') : map(a.id, a.id === 2 ? 'stale' : 'good'),
    usable: m => m.commit === 'good' });
  assert.equal(selected.artifact.id, 1);
  assert.equal(await newestCoverageMap({ artifacts: [], run: release }), undefined);
});

test('manual recovery maps require successful Checks on a PR base or head branch', () => {
  const run = { event: 'workflow_dispatch', path: '.github/workflows/checks.yml', head_branch: 'topic', conclusion: 'success' };
  assert.equal(trustedMapRun(run, { base: 'main', head: 'topic' }), true);
  assert.equal(trustedMapRun(run, { base: 'main', head: 'other' }), false);
  assert.equal(trustedMapRun({ ...run, conclusion: 'failure' }, { head: 'topic' }), false);
  assert.equal(trustedMapRun({ ...release(1), head_branch: 'untrusted' }, {}), false);
});
