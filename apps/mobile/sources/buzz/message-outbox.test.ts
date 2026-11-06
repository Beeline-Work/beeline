import { expect, it, vi } from 'vitest';
import { MessageOutbox, type MessageOutboxRecord } from './message-outbox';

const event = (id = 'a'.repeat(64)) => ({ id, pubkey: 'c'.repeat(64), kind: 9, sig: '', created_at: 1,
  content: 'Please check the market', tags: [['h', 'room-a'], ['monolith-attachments', '[]'], ['monolith-mentions', '[]']] });
const row = (id = 'a'.repeat(64)) => ({ id, text: 'Please check the market', createdAt: 1,
  author: { pubkey: 'c'.repeat(64), kind: 'human' as const, name: 'Kai' }, presentation: 'message' as const });
function setup(stored: MessageOutboxRecord[] = []) {
  const send = vi.fn(async (value: ReturnType<typeof event>) => ({ messageId: value.id }));
  const save = vi.fn(async (records: readonly MessageOutboxRecord[]) => { stored = structuredClone([...records]); });
  const outbox = new MessageOutbox({ load: async () => stored, save, send,
    rejection: error => error instanceof Error && error.message === 'Room access denied' ? error.message : undefined });
  return { outbox, send, save, stored: () => stored };
}

it('pending delivery stays pending without inferring failure from elapsed time', async () => {
  vi.useFakeTimers();
  const { outbox } = setup();
  try {
    await outbox.enqueue(event(), row());
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    expect(outbox.state(event().id)).toEqual({ kind: 'sending', text: 'Sending' });
    expect(vi.getTimerCount()).toBe(0);
  } finally { outbox.dispose(); vi.useRealTimers(); }
});

it('one failed replacement delivery becomes a durable failure immediately', async () => {
  const { outbox, send, stored } = setup();
  await outbox.connectionChanged(true); await outbox.enqueue(event(), row());
  send.mockRejectedValue(new Error('Connection closed'));
  await outbox.send(event().id);
  expect(outbox.state(event().id)?.kind).toBe('sending');
  await outbox.connectionChanged(false); await outbox.connectionChanged(true);
  expect(outbox.state(event().id)).toEqual({ kind: 'offline', text: 'Not sent' });
  expect(send).toHaveBeenCalledTimes(2);
  const restored = setup(stored()).outbox; await restored.restore();
  expect(restored.state(event().id)).toEqual({ kind: 'offline', text: 'Not sent' });
  await outbox.connectionChanged(true); expect(send).toHaveBeenCalledTimes(2);
  outbox.dispose(); restored.dispose();
});

it('server refusal exposes the exact reason and waits for an explicit retry', async () => {
  const { outbox, send } = setup();
  await outbox.connectionChanged(true); await outbox.enqueue(event(), row());
  send.mockRejectedValueOnce(new Error('Room access denied'));
  await outbox.send(event().id);
  expect(outbox.state(event().id)).toEqual({ kind: 'refused', text: 'Not sent: Room access denied', reason: 'Room access denied' });
  await outbox.connectionChanged(true); expect(send).toHaveBeenCalledTimes(1);
  await outbox.retry([event().id]);
  expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[1][0].id).toBe(event().id);
  expect(outbox.list()).toHaveLength(0); outbox.dispose();
});

it('Retry all sends only its still-failed ids, even while the owner is disconnected', async () => {
  const { outbox, send } = setup();
  const ids = ['a', 'b', 'd'].map(value => value.repeat(64));
  for (const id of ids) { await outbox.enqueue(event(id), row(id)); await outbox.fail(id); }
  await outbox.remove(ids[1]);
  let accept!: (value: { messageId: string }) => void;
  send.mockImplementationOnce(() => new Promise(resolve => { accept = resolve; }));
  const first = outbox.retry(ids.slice(0, 2));
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(outbox.state(ids[0])?.kind).toBe('sending');
  const duplicate = outbox.retry(ids.slice(0, 2)); expect(send).toHaveBeenCalledTimes(1);
  accept({ messageId: ids[0] }); await Promise.all([first, duplicate]);
  expect(outbox.get(ids[0])).toBeUndefined();
  expect(outbox.state(ids[2])?.text).toBe('Not sent'); outbox.dispose();
});

it('legacy failed records without a refusal are restored as pending; Delete removes the local failure', async () => {
  const { outbox } = setup([{ event: event(), row: row(), queuedAt: 1, status: 'failed', attempts: 3 }]);
  await outbox.restore(); expect(outbox.state(event().id)?.kind).toBe('sending');
  await outbox.fail(event().id); expect(outbox.state(event().id)?.text).toBe('Not sent');
  await outbox.remove(event().id); expect(outbox.list()).toHaveLength(0); outbox.dispose();
});

it('a failed retry save keeps the failure durable and never starts a send', async () => {
  const { outbox, send, save } = setup();
  await outbox.enqueue(event(), row()); await outbox.fail(event().id);
  save.mockRejectedValueOnce(new Error('Storage unavailable'));
  await expect(outbox.retry([event().id])).rejects.toThrow('Storage unavailable');
  expect(outbox.state(event().id)?.text).toBe('Not sent');
  expect(send).not.toHaveBeenCalled(); outbox.dispose();
});

it('a retry requested as failure is published waits for the old flight to finish', async () => {
  const { outbox, send } = setup();
  await outbox.connectionChanged(true); await outbox.enqueue(event(), row());
  send.mockRejectedValueOnce(new Error('Room access denied'));
  let retry: Promise<unknown> | undefined;
  outbox.subscribe(() => {
    if (!retry && outbox.state(event().id)?.kind === 'refused') retry = outbox.retry([event().id]);
  });
  await outbox.send(event().id); await retry;
  expect(send).toHaveBeenCalledTimes(2); expect(outbox.list()).toHaveLength(0); outbox.dispose();
});
