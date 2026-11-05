
import { createHash as move12_createHash } from 'node:crypto';

import { describe as move12_describe, expect as move12_expect, it as move12_it, vi as move12_vi } from 'vitest';

import { CommandIntents as move12_CommandIntents, type CommandIntent as move12_CommandIntent } from "./command-intents.js";

import { canonical as move12_canonical } from "./canonical.js";
import { describe as movedDescribe12 } from 'vitest';
movedDescribe12("command-intents.test.ts", () => {

const PARTITION = { origin: 'https://beeline.test', principal: 'reader' };

const hash = async (input: string) => move12_createHash('sha256').update(input).digest('hex');

const admitted = (text = 'hello') => ({ wire: { operation: 'sendRoomMessage', input: move12_canonical({ roomId: 'room', text, messageId: 'a'.repeat(64) }) }, isCurrent: () => true });

const receipt = (record: move12_CommandIntent, state: 'committed' | 'pending' | 'unknown' = 'committed') => ({ v: 1 as const, commandId: record.id, operation: record.operation, state });

function owner(save = move12_vi.fn(async (_records: readonly move12_CommandIntent[]) => {})) {
  let sequence = 0;
  const intents = new move12_CommandIntents({ save }, hash, () => `intent-${++sequence}`, () => 42);
  intents.setPartition(PARTITION);
  return { intents, save };
}

move12_describe('P7 durable private command owner', () => {
  move12_it('reserves one immutable intent synchronously and joins repeated preparation', async () => {
    const { intents, save } = owner();
    const first = intents.prepare(admitted()), second = intents.prepare(admitted());
    move12_expect(first).toBe(second);
    const record = await first;
    move12_expect(record).toMatchObject({ ...PARTITION, state: 'prepared', sent: false, id: 'a'.repeat(64) });
    move12_expect(save).toHaveBeenCalledTimes(1);
  });
  move12_it('never sends before the atomic storage promise succeeds', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const { intents } = owner(move12_vi.fn(async () => blocked));
    const preparing = intents.prepare(admitted());
    const send = move12_vi.fn();
    move12_expect(() => intents.dispatch({ ...PARTITION, id: 'a'.repeat(64), operation: 'sendRoomMessage' } as move12_CommandIntent,
      { kind: 'initial', generation: 1, commandDedupV1: true }, send)).toThrow('not durably prepared');
    move12_expect(send).not.toHaveBeenCalled();
    release(); await preparing;
  });
  move12_it('storage failure refuses preparation without a queue success or effect', async () => {
    const { intents } = owner(move12_vi.fn(async () => { throw new Error('disk full'); }));
    await move12_expect(intents.prepare(admitted())).rejects.toThrow('disk full');
    move12_expect(intents.view()).toEqual([]);
  });
  move12_it('loss becomes UNKNOWN; incapable server and same-generation reconnect cannot resend', async () => {
    const { intents } = owner(), record = await intents.prepare(admitted());
    const send = move12_vi.fn(async () => { throw new Error('reply lost'); });
    await move12_expect(intents.dispatch(record, { kind: 'initial', generation: 1, commandDedupV1: true }, send)).rejects.toThrow('reply lost');
    move12_expect(intents.view()[0]?.state).toBe('unknown');
    move12_expect(() => intents.dispatch(record, { kind: 'reconnect', generation: 2, commandDedupV1: false }, send)).toThrow('dedup unavailable');
    const resumed = move12_vi.fn(async (_op, _args, command) => { move12_expect(command.id).toBe(record.id); return receipt(record); });
    await intents.dispatch(record, { kind: 'reconnect', generation: 2, commandDedupV1: true }, resumed);
    move12_expect(resumed).toHaveBeenCalledTimes(1);
    move12_expect(intents.view()[0]?.state).toBe('committed');
  });
  move12_it('suspends old-principal intents on logout and resumes only the same principal', async () => {
    const { intents } = owner(), record = await intents.prepare(admitted());
    intents.setPartition({ ...PARTITION, principal: 'different' });
    move12_expect(intents.view()).toEqual([]);
    move12_expect(() => intents.dispatch(record, { kind: 'initial', generation: 1, commandDedupV1: true }, move12_vi.fn())).toThrow('principal suspended');
    intents.setPartition(PARTITION);
    await intents.dispatch(record, { kind: 'initial', generation: 2, commandDedupV1: true }, async () => receipt(record));
    move12_expect(intents.view()[0]?.state).toBe('committed');
  });
  move12_it('committed fact wins before a late pending receipt and no effect is applied twice', async () => {
    const { intents } = owner(), record = await intents.prepare(admitted());
    let complete!: (value: ReturnType<typeof receipt>) => void, sent!: () => void;
    const started = new Promise<void>(resolve => { sent = resolve; });
    const delayed = new Promise<ReturnType<typeof receipt>>(resolve => { complete = resolve; });
    const sending = intents.dispatch(record, { kind: 'initial', generation: 1, commandDedupV1: true }, async () => { sent(); return delayed; });
    await started;
    await intents.committedEffect(PARTITION, record.operation, record.id);
    complete(receipt(record, 'pending'));
    move12_expect((await sending).state).toBe('committed');
  });
  move12_it('cancel is permitted before send and cannot invent cancellation after send', async () => {
    const { intents } = owner(), record = await intents.prepare(admitted());
    move12_expect((await intents.cancel(record)).state).toBe('cancelled');
    const send = move12_vi.fn();
    move12_expect((await intents.dispatch(record, { kind: 'initial', generation: 1, commandDedupV1: true }, send)).state).toBe('cancelled');
    move12_expect(send).not.toHaveBeenCalled();
  });
  move12_it('restores a crash during sending as UNKNOWN and preserves original identity/bytes', async () => {
    const { intents } = owner(), record = await intents.prepare(admitted());
    const restored = owner().intents;
    restored.restore([{ ...record, state: 'sending', sent: true }]);
    move12_expect(restored.view()[0]).toMatchObject({ id: record.id, bytes: record.bytes, digest: record.digest, state: 'unknown' });
  });
  move12_it('capacity refuses the 101st command synchronously without evicting uncertainty', async () => {
    const { intents } = owner();
    for (let index = 0; index < 100; index++) await intents.prepare({ wire: { operation: 'markRead', input: move12_canonical({ roomId: 'room', messageId: String(index) }) }, isCurrent: () => true });
    move12_expect(() => intents.prepare({ wire: { operation: 'markRead', input: move12_canonical({ roomId: 'room', messageId: 'overflow' }) }, isCurrent: () => true })).toThrow('capacity');
    move12_expect(intents.view()).toHaveLength(100);
  });
});
});
