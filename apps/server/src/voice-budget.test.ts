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
    CREATE TABLE voice_audio_windows(identity_id text PRIMARY KEY, through_ms bigint NOT NULL);
    CREATE TABLE voice_audio_checkpoints(meter_id uuid PRIMARY KEY, identity_id text, through_ms bigint, expires_at timestamptz);
    INSERT INTO voice_calls VALUES('call','owner','2099-01-01',NULL);
    INSERT INTO voice_participants VALUES('call','human',NULL,NULL),('call','second',NULL,NULL);`);
});
afterAll(() => db.close());

it('shares one budget across overlapping devices and idempotent checkpoints, excluding the no-audio gap', async () => {
  await db.query('DELETE FROM voice_daily_usage; DELETE FROM voice_audio_windows; DELETE FROM voice_audio_checkpoints');
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
  await db.query('DELETE FROM voice_daily_usage; DELETE FROM voice_audio_windows; DELETE FROM voice_audio_checkpoints');
  now = START;
  const failed = vi.fn();
  vi.useFakeTimers();
  const meter = new VoiceAudioMeter(budget, 'call', 'owner', 'human', await budget.read('human'),
    async () => {}, failed, () => now);
  await meter.flush(); meter.activate();
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
  await db.query('DELETE FROM voice_daily_usage; DELETE FROM voice_audio_windows; DELETE FROM voice_audio_checkpoints'); now = START;
  vi.useFakeTimers();
  const record = vi.spyOn(budget, 'checkpoint');
  const log = vi.fn();
  const meter = new VoiceAudioMeter(budget, 'call', 'owner', 'human', await budget.read('human'), () => {}, log, () => now);
  await meter.flush(); meter.activate();
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
  await db.query('DELETE FROM voice_daily_usage; DELETE FROM voice_audio_windows; DELETE FROM voice_audio_checkpoints'); now = START;
  const record = vi.spyOn(budget, 'checkpoint');
  const meter = new VoiceAudioMeter(budget, 'call', 'owner', 'human', await budget.read('human'), () => {}, () => {}, () => now);
  await meter.flush(); meter.activate(); record.mockClear();
  now += 200; meter.audio(200);
  record.mockRejectedValueOnce(new Error('temporary failure during leave'));
  try {
    await meter.close();
    expect(record).toHaveBeenCalledTimes(2);
    expect((await budget.read('human')).remainingMs).toBe(179_800);
  } finally { record.mockRestore(); await meter.close(); }
});

it('splits audio at midnight and refuses exhausted callers until reset', async () => {
  await db.query('DELETE FROM voice_daily_usage; DELETE FROM voice_audio_windows; DELETE FROM voice_audio_checkpoints');
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
  await db.query('DELETE FROM voice_daily_usage; DELETE FROM voice_audio_windows; DELETE FROM voice_audio_checkpoints'); now = START + 60_000;
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

it('Reproduction VOICE-BOUND-2: two independent runtimes share the failure window across abrupt recovery', async () => {
  await db.query('DELETE FROM voice_daily_usage; DELETE FROM voice_audio_windows; DELETE FROM voice_audio_checkpoints');
  await db.query(`INSERT INTO voice_calls VALUES('other','other-owner','2099-01-01',NULL) ON CONFLICT DO NOTHING;
    INSERT INTO voice_participants VALUES('other','human',NULL,NULL)`);
  now = START;
  vi.useFakeTimers();
  const secondStore = new VoiceBudgetStore(db, 180_000, () => now);
  const a = new VoiceAudioMeter(budget, 'call', 'owner', 'human', await budget.read('human'), () => {}, () => {}, () => now);
  const b = new VoiceAudioMeter(secondStore, 'other', 'other-owner', 'human', await secondStore.read('human'), () => {}, () => {}, () => now);
  await a.flush(); await b.flush(); a.activate(); b.activate();
  const failA = vi.spyOn(budget, 'checkpoint');
  const failB = vi.spyOn(secondStore, 'checkpoint');
  try {
    // Two disjoint half-second streams exhaust the SAME second, regardless of
    // separate store instances, call IDs and runtime lease owners.
    now += 500; const first = a.audio(500);
    failA.mockRejectedValue(new Error('checkpoint outage'));
    failB.mockRejectedValue(new Error('checkpoint outage'));
    await expect(a.flush()).rejects.toThrow('outage');
    now += 500; const second = b.audio(500);
    await expect(b.flush()).rejects.toThrow('outage');
    now += 1000;
    expect(a.audio(1000)).toBe(0); expect(b.audio(1000)).toBe(0);
    expect(first + second).toBe(1000);
    // Snapshot before either final flush: this is what an abrupt restart sees.
    const restored = PgliteDatabase.fromSnapshot(await db.snapshot());
    try {
      const recovered = new VoiceBudgetStore(restored, 180_000, () => now);
      const durableUsed = 180_000 - (await recovered.read('human')).remainingMs;
      expect(first + second - durableUsed).toBe(1000);
      // A new runtime cannot bypass the still-live old window after a restart.
      await restored.query(`UPDATE voice_calls SET runtime_owner='successor' WHERE id='call'`);
      const replacement = new VoiceAudioMeter(recovered, 'call', 'successor', 'human', await recovered.read('human'), () => {}, () => {}, () => now);
      await replacement.flush(); replacement.activate();
      expect(replacement.audio(1000)).toBe(0);
      // Expiry fences the abandoned grants before a successor advances the window.
      await restored.query(`UPDATE voice_audio_checkpoints SET expires_at=clock_timestamp()-interval '1 second'`);
      await replacement.flush(); now += 20;
      expect(replacement.audio(20)).toBe(20);
      await replacement.close();
      expect((await recovered.read('human')).remainingMs).toBe(179_980);
    } finally { await restored.close(); }
    failA.mockRestore(); failB.mockRestore();
    await a.flush(); await b.flush();
    expect((await budget.read('human')).remainingMs).toBe(179_000);
    await a.flush(); // Receive the frontier advanced by the other runtime.
    now += 20; expect(a.audio(20)).toBe(20);
    console.log('VOICE-BOUND-2: two stores/calls/owners, failed checkpoints, 1000ms total forwarded; snapshot restart loses 1000ms; retained grants fence restart; recovery resumes.');
  } finally { failA.mockRestore(); failB.mockRestore(); await a.close(); await b.close(); vi.useRealTimers(); }
});

it('keeps three overlapping devices streaming through advancing durable windows without counting overlap twice', async () => {
  await db.query('DELETE FROM voice_daily_usage; DELETE FROM voice_audio_windows; DELETE FROM voice_audio_checkpoints');
  now = START;
  vi.useFakeTimers();
  const meters: VoiceAudioMeter[] = [];
  try {
    for (let i = 0; i < 3; i++) {
      const store = new VoiceBudgetStore(db, 180_000, () => now);
      const meter = new VoiceAudioMeter(store, 'call', 'owner', 'human', await store.read('human'), () => {}, () => {}, () => now);
      await meter.flush(); meter.activate(); meters.push(meter);
    }
    for (let frame = 1; frame <= 100; frame++) {
      now += 20;
      for (const meter of meters) expect(meter.audio(20)).toBe(20);
      if (frame % 13 === 0) for (const meter of meters) await meter.flush();
    }
    for (const meter of meters) await meter.close();
    expect((await budget.read('human')).remainingMs).toBe(178_000);
    expect((await db.query('SELECT * FROM voice_audio_checkpoints')).rowCount).toBe(0);
  } finally { for (const meter of meters) await meter.close(); vi.useRealTimers(); }
});

it('stops forwarding an expired grant even when its window still has unused capacity', async () => {
  await db.query('DELETE FROM voice_daily_usage; DELETE FROM voice_audio_windows; DELETE FROM voice_audio_checkpoints');
  await db.query(`UPDATE voice_calls SET runtime_until=clock_timestamp()+interval '1 second' WHERE id='call'`);
  now = START;
  let elapsed = 0;
  const monotonic = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
  const meter = new VoiceAudioMeter(budget, 'call', 'owner', 'human', await budget.read('human'), () => {}, () => {}, () => now);
  try {
    await meter.flush(); meter.activate();
    now += 20; expect(meter.audio(20)).toBe(20);
    elapsed = 2000; now += 20;
    expect(meter.audio(20)).toBe(0);
  } finally {
    await db.query(`UPDATE voice_calls SET runtime_until='2099-01-01' WHERE id='call'`);
    await meter.close(); monotonic.mockRestore();
  }
});
