#!/usr/bin/env node
/** Correlate opt-in route content-frame marks with an in-app tap or route commit. */
import { readFile, writeFile } from 'node:fs/promises';

const [input, output, variant = 'warm', overrideName] = process.argv.slice(2);
if (!input || !output || !['cold', 'warm'].includes(variant))
  throw new Error('usage: route-marks.mjs logcat.txt moments.ndjson [cold|warm] [route-name]');
const starts = [];
const moments = [];
let candidates = 0;
const usedNavigation = new Set();
const routeMatches = (template, actual) => {
  if (typeof template !== 'string' || typeof actual !== 'string') return false;
  const expected = template.split('/'), observed = actual.split('/');
  return expected.length === observed.length && expected.every((part, index) =>
    /^\[[^/]+\]$/.test(part) || part === observed[index]);
};
for (const line of (await readFile(input, 'utf8')).split(/\r?\n/)) {
  const epoch = /^\s*(\d{10})\.(\d{3})\s/.exec(line);
  const match = /\[LATENCY_FRAME\]\s*(\{.*\})/.exec(line);
  if (!epoch || !match) continue;
  let mark;
  try { mark = JSON.parse(match[1]); } catch { continue; }
  const atMs = Number(epoch[1]) * 1000 + Number(epoch[2]);
  if ((mark.kind === 'tap' && mark.phase === 'start') ||
      (mark.kind === 'route' && mark.phase === 'navigation-commit')) {
    starts.push({ ...mark, atMs });
    continue;
  }
  if (mark.kind !== 'route' || !['frame-candidate', 'meaningful-frame'].includes(mark.phase)) continue;
  if (mark.phase === 'frame-candidate') { candidates++; continue; }
  const navigation = starts.findLast((item) => item.kind === 'route' &&
    typeof item.t === 'number' && item.t <= mark.t && mark.t - item.t <= 5_000 &&
    routeMatches(mark.route, item.route) && !usedNavigation.has(item));
  if (!navigation) continue;
  usedNavigation.add(navigation);
  const touch = starts.findLast((item) => item.kind === 'tap' &&
    typeof item.t === 'number' && item.t <= navigation.t &&
    navigation.t - item.t <= 1_000);
  const start = touch ?? navigation;
  const name = overrideName ?? mark.route;
  const paintMs = start.atMs + mark.t - start.t;
  moments.push({ kind: 'route', name, variant, startMs: start.atMs,
    paintMs, endMs: Math.max(paintMs, atMs) + 100,
    startSource: start.kind === 'tap' ? 'touch' : 'route-commit' });
}
await writeFile(output, moments.map(JSON.stringify).join('\n') + (moments.length ? '\n' : ''));
console.log(`Extracted ${moments.length} meaningful route frames; ${candidates} candidates need content verification.`);
