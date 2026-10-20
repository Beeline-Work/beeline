import test from 'node:test';
import assert from 'node:assert/strict';
import { calibrateDeviceClock, hostClockMoment, sampleDeviceClock } from './device-clock.mjs';

const anchor = (deviceMs, offset, uncertainty = 0) => ({ deviceMs,
  hostBeforeMs: deviceMs + offset - uncertainty, hostAfterMs: deviceMs + offset + uncertainty });
const moment = (offset) => ({ clockDomain: 'device', startMs: 100, paintMs: 200, endMs: 250,
  clockSync: { before: anchor(90, offset), after: anchor(250, offset) } });

test('normalizes either signed device offset without changing native paint duration', () => {
  for (const offset of [384, -20]) {
    const result = hostClockMoment(moment(offset));
    assert.equal(result.startMs, 100 + offset);
    assert.equal(result.paintMs, 200 + offset);
    assert.equal(result.endMs, 250 + offset);
    assert.equal(result.paintMs - result.startMs, 100);
    assert.equal(result.deviceStartMs, 100);
    assert.equal(result.clockDomain, 'host');
  }
});

test('chooses the smallest measured round trip and retains its midpoint uncertainty', () => {
  const times = [1000, 1020, 1030, 1034, 1040, 1050];
  const devices = [610, 632, 645];
  const chosen = calibrateDeviceClock(() => devices.shift(), () => times.shift());
  assert.deepEqual(chosen, { deviceMs: 632, hostBeforeMs: 1030, hostAfterMs: 1034 });
});

test('rejects missing calibration, stale bounds, uncertain clocks and clock jumps', () => {
  assert.throws(() => hostClockMoment({ startMs: 100, paintMs: 200, endMs: 250 }), /clock domain/);
  assert.throws(() => hostClockMoment({ ...moment(384), clockSync: undefined }), /calibration/);
  assert.throws(() => hostClockMoment({ ...moment(384), startMs: 80 }), /bound/);
  const changed = moment(384);
  changed.clockSync.after = anchor(250, 484);
  assert.throws(() => hostClockMoment(changed), /changed/);
  const times = [1000, 1100];
  assert.throws(() => sampleDeviceClock(() => 610, () => times.shift()), /uncertain/);
});

test('carries measured uncertainty conservatively and leaves explicit host samples alone', () => {
  const value = moment(384);
  value.clockSync.before = anchor(90, 384, 2);
  value.clockSync.after = anchor(250, 385, 2);
  assert.equal(hostClockMoment(value).clockUncertaintyMs, 4);
  const host = { clockDomain: 'host', startMs: 100, paintMs: 200, endMs: 250 };
  assert.equal(hostClockMoment(host), host);
});
