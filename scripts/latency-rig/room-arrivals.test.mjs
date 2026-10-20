import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateArrivalCases, extractArrivalMoments } from './room-arrivals.mjs';
const cases = JSON.parse(await readFile(new URL('./room-arrival-cases.json', import.meta.url)));
test('all entry/count combinations carry a page budget', () => {
  validateArrivalCases(cases);
  assert.throws(() => validateArrivalCases(cases.slice(1)));
  assert.throws(() => validateArrivalCases(cases.map((item, i) => i ? item : { ...item, budgetMs: undefined })));
});
test('cached frame cannot end newest unseen message timing', () => {
  const log = [
    '1700000000.100 W [ROOM_OPEN] {"phase":"newest-frame","detail":"cached"}',
    '1700000002.100 W [ROOM_OPEN] {"phase":"newest-frame","detail":"target"}',
  ].join('\n');
  const attempts = [{ name: 'push-unseen-5', targetId: 'target', startMs: 1700000000000, endMs: 1700000003000 }];
  assert.equal(extractArrivalMoments(log, attempts)[0].paintMs - attempts[0].startMs, 2100);
  assert.throws(() => extractArrivalMoments(log.split('\n')[0], attempts), /never painted/);
  assert.throws(() => extractArrivalMoments(log, [{ ...attempts[0], startMs: 1700000002200 }]), /never painted/);
});

const { summarize } = await import('./analyze.mjs');
test('analysis fails closed for missing or undersampled arrivals and enforces 450 ms', () => {
  const samples = cases.flatMap((item) => Array.from({ length: 20 }, () => ({
    kind: 'route', name: '/beeline/chat/[channelId]', variant: item.name,
    startMs: 0, paintMs: 449,
  })));
  assert.equal(summarize(samples, [], [], cases).complete, true);
  assert.equal(summarize(samples.slice(1), [], [], cases).complete, false);
  assert.equal(summarize(samples.map((item) => ({ ...item, paintMs: 450 })), [], [], cases).timingPass, false);
  assert.equal(summarize([], [], [], cases).missingArrivalCases.length, 4);
});

test('nightly keeps the warm open-room and send-text cases without a cold-start gate', () => {
  const route = { path: '/beeline/chat/[channelId]', coldHttpMax: 1, coldDepthMax: 1, variants: ['warm'] };
  const samples = [...cases.map((item) => item.name), 'warm'].flatMap((variant) =>
    Array.from({ length: 20 }, () => ({ kind: 'route', name: route.path, variant, startMs: 0, paintMs: 100 })));
  samples.push(...Array.from({ length: 20 }, () => ({ kind: 'tap', name: 'send-text', variant: 'warm',
    startMs: 0, paintMs: 100, http: [{ method: 'POST', startMs: 1, endMs: 150 }] })));
  const report = summarize(samples, [route], ['send-text'], cases);
  assert.equal(report.complete, true);
  assert.equal(report.timingPass, true);
  assert.equal(report.requestPass, true);
  assert.equal(summarize(samples.filter((item) => item.variant !== 'warm'), [route], ['send-text'], cases).complete, false);
});

const { nativeArrivalMoment } = await import('./room-arrivals.mjs');
test('native capture requires a target-visible result, not a successful test-run banner', () => {
  assert.throws(() => nativeArrivalMoment('OK (1 test)', 'push-unseen-1'), /never became visible/);
  assert.throws(() => nativeArrivalMoment('LATENCY_VISIBLE {"probe":"native-frame-commit-v1","case":"room-list-unseen-1","startMs":100,"paintMs":240}', 'push-unseen-1'));
  assert.throws(() => nativeArrivalMoment('LATENCY_VISIBLE {"probe":"native-accessibility-v1","case":"push-unseen-1","startMs":100,"paintMs":240}', 'push-unseen-1'));
  assert.equal(nativeArrivalMoment('LATENCY_VISIBLE {"probe":"native-frame-commit-v1","case":"push-unseen-1","startMs":100,"paintMs":240}', 'push-unseen-1').paintMs, 240);
  assert.throws(() => nativeArrivalMoment('LATENCY_VISIBLE {"probe":"native-frame-commit-v1","case":"push-unseen-1","startMs":200,"paintMs":100}', 'push-unseen-1'));
});

test('send-text native frame is an interaction, while warm Room open remains a route', () => {
  const mark = (name) => `LATENCY_VISIBLE ${JSON.stringify({ probe: 'native-frame-commit-v1', case: name, startMs: 100, paintMs: 120 })}`;
  assert.deepEqual(nativeArrivalMoment(mark('send-text'), 'send-text'), {
    kind: 'tap', name: 'send-text', variant: 'warm', startMs: 100, paintMs: 120,
  });
  assert.equal(nativeArrivalMoment(mark('warm'), 'warm').kind, 'route');
});
