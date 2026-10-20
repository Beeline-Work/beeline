import test from 'node:test';
import assert from 'node:assert/strict';
import { messageSchedule } from './message-shaping.mjs';

test('a subscription burst pays propagation once and serializes only its bytes', () => {
  const schedule = messageSchedule();
  const times = Array.from({ length: 200 }, () => schedule(1000, 50, 142 * 8 / 10000));
  assert.ok(Math.abs(times[0] - 1050.1136) < .001);
  assert.ok(Math.abs(times.at(-1) - 1072.72) < .001);
});

test('idle messages pay their own propagation and jitter cannot reorder a stream', () => {
  const schedule = messageSchedule();
  assert.equal(schedule(1000, 50, 1), 1051);
  assert.equal(schedule(1200, 60, 1), 1261);
  assert.equal(schedule(1201, 20, 1), 1262);
  assert.throws(() => schedule(0, -1, 1), /Invalid/);
});
