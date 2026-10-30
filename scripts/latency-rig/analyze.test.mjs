import test from 'node:test';
import assert from 'node:assert/strict';
import { percentile, serialDepth, summarize, summarizeSample, markdown } from './analyze.mjs';
import { checkRoutes, routeForFile } from './check-routes.mjs';

test('counts independent network requests at one RTT depth', () => {
  assert.equal(serialDepth([
    { startMs: 0, endMs: 100 },
    { startMs: 10, endMs: 80 },
    { startMs: 100, endMs: 180 },
  ]), 2);
  assert.equal(serialDepth([]), 0);
});

test('an optional request before Room draw fails even within the cold request budget', () => {
  for (const operation of ['/v1/phone/operations/readStarPrompt', '/v1/phone/workspaces/w',
    '/v1/phone/workspaces/w/chats', '/v1/phone/rooms/r/read', '/v1/phone/observations/page-load']) {
    const sample = { kind: 'route', name: '/beeline/chat/[channelId]', variant: 'cold',
      clockDomain: 'host', startMs: 0, paintMs: 100,
      http: [{ operation, startMs: 10, endMs: 110 }] };
    const routes = [{ path: sample.name, variants: ['cold'], coldHttpMax: 1, coldDepthMax: 1 }];
    assert.equal(summarize([sample], routes).requestPass, false, operation);
    sample.http[0].startMs = 101;
    assert.equal(summarize([sample], routes).requestPass, true, operation);
  }
});

test('nearest rank p95 exposes one slow sample in twenty', () => {
  assert.equal(percentile([...Array(19).fill(10), 100], .95), 10);
  assert.equal(percentile([...Array(18).fill(10), 99, 100], .95), 99);
});

test('separates prepaint HTTP, frames, bytes and per-operation SQL spans', () => {
  const sample = summarizeSample({ kind: 'route', name: '/beeline/channels', variant: 'cold',
    startMs: 100, paintMs: 320, canonicalMs: 350,
    http: [
      { startMs: 110, endMs: 210, requestBytes: 20, responseBytes: 400 },
      { startMs: 220, endMs: 300, requestBytes: 10, responseBytes: 100 },
      { startMs: 330, endMs: 390, requestBytes: 5, responseBytes: 40 },
    ],
    ws: [{ startMs: 250, endMs: 250, bytes: 75 }],
    sql: [
      { operation: 'phone.chats', startMs: 120, endMs: 150, poolWaitMs: 4 },
      { operation: 'phone.chats', startMs: 155, endMs: 190, poolWaitMs: 2 },
    ],
  });
  assert.equal(sample.paintMs, 220);
  assert.equal(sample.prepaintHttpCount, 2);
  assert.equal(sample.prepaintHttpDepth, 2);
  assert.equal(sample.httpCount, 3);
  assert.equal(sample.httpResponseBytes, 540);
  assert.equal(sample.wsMessages, 1);
  assert.equal(sample.wsFrames, 0);
  assert.deepEqual(sample.sqlOperations['phone.chats'], { count: 2, depth: 2, poolWaitMs: 6 });
});

test('fails missing screens and route/interaction timing or network budgets', () => {
  const routes = [
    { path: '/beeline/channels', coldHttpMax: 1, coldDepthMax: 1 },
    { path: '/beeline/tray', coldHttpMax: 1, coldDepthMax: 1 },
  ];
  const report = summarize([{ kind: 'route', name: '/beeline/channels', variant: 'cold',
    startMs: 0, paintMs: 451, http: [
      { startMs: 0, endMs: 100 }, { startMs: 110, endMs: 210 },
    ] }], routes, ['send-text']);
  assert.deepEqual(report.missingRoutes, ['/beeline/tray']);
  assert.deepEqual(report.missingRouteVariants.map((item) => `${item.path}:${item.variant}`),
    ['/beeline/channels:warm', '/beeline/tray:cold', '/beeline/tray:warm']);
  assert.deepEqual(report.missingInteractions, ['send-text']);
  assert.equal(report.complete, false);
  assert.equal(report.timingPass, false);
  assert.equal(report.requestPass, false);
});

test('tap budget requires one write, no completed RTT before feedback and no follow-up GET', () => {
  const passing = { kind: 'tap', name: 'send-text', variant: 'warm', clockDomain: 'host', startMs: 0,
    paintMs: 30, http: [{ method: 'POST', startMs: 10, endMs: 110 }] };
  assert.equal(summarize([passing], [], ['send-text']).requestPass, true);
  const late = { ...passing, paintMs: 120, http: [
    { method: 'POST', startMs: 10, endMs: 110 },
    { method: 'GET', startMs: 111, endMs: 140 },
  ] };
  assert.equal(summarize([late], [], ['send-text']).requestPass, false);
});

