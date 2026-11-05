import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DEFAULT_HOSTED_CAPACITY, loadHostedCapacity, loadRunners, loadPressure, planRouting, routeRunners } from './ci-runner-routing.mjs';
const repository = 'Beeline-Work/beeline';
const runner = (name, role, changes = {}) => ({ name, status: 'online', busy: false,
  labels: ['self-hosted', 'Linux', 'X64', 'beeline-ci', 'beeline-ci-balanced', `beeline-ci-${role}`].map(name => ({ name })), ...changes });
const pool = () => [runner('beeline-ci-squire-01', 'control'),
  ...Array.from({ length: 6 }, (_, i) => runner(`beeline-ci-squire-0${i + 2}`, 'heavy')),
  runner('beeline-ci-squire-10', 'workspace')];
const flags = { code: 'true', serverSuite: 'true', nativeFingerprint: 'true', mobileSuite: 'true', mobileExportReachability: 'true' };
const counts = (queued = 0, inProgress = 0) => ({ queued, inProgress });
const emptyPressure = () => ({ control: counts(), heavy: counts(), workspace: counts(), hosted: counts() });
const active = plan => plan.placements.filter(p => p.enabled);
const isSquire = target => target.includes('self-hosted');

// Jobs from every active workflow, not just older Checks runs. Returning each
// run in several status snapshots also exercises cross-snapshot deduplication.
const pressureRequest = (jobsByRun = { 3: [] }) => async path => {
  if (path.includes('/actions/runs?')) return { total_count: Object.keys(jobsByRun).length,
    workflow_runs: Object.keys(jobsByRun).map(id => ({ id: Number(id), status: 'in_progress' })) };
  const id = path.match(/\/runs\/(\d+)\/jobs/)[1];
  const jobs = jobsByRun[id];
  assert.ok(jobs, `Unexpected job inventory: ${path}`);
  return { total_count: jobs.length, jobs };
};

test('idle Squire wins ties and uses online capacity, including busy listeners', () => {
  const plan = routeRunners({ runners: pool(), flags });
  assert.deepEqual(plan.capacity, { control: 1, heavy: 6, workspace: 1, hosted: DEFAULT_HOSTED_CAPACITY });
  assert.deepEqual(plan.idle, { control: 1, heavy: 6, workspace: 1 });
  assert.ok(isSquire(plan.targets.prepare));
  assert.ok(isSquire(plan.targets.typecheck));
  assert.ok(isSquire(plan.targets.mobile));
  for (const p of active(plan).filter(p => isSquire(p.target))) {
    assert.deepEqual(p.target, ['self-hosted', 'Linux', 'X64', 'beeline-ci', 'beeline-ci-balanced', `beeline-ci-${p.role}`]);
    assert.ok(p.squireWait <= p.hostedWait);
  }
});

test('saturated Squire with a deep queue and empty hosted pool chooses hosted', () => {
  const plan = routeRunners({ runners: pool().map(r => ({ ...r, busy: true })), flags,
    pressure: { heavy: counts(80, 6), control: counts(10, 1), workspace: counts(10, 1) } });
  assert.deepEqual(plan.idle, { control: 0, heavy: 0, workspace: 0 });
  assert.equal(plan.capacity.heavy, 6);
  assert.ok(active(plan).every(p => !isSquire(p.target)));
});

test('deep hosted queue chooses briefly busy Squire, including control selection and verdicts', () => {
  const plan = routeRunners({ runners: pool().map(r => ({ ...r, busy: true })), flags,
    pressure: { hosted: counts(200, 20), heavy: counts(0, 6), control: counts(0, 1), workspace: counts(0, 1) } });
  assert.ok(active(plan).every(p => isSquire(p.target)));
  assert.ok(isSquire(plan.targets.serverSelection));
  assert.ok(isSquire(plan.targets.serverSuite));
  // API running counts and busy inventory describe the same six jobs.
  assert.equal(plan.placements.find(p => p.job === 'typecheck').squireWait, 1);
});

test('one run spreads its enabled jobs and server shards across both pools', () => {
  const plan = routeRunners({ runners: pool(), flags });
  assert.ok(plan.serverMatrix.some(r => r.hosted));
  assert.ok(plan.serverMatrix.some(r => !r.hosted));
  assert.deepEqual(plan.serverMatrix.map(r => r.shard), [1, 2, 3, 4, 5, 6, 7, 8]);
  const heavy = active(plan).filter(p => p.role === 'heavy');
  assert.equal(heavy[0].squireWait, 0);
  assert.equal(heavy[1].squireWait, 1 / 6);
  assert.equal(heavy[2].squireWait, 1 / 6);
  assert.equal(heavy[1].target[0], 'ubuntu-latest');
  assert.ok(isSquire(heavy[2].target));
  assert.equal(heavy[2].hostedWait, heavy[1].hostedWait + 1 / DEFAULT_HOSTED_CAPACITY);
});

