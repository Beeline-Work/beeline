#!/usr/bin/env node
/** Local reports are posted by the scheduled agent, never by a token or webhook. */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareNightly, mergedPrs } from './nightly-compare.mjs';

export function assessNight({ current, baseline, commits = [], head, rerun, rerunAttempted = false, night, hostLoad = [] }) {
  const evaluate = (report) => {
    const result = compareNightly(report, baseline);
    if (report && report.commit !== head) {
      result.pass = false;
      result.failures.push('Captured commit differs from the requested main head');
    }
    return result;
  };
  const first = evaluate(current);
  const chosen = !first.pass && rerunAttempted ? rerun : current;
  const verdict = !first.pass && rerunAttempted ? evaluate(rerun) : first;
  let prs = [];
  if (baseline?.commit) {
    try { prs = mergedPrs(commits, baseline.commit, head); }
    catch { verdict.pass = false; verdict.failures.push('PR range since last passing run unavailable'); }
  }
  const needsRerun = !verdict.pass && !rerunAttempted;
  const shouldAlert = !verdict.pass && rerunAttempted;
  const text = [
    `Nightly squire emulator rig ${night}: ${verdict.pass ? 'passed' : needsRerun ? 'rerun required' : 'failed or skipped'}`,
    ...verdict.failures,
    baseline?.commit ? `PRs since last pass (${baseline.commit}): ${prs.length ? prs.map((n) => `#${n}`).join(', ') : 'none identified'}` : 'No passing baseline yet; PR regression range unavailable',
    `Measured main: ${head}`,
    `Host load recorded: ${Array.isArray(hostLoad) ? hostLoad.length : 1} observation(s); see attached report`,
  ].join('\n');
  return { ...verdict, night, head, prs, needsRerun, shouldAlert, hostLoad,
    firstAttempt: first, text, passingReport: verdict.pass ? chosen : undefined };
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const output = option('--out');
  const baselinePath = option('--baseline');
  const head = option('--head');
  if (!output || !baselinePath || !/^[a-f0-9]{40}$/.test(head ?? ''))
    throw new Error('Require --out, --baseline and --head (40-character main SHA)');
  const errors = [];
  const load = async (path, label) => {
    if (!path) return undefined;
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') errors.push(`${label} could not be read`);
      return undefined;
    }
  };
  const baseline = await load(baselinePath, 'Passing baseline');
  const current = await load(option('--current'), 'New report');
  const rerun = await load(option('--rerun'), 'Rerun report');
  const commits = await load(option('--commits'), 'Commit range');
  const hostLoad = await load(option('--load'), 'Host load') ?? [];
  const result = assessNight({ current, baseline, rerun, commits, hostLoad, head,
    night: option('--night') ?? new Date().toISOString().slice(0, 10), rerunAttempted: args.includes('--rerun') });
  if (errors.length) {
    result.pass = false;
    result.failures.push(...errors);
    result.needsRerun = !args.includes('--rerun');
    result.shouldAlert = !result.needsRerun;
    delete result.passingReport;
    result.text = result.text.replace(/: passed\n/, ': failed or skipped\n') + `\n${errors.join('\n')}`;
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  if (result.pass) {
    await mkdir(dirname(baselinePath), { recursive: true });
    const temp = `${baselinePath}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(result.passingReport, null, 2) + '\n');
    await rename(temp, baselinePath);
  }
  console.log(result.text);
  for (const row of result.passingReport?.rows ?? (args.includes('--rerun') ? rerun?.rows : current?.rows) ?? []) {
    const key = `${row.kind}/${row.name}/${row.variant}`;
    const failures = result.failures.filter((failure) => failure.startsWith(`${key}:`));
    console.log(`${key}: ${failures.length ? 'FAIL' : 'PASS'} n=${row.samples} p50=${row.p50Ms ?? 'unknown'}ms p95=${row.p95Ms}ms target<${row.budgetMs}ms${failures.length ? `; ${failures.join('; ')}` : ''}`);
  }
  if (!result.pass) process.exitCode = result.needsRerun ? 2 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
