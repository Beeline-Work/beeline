// Compare queue pressure per slot for every job, including this plan's placements.
// API/inventory failures still fall back to standard GitHub-hosted Ubuntu.
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// A rollout label prevents older, overcommitted listeners taking these jobs.
const baseLabels = ['self-hosted', 'Linux', 'X64', 'beeline-ci', 'beeline-ci-balanced'];
const poolRole = name => name === 'beeline-ci-squire-01' ? 'control'
  : name === 'beeline-ci-squire-10' ? 'workspace'
  : /^beeline-ci-squire-0[2-7]$/.test(name ?? '') ? 'heavy' : undefined;
const roles = ['control', 'heavy', 'workspace'];
const hosted = () => ['ubuntu-latest'];
const yes = value => value === true || value === 'true';
// Beeline-Work's /orgs API reports plan=free (2026-11-04). Standard hosted
// concurrency is 20, not the larger-runner limits endpoint's public-IP quota.
// https://docs.github.com/en/actions/reference/limits#job-concurrency-limits-for-github-hosted-runners
export const DEFAULT_HOSTED_CAPACITY = 20;
const emptyPressure = () => Object.fromEntries([...roles, 'hosted'].map(role =>
  [role, { queued: 0, inProgress: 0 }]));

export function routeRunners({ runners = [], flags = {}, event = 'pull_request', suite = 'all', inventoryError,
  pressure = {}, hostedCapacity = DEFAULT_HOSTED_CAPACITY } = {}) {
  const capacity = { ...Object.fromEntries(roles.map(role => [role, 0])), hosted: hostedCapacity };
  const busy = Object.fromEntries(roles.map(role => [role, 0]));
  const seen = new Set();
  if (!inventoryError && ['pull_request', 'push'].includes(event)) {
    for (const runner of runners) {
      if (!poolRole(runner.name) || runner.status !== 'online' || typeof runner.busy !== 'boolean' || seen.has(runner.name)) continue;
      const labels = new Set((runner.labels ?? []).map(label => typeof label === 'string' ? label : label.name));
      if (!baseLabels.every(label => labels.has(label))) continue;
      const matches = roles.filter(role => labels.has(`beeline-ci-${role}`));
      if (matches.length !== 1 || matches[0] !== poolRole(runner.name)) continue;
      capacity[matches[0]]++;
      if (runner.busy) busy[matches[0]]++;
      seen.add(runner.name);
    }
  }
  assert.ok(Number.isInteger(hostedCapacity) && hostedCapacity > 0, 'Invalid hosted capacity');
  const idle = Object.fromEntries(roles.map(role => [role, capacity[role] - busy[role]]));
  const reserved = Object.fromEntries(roles.map(role => [role, pressure[role]?.queued ?? 0]));
  // Busy inventory is a floor, not an extra running job: avoid counting a job
  // twice when both the runner and Actions APIs see it.
  const load = Object.fromEntries([...roles, 'hosted'].map(role => [role,
    (pressure[role]?.queued ?? 0) + Math.max(pressure[role]?.inProgress ?? 0, busy[role] ?? 0)]));
  const placements = [];
  const take = (job, role, enabled = true) => {
    const squireWait = capacity[role] ? load[role] / capacity[role] : null;
    const hostedWait = load.hosted / hostedCapacity;
    const squire = enabled && squireWait !== null && squireWait <= hostedWait;
    const target = squire ? [...baseLabels, `beeline-ci-${role}`] : hosted();
    if (enabled) load[squire ? role : 'hosted']++;
    placements.push({ job, role, target, enabled, squireWait, hostedWait });
    return target;
  };
  const server = yes(flags.serverSuite) || yes(flags.serverIntegration);
  const targets = { prepare: take('prepare', 'control') };
  const controls = { serverSelection: event === 'pull_request' && yes(flags.code),
    serverSuite: server, serverIntegration: server, coverage: event === 'push',
    frameBudget: yes(flags.frameBudget), stateUpgrade: yes(flags.stateUpgrade),
    readme: yes(flags.readme), appLinks: yes(flags.appLinkAssociations) };
  for (const [job, enabled] of Object.entries(controls)) targets[job] = take(job, 'control', enabled);
  const dispatched = value => event === 'workflow_dispatch' && ['all', value].includes(suite);
  targets.typecheck = take('typecheck', 'heavy');
  targets.shared = take('shared', 'heavy');
  const serverMatrix = Array.from({ length: 8 }, (_, index) => {
    const target = take(`server-${index + 1}`, 'heavy', server || dispatched('server-suite') || dispatched('server-integration'));
    return { shard: index + 1, target, hosted: target[0] === 'ubuntu-latest' };
  });
  targets.deadCode = take('deadCode', 'heavy', yes(flags.code) || dispatched('dead-code'));
  targets.native = take('native', 'heavy', yes(flags.nativeFingerprint) || yes(flags.mobileSuite) || dispatched('native-fingerprint') || dispatched('mobile-suite'));
  targets.mobileExport = take('mobileExport', 'heavy', yes(flags.mobileExportReachability) || dispatched('mobile-export-reachability'));
  targets.mobile = take('mobile', 'workspace', yes(flags.mobileSuite) || dispatched('mobile-suite'));
  return { version: 1, idle, reserved, capacity, pressure, targets, serverMatrix, placements,
    ...(inventoryError ? { inventoryError } : {}) };
}