test('busy runner inventory supplies a running-job floor when Actions has not caught up', () => {
  const plan = routeRunners({ runners: [runner('beeline-ci-squire-02', 'heavy', { busy: true })] });
  assert.equal(plan.placements.find(p => p.job === 'typecheck').squireWait, 1);
  assert.deepEqual(plan.targets.typecheck, ['ubuntu-latest']);
});

test('hosted concurrency controls the comparison rather than a fixed hosted preference', () => {
  const options = { runners: [runner('beeline-ci-squire-02', 'heavy', { busy: true })],
    pressure: { hosted: counts(20) } };
  assert.ok(isSquire(routeRunners({ ...options, hostedCapacity: 20 }).targets.typecheck));
  assert.deepEqual(routeRunners({ ...options, hostedCapacity: 60 }).targets.typecheck, ['ubuntu-latest']);
});

test('unused coarse suites consume neither pool and never remove shard rows', () => {
  const plan = routeRunners({ runners: pool(), flags: {} });
  assert.equal(active(plan).length, 3); // preparation, typecheck, shared
  assert.equal(plan.serverMatrix.length, 8);
  assert.ok(plan.serverMatrix.every(r => r.hosted));
  assert.deepEqual(plan.targets.mobile, ['ubuntu-latest']);
  assert.equal(plan.placements.find(p => p.job === 'typecheck').hostedWait, 0);
});

test('offline or missing Squire always uses hosted', () => {
  for (const runners of [pool().map(r => ({ ...r, status: 'offline' })), []]) {
    const plan = routeRunners({ runners, flags, pressure: { hosted: counts(1000) } });
    assert.ok(plan.placements.every(p => p.target[0] === 'ubuntu-latest'));
  }
});

test('production, ambiguous, duplicate, wrong-platform and unverified runners supply no capacity', () => {
  const base = runner('beeline-ci-squire-02', 'heavy');
  const plan = routeRunners({ flags, runners: [base, base,
    runner('production-host', 'heavy'), runner('beeline-ci-squire-03', 'heavy', { busy: undefined }),
    runner('beeline-ci-squire-04', 'heavy', { labels: base.labels.filter(l => l.name !== 'X64') }),
    runner('beeline-ci-squire-05', 'heavy', { labels: [...base.labels, { name: 'beeline-ci-control' }] }),
  ] });
  assert.equal(plan.capacity.heavy, 1);
  assert.equal(plan.idle.heavy, 1);
  assert.equal(plan.capacity.control, 0);
});

test('merge groups, manual work and inventory errors retain hosted fallbacks', () => {
  for (const options of [{ event: 'merge_group' }, { event: 'workflow_dispatch' }, { inventoryError: 'HTTP 403' }]) {
    const plan = routeRunners({ ...options, runners: pool(), flags, pressure: { hosted: counts(1000) } });
    assert.ok(plan.placements.every(p => p.target[0] === 'ubuntu-latest'));
  }
});

test('API denial, malformed inventory and truncated pages fail open to hosted', async () => {
  for (const request of [async () => { throw Error('HTTP 403'); }, async () => ({}),
    async () => ({ total_count: 2, runners: [] })]) {
    const plan = await planRouting({ request, repository, flags });
    assert.ok(plan.inventoryError);
    assert.ok(plan.placements.every(p => p.target[0] === 'ubuntu-latest'));
  }
});

test('inventory pagination includes later slots and rejects invalid repository paths', async () => {
  const calls = [];
  const loaded = await loadRunners({ repository, request: async path => {
    calls.push(path);
    return path.endsWith('page=1') ? { total_count: 2, runners: [runner('beeline-ci-squire-02', 'heavy', { busy: true })] }
      : { total_count: 2, runners: [runner('beeline-ci-squire-03', 'heavy')] };
  } });
  assert.equal(calls.length, 2);
  const plan = routeRunners({ runners: loaded, flags });
  assert.equal(plan.idle.heavy, 1);
  assert.equal(plan.capacity.heavy, 2);
  await assert.rejects(loadRunners({ repository: '../other', request: async () => {} }));
});

