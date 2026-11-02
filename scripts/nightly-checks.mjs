import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function easternSlot(date) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(date) === '03';
}
const bad = (job) => !['success', 'skipped', 'neutral'].includes(job.conclusion);
export function classify(attempts) {
  if (!attempts.length || attempts.some(a => a.sha !== attempts[0].sha)) throw new Error('Attempts must share one SHA');
  const first = attempts[0];
  const last = attempts.at(-1);
  const flakyJobs = [], failures = [];
  for (const job of first.jobs.filter(bad)) {
    const retry = last === first ? undefined : last.jobs.find(j => j.name === job.name);
    const entry = { name: job.name, attempts: [job, ...(retry ? [retry] : [])] };
    (retry?.conclusion === 'success' ? flakyJobs : failures).push(entry);
  }
  for (const job of last.jobs.filter(bad)) {
    if (!failures.some(j => j.name === job.name) && !flakyJobs.some(j => j.name === job.name)) failures.push({ name: job.name, attempts: [job] });
  }
  const jobs = attempts.flatMap(a => a.jobs);
  const starts = jobs.map(j => Date.parse(j.started_at)).filter(Number.isFinite);
  const ends = jobs.map(j => Date.parse(j.completed_at)).filter(Number.isFinite);
  return { schemaVersion: 1, sha: first.sha, attempts, flakyJobs, failures,
    wallClockMinutes: starts.length && ends.length ? (Math.max(...ends) - Math.min(...starts)) / 60000 : 0,
    runnerMinutes: jobs.reduce((n, j) => n + Math.max(0, (Date.parse(j.completed_at) - Date.parse(j.started_at)) / 60000 || 0), 0) };
}

export async function runNightly({ api, save, now = () => new Date(), manual = false, requestId = String(Date.now()) }) {
  if (!manual && !easternSlot(now())) return;
  if (!/^\d+$/.test(requestId)) throw new Error('Invalid nightly request identity');
  const releases = await api('GET', 'actions/workflows/unified-release.yml/runs?branch=main&per_page=100');
  if (releases.workflow_runs.some(r => r.status !== 'completed')) {
    const result = { schemaVersion: 1, skipped: true, reason: 'A unified-release run on main is active', releases: releases.workflow_runs.filter(r => r.status !== 'completed').map(r => r.html_url) };
    save(result); return result;
  }
  const sha = (await api('GET', 'commits/main')).sha;
  await api('POST', 'actions/workflows/checks.yml/dispatches', { ref: 'main', inputs: { suite: 'all', nightly_id: requestId } });
  // Completion is a workflow_run event. No run-discovery or status polling.
  const result = { schemaVersion: 1, dispatched: true, requestedSha: sha, requestId };
  save(result); return result;
}

export async function finishNightly({ api, run, save }) {
  if (run?.event !== 'workflow_dispatch' || run.head_branch !== 'main' || run.path !== '.github/workflows/checks.yml' ||
      !/^Nightly Checks \d+$/.test(run.display_title ?? '') || run.status !== 'completed') return;
  // One final observation also rejects a duplicate old completion after its
  // rerun has started. The workflow serializes handlers for this run identity.
  const state = await api('GET', `actions/runs/${run.id}`);
  if (state.run_attempt !== run.run_attempt || state.status !== 'completed') {
    const result = { schemaVersion: 1, skipped: true, reason: 'Superseded nightly completion' };
    save(result); return result;
  }
  if (state.head_sha !== run.head_sha) throw new Error('Completion SHA changed');
  if (![1, 2].includes(state.run_attempt)) throw new Error('Nightly attempt exceeds its one-rerun policy');
  const attempts = [];
  for (let attempt = 1; attempt <= state.run_attempt; attempt++) {
    const completed = attempt === state.run_attempt ? state : await api('GET', `actions/runs/${run.id}/attempts/${attempt}`);
    if (completed.head_sha !== state.head_sha || completed.status !== 'completed') throw new Error('Invalid completed attempt');
    const jobs = await api('GET', `actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`);
    if (jobs.total_count > jobs.jobs.length) throw new Error('Job list truncated');
    for (const job of jobs.jobs.filter(bad)) {
      try {
        const log = await api('LOG', `actions/jobs/${job.id}/logs`);
        job.failingTests = [...new Set(log.split('\n').filter(l => /(?:not ok \d+|FAIL\s|✕|×)/.test(l)).map(l => l.replace(/\u001b\[[0-9;]*m/g, '').slice(0, 1000)))].slice(0, 100);
      } catch (error) { job.logError = error.message; }
    }
    attempts.push({ attempt, sha: state.head_sha, url: `${run.html_url}/attempts/${attempt}`, conclusion: completed.conclusion, jobs: jobs.jobs });
  }
  const result = classify(attempts);
  if (attempts.at(-1).conclusion !== 'success' && result.failures.length === 0)
    result.failures.push({ name: 'Checks workflow', attempts: attempts.map(a => ({ url: a.url, conclusion: a.conclusion })) });
  if (state.run_attempt === 1 && state.conclusion === 'failure') {
    await api('POST', `actions/runs/${run.id}/rerun-failed-jobs`);
    result.rerunRequested = true;
  }
  save(result); return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repo = process.env.GITHUB_REPOSITORY;
  const api = async (method, endpoint, body) => {
    const args = ['api', ...(method === 'LOG' ? [] : ['--method', method]), `repos/${repo}/${endpoint}`];
    if (body) args.push('--input', '-');
    const output = execFileSync('gh', args, { input: body ? JSON.stringify(body) : undefined, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return method === 'LOG' ? output : output.trim() ? JSON.parse(output) : null;
  };
  let latestResult;
  const save = result => {
    latestResult = result;
    writeFileSync('nightly-checks.json', JSON.stringify(result, null, 2) + '\n');
  };
  try {
    const result = process.env.EVENT_NAME === 'workflow_run'
      ? await finishNightly({ api, save, run: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).workflow_run })
      : await runNightly({ api, save, manual: process.env.EVENT_NAME === 'workflow_dispatch', requestId: process.env.GITHUB_RUN_ID });
    if (result && process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.skipped ? `${result.reason}\n` : result.dispatched ? `Nightly Checks dispatched for ${result.requestedSha}; completion follows its workflow event.\n` : `## Nightly Checks\nCommit: ${result.sha}\n\nFailures: ${result.failures.length}; flaky jobs: ${result.flakyJobs.length}\n\nWall clock: ${result.wallClockMinutes.toFixed(2)} minutes; runner time: ${result.runnerMinutes.toFixed(2)} minutes\n\n${result.attempts.map(a => `[Attempt ${a.attempt}](${a.url})`).join(' · ')}\n\n${[...result.failures, ...result.flakyJobs].map(j => `- ${j.name}: ${j.attempts.map(a => `[${a.conclusion}](${a.html_url || a.url})`).join(' → ')}`).join('\n')}\n`);
    if (result?.failures?.length) process.exitCode = 1;
  } catch (error) {
    save({ ...latestResult, schemaVersion: 1, infrastructureError: error.message });
    throw error;
  }
}
