#!/usr/bin/env node
/** GitHub-hosted reporting, including when the device runner never starts. */
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { compareNightly, mergedPrs } from './nightly-compare.mjs';

const [currentPath, baselinePath, outputPath = 'latency-rig-output/nightly.json'] = process.argv.slice(2);
async function optionalJson(path) {
  if (!path) return null;
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const current = await optionalJson(currentPath);
const baseline = await optionalJson(baselinePath);
const result = compareNightly(current, baseline);
if (process.env.LATENCY_RIG_BASELINE_ERROR === 'true') {
  result.pass = false;
  result.failures.push('Last passing baseline could not be loaded');
}
const head = current?.commit ?? process.env.GITHUB_SHA;
let prs = [];
if (baseline?.commit) {
  try {
    if (!/^[0-9a-f]{40}$/.test(head ?? '') || !/^[0-9a-f]{40}$/.test(baseline.commit))
      throw new Error('Measured head or passing baseline SHA is invalid');
    const log = execFileSync('git', ['log', '--first-parent', '--format=%H%x09%s', head], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    prs = mergedPrs(log.trim().split('\n').map((line) => {
      const tab = line.indexOf('\t'); return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
    }), baseline.commit, head);
  } catch {
    result.pass = false;
    result.failures.push('PR range since last passing run could not be established');
  }
}
const rangeFailed = result.failures.some((failure) => failure.startsWith('PR range'));
const text = [
  'Nightly Android latency rig failed',
  ...result.failures,
  rangeFailed ? 'Merged PR range unavailable; check the nightly run logs' : baseline?.commit ? `Since last passing run (${baseline.commit}): ${prs.length ? prs.map((number) => `#${number}`).join(', ') : 'no merged PRs'}` : 'No passing baseline yet; regression comparison unavailable',
  process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : '',
].filter(Boolean).join('\n');
await writeFile(outputPath, JSON.stringify({ ...result, prs, text }, null, 2) + '\n');
// The workflow saves only passing reports as future baselines.
if (result.pass) {
  await writeFile('latency-rig-output/passing.json', JSON.stringify(current, null, 2) + '\n');
} else {
  process.stdout.write(`${text}\n`);
  process.exitCode = 1;
}
