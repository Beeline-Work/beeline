// Snapshot CI-only runner capacity once. Never wait for unavailable capacity:
// public-repository overflow uses standard GitHub-hosted Ubuntu machines.
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const baseLabels = ['self-hosted', 'Linux', 'X64', 'beeline-ci'];
const roles = ['control', 'heavy', 'workspace'];
const controlJobs = ['serverSelection', 'serverSuite', 'serverIntegration', 'coverage',
  'frameBudget', 'stateUpgrade', 'readme', 'appLinks'];
const hosted = () => ['ubuntu-latest'];
const yes = value => value === true || value === 'true';

export function routeRunners({ runners = [], flags = {}, event = 'pull_request', suite = 'all', inventoryError, reservations = {} } = {}) {
  const available = Object.fromEntries(roles.map(role => [role, []]));
  const seen = new Set();
  if (!inventoryError && ['pull_request', 'push'].includes(event)) {
    for (const runner of runners) {
      if (!/^beeline-ci-squire-\d\d$/.test(runner.name ?? '') || runner.status !== 'online' || runner.busy !== false || seen.has(runner.name)) continue;
      const labels = new Set((runner.labels ?? []).map(label => typeof label === 'string' ? label : label.name));
      if (!baseLabels.every(label => labels.has(label))) continue;
      const matches = roles.filter(role => labels.has(`beeline-ci-${role}`));
      if (matches.length !== 1) continue;
      available[matches[0]].push(runner.name);
      seen.add(runner.name);
    }
  }
  for (const values of Object.values(available)) values.sort();
  const idle = Object.fromEntries(roles.map(role => [role, available[role].length]));
  const reserved = Object.fromEntries(roles.map(role => {
    const count = Number.isInteger(reservations[role]) && reservations[role] > 0 ? reservations[role] : 0;
    return [role, available[role].splice(0, count).length];
  }));
  const placements = [];
  const take = (job, role, enabled = true) => {
    const runner = enabled && available[role].shift();
    const target = runner ? [...baseLabels, `beeline-ci-${role}`] : hosted();
    placements.push({ job, role, target, ...(runner ? { observedIdleRunner: runner } : {}) });
    return target;
  };
  // Preparation owns at most the one observed control slot; small verdicts
  // stay hosted instead of queuing behind preparation in another workflow.
  const targets = { prepare: take('prepare', 'control') };
  for (const job of controlJobs) targets[job] = take(job, 'control', false);
  const dispatched = value => event === 'workflow_dispatch' && ['all', value].includes(suite);
  targets.typecheck = take('typecheck', 'heavy');
  targets.shared = take('shared', 'heavy');
  const server = yes(flags.serverSuite) || dispatched('server-suite') || dispatched('server-integration');
  const serverMatrix = Array.from({ length: 8 }, (_, index) => {
    const target = take(`server-${index + 1}`, 'heavy', server);
    return { shard: index + 1, target, hosted: target[0] === 'ubuntu-latest' };
  });
  targets.deadCode = take('deadCode', 'heavy', yes(flags.code) || dispatched('dead-code'));
  targets.native = take('native', 'heavy', yes(flags.nativeFingerprint) || yes(flags.mobileSuite) || dispatched('native-fingerprint') || dispatched('mobile-suite'));
  targets.mobileExport = take('mobileExport', 'heavy', yes(flags.mobileExportReachability) || dispatched('mobile-export-reachability'));
  targets.mobile = take('mobile', 'workspace', yes(flags.mobileSuite) || dispatched('mobile-suite'));
  return { version: 1, idle, reserved, targets, serverMatrix, placements,
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

// Account for older jobs already queued, and older workflows still preparing
// their job graph. This avoids competing snapshots booking the same free role
// before the previous workflow's dependent jobs have appeared in the API.
export async function loadPressure({ request, repository, runId }) {
  assert.match(String(runId), /^\d+$/);
  const pages = await Promise.all(['queued', 'in_progress', 'pending'].map(status =>
    request(`/repos/${repository}/actions/workflows/checks.yml/runs?status=${status}&per_page=100`)));
  const listed = new Map();
  for (const page of pages) {
    assert.ok(Array.isArray(page.workflow_runs) && page.total_count <= page.workflow_runs.length, 'Incomplete active workflow inventory');
    for (const run of page.workflow_runs) listed.set(run.id, run);
  }
  assert.ok(listed.has(Number(runId)), 'Active workflow inventory is not current yet');
  const reservations = { heavy: 0, control: 0, workspace: 0 };
  const heavyName = name => /^(?:TYPECHECK|SHARED PACKAGE TESTS|DEAD CODE|NATIVE FINGERPRINT|MOBILE-EXPORT REACHABILITY|SERVER SUITE SHARD )/.test(name);
  for (const run of listed.values()) {
    if (run.id >= Number(runId) || run.status === 'completed') continue;
    const result = await request(`/repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`);
    assert.ok(Array.isArray(result.jobs) && result.total_count <= result.jobs.length, 'Incomplete queued job inventory');
    for (const job of result.jobs) {
      if (job.status !== 'queued' || job.runner_name || job.runner_id > 0) continue;
      for (const role of roles) if (job.labels?.includes(`beeline-ci-${role}`)) reservations[role]++;
    }
    if (!result.jobs.some(job => heavyName(job.name))) reservations.heavy += 8;
    if (!result.jobs.some(job => job.name === 'Prepare workspace caches')) reservations.control++;
    if (!result.jobs.some(job => job.name === 'MOBILE SUITE')) reservations.workspace++;
  }
  return reservations;
}

export async function planRouting({ request, actionsRequest = request, repository, runId, ...options }) {
  try {
    const runners = await loadRunners({ request, repository });
    const reservations = runId ? await loadPressure({ request: actionsRequest, repository, runId }) : {};
    return routeRunners({ ...options, runners, reservations });
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
  const rows = result.placements.map(row => `| ${row.job} | ${row.target.includes('self-hosted') ? 'squire' : 'ubuntu-latest'} | ${row.observedIdleRunner ?? 'hosted overflow'} |`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `Runner inventory: ${JSON.stringify(result.idle)}; prior reservations: ${JSON.stringify(result.reserved)}${result.inventoryError ? `; ${result.inventoryError}` : ''}\n\n| Job | Placement | Observed slot |\n| --- | --- | --- |\n${rows.join('\n')}\n`);
  console.log(JSON.stringify(result));
}
