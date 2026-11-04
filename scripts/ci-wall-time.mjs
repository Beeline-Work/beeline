// Read-only acceptance sample: node scripts/ci-wall-time.mjs --since ISO --contains SHA --limit 10
// Uses gh-axi for GitHub access. This is a report, never a workflow/check gate.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const minute = (end, start) => Math.round((Date.parse(end) - Date.parse(start)) / 600) / 100;
const quantile = (values, fraction) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] : null;
export function summarizeRuns(runs, jobsByRun, { now = new Date().toISOString(), limit = 10 } = {}) {
  const rows = [], grouped = new Map();
  let invalidQueueSamples = 0;
  for (const run of [...runs].sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(0, limit)) {
    const jobs = jobsByRun[run.id] ?? [];
    const work = jobs.filter(job => job.conclusion !== 'skipped');
    const finished = run.status === 'completed' && work.length > 0 && work.every(job => job.status === 'completed');
    const end = finished ? work.map(job => job.completed_at).filter(Boolean).sort().at(-1) : now;
    const elapsed = minute(end ?? now, run.created_at);
    const latest = [...new Map(work.map(job => [job.name, job])).values()];
    const passed = finished && run.conclusion === 'success' && latest.every(job => job.conclusion === 'success');
    rows.push({ id: run.id, url: run.html_url, sha: run.head_sha, createdAt: run.created_at,
      attempts: run.run_attempt ?? 1, conclusion: run.conclusion, complete: finished, elapsedMinutes: elapsed,
      withinTarget: passed && elapsed <= 15, lowerBound: !finished });
    for (const job of work) {
      const pool = job.labels?.includes('beeline-ci') ? 'squire' : job.labels?.includes('self-hosted') ? 'other-self-hosted' : 'hosted';
      const key = `${job.name}::${pool}`;
      if (!grouped.has(key)) grouped.set(key, { name: job.name, pool, queues: [], runtimes: [], pending: 0 });
      const group = grouped.get(key);
      if (job.started_at && job.created_at) {
        const queue = minute(job.started_at, job.created_at);
        if (queue >= 0) group.queues.push(queue); else invalidQueueSamples++;
      } else if (job.status !== 'completed') group.pending++;
      if (job.conclusion === 'success' && job.started_at && job.completed_at)
        group.runtimes.push(minute(job.completed_at, job.started_at));
    }
  }
  return { generatedAt: now, targetMinutes: 15, requiredSamples: limit, observed: rows.length,
    accepted: rows.length === limit && rows.every(row => row.withinTarget),
    passingWithinTarget: rows.filter(row => row.withinTarget).length, invalidQueueSamples, runs: rows,
    jobs: [...grouped.values()].map(({ queues, runtimes, ...group }) => ({ ...group,
      queueSamples: queues.length, queueP50: quantile(queues, .5), queueP99: quantile(queues, .99),
      runtimeSamples: runtimes.length, runtimeP50: quantile(runtimes, .5), runtimeP99: quantile(runtimes, .99) })) };
}

function api(path) {
  // Wrap the response before @base64 so gh-axi's human renderer cannot change
  // nested data or mistake a JSON string for another structured response.
  const output = execFileSync('gh-axi', ['api', path, '--jq', '[.] | @base64', '--full'], { encoding: 'utf8', maxBuffer: 32 * 1024 ** 2 });
  const encoded = output.match(/\bbody:\s*["']?([A-Za-z0-9+/=]+)/)?.[1];
  if (!encoded) throw Error('GitHub response missing its encoded body');
  return JSON.parse(Buffer.from(encoded, 'base64').toString())[0];
}

async function main() {
  const args = process.argv.slice(2);
  const option = name => args[args.indexOf(name) + 1];
  const since = args.includes('--since') && option('--since');
  const contains = args.includes('--contains') && option('--contains');
  const limit = args.includes('--limit') ? Number(option('--limit')) : 10;
  if (!since || !Number.isFinite(Date.parse(since)) || !/^[a-f0-9]{40}$/.test(contains ?? '') || !Number.isInteger(limit) || limit < 1 || limit > 100)
    throw Error('Usage: --since ISO --contains FULL_COMMIT_SHA [--limit 10]');
  const repository = 'Beeline-Work/beeline';
  const runs = [];
  for (let page = 1; page <= 20; page++) {
    const batch = api(`/repos/${repository}/actions/workflows/checks.yml/runs?event=pull_request&created=>=${encodeURIComponent(since)}&per_page=100&page=${page}`).workflow_runs;
    for (const run of batch) {
      const comparison = api(`/repos/${repository}/compare/${contains}...${run.head_sha}`);
      if (['ahead', 'identical'].includes(comparison.status)) runs.push(run);
    }
    if (batch.length < 100) break;
    if (page === 20) throw Error('Run inventory exceeds bounded pagination; narrow --since');
  }
  const sample = runs.sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(0, limit);
  const jobs = {};
  for (const run of sample) {
    jobs[run.id] = [];
    // The API returns the latest attempts. Completion remains anchored to the
    // original run creation, so a successful rerun cannot reset push-to-green.
    for (let page = 1; page <= 20; page++) {
      const batch = api(`/repos/${repository}/actions/runs/${run.id}/jobs?per_page=100&page=${page}`).jobs;
      jobs[run.id].push(...batch);
      if (batch.length < 100) break;
      if (page === 20) throw Error('Job inventory exceeds bounded pagination');
    }
  }
  console.log(JSON.stringify({ contains, since, ...summarizeRuns(sample, jobs, { limit }) }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
