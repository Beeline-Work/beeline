#!/usr/bin/env node
/** Local reports are posted by the scheduled agent, never by a token or webhook. */
import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readHistory, appendVerdict, lockState, compareDrift, referenceNight, referenceNights, caseKey, easternDate } from './nightly-history.mjs';
import { compareNightly, mergedPrs, summarizeLoad, contention } from './nightly-compare.mjs';

export function assessNight({ current, baseline, commits = [], head, rerun, rerunAttempted = false, night, hostLoad = [], firstHostLoad = hostLoad, history = [], runId, firstBaseline }) {
  const references = referenceNights(history, { night, runId });
  const original = history.find((entry) => entry.night === references[0]?.night && entry.runId !== runId && referenceNight(entry))?.report;
  const fixed = [firstBaseline, original, baseline].find((report) => compareNightly(report).capture.pass);
  const evaluate = (report, observations) => {
    const result = compareNightly(report);
    if (report && report.commit !== head) result.capture.failures.push('Captured commit differs from the requested main head');
    result.capture.pass = result.capture.failures.length === 0;
    result.load = summarizeLoad(observations);
    result.contended = contention(result.load);
    const status = !result.capture.pass ? 'invalid' : result.contended === true ? 'contended' : result.contended === null ? 'missing-load' : undefined;
    result.regression = status ? { pass: null, status, rows: [], failures: [] } : compareDrift(report, history, { night, runId, firstBaseline: fixed });
    result.drift = result.regression;
    result.failures = [result.capture, result.budget, result.contract, result.regression].flatMap((item) => item.failures);
    if (status && status !== 'invalid') result.failures.push(`Regression not assessed: ${status}`);
    result.pass = result.capture.pass && result.budget.pass && result.contract.pass && result.regression.pass === true;
    return result;
  };
  const first = evaluate(current, firstHostLoad);
  const chosen = rerunAttempted ? rerun : current;
  const verdict = rerunAttempted ? evaluate(rerun, hostLoad) : first;
  const regressionFor = (entry) => entry.regression ?? compareDrift(entry.report, history, { night: entry.night, runId: entry.runId, firstBaseline: fixed });
  const lastClean = references.findLast((entry) => regressionFor(entry).pass === true)?.report ?? (compareNightly(baseline).capture.pass ? baseline : undefined);
  let prs = [], rangeError;
  if (lastClean?.commit) {
    try { prs = mergedPrs(commits, lastClean.commit, head); }
    catch { rangeError = 'PR range since last non-regressed valid run unavailable'; }
  }
  if (rangeError) { verdict.pass = false; verdict.failures.push(rangeError); }
  const previous = references.at(-1);
  const previousFlags = new Set(previous ? regressionFor(previous).rows.filter((row) => row.flags?.length).map((row) => row.key) : []);
  const repeated = verdict.regression.rows.filter((row) => row.flags.length && previousFlags.has(row.key));
  const contractCases = verdict.contract.rows.filter((row) => !row.pass).map((row) => row.key);
  const keys = new Set([...contractCases, ...repeated.map((row) => row.key)]);
  const comparisons = keys.size ? compareDrift(chosen, history, { night, runId, firstBaseline: fixed }).rows : [];
  const needsRerun = !verdict.pass && !rerunAttempted;
  const shouldAlert = !verdict.pass && rerunAttempted;
  const fixOrder = keys.size && !needsRerun ? {
    night, head, reasons: [...(contractCases.length ? ['request-contract'] : []), ...(repeated.length ? ['consecutive-regression'] : [])],
    cases: [...keys].map((key) => {
      const row = chosen.rows.find((row) => caseKey(row) === key);
      const drift = comparisons.find((row) => row.key === key);
      return { key, p95Ms: row.p95Ms ?? null, firstP95Ms: drift?.firstP95Ms ?? null, medianP95Ms: drift?.medianP95Ms ?? null,
        slowestPhase: row.slowestPhase ?? null };
    }),
    range: { base: lastClean?.commit ?? null, head, prs, available: !!lastClean?.commit && !rangeError },
  } : undefined;
  const text = [
    `Nightly squire emulator rig ${night}: ${verdict.pass ? 'passed' : needsRerun ? 'rerun required' : 'failed or skipped'}`,
    `Capture: ${verdict.capture.pass ? 'valid' : 'invalid'}; budget: ${verdict.budget.pass ? 'pass' : 'fail'}; contract: ${verdict.contract.pass ? 'pass' : 'fail'}; regression: ${verdict.regression.status === 'measured' ? verdict.regression.pass ? 'pass' : 'fail' : verdict.regression.status}`,
    ...verdict.failures,
    ...verdict.regression.rows.map((row) => `${row.key}: drift p95=${row.p95Ms} ms; first=${row.firstP95Ms ?? 'unavailable'} ms; recent median=${row.medianP95Ms ?? 'unavailable'} ms (${row.validNights}/7 prior valid uncontended nights)`),
    ...(Array.isArray(chosen?.rows) && chosen.rows.some((row) => row?.variant?.startsWith('push-')) && chosen.pushMeasurement ? [
      `Push measurement: ${chosen.pushMeasurement.measured}; native-response phase ${chosen.pushMeasurement.nativeResponsePhase}. Unmeasured: ${chosen.pushMeasurement.excluded}.`,
    ] : []),
    lastClean?.commit ? `PRs since last non-regressed valid run (${lastClean.commit}): ${prs.length ? prs.map((n) => `#${n}`).join(', ') : 'none identified'}` : 'No valid reference yet; PR regression range unavailable',
    `Measured main: ${head}`,
    `Host load: mean=${verdict.load.mean ?? 'missing'}, max=${verdict.load.max ?? 'missing'}, cpus=${verdict.load.cpus ?? 'missing'}; contended=${verdict.contended ?? 'unknown'}`,
  ].join('\n');
  return { ...verdict, night, head, prs, needsRerun, shouldAlert, hostLoad, fixOrder,
    firstAttempt: first, text, measuredReport: chosen, passingReport: verdict.pass ? chosen : undefined };
}

