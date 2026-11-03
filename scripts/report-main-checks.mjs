import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { classify, publishIssues } from './nightly-checks.mjs';

export async function reportMainChecks({ api, runId }) {
  assert.match(String(runId), /^\d+$/, 'Expected a Checks run ID');
  const run = await api('GET', `actions/runs/${runId}`);
  if (run.event !== 'push' || run.head_branch !== 'main' || run.status !== 'completed' || run.name !== 'Checks') return { skipped: true };
  assert.ok(Number.isInteger(run.run_attempt) && run.run_attempt >= 1 && run.run_attempt <= 100, 'Invalid run attempt');
  const attempts = [];
  for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
    const response = await api('GET', `actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`);
    assert.ok(response.total_count <= response.jobs.length, 'Refusing a truncated main check result');
    attempts.push({ attempt, sha: run.head_sha, url: `${run.html_url}/attempts/${attempt}`, jobs: response.jobs });
  }
  const result = classify(attempts);
  if (run.conclusion !== 'success' && !result.failures.length) result.failures.push({ name: 'Checks workflow', attempts: [{ url: run.html_url, conclusion: run.conclusion }] });
  const actions = await publishIssues({ api, result, runUrl: run.html_url, scope: 'Main Checks' });
  return { ...result, actions };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const api = async (method, endpoint, body) => {
    const args = ['api', '--method', method, `repos/${process.env.GITHUB_REPOSITORY}/${endpoint}`];
    if (body) args.push('--input', '-');
    const output = execFileSync('gh', args, { input: body ? JSON.stringify(body) : undefined, encoding: 'utf8', maxBuffer: 8 * 1024 ** 2 });
    return output.trim() ? JSON.parse(output) : null;
  };
  const result = await reportMainChecks({ api, runId: process.env.CHECKS_RUN_ID });
  console.log(JSON.stringify(result, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `Main Checks: ${result.skipped ? 'not a completed main push' : `${result.failures.length} failed jobs; ${result.actions.length} issue updates`}\n`);
}
