import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRunners, loadPressure, planRouting, routeRunners } from './ci-runner-routing.mjs';
const runner = (name, role, changes = {}) => ({ name, status: 'online', busy: false,
  labels: ['self-hosted', 'Linux', 'X64', 'beeline-ci', `beeline-ci-${role}`].map(name => ({ name })), ...changes });
const pool = () => [runner('beeline-ci-squire-01', 'control'),
  ...Array.from({ length: 8 }, (_, i) => runner(`beeline-ci-squire-0${i + 2}`, 'heavy')),
  runner('beeline-ci-squire-10', 'workspace')];
const flags = { code: 'true', serverSuite: 'true', nativeFingerprint: 'true', mobileSuite: 'true', mobileExportReachability: 'true' };

test('saturated or unavailable squire sends every job and all eight shards to hosted runners', () => {
  for (const runners of [pool().map(r => ({ ...r, busy: true })), pool().map(r => ({ ...r, status: 'offline' })), []]) {
    const plan = routeRunners({ runners, flags });
    assert.deepEqual(plan.idle, { control: 0, heavy: 0, workspace: 0 });
    assert.ok(plan.placements.every(p => p.target.length === 1 && p.target[0] === 'ubuntu-latest'));
    assert.deepEqual(plan.serverMatrix.map(r => r.shard), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.ok(plan.serverMatrix.every(r => r.hosted));
  }
});

test('one snapshot never allocates an idle role slot twice and always overflows excess jobs', () => {
  const plan = routeRunners({ runners: pool(), flags });
  assert.deepEqual(plan.idle, { control: 1, heavy: 8, workspace: 1 });
  const local = plan.placements.filter(p => p.observedIdleRunner);
  assert.equal(local.length, 10);
  assert.equal(new Set(local.map(p => p.observedIdleRunner)).size, 10);
  assert.ok(plan.targets.prepare.includes('beeline-ci-control'));
  assert.ok(plan.targets.mobile.includes('beeline-ci-workspace'));
  assert.ok(plan.targets.typecheck.includes('beeline-ci-heavy'));
  assert.equal(plan.serverMatrix.filter(r => r.hosted).length, 2);
  for (const p of local) assert.deepEqual(p.target, ['self-hosted', 'Linux', 'X64', 'beeline-ci', `beeline-ci-${p.role}`]);
});

test('unused coarse suites do not reserve server or mobile slots; routing never removes shard rows', () => {
  const plan = routeRunners({ runners: pool(), flags: {} });
  assert.equal(plan.placements.filter(p => p.role === 'heavy' && p.observedIdleRunner).length, 2);
  assert.equal(plan.serverMatrix.length, 8);
  assert.ok(plan.serverMatrix.every(r => r.hosted));
  assert.deepEqual(plan.targets.mobile, ['ubuntu-latest']);
});

test('production, ambiguous, duplicate, wrong-platform and unverified runners are never allocated', () => {
  const base = runner('beeline-ci-squire-02', 'heavy');
  const plan = routeRunners({ flags, runners: [base, base,
    runner('production-host', 'heavy'), runner('beeline-ci-squire-03', 'heavy', { busy: undefined }),
    runner('beeline-ci-squire-04', 'heavy', { labels: base.labels.filter(l => l.name !== 'X64') }),
    runner('beeline-ci-squire-05', 'heavy', { labels: [...base.labels, { name: 'beeline-ci-control' }] }),
  ] });
  assert.equal(plan.placements.filter(p => p.observedIdleRunner).length, 1);
  assert.equal(plan.idle.heavy, 1);
});

test('merge-group and manual work retain hosted placement despite a fully idle inventory', () => {
  for (const event of ['merge_group', 'workflow_dispatch']) {
    const plan = routeRunners({ event, runners: pool(), flags });
    assert.ok(plan.placements.every(p => p.target[0] === 'ubuntu-latest'));
  }
});

test('API denial, malformed inventory and truncated pages fail open to hosted execution', async () => {
  for (const request of [async () => { throw Error('HTTP 403'); }, async () => ({}),
    async () => ({ total_count: 2, runners: [] })]) {
    const plan = await planRouting({ request, repository: 'Beeline-Work/beeline', flags });
    assert.ok(plan.inventoryError);
    assert.ok(plan.placements.every(p => p.target[0] === 'ubuntu-latest'));
  }
});

test('inventory pagination includes later free slots and rejects invalid repository paths', async () => {
  const calls = [];
  const loaded = await loadRunners({ repository: 'Beeline-Work/beeline', request: async path => {
    calls.push(path);
    return path.endsWith('page=1') ? { total_count: 2, runners: [runner('beeline-ci-squire-02', 'heavy', { busy: true })] }
      : { total_count: 2, runners: [runner('beeline-ci-squire-03', 'heavy')] };
  } });
  assert.equal(calls.length, 2);
  assert.equal(routeRunners({ runners: loaded, flags }).idle.heavy, 1);
  await assert.rejects(loadRunners({ repository: '../other', request: async () => {} }));
});


test('older preparing workflows cannot reserve idle capacity before requesting Squire jobs', async () => {
  const reservations = await loadPressure({ repository: 'Beeline-Work/beeline', runId: 3, request: async path => {
    if (path.includes('/workflows/')) return { total_count: 2, workflow_runs: [{ id: 2, status: 'queued' }, { id: 3, status: 'in_progress' }] };
    return { total_count: 1, jobs: [{ name: 'Detect changes', status: 'in_progress' }] };
  } });
  assert.deepEqual(reservations, { heavy: 0, control: 0, workspace: 0 });
  const plan = routeRunners({ runners: pool(), flags, reservations });
  assert.equal(plan.serverMatrix.filter(row => !row.hosted).length, 6);
  assert.ok(plan.targets.typecheck.includes('beeline-ci-heavy'));
  assert.ok(plan.targets.mobile.includes('beeline-ci-workspace'));
});

test('queued role requests count even when API timestamps imply they already started', async () => {
  const result = await loadPressure({ repository: 'Beeline-Work/beeline', runId: 3, request: async path => {
    if (path.includes('/workflows/')) return { total_count: 2, workflow_runs: [{ id: 2, status: 'queued' }, { id: 3, status: 'queued' }] };
    return { total_count: 3, jobs: [
      { name: 'TYPECHECK', status: 'queued', runner_id: 0, runner_name: '', labels: ['beeline-ci-heavy'], started_at: 'already populated' },
      { name: 'Prepare workspace caches', status: 'completed' }, { name: 'MOBILE SUITE', status: 'completed' },
    ] };
  } });
  assert.deepEqual(result, { heavy: 1, control: 0, workspace: 0 });
});

test('stale active-run inventory refuses to place new work on uncertain squire capacity', async () => {
  await assert.rejects(loadPressure({ repository: 'Beeline-Work/beeline', runId: 3,
    request: async () => ({ total_count: 0, workflow_runs: [] }) }), /not current/);
});


test('older hosted runs and empty job graphs cannot hold Squire capacity', async () => {
  for (const jobs of [[], [
    { name: 'Detect changes', status: 'in_progress', labels: ['ubuntu-latest'] },
    { name: 'TYPECHECK', status: 'queued', labels: ['ubuntu-latest'] },
  ]]) {
    const reservations = await loadPressure({ repository: 'Beeline-Work/beeline', runId: 3, request: async path => {
      if (path.includes('/workflows/')) return { total_count: 2, workflow_runs: [{ id: 2, status: 'in_progress' }, { id: 3, status: 'queued' }] };
      return { total_count: jobs.length, jobs };
    } });
    assert.deepEqual(reservations, { heavy: 0, control: 0, workspace: 0 });
    assert.equal(routeRunners({ runners: pool(), flags, reservations }).serverMatrix.filter(row => !row.hosted).length, 6);
  }
});

test('only actual unassigned queued Squire jobs consume observed capacity', async () => {
  const reservations = await loadPressure({ repository: 'Beeline-Work/beeline', runId: 3, request: async path => {
    if (path.includes('/workflows/')) return { total_count: 3, workflow_runs: [{ id: 2, status: 'in_progress' }, { id: 3, status: 'queued' }, { id: 4, status: 'queued' }] };
    assert.ok(path.includes('/runs/2/'), 'current and newer runs cannot reserve slots');
    const jobs = [
      { name: 'SERVER SUITE SHARD 1/8', status: 'queued', labels: ['beeline-ci-heavy'], runner_id: 0 },
      { name: 'TYPECHECK', status: 'queued', labels: ['ubuntu-latest'] },
      { name: 'SHARED PACKAGE TESTS', status: 'in_progress', labels: ['beeline-ci-heavy'], runner_name: 'beeline-ci-squire-03' },
      { name: 'DEAD CODE', status: 'completed', labels: ['beeline-ci-heavy'] },
      { name: 'NATIVE FINGERPRINT', status: 'queued', labels: ['beeline-ci-heavy'], runner_id: 123 },
      { name: 'Prepare workspace caches', status: 'queued', labels: ['beeline-ci-control'] },
    ];
    return { total_count: jobs.length, jobs };
  } });
  assert.deepEqual(reservations, { heavy: 1, control: 1, workspace: 0 });
  const plan = routeRunners({ runners: pool(), flags, reservations });
  assert.deepEqual(plan.reserved, reservations);
  assert.equal(plan.serverMatrix.filter(row => !row.hosted).length, 5);
  assert.deepEqual(plan.targets.prepare, ['ubuntu-latest']);
});
