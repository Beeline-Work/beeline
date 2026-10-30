#!/usr/bin/env node
/** End-to-end deterministic proof: comparator CLI → journal → GitHub contents payload. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const dir = await mkdtemp(join(tmpdir(), 'nightly-drift-proof-'));
const head = 'a'.repeat(40);
const script = (name) => fileURLToPath(new URL(name, import.meta.url));
await writeFile(join(dir, 'commits.json'), JSON.stringify([{ sha: head, subject: 'fixture' }]));
const run = (name, args, status) => {
  const result = spawnSync(process.execPath, [script(name), ...args], { encoding: 'utf8' });
  assert.equal(result.status, status, result.stderr || result.stdout);
};
const baseline = join(dir, 'last-pass.json');
let final;
for (const [index, p95Ms] of [100, 105, 110.25].entries()) {
  const report = { commit: head, complete: true, clockCalibrated: true, maxClockUncertaintyMs: 8,
    rows: [{ kind: 'route', name: 'room', variant: 'warm', samples: 20, p50Ms: p95Ms / 2, p95Ms, budgetMs: 450, timingPass: true, requestPass: true }] };
  const capture = join(dir, `capture-${index}.json`), out = join(dir, `night-${index}.json`);
  await writeFile(capture, JSON.stringify(report));
  const args = ['--baseline', baseline, '--current', capture, '--commits', join(dir, 'commits.json'), '--head', head,
    '--night', `2026-10-${28 + index}`, '--run-id', `creep-${index}`, '--out', out];
  run('./nightly-local.mjs', args, index === 2 ? 2 : 0);
  if (index === 2) run('./nightly-local.mjs', [...args, '--rerun', capture], 1);
  final = JSON.parse(await readFile(out));
}
assert.match(final.text, />10% cumulative slowdown/);
assert.equal(JSON.parse(await readFile(baseline)).rows[0].p95Ms, 105);
const history = (await readFile(join(dir, 'history.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
assert.equal(history.length, 4);
const current = { loops: [{ slug: 'latency', name: 'Latency loop', unit: 'ms', charts: [], fixes: [], log: [] }] };
await writeFile(join(dir, 'contents.json'), JSON.stringify({ sha: 'synthetic-sha', content: Buffer.from(JSON.stringify(current)).toString('base64') }));
run('./nightly-insights.mjs', ['--contents', join(dir, 'contents.json'), '--verdict', join(dir, 'night-2.json'), '--out', join(dir, 'put.json')], 0);
const request = JSON.parse(await readFile(join(dir, 'put.json')));
const loops = JSON.parse(Buffer.from(request.content, 'base64'));
assert.equal(loops.loops[0].charts[0].series[1].points[0].value, 110.25);
const receipt = { proof: 'not a defect report; new drift/history feature', inputP95Ms: [100,105,110.25],
  verdicts: history.map(({ night, attempt, pass, final }) => ({ night, attempt, pass, final })),
  originalBaselineP95Ms: JSON.parse(await readFile(join(dir, 'first-pass.json'))).rows[0].p95Ms,
  lastPassP95Ms: 105, finalText: final.text, publicationSHA: request.sha, chartedP95Ms: 110.25, evidence: dir };
await writeFile(join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt, null, 2));