export async function loadRunners({ request, repository }) {
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/);
  const runners = [];
  for (let page = 1; page <= 20; page++) {
    const response = await request(`/repos/${repository}/actions/runners?per_page=100&page=${page}`);
    assert.ok(Array.isArray(response.runners) && Number.isInteger(response.total_count), 'Invalid runner inventory');
    runners.push(...response.runners);
    if (runners.length >= response.total_count) return runners;
    assert.ok(response.runners.length, 'Truncated runner inventory');
  }
  throw Error('Runner inventory exceeds bounded pagination');
}

// Count materialized queued/running jobs across all repository workflows and
// all active runs (including current/newer runs). Future jobs claim no slots.
export async function loadPressure({ request, repository, runId }) {
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/);
  assert.match(String(runId), /^\d+$/);
  const pages = await Promise.all(['queued', 'in_progress', 'pending', 'waiting', 'requested'].map(status =>
    request(`/repos/${repository}/actions/runs?status=${status}&per_page=100`)));
  const listed = new Map();
  for (const page of pages) {
    assert.ok(Array.isArray(page.workflow_runs) && Number.isInteger(page.total_count) && page.total_count <= page.workflow_runs.length, 'Incomplete active workflow inventory');
    for (const run of page.workflow_runs) listed.set(run.id, run);
  }
  assert.ok(listed.has(Number(runId)), 'Active workflow inventory is not current yet');
  const pressure = emptyPressure();
  const inventories = await Promise.all([...listed.values()].filter(run => run.status !== 'completed').map(run =>
    request(`/repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`)));
  for (const result of inventories) {
    assert.ok(Array.isArray(result.jobs) && Number.isInteger(result.total_count) && result.total_count <= result.jobs.length, 'Incomplete queued job inventory');
    for (const job of result.jobs) {
      if (!['queued', 'in_progress'].includes(job.status)) continue;
      const state = job.status === 'queued' ? 'queued' : 'inProgress';
      const role = roles.find(role => job.labels?.includes(`beeline-ci-${role}`));
      if (role) pressure[role][state]++;
      else if (!job.labels?.includes('self-hosted') && job.labels?.some(label => /^(ubuntu|windows|macos)-/.test(label))) pressure.hosted[state]++;
    }
  }
  return pressure;
}

export async function loadHostedCapacity({ request, repository }) {
  // Organization metadata may omit plan for the workflow credential. This is
  // optional: retain the documented org limit rather than disabling Squire.
  try {
    const org = await request(`/orgs/${repository.split('/')[0]}`);
    const capacity = { free: 20, pro: 40, team: 60, enterprise: 500 }[org.plan?.name];
    if (capacity) return { hostedCapacity: capacity, hostedCapacitySource: `org plan: ${org.plan.name}` };
  } catch { /* No plan visibility; use the org's documented default below. */ }
  return { hostedCapacity: DEFAULT_HOSTED_CAPACITY, hostedCapacitySource: 'documented Beeline-Work default' };
}

export async function planRouting({ request, actionsRequest = request, repository, runId, ...options }) {
  try {
    const [runners, pressure, hostedLimit] = await Promise.all([
      loadRunners({ request, repository }),
      runId ? loadPressure({ request: actionsRequest, repository, runId }) : {},
      loadHostedCapacity({ request, repository }),
    ]);
    return { ...routeRunners({ ...options, ...hostedLimit, runners, pressure }), hostedCapacitySource: hostedLimit.hostedCapacitySource };
  } catch (error) { return routeRunners({ ...options, inventoryError: String(error.message).slice(0, 200) }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repository = process.env.GITHUB_REPOSITORY;
  const totalDeadline = AbortSignal.timeout(15_000);
  const requestWith = token => async path => {
    const response = await fetch(`https://api.github.com${path}`, { headers: {
      Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
    }, signal: AbortSignal.any([totalDeadline, AbortSignal.timeout(5000)]) });
    if (!response.ok) throw Error(`Runner inventory HTTP ${response.status}; using hosted overflow`);
    return response.json();
  };
  const result = await planRouting({ request: requestWith(process.env.GH_TOKEN),
    actionsRequest: requestWith(process.env.CI_ACTIONS_TOKEN || process.env.GH_TOKEN), repository, runId: process.env.GITHUB_RUN_ID,
    flags: JSON.parse(process.env.CI_ROUTE_FLAGS || '{}'), event: process.env.GITHUB_EVENT_NAME,
    suite: process.env.CI_ROUTE_SUITE || 'all' });
  const outputs = Object.entries(result.targets).map(([name, target]) => `runner_${name}=${JSON.stringify(target)}`);
  outputs.push(`serverMatrix=${JSON.stringify(result.serverMatrix)}`);
  appendFileSync(process.env.GITHUB_OUTPUT, outputs.join('\n') + '\n');
  const rows = result.placements.map(row => `| ${row.job} | ${row.target.includes('self-hosted') ? 'squire' : 'ubuntu-latest'} | ${row.squireWait ?? 'unavailable'} | ${row.hostedWait} | ${row.enabled ? 'shorter wait; ties to squire' : 'disabled; hosted fallback'} |`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `Idle Squire: ${JSON.stringify(result.idle)}; capacity: ${JSON.stringify(result.capacity)}; hosted limit: ${result.hostedCapacitySource ?? 'fallback'}; queued/running jobs: ${JSON.stringify(result.pressure)}${result.inventoryError ? `; ${result.inventoryError}` : ''}\n\n| Job | Placement | Squire wait | Hosted wait | Reason |\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}\n`);
  console.log(JSON.stringify(result));
}
