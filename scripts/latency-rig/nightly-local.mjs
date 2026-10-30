#!/usr/bin/env node
/** Local reports are posted by the scheduled agent, never by a token or webhook. */
import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readHistory, appendVerdict, lockState, compareDrift, easternDate } from './nightly-history.mjs';
import { compareNightly, mergedPrs } from './nightly-compare.mjs';

export function assessNight({ current, baseline, commits = [], head, rerun, rerunAttempted = false, night, hostLoad = [], history = [], runId, firstBaseline }) {
  const evaluate = (report) => {
    const result = compareNightly(report, baseline);
    result.drift = compareDrift(report, history, { night, runId, firstBaseline });
    result.failures.push(...result.drift.failures);
    result.pass = result.failures.length === 0;
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
    ...verdict.drift.rows.map((row) => `${row.key}: drift p95=${row.p95Ms} ms; first=${row.firstP95Ms ?? 'unavailable'} ms; recent median=${row.medianP95Ms ?? 'unavailable'} ms (${row.passingNights}/7 prior passing nights)`),
    ...(Array.isArray(chosen?.rows) && chosen.rows.some((row) => row?.variant?.startsWith('push-')) && chosen.pushMeasurement ? [
      `Push measurement: ${chosen.pushMeasurement.measured}; native-response phase ${chosen.pushMeasurement.nativeResponsePhase}. Unmeasured: ${chosen.pushMeasurement.excluded}.`,
    ] : []),
    baseline?.commit ? `PRs since last pass (${baseline.commit}): ${prs.length ? prs.map((n) => `#${n}`).join(', ') : 'none identified'}` : 'No passing baseline yet; PR regression range unavailable',
    `Measured main: ${head}`,
    `Host load recorded: ${Array.isArray(hostLoad) ? hostLoad.length : 1} observation(s); see attached report`,
  ].join('\n');
  return { ...verdict, night, head, prs, needsRerun, shouldAlert, hostLoad,
    firstAttempt: first, text, measuredReport: chosen, passingReport: verdict.pass ? chosen : undefined };
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const output = option('--out');
  const baselinePath = option('--baseline');
  const head = option('--head');
  if (!output || !baselinePath || !/^[a-f0-9]{40}$/.test(head ?? ''))
    throw new Error('Require --out, --baseline and --head (40-character main SHA)');
  const stateDir = dirname(resolve(baselinePath));
  await mkdir(stateDir, { recursive: true });
  const lock = `${stateDir}/nightly.lock`;
  await lockState(lock);
  try {
    const historyPath = `${stateDir}/history.jsonl`;
    const history = await readHistory(historyPath);
    // Recover last-pass if a process stopped after the durable append but before its rename.
    const lastPass = history.findLast((entry) => entry.final && entry.pass);
    if (lastPass) {
      const temp = `${baselinePath}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(lastPass.report, null, 2) + '\n');
      await rename(temp, baselinePath);
    }
    const runId = option('--run-id') ?? resolve(output);
    const attempt = args.includes('--rerun') ? 2 : 1;
    const previous = history.find((entry) => entry.runId === runId && entry.attempt === attempt);
    if (previous) {
      // Invocation identity is immutable: retries reproduce the recorded verdict, not new measurements.
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, JSON.stringify(previous, null, 2) + '\n');
      console.log(previous.text);
      if (!previous.pass) process.exitCode = previous.needsRerun ? 2 : 1;
      return;
    }
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
    const firstBaseline = await load(`${stateDir}/first-pass.json`, 'First passing baseline') ?? history.find((entry) => entry.final && entry.pass)?.report ?? baseline;
    const current = await load(option('--current'), 'New report');
    const rerun = await load(option('--rerun'), 'Rerun report');
    const commits = await load(option('--commits'), 'Commit range');
    const hostLoad = await load(option('--load'), 'Host load') ?? [];
    const priorRun = history.find((entry) => entry.runId === runId);
    const night = priorRun?.night ?? option('--night') ?? easternDate(option('--started-at') ?? new Date());
    if (priorRun && (priorRun.head !== head || (option('--night') && option('--night') !== night)))
      throw new Error('Run identity must retain its original head and Eastern night');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(night) || !Number.isFinite(Date.parse(`${night}T12:00:00Z`)) ||
        new Date(`${night}T12:00:00Z`).toISOString().slice(0, 10) !== night)
      throw new Error('Require an Eastern YYYY-MM-DD night');
    const result = assessNight({ current, baseline, rerun, commits, hostLoad, head,
      history, runId, firstBaseline, night, rerunAttempted: args.includes('--rerun') });
    if (errors.length) {
      result.pass = false;
      result.failures.push(...errors);
      result.needsRerun = !args.includes('--rerun');
      result.shouldAlert = !result.needsRerun;
      delete result.passingReport;
      result.text = result.text.replace(/: passed\n/, ': failed or skipped\n') + `\n${errors.join('\n')}`;
    }
    Object.assign(result, { runId, attempt, final: !result.needsRerun, recordedAt: new Date().toISOString(), report: result.measuredReport });
    // Capture the original baseline before last-pass advances, including migration from older rigs.
    const original = firstBaseline ?? result.passingReport;
    if (original) {
      try { await writeFile(`${stateDir}/first-pass.json`, JSON.stringify(original, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    await appendVerdict(historyPath, result);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(result, null, 2) + '\n');
    if (result.pass) {
      await mkdir(dirname(baselinePath), { recursive: true });
      const temp = `${baselinePath}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(result.passingReport, null, 2) + '\n');
      await rename(temp, baselinePath);
    }
    console.log(result.text);
    for (const row of Array.isArray(result.measuredReport?.rows) ? result.measuredReport.rows.filter(Boolean) : []) {
      const key = `${row.kind}/${row.name}/${row.variant}`;
      const failures = result.failures.filter((failure) => failure.startsWith(`${key}:`));
      console.log(`${key}: ${failures.length ? 'FAIL' : 'PASS'} n=${row.samples} p50=${row.p50Ms ?? 'unknown'}ms p95=${row.p95Ms}ms target<${row.budgetMs}ms${failures.length ? `; ${failures.join('; ')}` : ''}`);
    }
    if (!result.pass) process.exitCode = result.needsRerun ? 2 : 1;
  } finally { await rm(lock, { recursive: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