async function writeFixOrder(output, verdict) {
  const path = `${dirname(output)}/fix-order.json`;
  if (verdict.fixOrder) await writeFile(path, JSON.stringify(verdict.fixOrder, null, 2) + '\n');
  else await rm(path, { force: true });
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
      await writeFixOrder(output, history.findLast((entry) => entry.runId === runId && entry.final) ?? previous);
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
    const candidates = [await load(`${stateDir}/first-valid.json`, 'First valid baseline'),
      await load(`${stateDir}/first-pass.json`, 'First passing baseline'), history.find(referenceNight)?.report, baseline];
    const firstBaseline = candidates.find((report) => compareNightly(report).capture.pass);
    const current = await load(option('--current'), 'New report');
    const rerun = await load(option('--rerun'), 'Rerun report');
    const commits = await load(option('--commits'), 'Commit range');
    const hostLoad = await load(option('--load'), 'Host load') ?? [];
    const firstHostLoad = await load(option('--first-load'), 'First host load') ?? hostLoad;
    const priorRun = history.find((entry) => entry.runId === runId);
    const night = priorRun?.night ?? option('--night') ?? easternDate(option('--started-at') ?? new Date());
    if (priorRun && (priorRun.head !== head || (option('--night') && option('--night') !== night)))
      throw new Error('Run identity must retain its original head and Eastern night');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(night) || !Number.isFinite(Date.parse(`${night}T12:00:00Z`)) ||
        new Date(`${night}T12:00:00Z`).toISOString().slice(0, 10) !== night)
      throw new Error('Require an Eastern YYYY-MM-DD night');
    const result = assessNight({ current, baseline, rerun, commits, hostLoad, firstHostLoad, head,
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
    // Preserve the first reference across migration; new references need valid idle captures.
    const eligible = referenceNight(result);
    const original = firstBaseline ?? (eligible ? result.report : undefined);
    if (original) {
      for (const name of ['first-valid.json', 'first-pass.json']) {
        try { await writeFile(`${stateDir}/${name}`, JSON.stringify(original, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
    }
    await appendVerdict(historyPath, result);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(result, null, 2) + '\n');
    await writeFixOrder(output, result);
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
