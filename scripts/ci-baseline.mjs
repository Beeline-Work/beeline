// Read-only GitHub Actions sample. Usage: node scripts/ci-baseline.mjs [sample-size]
import { execFileSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
const repository = process.env.GITHUB_REPOSITORY || 'Beeline-Work/beeline';
const count = Number(process.argv[2] || 20);
if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('sample-size must be 1..100');
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const api = (path) => JSON.parse(gh('api', `repos/${repository}/${path}`));
const runs = api('actions/workflows/checks.yml/runs?event=pull_request&status=completed&per_page=100').workflow_runs
  .filter((run) => ['success', 'failure'].includes(run.conclusion)).slice(0, count);
const rows = [], flakes = [], limitations = [];
for (const run of runs) {
  // The run endpoint resets run_started_at on rerun; attempt one preserves it.
  const firstAttempt = run.run_attempt > 1 ? api(`actions/runs/${run.id}/attempts/1`) : run;
  let seconds = 0;
  const attempts = [];
  for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
    const jobs = JSON.parse(gh('api', '--paginate', '--slurp', `repos/${repository}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`)).flatMap((page) => page.jobs);
    attempts.push(jobs);
    for (const job of jobs) if (job.started_at && job.completed_at && job.conclusion !== 'skipped') {
      seconds += Math.max(0, (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000);
    }
  }
  rows.push({ date: run.created_at, sha: run.head_sha, url: run.html_url, attempts: run.run_attempt,
    startedAt: firstAttempt.run_started_at, completedAt: run.updated_at,
    wallMinutes: +( (Date.parse(run.updated_at) - Date.parse(firstAttempt.run_started_at)) / 60000).toFixed(2),
    runnerMinutes: +(seconds / 60).toFixed(2), conclusion: run.conclusion });
  for (let index = 0; index < attempts.length - 1; index++) {
    for (const failed of attempts[index].filter((job) => job.conclusion === 'failure')) {
      const passed = attempts.slice(index + 1).flat().find((job) => job.name === failed.name && job.conclusion === 'success');
      if (!passed) continue;
      try {
        const failedLog = stripVTControlCharacters(gh('api', `repos/${repository}/actions/jobs/${failed.id}/logs`));
        const passedLog = stripVTControlCharacters(gh('api', `repos/${repository}/actions/jobs/${passed.id}/logs`));
        const files = [...new Set([...failedLog.matchAll(/\bFAIL\s+([^\s]+\.test\.[cm]?[jt]sx?)/g)].map((match) => match[1]))];
        const confirmed = files.filter((file) => passedLog.split('\n').some((line) => line.includes(file) && /[✓✔]|\bPASS\b/.test(line)));
        for (const file of confirmed) flakes.push({ date: run.created_at, sha: run.head_sha, file, failedJob: failed.html_url, passedJob: passed.html_url });
        if (!confirmed.length) limitations.push(`${run.html_url}: ${failed.name} failed then passed; no matching Vitest file verdict available (not counted as a flaky test).`);
      } catch (error) { limitations.push(`${run.html_url}: logs unavailable: ${error.status ?? 'unknown'}`); }
    }
  }
}
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), repository, requested: count, runs: rows, flakes, limitations }, null, 2));
