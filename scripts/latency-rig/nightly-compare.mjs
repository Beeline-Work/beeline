/** Capture, strict budgets and request contracts are independent verdicts. */
import { MAX_CLOCK_UNCERTAINTY_MS } from './device-clock.mjs';

export function summarizeLoad(observations) {
  if (!Array.isArray(observations)) return { mean: observations?.mean ?? null, max: observations?.max ?? null, cpus: observations?.cpus ?? null };
  const samples = observations.filter((item) => Number.isFinite(item?.load?.[0]) && item.load[0] >= 0 &&
    Number.isFinite(item.cpus) && item.cpus > 0);
  if (!samples.length) return { mean: null, max: null, cpus: null };
  const values = samples.map((item) => item.load[0]);
  return { mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    max: Math.max(...values), cpus: Math.min(...samples.map((item) => item.cpus)) };
}
export function contention(load) {
  return Number.isFinite(load?.mean) && load.mean >= 0 && Number.isFinite(load?.max) && load.max >= load.mean &&
    Number.isFinite(load?.cpus) && load.cpus > 0 ? load.mean > 0.5 * load.cpus : null;
}
export function compareNightly(current) {
  const capture = { pass: true, failures: [] }, budget = { pass: true, failures: [] }, contract = { pass: true, failures: [] };
  const rows = Array.isArray(current?.rows) ? current.rows : [];
  const calibrated = (report) => report?.clockCalibrated === true &&
    Number.isFinite(report.maxClockUncertaintyMs) && report.maxClockUncertaintyMs >= 0 &&
    report.maxClockUncertaintyMs <= MAX_CLOCK_UNCERTAINTY_MS;
  if (!rows.length || rows.some((row) => !row || typeof row !== 'object')) capture.failures.push('Capture skipped or produced no measured cases');
  if (!calibrated(current)) capture.failures.push('Capture lacks verified device/host clock calibration');
  if (current?.complete !== true) capture.failures.push('Required case coverage is incomplete');
  if (current?.setupError) capture.failures.push('Capture setup failed');
  budget.rows = []; contract.rows = [];
  for (const row of rows.filter((row) => row && typeof row === 'object')) {
    const key = `${row.kind}/${row.name}/${row.variant}`;
    if (!Number.isFinite(row.samples) || row.samples < 20 || !Number.isFinite(row.p95Ms) || row.p95Ms < 0 || row.timedOutSamples > 0)
      capture.failures.push(`${key}: fewer than 20 completed valid samples or timed out`);
    const budgetPass = Number.isFinite(row.budgetMs) && row.budgetMs === (row.kind === 'route' ? 450 : row.kind === 'tap' ? 150 : -1) &&
      row.p95Ms < row.budgetMs && row.timingPass === true;
    budget.rows.push({ key, p95Ms: row.p95Ms, budgetMs: row.budgetMs, pass: budgetPass });
    if (!budgetPass) budget.failures.push(`${key}: budget exceeded (${row.p95Ms} ms; budget <${row.budgetMs} ms)`);
    contract.rows.push({ key, pass: row.requestPass === true });
    if (row.requestPass !== true) contract.failures.push(`${key}: request contract failed`);
  }
  for (const result of [capture, budget, contract]) result.pass = result.failures.length === 0;
  const failures = [capture, budget, contract].flatMap((result) => result.failures);
  return { pass: failures.length === 0, failures, capture, budget, contract };
}

/** The caller supplies the complete first-parent range, excluding the reference base. */
export function mergedPrs(commits, baselineSha, headSha) {
  if (!baselineSha || !headSha) throw new Error('Reference and measured head SHAs required');
  const baseIndex = commits.findIndex((commit) => commit.sha === baselineSha);
  const headIndex = commits.findIndex((commit) => commit.sha === headSha);
  if (baseIndex < 0 || headIndex < 0 || headIndex > baseIndex) throw new Error('Incomplete or non-ancestor PR range');
  return [...new Set(commits.slice(headIndex, baseIndex).flatMap((commit) => {
    const match = /(?:\(#(\d+)\)\s*$|^Merge pull request #(\d+)\b)/.exec(commit.subject);
    return match ? [Number(match[1] ?? match[2])] : [];
  }))];
}
