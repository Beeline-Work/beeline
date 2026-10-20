#!/usr/bin/env node
/** Independent hosted watchdog: a queued self-hosted job has no start timeout. */
import { mkdir, writeFile } from 'node:fs/promises';
const repository = process.env.GITHUB_REPOSITORY;
if (repository !== 'Beeline-Work/beeline') throw new Error('Unexpected rig repository');
const night = new Date().toISOString().slice(0, 10);
const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/latency-rig.yml/runs?event=schedule&branch=main&per_page=20`, {
  headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json' },
  signal: AbortSignal.timeout(15_000),
});
if (!response.ok) throw new Error(`Nightly run lookup failed: HTTP ${response.status}`);
const runs = (await response.json()).workflow_runs;
const run = runs.find((candidate) => candidate.created_at.slice(0, 10) === night);
if (run?.status === 'completed' && run.conclusion === 'success') {
  console.log('Nightly finished; its report job owns the verdict and alert');
  process.exit(0);
}
if (run && run.status !== 'completed') {
  const cancelled = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${run.id}/cancel`, {
    method: 'POST', headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (![202, 409].includes(cancelled.status)) throw new Error(`Stale nightly cancellation failed: HTTP ${cancelled.status}`);
}
await mkdir('latency-rig-output', { recursive: true });
await writeFile('latency-rig-output/skipped.json', JSON.stringify({ pass: false,
  text: `Nightly Android latency rig skipped or did not finish within three hours${run ? ` (run ${run.id}, ${run.status})` : ' (no scheduled run)'}` }));
// The deterministic Room message id also deduplicates a late normal report.
console.log('Device capture did not finish; the hosted watchdog will alert');
process.exitCode = 1;
