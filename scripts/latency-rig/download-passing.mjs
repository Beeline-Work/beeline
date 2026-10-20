#!/usr/bin/env node
/** Restore only a main-branch nightly artifact; PR artifacts are never trusted. */
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const repository = process.env.GITHUB_REPOSITORY;
if (repository !== 'Beeline-Work/beeline') throw new Error('Unexpected rig repository');
const headers = { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json' };
async function api(path) {
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, { headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`GitHub baseline lookup failed: HTTP ${response.status}`);
  return response.json();
}
await mkdir('latency-rig-output', { recursive: true });
const artifacts = await api('actions/artifacts?name=latency-rig-passing&per_page=100');
for (const artifact of artifacts.artifacts) {
  if (artifact.expired || !artifact.workflow_run?.id) continue;
  const run = await api(`actions/runs/${artifact.workflow_run.id}`);
  if (run.head_branch !== 'main' || !['schedule', 'workflow_dispatch'].includes(run.event) ||
      run.path !== '.github/workflows/latency-rig.yml' || run.repository.full_name !== repository) continue;
  const redirect = await fetch(`https://api.github.com/repos/${repository}/actions/artifacts/${artifact.id}/zip`,
    { headers, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  const location = redirect.headers.get('location');
  if (redirect.status !== 302 || !location || new URL(location).protocol !== 'https:')
    throw new Error('Baseline download location unavailable');
  const download = await fetch(location, { signal: AbortSignal.timeout(30_000) });
  if (!download.ok) throw new Error(`Baseline download failed: HTTP ${download.status}`);
  await writeFile('latency-rig-output/baseline.zip', Buffer.from(await download.arrayBuffer()));
  const json = execFileSync('unzip', ['-p', 'latency-rig-output/baseline.zip', 'passing.json'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  const report = JSON.parse(json);
  if (!/^[0-9a-f]{40}$/.test(report.commit) || !report.complete || !report.rows?.length)
    throw new Error('Invalid passing baseline artifact');
  await writeFile('latency-rig-output/baseline.json', json);
  console.log(`Restored passing baseline ${report.commit}`);
  process.exit(0);
}
console.log('No retained main nightly baseline; this run establishes one if it passes');
