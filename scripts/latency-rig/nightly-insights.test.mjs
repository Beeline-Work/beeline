import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { latencyLoops, prepareInsights, publishInsights } from './nightly-insights.mjs';
const capture = JSON.parse(await readFile(new URL('./fixtures/night-2026-10-30-report.json', import.meta.url)));
const loops = () => ({ updatedAt: '2026-10-29T12:00:00Z', loops: [{ slug: 'ci', charts: [], note: 'keep me' },
  { slug: 'latency', charts: [{ series: [{ key: 'actions', points: [{ date: '2026-10-29', value: 42 }] }] }], fixes: [{ title: 'keep fix' }], log: [] }] });
const verdict = { head: capture.commit, runId: 'night-2026-10-30-EG85he', night: '2026-10-30', pass: false, final: true, report: capture, failures: ['budget exceeded'] };
const contents = (document, sha = 'original') => ({ sha, content: Buffer.from(JSON.stringify(document)).toString('base64') });
test('real completed failed capture publishes measured per-case p50/p95 without altering other loops or existing series', () => {
  const before = loops(), after = latencyLoops(before, verdict);
  assert.deepEqual(after.loops[0], before.loops[0]);
  const latency = after.loops[1];
  assert.deepEqual(latency.charts[0], before.loops[1].charts[0]);
  assert.deepEqual(latency.fixes, before.loops[1].fixes);
  assert.equal(latency.charts.length, 7);
  for (const row of capture.rows) {
    for (const percentile of ['p50', 'p95']) {
      const series = latency.charts.flatMap((chart) => chart.series).find((series) => series.key === `case:${row.kind}/${row.name}/${row.variant}:${percentile}`);
      assert.deepEqual(series.points, [{ date: '2026-10-30', value: row[`${percentile}Ms`] }]);
    }
  }
  const updated = structuredClone(verdict); updated.report.rows[0].p50Ms = 470;
  const retry = latencyLoops(after, updated);
  assert.equal(retry.loops[1].charts[1].series[0].points.length, 1);
  assert.equal(retry.loops[1].charts[1].series[0].points[0].value, 470);
  assert.equal(retry.loops[1].log.length, 1);
  const nextNight = latencyLoops(retry, { ...updated, night: '2026-10-31', runId: 'next-night' });
  assert.deepEqual(nextNight.loops[1].charts[1].series[0].points.map((point) => point.date), ['2026-10-30', '2026-10-31']);
  assert.match(retry.loops[1].note, /Measured 6.*FAIL/);
});
test('missing, uncalibrated, stale and incomplete capture adds no points and provisional verdict is refused', () => {
  for (const report of [undefined, { ...capture, complete: false }, { ...capture, clockCalibrated: false }, { ...capture, commit: 'stale' }]) {
    const before = latencyLoops(loops(), verdict);
    const after = latencyLoops(before, { ...verdict, night: '2026-10-31', report });
    assert.deepEqual(after.loops[1].charts, before.loops[1].charts);
    assert.match(after.loops[1].note, /No usable capture/);
  }
  assert.throws(() => latencyLoops(loops(), { ...verdict, final: false }), /final/);
  assert.throws(() => prepareInsights({ content: contents(loops()).content }, verdict), /SHA/);
});
test('optimistic conflict re-reads and preserves a concurrent unrelated edit', async () => {
  let document = loops(), sha = 'a', reads = 0, writes = 0;
  await publishInsights({
    read: async () => { reads++; return contents(document, sha); },
    write: async (request) => {
      writes++;
      if (writes === 1) { document.loops[0].note = 'concurrent writer'; sha = 'b'; return { status: 409 }; }
      assert.equal(request.sha, 'b');
      document = JSON.parse(Buffer.from(request.content, 'base64'));
      return { status: 200 };
    },
  }, verdict);
  assert.equal(reads, 2);
  assert.equal(document.loops[0].note, 'concurrent writer');
  assert.equal(document.loops[1].charts.length, 7);
  await assert.rejects(publishInsights({ read: async () => contents(loops()), write: async () => ({ status: 403 }) }, verdict), /403/);
  await assert.rejects(publishInsights({ read: async () => contents(loops()), write: async () => ({ status: 409 }) }, verdict), /three times/);
});
test('actual nightly CLI to history to sealed-API request body with the inherited clean run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'latency-insights-'));
  const script = (name) => fileURLToPath(new URL(name, import.meta.url));
  try {
    const report = join(dir, 'capture.json'), output = join(dir, 'nightly.json'), snapshot = join(dir, 'contents.json'), request = join(dir, 'put.json');
    await writeFile(report, JSON.stringify(capture));
    const result = spawnSync(process.execPath, [script('./nightly-local.mjs'), '--current', report, '--rerun', report,
      '--baseline', join(dir, 'last-pass.json'), '--out', output, '--head', capture.commit,
      '--run-id', verdict.runId, '--started-at', '2026-10-31T02:00:00Z'], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    const recorded = JSON.parse(await readFile(output));
    assert.equal(recorded.night, '2026-10-30');
    assert.equal(recorded.final, true);
    assert.deepEqual(recorded.report, capture);
    assert.equal((await readFile(join(dir, 'history.jsonl'), 'utf8')).trim().split('\n').length, 1);
    await assert.rejects(readFile(join(dir, 'last-pass.json')), { code: 'ENOENT' });
    await writeFile(snapshot, JSON.stringify(contents(loops())));
    const prepared = spawnSync(process.execPath, [script('./nightly-insights.mjs'), '--contents', snapshot, '--verdict', output, '--out', request], { encoding: 'utf8' });
    assert.equal(prepared.status, 0, prepared.stderr);
    const body = JSON.parse(await readFile(request));
    assert.equal(body.sha, 'original');
    const published = JSON.parse(Buffer.from(body.content, 'base64'));
    assert.equal(published.loops[1].charts[1].series[0].points[0].value, 472);
    assert.equal(published.loops[1].charts[6].series[1].points[0].value, 178);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
