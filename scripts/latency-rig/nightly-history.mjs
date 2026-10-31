/** Append-only verdict journal. Only final passing nights are drift references. */
import { readFile, open, mkdir } from 'node:fs/promises';

export const caseKey = (row) => `${row.kind}/${row.name}/${row.variant}`;
export function easternDate(instant) {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid run timestamp');
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
export async function readHistory(path) {
  try { return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
export async function appendVerdict(path, entry) {
  const file = await open(path, 'a', 0o600);
  try { await file.writeFile(JSON.stringify(entry) + '\n'); await file.sync(); }
  finally { await file.close(); }
}
export async function lockState(path) {
  try { await mkdir(path); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`Rig state is locked: ${path}; verify no writer is running before removing a stale lock`); throw error; }
}
export function compareDrift(current, history, { night, runId, firstBaseline } = {}) {
  // A second invocation on the same date cannot count as another passing night.
  const nights = new Map();
  for (const entry of history) {
    if (entry.final && entry.pass && entry.night < night && entry.runId !== runId)
      nights.set(entry.night, entry);
  }
  const passing = [...nights.values()].sort((a, b) => a.night.localeCompare(b.night));
  const first = firstBaseline ?? passing[0]?.report;
  const recent = passing.slice(-7);
  const failures = [], rows = [];
  for (const row of Array.isArray(current?.rows) ? current.rows : []) {
    if (!row || !Number.isFinite(row.p95Ms)) continue;
    const key = caseKey(row);
    const original = first?.rows?.find((item) => caseKey(item) === key)?.p95Ms;
    const values = recent.map((entry) => entry.report?.rows?.find((item) => caseKey(item) === key)?.p95Ms)
      .filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    const median = values.length ? values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2 : undefined;
    for (const [label, value] of [['first passing baseline', original], ['median of prior passing nights', median]]) {
      // Difference form avoids treating exactly 10% as a regression due to division rounding.
      if (Number.isFinite(value) && row.p95Ms - value > value * 0.1 + Number.EPSILON * Math.max(1, row.p95Ms) * 4)
        failures.push(`${key}: >10% cumulative slowdown against ${label} (${value} → ${row.p95Ms} ms p95)`);
    }
    rows.push({ key, p95Ms: row.p95Ms, firstP95Ms: original ?? null, medianP95Ms: median ?? null, passingNights: values.length });
  }
  return { rows, failures };
}
