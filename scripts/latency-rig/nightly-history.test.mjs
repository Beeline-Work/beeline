import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareDrift, easternDate, readHistory } from './nightly-history.mjs';
import { assessNight } from './nightly-local.mjs';
const head = 'a'.repeat(40);
const report = (value) => ({ commit: head, complete: true, clockCalibrated: true, maxClockUncertaintyMs: 8,
  rows: [{ kind: 'route', name: 'room', variant: 'warm', samples: 20, p50Ms: value / 2, p95Ms: value, budgetMs: 450, timingPass: true, requestPass: true }] });
const entry = (day, value, extra = {}) => ({ night: `2026-10-${String(day).padStart(2, '0')}`, runId: `run-${day}`, pass: true, final: true, report: report(value), ...extra });
const context = { night: '2026-10-20', runId: 'current' };
test('last seven distinct prior passing nights, original baseline, case matching and exclusions', () => {
  const history = Array.from({ length: 10 }, (_, i) => entry(i + 1, (i + 1) * 10));
  history.push(entry(11, 999, { pass: false }), entry(12, 999, { final: false }), entry(20, 999), entry(21, 999));
  history.push(entry(13, 999, { runId: 'current' }));
  history.push(entry(10, 100)); // same calendar night is one reference
  const result = compareDrift(report(110), history, context);
  assert.equal(result.rows[0].medianP95Ms, 70);
  assert.equal(result.rows[0].firstP95Ms, 10);
  assert.equal(result.rows[0].passingNights, 7);
  const mismatch = report(90); mismatch.rows[0].variant = 'cold';
  assert.deepEqual(compareDrift(mismatch, history, context).rows[0], { key: 'route/room/cold', p95Ms: 90, firstP95Ms: null, medianP95Ms: null, passingNights: 0 });
});
test('exact ten percent, just above, zero, and insufficient history', () => {
  const history = [entry(1, 100)];
  assert.equal(compareDrift(report(110), history, context).failures.length, 0);
  assert.equal(compareDrift(report(110.0001), history, context).failures.length, 2);
  assert.equal(compareDrift(report(1), [entry(1, 0)], context).failures.length, 2);
  assert.equal(compareDrift(report(100), [], context).rows[0].passingNights, 0);
  assert.equal(compareDrift(report(100), [], context).failures.length, 0);
  assert.equal(compareDrift(report(101), [entry(1, 100), entry(2, 102)], context).rows[0].medianP95Ms, 101);
});
test('five percent nightly creep trips cumulative drift while last-pass comparison stays under twenty percent', () => {
  const history = [entry(1, 100), entry(2, 105)];
  const result = assessNight({ current: report(110.25), baseline: report(105), commits: [{ sha: head, subject: 'same' }],
    head, ...context, history, rerun: report(110.25), rerunAttempted: true });
  assert.equal(result.shouldAlert, true);
  assert.match(result.text, />10% cumulative slowdown against first passing baseline/);
  assert.doesNotMatch(result.text, />20% slower/);
});
test('journal preserves every verdict, immutable duplicate identities, reruns, skipped nights and original baseline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'night-history-'));
  const baseline = join(dir, 'last-pass.json'), output = join(dir, 'nightly.json'), capture = join(dir, 'report.json');
  const range = join(dir, 'commits.json');
  const run = (id, extra = []) => spawnSync(process.execPath, [fileURLToPath(new URL('./nightly-local.mjs', import.meta.url)),
    '--baseline', baseline, '--current', capture, '--out', output, '--commits', range, '--head', head,
    '--run-id', id, '--started-at', '2026-10-21T02:30:00Z', ...extra], { encoding: 'utf8' });
  try {
    await writeFile(range, JSON.stringify([{ sha: head, subject: 'same' }]));
    assert.equal(run('skip').status, 2);
    // The first entry freezes the date; rerun without --night retains it.
    assert.equal(run('skip', ['--rerun', capture]).status, 1);
    assert.equal(JSON.parse(await readFile(output)).night, '2026-10-20');
    const skipped = await readFile(join(dir, 'history.jsonl'), 'utf8');
    assert.equal(run('skip', ['--rerun', capture]).status, 1);
    assert.equal(await readFile(join(dir, 'history.jsonl'), 'utf8'), skipped);
    await writeFile(capture, JSON.stringify(report(100)));
    assert.equal(run('pass').status, 0);
    const original = await readFile(join(dir, 'first-pass.json'), 'utf8');
    await writeFile(capture, JSON.stringify(report(105)));
    assert.equal(run('pass-again', ['--night', '2026-10-21']).status, 0);
    assert.equal(await readFile(join(dir, 'first-pass.json'), 'utf8'), original);
    await writeFile(capture, JSON.stringify(report(120)));
    assert.equal(run('fail', ['--night', '2026-10-22']).status, 2);
    assert.equal(run('fail', ['--night', '2026-10-22', '--rerun', capture]).status, 1);
    const history = await readHistory(join(dir, 'history.jsonl'));
    assert.equal(history.length, 6);
    assert.equal(history[0].night, '2026-10-20');
    assert.deepEqual(history.map((item) => [item.pass, item.final]), [[false,false], [false,true], [true,true], [true,true], [false,false], [false,true]]);
    assert.equal(JSON.parse(await readFile(baseline)).rows[0].p95Ms, 105);
    // A crash between append and baseline replacement is repaired by any invocation.
    await writeFile(baseline, JSON.stringify(report(1)));
    assert.equal(run('pass').status, 0);
    assert.equal(JSON.parse(await readFile(baseline)).rows[0].p95Ms, 105);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('Eastern dates include DST transitions', () => {
  assert.equal(easternDate('2026-10-31T02:00:00Z'), '2026-10-30');
  assert.equal(easternDate('2026-11-02T04:30:00Z'), '2026-11-01');
});
