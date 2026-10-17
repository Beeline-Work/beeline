import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { PgliteDatabase } from './test-support.js';
import { VoiceAudioMeter, VoiceBudgetStore, voiceBudgetDay } from './voice-budget.js';

const db = new PgliteDatabase();
const START = Date.UTC(2026, 9, 17, 12);
let now = START;
const budget = new VoiceBudgetStore(db, 180_000, () => now);
beforeAll(async () => {
  await db.query(`CREATE TABLE voice_calls(id text PRIMARY KEY, runtime_owner text,
    runtime_until timestamptz, ended_at timestamptz);
    CREATE TABLE voice_participants(call_id text, identity_id text, left_at timestamptz, parked_at timestamptz);
    CREATE TABLE voice_daily_usage(identity_id text, day_start bigint,
      audio int8multirange NOT NULL DEFAULT '{}', PRIMARY KEY(identity_id,day_start));
    INSERT INTO voice_calls VALUES('call','owner','2099-01-01',NULL);
    INSERT INTO voice_participants VALUES('call','human',NULL,NULL),('call','second',NULL,NULL);`);
});
afterAll(() => db.close());

it('shares one budget across overlapping devices and idempotent checkpoints, excluding the no-audio gap', async () => {
  await db.query('DELETE FROM voice_daily_usage');
  now = START + 70_000;
  await budget.record('call', 'owner', 'human', [[START, START + 60_000]]);
  await budget.record('call', 'owner', 'human', [[START + 30_000, START + 60_000]]);
  expect((await budget.read('human')).remainingMs).toBe(120_000);
  await budget.record('call', 'owner', 'human', [[START + 65_000, START + 70_000]]);
  expect((await budget.read('human')).remainingMs).toBe(115_000);
  expect((await budget.read('second')).remainingMs).toBe(180_000);
  expect(await budget.record('call', 'stale-owner', 'human', [[START, START + 70_000]])).toBeNull();
});

it('retains committed usage across a new store and resets at the documented UTC midnight', async () => {
  const replacement = new VoiceBudgetStore(db, 180_000, () => now);
  expect((await replacement.read('human')).remainingMs).toBe(115_000);
  now = voiceBudgetDay(now).resetAt;
  expect(await replacement.read('human')).toEqual({ remainingMs: 180_000,
    resetAt: now + 86_400_000, timeZone: 'UTC' });
});

it('demonstrates the abrupt-loss window and stops audio if uncommitted usage would exceed one second', async () => {
  await db.query('DELETE FROM voice_daily_usage');
  now = START;
  const failed = vi.fn();
  vi.useFakeTimers();
  const meter = new VoiceAudioMeter(budget, 'call', 'owner', 'human', await budget.read('human'),
    async () => {}, failed, () => now);
  try {
    // Frames have gone to STT, but a replacement process can only read the durable checkpoint.
    for (let i = 0; i < 50; i++) { now += 20; expect(meter.audio(20)).toBe(20); }
    expect((await new VoiceBudgetStore(db, 180_000, () => now).read('human')).remainingMs).toBe(180_000);
    now += 20;
    expect(meter.audio(20)).toBe(0);
    expect(failed).toHaveBeenCalledOnce();
    await meter.close();
    expect((await budget.read('human')).remainingMs).toBe(179_000);
  } finally { await meter.close(); vi.useRealTimers(); }
});

it('retains a failed checkpoint, pauses at the bound, retries idempotently and resumes', async () => {
  await db.query('DELETE FROM voice_daily_usage'); now = START;
  vi.useFakeTimers();
  const record = vi.spyOn(budget, 'record');
  const log = vi.fn();
  const meter = new VoiceAudioMeter(budget, 'call', 'owner', 'human', await budget.read('human'), () => {}, log, () => now);
  try {
    for (let i = 0; i < 25; i++) { now += 20; expect(meter.audio(20)).toBe(20); }
    record.mockRejectedValueOnce(new Error('database temporarily unavailable'));
    await expect(meter.flush()).rejects.toThrow('temporarily');
    for (let i = 0; i < 25; i++) { now += 20; expect(meter.audio(20)).toBe(20); }
    now += 20; expect(meter.audio(20)).toBe(0);
    await meter.flush();
    expect((await budget.read('human')).remainingMs).toBe(179_000);
    now += 20; expect(meter.audio(20)).toBe(20);
    await meter.flush();
    expect((await budget.read('human')).remainingMs).toBe(178_980);
    expect(log.mock.calls.map(([text]) => text)).toEqual([
      'Voice accounting checkpoint failed; retrying',
      'Voice input paused at the one-second accounting checkpoint bound',
      'Voice input resumed after accounting checkpoint',
    ]);
  } finally { await meter.close(); record.mockRestore(); vi.useRealTimers(); }
});

it('retries the final checkpoint after a normal leave', async () => {
  await db.query('DELETE FROM voice_daily_usage'); now = START;
  const record = vi.spyOn(budget, 'record');
  const meter = new VoiceAudioMeter(budget, 'call', 'owner', 'human', await budget.read('human'), () => {}, () => {}, () => now);
  now += 200; meter.audio(200);
  record.mockRejectedValueOnce(new Error('temporary failure during leave'));
  try {
    await meter.close();
    expect(record).toHaveBeenCalledTimes(2);
    expect((await budget.read('human')).remainingMs).toBe(179_800);
  } finally { record.mockRestore(); await meter.close(); }
});

it('splits audio at midnight and refuses exhausted callers until reset', async () => {
  await db.query('DELETE FROM voice_daily_usage');
  const midnight = voiceBudgetDay(START).resetAt;
  now = midnight + 100;
  const tiny = new VoiceBudgetStore(db, 100, () => now);
  await tiny.record('call', 'owner', 'human', [[midnight - 50, midnight + 100]]);
  await expect(tiny.require('human')).rejects.toThrow('0 minutes');
  expect((await db.query('SELECT day_start FROM voice_daily_usage')).rowCount).toBe(2);
  now += 86_400_000;
  expect((await tiny.require('human')).remainingMs).toBe(100);
});

it('restores a persisted database into a new server store and fences the previous lease owner', async () => {
  await db.query('DELETE FROM voice_daily_usage'); now = START + 60_000;
  await budget.record('call', 'owner', 'human', [[START, now]]);
  const restored = PgliteDatabase.fromSnapshot(await db.snapshot());
  try {
    const successor = new VoiceBudgetStore(restored, 180_000, () => now);
    expect((await successor.read('human')).remainingMs).toBe(120_000);
    await restored.query(`UPDATE voice_calls SET runtime_owner='successor' WHERE id='call'`);
    now += 250;
    expect(await successor.record('call', 'owner', 'human', [[now - 250, now]])).toBeNull();
    await successor.record('call', 'successor', 'human', [[now - 250, now]]);
    expect((await successor.read('human')).remainingMs).toBe(119_750);
  } finally { await restored.close(); }
});
