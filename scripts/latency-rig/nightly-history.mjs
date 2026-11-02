/** Append-only verdict journal. Final valid, uncontended nights are drift references. */
import { readFile, open, mkdir } from 'node:fs/promises';
import { compareNightly, summarizeLoad, contention } from './nightly-compare.mjs';

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
export function referenceNight(entry) {
  if (!entry.final || !compareNightly(entry.report).capture.pass || entry.capture?.pass === false ||
      (entry.head && entry.report.commit !== entry.head)) return false;
  // Old passing journals predate load summaries; retain their established references.
  const legacy = !entry.capture && entry.pass && !entry.load && !entry.hostLoad?.length;
  return legacy || (entry.contended !== true && contention(summarizeLoad(entry.load ?? entry.hostLoad)) === false);
}
export function referenceNights(history, { night, runId } = {}) {
  const nights = new Map();
  for (const entry of history) {
    if (referenceNight(entry) && entry.night < night && entry.runId !== runId) nights.set(entry.night, entry);
  }
  return [...nights.values()].sort((a, b) => a.night.localeCompare(b.night));
}
export function compareDrift(current, history, { night, runId, firstBaseline } = {}) {
  const valid = referenceNights(history, { night, runId });
  const first = firstBaseline ?? history.find((entry) => entry.night === valid[0]?.night &&
    entry.runId !== runId && referenceNight(entry))?.report;
  const recent = valid.slice(-7);
  const failures = [], rows = [];
  for (const row of Array.isArray(current?.rows) ? current.rows : []) {
    if (!row || !Number.isFinite(row.p95Ms)) continue;
    const key = caseKey(row);
    const original = first?.rows?.find((item) => caseKey(item) === key)?.p95Ms;
    const values = recent.map((entry) => entry.report?.rows?.find((item) => caseKey(item) === key)?.p95Ms)
      .filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    const median = values.length ? values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2 : undefined;
    const flags = [];
    for (const [label, value, fraction] of [['first valid baseline', original, 0.1], ['median of prior valid nights', median, 0.2]]) {
      // Difference form keeps the exact threshold from failing due to rounding.
      if (Number.isFinite(value) && row.p95Ms - value > value * fraction + Number.EPSILON * Math.max(1, row.p95Ms) * 4) {
        flags.push(label);
        failures.push(`${key}: >${fraction * 100}% ${fraction === 0.1 ? 'cumulative slowdown' : 'slowdown'} against ${label} (${value} → ${row.p95Ms} ms p95)`);
      }
    }
    rows.push({ key, p95Ms: row.p95Ms, firstP95Ms: original ?? null, medianP95Ms: median ?? null, validNights: values.length, flags });
  }
  return { pass: failures.length === 0, status: 'measured', rows, failures };
}
