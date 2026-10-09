import { describe, expect, it } from 'vitest';
import { LiveHub } from './live.js';

describe('phone live replay boundary', () => {
  it('replays only unseen room events while its bounded history is present', () => {
    const live = new LiveHub();
    const first = live.subscribeReplay('room', undefined, () => undefined);
    first.release();
    live.publish({ type: 'invalidate', roomId: 'room', reason: 'first' });
    live.publish({ type: 'invalidate', roomId: 'room', reason: 'second' });
    const resumed = live.subscribeReplay('room',
      { epoch: first.epoch, base: 0, seen: [1] }, () => undefined);
    expect(resumed.resumed).toBe(true);
    expect(resumed.replay).toEqual([{ sequence: 2,
      event: { type: 'invalidate', roomId: 'room', reason: 'second' } }]);
    resumed.release();
  });

  it('requires a covering snapshot after a process switch or history eviction', () => {
    const live = new LiveHub();
    const first = live.subscribeReplay('room', undefined, () => undefined);
    first.release();
    for (let index = 0; index < 258; index += 1)
      live.publish({ type: 'invalidate', roomId: 'room', reason: `event-${index}` });
    const evicted = live.subscribeReplay('room',
      { epoch: first.epoch, base: 0, seen: [] }, () => undefined);
    expect(evicted.resumed).toBe(false);
    evicted.release();
    const other = new LiveHub().subscribeReplay('room',
      { epoch: first.epoch, base: 258, seen: [] }, () => undefined);
    expect(other.resumed).toBe(false);
    other.release();
  });

  it('changes a Room epoch when the Room history itself is evicted', () => {
    const live = new LiveHub();
    const first = live.subscribeReplay('room-0', undefined, () => undefined);
    first.release();
    for (let index = 1; index <= 256; index += 1)
      live.publish({ type: 'invalidate', roomId: `room-${index}`, reason: 'change' });
    const after = live.subscribeReplay('room-0',
      { epoch: first.epoch, base: 0, seen: [] }, () => undefined);
    expect(after.resumed).toBe(false);
    expect(after.epoch).not.toBe(first.epoch);
    after.release();
  });

  it('suppresses the writer instance\'s local plus Postgres copy before sequencing', () => {
    const live = new LiveHub();
    const events: string[] = [];
    const subscription = live.subscribeReplay('room', undefined,
      (event) => events.push(event.type));
    live.publish({ type: 'draft', roomId: 'room', agentId: 'agent', turnId: 'turn',
      text: 'hello', latestChunk: 'hello', localOrigin: true });
    live.publish({ type: 'draft', roomId: 'room', agentId: 'agent', turnId: 'turn',
      text: 'hello', latestChunk: 'hello' });
    live.publish({ type: 'invalidate', roomId: 'room', reason: 'message',
      messageId: 'message', committedRow: { type: 'message', row: { room_id: 'room' } as never } });
    live.publish({ type: 'invalidate', roomId: 'room', reason: 'postgres:messages',
      operation: 'INSERT', messageId: 'message' });
    expect(events).toEqual(['draft', 'invalidate']);
    const resumed = live.subscribeReplay('room',
      { epoch: subscription.epoch, base: 0, seen: [] }, () => undefined);
    expect(resumed.sequence).toBe(2);
    resumed.release();
    subscription.release();
  });
});
