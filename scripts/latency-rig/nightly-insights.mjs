#!/usr/bin/env node
/** Credential-free Loops projection. The scheduled agent sends the prepared PUT through Squire. */
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { caseKey } from './nightly-history.mjs';
import { MAX_CLOCK_UNCERTAINTY_MS } from './device-clock.mjs';

export function latencyLoops(current, verdict, updatedAt = new Date().toISOString()) {
  if (!verdict.final) throw new Error('Only a final nightly verdict may be published');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(verdict.night)) throw new Error('Verdict needs an Eastern calendar date');
  const result = structuredClone(current);
  const loop = result.loops?.find((item) => item.slug === 'latency');
  if (!loop || !Array.isArray(loop.charts)) throw new Error('Missing latency loop charts');
  const report = verdict.report;
  const measured = report?.commit === verdict.head && report.complete === true && report.clockCalibrated === true &&
    Number.isFinite(report.maxClockUncertaintyMs) && report.maxClockUncertaintyMs >= 0 && report.maxClockUncertaintyMs <= MAX_CLOCK_UNCERTAINTY_MS;
  const rows = measured ? (report.rows ?? []).filter((row) => row && row.samples >= 20 &&
    Number.isFinite(row.p50Ms) && row.p50Ms >= 0 && Number.isFinite(row.p95Ms) && row.p95Ms >= row.p50Ms) : [];
  for (const row of rows) {
    const key = caseKey(row);
    const seriesKey = (percentile) => `case:${key}:${percentile}`;
    let chart = loop.charts.find((chart) => chart.series.some((series) => series.key === seriesKey('p50')));
    if (!chart) {
      chart = { label: `${key}: nightly p50 (solid) and p95 (dotted), ms`, series: [
        { key: seriesKey('p50'), label: 'p50', style: 'solid', points: [] },
        { key: seriesKey('p95'), label: 'p95', style: 'dotted', points: [] },
      ] };
      loop.charts.push(chart);
      loop.limits ??= [];
      loop.limits.push({ series: seriesKey('p50'), value: row.budgetMs, label: `limit ${row.budgetMs} ms` });
    }
    for (const percentile of ['p50', 'p95']) {
      const series = chart.series.find((series) => series.key === seriesKey(percentile));
      series.points = [...series.points.filter((point) => point.date !== verdict.night),
        { date: verdict.night, value: row[`${percentile}Ms`] }].sort((a, b) => a.date.localeCompare(b.date));
    }
  }
  const note = rows.length ? `Measured ${rows.length} local emulator cases on ${verdict.night}; ${verdict.pass ? 'PASS' : 'FAIL'}. Per-case p50/p95 are measured native-frame timings, not production phone timings.` :
    `No usable capture on ${verdict.night}; no latency point added. Next measurement: the next scheduled 03:00 Eastern run.`;
  loop.note = note;
  loop.log ??= [];
  loop.log = [{ date: verdict.night, text: `${note} Run ${verdict.runId}. ${verdict.failures.join('; ')}` },
    ...loop.log.filter((entry) => entry.date !== verdict.night)];
  result.updatedAt = updatedAt;
  return result;
}

export function prepareInsights(contents, verdict, updatedAt) {
  const current = JSON.parse(Buffer.from(contents.content, 'base64').toString('utf8'));
  if (!contents.sha) throw new Error('GitHub contents SHA required for optimistic concurrency');
  return { message: `Record latency night ${verdict.night}`, branch: 'main', sha: contents.sha,
    content: Buffer.from(JSON.stringify(latencyLoops(current, verdict, updatedAt), null, 2) + '\n').toString('base64') };
}

/** Transport stays with the first-party connection; conflicts always re-read and re-project. */
export async function publishInsights(transport, verdict) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const contents = await transport.read();
    const response = await transport.write(prepareInsights(contents, verdict));
    if (response.status >= 200 && response.status < 300) return response;
    if (response.status !== 409) throw new Error(`Insights publication failed (${response.status})`);
  }
  throw new Error('Insights publication conflicted three times; retry with a fresh contents read');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const option = (key) => args[args.indexOf(key) + 1];
  if (!['--contents', '--verdict', '--out'].every((key) => args.includes(key))) throw new Error('Require --contents, --verdict and --out');
  const contents = JSON.parse(await readFile(option('--contents'), 'utf8'));
  const verdict = JSON.parse(await readFile(option('--verdict'), 'utf8'));
  await writeFile(option('--out'), JSON.stringify(prepareInsights(contents, verdict), null, 2) + '\n');
}
