import { expect, it } from 'vitest';
import { OrderedRecordStore, replayAfter } from './ordered-record-store';

it('orders a read against later changes and fences it after an account reset', () => {
  const records = new OrderedRecordStore<string>();
  const oldRead = records.mark();
  const later = records.clock();
  expect(replayAfter('read', oldRead, [{ clock: later, delta: 'frame' }], (_, delta) => delta))
    .toBe('frame');
  records.set('room', 'frame');
  records.reset();
  expect(records.accepts(oldRead)).toBe(false);
  expect(records.get('room')).toBeUndefined();
});

it('shares a GET only within its account and retries a requested refresh once', async () => {
  const records = new OrderedRecordStore<string>();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  const old = records.coalesceRead('viewer-a/room', false, async () => {
    reads += 1;
    await waiting;
    return false;
  });
  expect(records.coalesceRead('viewer-a/room', true, async () => false)).toBe(old);
  await records.coalesceRead('viewer-b/room', false, async () => { reads += 1; return false; });
  expect(reads).toBe(2);
  release();
  await old;
  expect(reads).toBe(3);

  const stale = records.mark();
  records.reset();
  expect(records.accepts(stale)).toBe(false);
  await records.coalesceRead('viewer-a/room', false, async () => { reads += 1; return false; });
  expect(reads).toBe(4);
});

it('releases a shared GET after a synchronous request failure', async () => {
  const records = new OrderedRecordStore<string>();
  await expect(records.coalesceRead('viewer/room', false, () => {
    throw new Error('offline');
  })).rejects.toThrow('offline');
  await expect(records.coalesceRead('viewer/room', false, async () => false)).resolves.toBeUndefined();
});