test('only materialized queued/running work counts across older, current and newer runs', async () => {
  const pressure = await loadPressure({ repository, runId: 3, request: pressureRequest({
    2: [
      { status: 'queued', labels: ['beeline-ci-heavy'], started_at: 'already populated' },
      { status: 'queued', labels: ['beeline-ci-heavy'], runner_id: 123 },
      { status: 'in_progress', labels: ['beeline-ci-heavy'], runner_name: 'beeline-ci-squire-03' },
      { status: 'completed', labels: ['beeline-ci-heavy'] },
      { status: 'queued', labels: ['beeline-ci-control'] },
      { status: 'in_progress', labels: ['self-hosted', 'beeline-prod-host'] },
    ],
    3: [{ status: 'in_progress', labels: ['ubuntu-latest'] }],
    4: [{ status: 'queued', labels: ['ubuntu-latest'] }, { status: 'in_progress', labels: ['windows-latest'] },
      { status: 'in_progress', labels: ['self-hosted', 'macOS', 'ios-builder'] }],
  }) });
  assert.deepEqual(pressure, { control: counts(1), heavy: counts(2, 1), workspace: counts(), hosted: counts(1, 2) });
});

test('preparing workflows and empty future graphs reserve nothing', async () => {
  const pressure = await loadPressure({ repository, runId: 3, request: pressureRequest({ 2: [], 3: [] }) });
  assert.deepEqual(pressure, emptyPressure());
});

test('stale, malformed and truncated pressure inventories retain hosted execution', async () => {
  for (const actionsRequest of [
    async () => ({ total_count: 0, workflow_runs: [] }),
    async () => ({ workflow_runs: [] }),
    async () => ({ total_count: 2, workflow_runs: [{ id: 3 }] }),
    async path => path.includes('/actions/runs?') ? { total_count: 1, workflow_runs: [{ id: 3 }] }
      : { total_count: 2, jobs: [] },
  ]) {
    const plan = await planRouting({ repository, runId: 3, actionsRequest, request: async path =>
      path.includes('/runners?') ? { total_count: 10, runners: pool() } : { plan: { name: 'free' } } });
    assert.ok(plan.inventoryError);
    assert.ok(plan.placements.every(p => !isSquire(p.target)));
  }
});

test('hosted capacity follows the organization plan and uses a named fallback without plan access', async () => {
  for (const [name, expected] of [['free', 20], ['team', 60], ['enterprise', 500]]) {
    const limit = await loadHostedCapacity({ repository, request: async path => {
      assert.equal(path, '/orgs/Beeline-Work');
      return { plan: { name } };
    } });
    assert.equal(limit.hostedCapacity, expected);
    assert.match(limit.hostedCapacitySource, /org plan/);
  }
  for (const request of [async () => { throw Error('403'); }, async () => ({}), async () => ({ plan: { name: 'unknown' } })]) {
    assert.equal((await loadHostedCapacity({ repository, request })).hostedCapacity, DEFAULT_HOSTED_CAPACITY);
  }
});

test('planner combines separate credentials, live pressure and hosted capacity', async () => {
  const plan = await planRouting({ repository, runId: 3, flags,
    request: async path => path.includes('/runners?') ? { total_count: 10, runners: pool() }
      : { plan: { name: 'team' } },
    actionsRequest: pressureRequest({ 3: [{ status: 'queued', labels: ['ubuntu-latest'] }] }),
  });
  assert.equal(plan.inventoryError, undefined);
  assert.equal(plan.capacity.hosted, 60);
  assert.equal(plan.pressure.hosted.queued, 1);
  assert.ok(isSquire(plan.targets.typecheck));
});

// A label is a rollout boundary, not a claim that eight two-CPU listeners fit
// inside ten CPU cores. Extra/legacy listeners cannot take balanced work.
test('balanced listeners fit the parent quota and old/extra listeners are excluded', () => {
  const plan = routeRunners({ runners: [...pool(), runner('beeline-ci-squire-08', 'heavy'), runner('beeline-ci-squire-09', 'heavy')], flags });
  assert.deepEqual(plan.capacity, { control: 1, heavy: 6, workspace: 1, hosted: 20 });
  const legacy = pool().map(r => ({ ...r, labels: r.labels.filter(label => label.name !== 'beeline-ci-balanced') }));
  assert.ok(active(routeRunners({ runners: legacy, flags })).every(row => !isSquire(row.target)));
  assert.ok(active(plan).filter(row => isSquire(row.target)).every(row => row.target.includes('beeline-ci-balanced')));
});

test('balanced service quotas sum to the unchanged ten-CPU parent budget', () => {
  const quota = file => Number(readFileSync(new URL('../infra/ci/' + file, import.meta.url), 'utf8').match(/^CPUQuota=(\d+)%$/m)[1]);
  assert.equal(6 * quota('beeline-ci@.service.d/50-budget.conf') + quota('beeline-ci@01.service.d/60-control-budget.conf') + quota('beeline-ci@10.service.d/60-workspace-budget.conf'), quota('beeline-ci.slice.d/50-budget.conf'));
});
