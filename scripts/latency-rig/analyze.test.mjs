import test from 'node:test';
import assert from 'node:assert/strict';
import { percentile, serialDepth, summarize, summarizeSample } from './analyze.mjs';
import { checkRoutes, routeForFile } from './check-routes.mjs';

test('counts independent network requests at one RTT depth', () => {
  assert.equal(serialDepth([
    { startMs: 0, endMs: 100 },
    { startMs: 10, endMs: 80 },
    { startMs: 100, endMs: 180 },
  ]), 2);
  assert.equal(serialDepth([]), 0);
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
  const passing = { kind: 'tap', name: 'send-text', variant: 'warm', startMs: 0,
    paintMs: 30, http: [{ method: 'POST', startMs: 10, endMs: 110 }] };
  assert.equal(summarize([passing], [], ['send-text']).requestPass, true);
  const late = { ...passing, paintMs: 120, http: [
    { method: 'POST', startMs: 10, endMs: 110 },
    { method: 'GET', startMs: 111, endMs: 140 },
  ] };
  assert.equal(summarize([late], [], ['send-text']).requestPass, false);
});

test('route inventory excludes tests, layouts and components', async () => {
  assert.equal(routeForFile('(app)/beeline/chat/[channelId].tsx'), '/beeline/chat/[channelId]');
  assert.equal(routeForFile('(app)/beeline/settings/index.tsx'), '/beeline/settings');
  assert.equal(routeForFile('(app)/beeline/chat/_chat-surface.tsx'), null);
  assert.equal(routeForFile('(app)/beeline/chat/RoomMessageVariants.tsx'), null);
  await assert.rejects(checkRoutes(['(app)/beeline/channels.tsx'], []), /missing=\/beeline\/channels/);
});
