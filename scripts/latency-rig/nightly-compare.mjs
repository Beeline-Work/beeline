/** Compare each measured case with the last passing run; never advance on failure. */
import { MAX_CLOCK_UNCERTAINTY_MS } from './device-clock.mjs';

export function compareNightly(current, baseline) {
  if (!Array.isArray(current?.rows) || !current.rows.length || current.rows.some((row) => !row || typeof row !== 'object')) return { pass: false, failures: ['Capture skipped or produced no measured cases'] };
  const failures = [];
  const calibrated = (report) => report.clockCalibrated === true &&
    Number.isFinite(report.maxClockUncertaintyMs) && report.maxClockUncertaintyMs >= 0 &&
    report.maxClockUncertaintyMs <= MAX_CLOCK_UNCERTAINTY_MS;
  if (!calibrated(current)) failures.push('Capture lacks verified device/host clock calibration');
  if (baseline && !calibrated(baseline)) failures.push('Passing baseline lacks verified device/host clock calibration');
  if (baseline && (!Array.isArray(baseline.rows) || !baseline.rows.length))
    return { pass: false, failures: ['Passing baseline is invalid'] };
  for (const row of current.rows) {
    const key = `${row.kind}/${row.name}/${row.variant}`;
    if (row.samples < 20 || !Number.isFinite(row.p95Ms) || row.p95Ms < 0)
      failures.push(`${key}: fewer than 20 valid samples`);
    if (!Number.isFinite(row.budgetMs) || row.budgetMs !== (row.kind === 'route' ? 450 : row.kind === 'tap' ? 150 : -1) ||
        row.p95Ms >= row.budgetMs || row.timingPass !== true || row.requestPass !== true)
      failures.push(`${key}: budget exceeded (${row.p95Ms} ms; budget <${row.budgetMs} ms)`);
    const previous = baseline?.rows?.find((item) => item.kind === row.kind && item.name === row.name && item.variant === row.variant);
    if (previous && row.p95Ms > previous.p95Ms * 1.2)
      failures.push(`${key}: >20% slower (${previous.p95Ms} → ${row.p95Ms} ms p95)`);
  }
  if (current.complete !== true) failures.push('Required case coverage is incomplete');
  for (const previous of baseline?.rows ?? []) {
    if (!current.rows.some((row) => row.kind === previous.kind && row.name === previous.name && row.variant === previous.variant))
      failures.push(`Missing baseline case: ${previous.kind}/${previous.name}/${previous.variant}`);
  }
  return { pass: failures.length === 0, failures };
}

/** The caller supplies the complete first-parent range, excluding the passing base. */
export function mergedPrs(commits, baselineSha, headSha) {
  if (!baselineSha || !headSha) throw new Error('Last passing baseline and measured head SHAs required');
  const baseIndex = commits.findIndex((commit) => commit.sha === baselineSha);
  const headIndex = commits.findIndex((commit) => commit.sha === headSha);
  if (baseIndex < 0 || headIndex < 0 || headIndex > baseIndex) throw new Error('Incomplete or non-ancestor PR range');
  return [...new Set(commits.slice(headIndex, baseIndex).flatMap((commit) => {
    const match = /(?:\(#(\d+)\)\s*$|^Merge pull request #(\d+)\b)/.exec(commit.subject);
    return match ? [Number(match[1] ?? match[2])] : [];
  }))];
}