test('uncalibrated clocks cannot pass requests and boundary uncertainty cannot hide a prepaint read', () => {
  const raw = { kind: 'route', name: 'room', variant: 'warm', startMs: 100, paintMs: 200 };
  assert.equal(summarize([raw]).requestPass, false);
  const uncertain = { ...raw, clockDomain: 'host', clockUncertaintyMs: 8,
    http: [{ startMs: 205, endMs: 300, method: 'GET' }] };
  assert.equal(summarizeSample(uncertain).prepaintHttpCount, 1);
  assert.equal(summarize([uncertain]).requestPass, false);
  assert.throws(() => summarizeSample({ ...uncertain, clockUncertaintyMs: 26 }), /uncertain/);
});

test('route inventory excludes tests, layouts and components', async () => {
  assert.equal(routeForFile('(app)/beeline/chat/[channelId].tsx'), '/beeline/chat/[channelId]');
  assert.equal(routeForFile('(app)/beeline/settings/index.tsx'), '/beeline/settings');
  assert.equal(routeForFile('(app)/beeline/chat/_chat-surface.tsx'), null);
  assert.equal(routeForFile('(app)/beeline/chat/RoomMessageVariants.tsx'), null);
  await assert.rejects(checkRoutes(['(app)/beeline/channels.tsx'], []), /missing=\/beeline\/channels/);
});

test('push verdict names measured endpoints and absent native-response phase', () => {
  const report = summarize([{ kind: 'route', name: '/beeline/chat/[channelId]',
    variant: 'push-1', startMs: 0, paintMs: 100 }], [], []);
  assert.equal(report.pushMeasurement.nativeResponsePhase, 'absent');
  assert.match(markdown(report), /Activity entry to target text native frame commit; native-response phase absent/);
  assert.match(markdown(report), /foreground JS in-app notice are unmeasured/);
});

for (const name of ['react-message', 'open-corner', 'switch-tabs', 'open-composer']) {
  test(`${name} reports both percentiles and gates p50 strictly below 150 ms`, () => {
    const samples = [100, 149, 400].map(duration => ({ kind: 'tap', name, variant: 'warm',
      clockDomain: 'host', startMs: 1000, paintMs: 1000 + duration,
      http: name === 'react-message' ? [{method: 'POST', startMs: 1001, endMs: 1500}] : [] }));
    const report = summarize(samples, [], [name]);
    assert.equal(report.rows[0].p50Ms, 149);
    assert.equal(report.rows[0].p95Ms, 400);
    assert.equal(report.rows[0].budgetMs, 150);
    assert.equal(report.timingPass, true);
    assert.equal(report.requestPass, true);
    samples[1].paintMs = 1150;
    assert.equal(summarize(samples).timingPass, false);
    samples[1].timedOut = true;
    samples[1].paintMs = 1100;
    assert.equal(summarize(samples).timingPass, false);
  });
}
test('local navigation/composer actions reject writes while corner permits a covering read', () => {
  const base = { kind: 'tap', variant: 'warm', clockDomain: 'host', startMs: 1000, paintMs: 1100 };
  const read = { method: 'GET', startMs: 1001, endMs: 1050 };
  assert.equal(summarize([{...base, name: 'open-corner', http: [read]}]).requestPass, true);
  for (const name of ['switch-tabs', 'open-composer']) {
    assert.equal(summarize([{...base, name, http: [read]}]).requestPass, false);
    assert.equal(summarize([{...base, name, http: [{...read, method: 'POST'}]}]).requestPass, false);
  }
});

test('nightly CLI requires and retains all four new timed taps', async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'timed-taps-'));
  try {
    const samples = ['react-message', 'open-corner', 'switch-tabs', 'open-composer'].flatMap(name =>
      Array.from({length: 20}, () => ({ kind: 'tap', name, variant: 'warm',
        clockDomain: 'host', startMs: 1000, paintMs: 1100,
        http: name === 'react-message' ? [{ method: 'POST', startMs: 1001, endMs: 1200 }] : [] })));
    const input = join(dir, 'samples.ndjson');
    const output = join(dir, 'report.json');
    await writeFile(input, samples.map(s => JSON.stringify(s)).join('\n'));
    execFileSync(process.execPath, ['scripts/latency-rig/analyze.mjs', '--input', input,
      '--routes', 'scripts/latency-rig/routes.json', '--room-cases', 'scripts/latency-rig/room-arrival-cases.json',
      '--nightly', '--json-out', output], {stdio: 'pipe'});
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.deepEqual(report.rows.map(row => row.name).sort(), ['open-composer', 'open-corner', 'react-message', 'switch-tabs']);
    assert.deepEqual(report.missingInteractions, ['send-text']);
    assert.equal(report.complete, false);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('corner open uses the existing Room prepaint contract and permits postpaint housekeeping', () => {
  const base = { kind: 'tap', name: 'open-corner', variant: 'warm', clockDomain: 'host', startMs: 1000, paintMs: 1100 };
  const housekeeping = { method: 'POST', operation: '/v1/phone/rooms/r/read', startMs: 1101, endMs: 1200 };
  assert.equal(summarize([{...base, http: [housekeeping]}]).requestPass, true);
  housekeeping.startMs = 1001;
  assert.equal(summarize([{...base, http: [housekeeping]}]).requestPass, false);
});
