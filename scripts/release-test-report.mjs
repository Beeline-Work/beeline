// One observation of completed Checks jobs. Diagnostics never rerun tests.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildMap } from '../apps/server/scripts/test-selection.mjs';

export function failingTests(log, jobName, testFiles = []) {
  const clean = log.replace(/\u001b\[[0-9;]*m/g, '');
  const failures = clean.split('\n').filter(line => /(?:\bFAIL\s|not ok \d+|[×✕]|❯.*failed)/.test(line));
  const files = new Set();
  const add = path => {
    const repositoryPath = path.match(/(?:^|\/)((?:apps|packages|scripts|tests)\/.*)$/)?.[1];
    const matches = testFiles.filter(file => file.endsWith(`/${path}`));
    const prefix = /SERVER|PRODUCTION-CORPUS/.test(jobName) ? 'apps/server/'
      : /BODY/.test(jobName) ? 'apps/body/' : /MOBILE/.test(jobName) ? 'apps/mobile/' : '';
    files.add(repositoryPath ?? (matches.length === 1 ? matches[0] : prefix + path));
  };
  for (const line of failures) {
    for (const match of line.matchAll(/(?:^|\s)((?:[\w@().-]+\/)*[\w().-]+\.(?:test|spec)\.[cm]?[jt]sx?)/g)) {
      add(match[1]);
    }
  }
  // Node's TAP reporter puts the file in the failed test's location field,
  // while the `not ok` line itself can contain only the test title.
  for (const match of clean.matchAll(/\blocation:\s+['"]?([^\n'"]+?\.(?:test|spec)\.[cm]?[jt]sx?)(?::\d+)?/g)) add(match[1]);
  return { files: [...files].sort(), lines: failures.map(line => line.slice(0, 2000)) };
}

export function coveredFiles(map, test) {
  const id = map.tests.indexOf(test);
  if (id < 0) return [test];
  return [...new Set([test, ...Object.entries(map.sources).filter(([, source]) => source.tests.includes(id)).map(([file]) => file),
    ...Object.entries(map.reads).filter(([, tests]) => tests.includes(id)).map(([file]) => file)])].sort();
}

export async function releaseTestReport({ jobs, log, map, previous, sha, commits, testFiles }) {
  const lines = [`## Release tests blocked ${sha}`, `Previous release: ${previous || 'none recorded'}.`,
    'Likely culprits below are commits touching recorded coverage, not proof of causation.'];
  const failed = jobs.filter(job => ['failure', 'cancelled', 'timed_out', 'action_required'].includes(job.conclusion));
  for (const job of failed) {
    lines.push(`\n### ${job.name} (${job.conclusion})`);
    let failures;
    try { failures = failingTests(await log(job.id), job.name, testFiles); }
    catch (error) { lines.push(`Could not read completed job log: ${error.message}`); continue; }
    lines.push('```text', ...(failures.lines.length ? failures.lines : ['No failing test names in this log; inspect the job failure.']), '```');
    for (const test of failures.files) {
      const files = coveredFiles(map, test);
      lines.push(`\nFailing file: ${test}`);
      if (!map.tests.includes(test)) lines.push('No runtime coverage record; attribution is limited to the failing test file.');
      if (!previous) { lines.push('No previous release SHA; no commit range can be attributed.'); continue; }
      const suspects = await commits(previous, sha, files);
      lines.push(...(suspects.length ? suspects.map(commit => `- ${commit}`) : ['No commits since the previous release touched these recorded files.']));
    }
  }
  if (!failed.length) lines.push('No failed test jobs found. Inspect release validation setup or coverage-map validation above.');
  return lines.join('\n') + '\n';
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const run = process.env.GITHUB_RUN_ID;
  const gh = args => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const jobs = [];
  for (let page = 1; ; page++) {
    const result = JSON.parse(gh(['api', `repos/${repository}/actions/runs/${run}/attempts/${process.env.GITHUB_RUN_ATTEMPT}/jobs?per_page=100&page=${page}`]));
    jobs.push(...result.jobs);
    if (result.jobs.length < 100) break;
  }
  const directory = join(process.env.RUNNER_TEMP, 'coverage-records');
  const records = existsSync(directory) ? readdirSync(directory).filter(file => file.endsWith('.json'))
    .map(file => JSON.parse(readFileSync(join(directory, file), 'utf8'))) : [];
  const report = await releaseTestReport({ jobs: jobs.filter(job => job.name.startsWith('release_checks / ')),
    log: id => gh(['api', `repos/${repository}/actions/jobs/${id}/logs`]), map: buildMap(records),
    previous: process.env.PREVIOUS_SHA, sha: process.env.RELEASE_SHA,
    testFiles: execFileSync('git', ['ls-files'], { encoding: 'utf8' }).trim().split('\n').filter(file => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)),
    commits: (previous, sha, files) => execFileSync('git', ['log', '--format=%h %s', `${previous}..${sha}`, '--', ...files],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim().split('\n').filter(Boolean),
  });
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
