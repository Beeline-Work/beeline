import { describe, expect, it, vi, afterEach } from 'vitest';
import type { NostrEvent } from '@beeline/nostr';
import { MessageOutbox, type MessageOutboxRecord } from './message-outbox';
const event = (id = 'a'.repeat(64), room = 'room-a'): NostrEvent => ({ id, pubkey: 'c'.repeat(64), created_at: 1, kind: 9, sig: '', content: 'Start with the server PR', tags: [['h', room], ['monolith-attachments', '[]'], ['monolith-mentions', '[]']] });
const row = (e: NostrEvent) => ({ id: e.id, text: e.content, createdAt: e.created_at, author: { pubkey: 'c'.repeat(64), kind: 'human' as const, name: 'Kai' }, presentation: 'message' as const });
function rig() {
  let disk: readonly MessageOutboxRecord[] = [];
  const send = vi.fn(async (e: NostrEvent) => ({ messageId: e.id }));
  const owner = () => new MessageOutbox({ load: async () => JSON.parse(JSON.stringify(disk)), save: async records => { disk = JSON.parse(JSON.stringify(records)); }, send, rejection: error => (error as { reason?: string }).reason });
  return { owner, send, disk: () => disk };
}
afterEach(() => vi.useRealTimers());
describe('R2 app-wide message outbox', () => {
  it('keeps disconnected sends Sending, survives restart, and replays once after leaving the Room', async () => {
    const r = rig(); const first = r.owner(); const e = event();
    await first.enqueue(e, row(e)); await first.send(e.id);
    expect(first.state(e.id)?.text).toBe('Sending'); expect(r.send).not.toHaveBeenCalled();
    first.dispose(); const restarted = r.owner(); await restarted.restore();
    expect(restarted.list('room-a')).toHaveLength(1);
    await restarted.connectionChanged(true);
    expect(r.send).toHaveBeenCalledExactlyOnceWith(e); expect(restarted.list()).toEqual([]); restarted.dispose();
  });
  it('shows the offline cutoff once and automatically sends later without a retry timer', async () => {
    vi.useFakeTimers(); const r = rig(); const owner = r.owner(); const e = event();
    await owner.enqueue(e, row(e)); const listener = vi.fn(); owner.subscribe(listener);
    await vi.advanceTimersByTimeAsync(119_999); expect(owner.state(e.id)?.text).toBe('Sending');
    await vi.advanceTimersByTimeAsync(1); expect(owner.state(e.id)?.text).toBe('Not sent yet · no connection');
    expect(listener).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
    await owner.connectionChanged(true); expect(owner.list()).toEqual([]); owner.dispose();
  });
  it('dedupes concurrent enqueue and reconnect while the same id is in flight', async () => {
    const r = rig(); const owner = r.owner(); const e = event(); let release!: () => void;
    r.send.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return { messageId: e.id }; });
    await Promise.all([owner.enqueue(e, row(e)), owner.enqueue(e, row(e))]); expect(owner.list()).toHaveLength(1);
    const connection = owner.connectionChanged(true); await vi.waitFor(() => expect(r.send).toHaveBeenCalledTimes(1));
    const duplicate = owner.send(e.id); release(); await Promise.all([connection, duplicate]);
    expect(r.send).toHaveBeenCalledTimes(1); expect(owner.list()).toEqual([]); owner.dispose();
  });
  it('never gives up after transient failures and flushes every Room on reconnect', async () => {
    const r = rig(); const owner = r.owner(); const a = event(); const b = event('b'.repeat(64), 'room-b');
    await owner.enqueue(a, row(a)); await owner.enqueue(b, row(b)); r.send.mockRejectedValue(new TypeError('Network request failed'));
    for (let attempt = 0; attempt < 6; attempt++) await owner.connectionChanged(true);
    expect(owner.list()).toHaveLength(2); expect(owner.state(a.id)?.kind).toBe('sending');
    r.send.mockImplementation(async e => ({ messageId: e.id })); await owner.connectionChanged(true); expect(owner.list()).toEqual([]); owner.dispose();
  });
  it('retains the exact server refusal after leaving and restarting, and never retries it', async () => {
    const r = rig(); const owner = r.owner(); const e = event(); await owner.enqueue(e, row(e));
    r.send.mockRejectedValue({ reason: 'The relay did not allow this message.' }); await owner.connectionChanged(true);
    expect(owner.state(e.id)).toEqual({ kind: 'refused', text: 'Not sent · The relay did not allow this message.' });
    owner.dispose(); const restarted = r.owner(); await restarted.restore(); await restarted.connectionChanged(true);
    expect(r.send).toHaveBeenCalledTimes(1); expect(restarted.list('room-a')[0]?.reason).toBe('The relay did not allow this message.');
    await restarted.remove(e.id); expect(r.disk()).toEqual([]); restarted.dispose();
  });
});

it('replays if reconnect arrives before the old request fails, without starting a second flight', async () => {
  const r = rig(); const owner = r.owner(); const e = event();
  await owner.enqueue(e, row(e));
  let reject!: (error: Error) => void;
  r.send.mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no; }));
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
