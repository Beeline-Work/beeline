import { describe, expect, it, vi, afterEach } from 'vitest';
import type { NostrEvent } from '@beeline/nostr';
import { MessageOutbox, type MessageOutboxRecord } from './message-outbox';
const event = (id = 'a'.repeat(64), room = 'room-a'): NostrEvent => ({
  id,
  pubkey: 'c'.repeat(64),
  created_at: 1,
  kind: 9,
  sig: '',
  content: 'Start with the server PR',
  tags: [
    ['h', room],
    ['monolith-attachments', '[]'],
    ['monolith-mentions', '[]'],
  ],
});
const row = (e: NostrEvent) => ({
  id: e.id,
  text: e.content,
  createdAt: e.created_at,
  author: { pubkey: 'c'.repeat(64), kind: 'human' as const, name: 'Kai' },
  presentation: 'message' as const,
});
function rig(beforeSave?: (records: readonly MessageOutboxRecord[]) => Promise<void>) {
  let disk: readonly MessageOutboxRecord[] = [];
  const send = vi.fn(async (e: NostrEvent) => ({ messageId: e.id }));
  const owner = () =>
    new MessageOutbox({
      load: async () => JSON.parse(JSON.stringify(disk)),
      save: async (records) => {
        await beforeSave?.(records);
        disk = JSON.parse(JSON.stringify(records));
      },
      send,
      rejection: (error) => (error as { reason?: string }).reason,
    });
  return { owner, send, disk: () => disk };
}
afterEach(() => vi.useRealTimers());
describe('R2 app-wide message outbox', () => {
  it('never persists or replays a rejected enqueue after retry and restart', async () => {
    const failed = event();
    const retry = event('b'.repeat(64));
    let rejectOnce = true;
    const r = rig(async (records) => {
      if (rejectOnce && records.some((record) => record.event.id === failed.id)) {
        rejectOnce = false;
        throw new Error('Storage unavailable');
      }
    });
    const owner = r.owner();
    try {
      await expect(owner.enqueue(failed, row(failed))).rejects.toThrow('Storage unavailable');
      expect(owner.get(failed.id)).toBeUndefined();
      expect(owner.snapshot()).toEqual([]);
      await owner.enqueue(retry, row(retry));
      expect(r.disk().map((record) => record.event.id)).toEqual([retry.id]);
      await owner.connectionChanged(true);
      expect(r.send.mock.calls.map(([sent]) => sent.id)).toEqual([retry.id]);
    } finally {
      owner.dispose();
    }
    const restarted = r.owner();
    try {
      await restarted.connectionChanged(true);
      expect(restarted.list()).toEqual([]);
      expect(r.send.mock.calls.map(([sent]) => sent.id)).toEqual([retry.id]);
    } finally {
      restarted.dispose();
    }
  });
  it('hides an uncommitted enqueue and preserves unrelated records when its save rejects', async () => {
    const failed = event();
    const other = event('b'.repeat(64), 'room-b');
    let rejectSave!: (error: Error) => void;
    let saveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      saveStarted = resolve;
    });
    let rejectOnce = true;
    const r = rig((records) => {
      if (!rejectOnce || !records.some((record) => record.event.id === failed.id))
        return Promise.resolve();
      rejectOnce = false;
      saveStarted();
      return new Promise<void>((_resolve, reject) => {
        rejectSave = reject;
      });
    });
    const owner = r.owner();
    try {
      const enqueue = owner.enqueue(failed, row(failed));
      const rejected = expect(enqueue).rejects.toThrow('Storage unavailable');
      await started;
      const visibleWhileSaving = owner.snapshot();
      const unrelated = owner.enqueue(other, row(other));
      const reconnect = owner.connectionChanged(true);
      rejectSave(new Error('Storage unavailable'));
      await rejected;
      await Promise.all([unrelated, reconnect]);
      expect(visibleWhileSaving).toEqual([]);
      expect(owner.get(failed.id)).toBeUndefined();
      expect(r.disk().some((record) => record.event.id === failed.id)).toBe(false);
      await owner.flush();
      expect(r.send.mock.calls.map(([sent]) => sent.id)).toEqual([other.id]);
      expect(owner.list()).toEqual([]);
    } finally {
      owner.dispose();
    }
  });
  it('keeps a successful enqueue durable when a concurrent save was queued before it committed', async () => {
    const e = event();
    let release!: () => void;
    let saveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      saveStarted = resolve;
    });
    let holdOnce = true;
    const r = rig(async (records) => {
      if (holdOnce && records.some((record) => record.event.id === e.id)) {
        holdOnce = false;
        saveStarted();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    });
    const owner = r.owner();
    try {
      const enqueue = owner.enqueue(e, row(e));
      await started;
      const connection = owner.connectionChanged(false);
      release();
      await Promise.all([enqueue, connection]);
      expect(r.disk().map((record) => record.event.id)).toEqual([e.id]);
    } finally {
      owner.dispose();
    }
    const restarted = r.owner();
    try {
      await restarted.connectionChanged(true);
      expect(r.send).toHaveBeenCalledExactlyOnceWith(e);
      expect(restarted.list()).toEqual([]);
    } finally {
      restarted.dispose();
    }
  });
  it('keeps disconnected sends Sending, survives restart, and replays once after leaving the Room', async () => {
    const r = rig();
    const first = r.owner();
    const e = event();
    await first.enqueue(e, row(e));
    await first.send(e.id);
    expect(first.state(e.id)?.text).toBe('Sending');
    expect(r.send).not.toHaveBeenCalled();
    first.dispose();
    const restarted = r.owner();
    await restarted.restore();
    expect(restarted.list('room-a')).toHaveLength(1);
    await restarted.connectionChanged(true);
    expect(r.send).toHaveBeenCalledExactlyOnceWith(e);
    expect(restarted.list()).toEqual([]);
    restarted.dispose();
  });
  it('shows the offline cutoff once and automatically sends later without a retry timer', async () => {
    vi.useFakeTimers();
    const r = rig();
    const owner = r.owner();
    const e = event();
    await owner.enqueue(e, row(e));
    const listener = vi.fn();
    owner.subscribe(listener);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(owner.state(e.id)?.text).toBe('Sending');
    await vi.advanceTimersByTimeAsync(1);
    expect(owner.state(e.id)?.text).toBe('Not sent yet · no connection');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await owner.connectionChanged(true);
    expect(owner.list()).toEqual([]);
    owner.dispose();
  });
  it('dedupes concurrent enqueue and reconnect while the same id is in flight', async () => {
    const r = rig();
    const owner = r.owner();
    const e = event();
    let release!: () => void;
    r.send.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { messageId: e.id };
    });
    await Promise.all([owner.enqueue(e, row(e)), owner.enqueue(e, row(e))]);
    expect(owner.list()).toHaveLength(1);
    const connection = owner.connectionChanged(true);
    await vi.waitFor(() => expect(r.send).toHaveBeenCalledTimes(1));
    const duplicate = owner.send(e.id);
    release();
    await Promise.all([connection, duplicate]);
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(owner.list()).toEqual([]);
    owner.dispose();
  });
  it('never gives up after transient failures and flushes every Room on reconnect', async () => {
    const r = rig();
    const owner = r.owner();
    const a = event();
    const b = event('b'.repeat(64), 'room-b');
    await owner.enqueue(a, row(a));
    await owner.enqueue(b, row(b));
    r.send.mockRejectedValue(new TypeError('Network request failed'));
    for (let attempt = 0; attempt < 6; attempt++) await owner.connectionChanged(true);
    expect(owner.list()).toHaveLength(2);
    expect(owner.state(a.id)?.kind).toBe('sending');
    r.send.mockImplementation(async (e) => ({ messageId: e.id }));
    await owner.connectionChanged(true);
    expect(owner.list()).toEqual([]);
    owner.dispose();
  });
  it('retains the exact server refusal after leaving and restarting, and never retries it', async () => {
    const r = rig();
    const owner = r.owner();
    const e = event();
    await owner.enqueue(e, row(e));
    r.send.mockRejectedValue({ reason: 'The relay did not allow this message.' });
    await owner.connectionChanged(true);
    expect(owner.state(e.id)).toEqual({
      kind: 'refused',
      text: 'Not sent · The relay did not allow this message.',
    });
    owner.dispose();
    const restarted = r.owner();
    await restarted.restore();
    await restarted.connectionChanged(true);
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(restarted.list('room-a')[0]?.reason).toBe('The relay did not allow this message.');
    await restarted.remove(e.id);
    expect(r.disk()).toEqual([]);
    restarted.dispose();
  });
});

it('replays if reconnect arrives before the old request fails, without starting a second flight', async () => {
  const r = rig();
  const owner = r.owner();
  const e = event();
  await owner.enqueue(e, row(e));
  let reject!: (error: Error) => void;
  r.send.mockImplementationOnce(
    () =>
      new Promise((_resolve, no) => {
        reject = no;
      }),
  );
  const old = owner.connectionChanged(true);
  await vi.waitFor(() => expect(r.send).toHaveBeenCalledTimes(1));
  await owner.connectionChanged(false);
  const reconnect = owner.connectionChanged(true);
  expect(r.send).toHaveBeenCalledTimes(1);
  reject(new TypeError('Network request failed'));
  await Promise.all([old, reconnect]);
  expect(r.send).toHaveBeenCalledTimes(2);
  expect(owner.list()).toEqual([]);
  owner.dispose();
});
