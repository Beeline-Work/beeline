import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CommandIntents, type CommandIntent } from './private/command-intents.js';
import { canonical } from './private/canonical.js';
const PARTITION = { origin: 'https://beeline.test', principal: 'reader' };
const hash = async (input: string) => createHash('sha256').update(input).digest('hex');
const admitted = (text = 'hello') => ({ wire: { operation: 'sendRoomMessage', input: canonical({ roomId: 'room', text, messageId: 'a'.repeat(64) }) }, isCurrent: () => true });
const receipt = (record: CommandIntent, state: 'committed' | 'pending' | 'unknown' = 'committed') => ({ v: 1 as const, commandId: record.id, operation: record.operation, state });
function owner(save = vi.fn(async (_records: readonly CommandIntent[]) => {})) {
  let sequence = 0;
  const intents = new CommandIntents({ save }, hash, () => `intent-${++sequence}`, () => 42);
  intents.setPartition(PARTITION);
  return { intents, save };
}
describe('P7 durable private command owner', () => {
  it('reserves one immutable intent synchronously and joins repeated preparation', async () => {
    const { intents, save } = owner();
    const first = intents.prepare(admitted()), second = intents.prepare(admitted());
    expect(first).toBe(second);
    const record = await first;
    expect(record).toMatchObject({ ...PARTITION, state: 'prepared', sent: false, id: 'a'.repeat(64) });
    expect(save).toHaveBeenCalledTimes(1);
  });
  it('never sends before the atomic storage promise succeeds', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const { intents } = owner(vi.fn(async () => blocked));
    const preparing = intents.prepare(admitted());
    const send = vi.fn();
    expect(() => intents.dispatch({ ...PARTITION, id: 'a'.repeat(64), operation: 'sendRoomMessage' } as CommandIntent,
      { kind: 'initial', generation: 1, commandDedupV1: true }, send)).toThrow('not durably prepared');
    expect(send).not.toHaveBeenCalled();
    release(); await preparing;
  });
  it('storage failure refuses preparation without a queue success or effect', async () => {
    const { intents } = owner(vi.fn(async () => { throw new Error('disk full'); }));
    await expect(intents.prepare(admitted())).rejects.toThrow('disk full');
    expect(intents.view()).toEqual([]);
  });
  it('loss becomes UNKNOWN; incapable server and same-generation reconnect cannot resend', async () => {
    const { intents } = owner(), record = await intents.prepare(admitted());
    const send = vi.fn(async () => { throw new Error('reply lost'); });
    await expect(intents.dispatch(record, { kind: 'initial', generation: 1, commandDedupV1: true }, send)).rejects.toThrow('reply lost');
    expect(intents.view()[0]?.state).toBe('unknown');
    expect(() => intents.dispatch(record, { kind: 'reconnect', generation: 2, commandDedupV1: false }, send)).toThrow('dedup unavailable');
    const resumed = vi.fn(async (_op, _args, command) => { expect(command.id).toBe(record.id); return receipt(record); });
    await intents.dispatch(record, { kind: 'reconnect', generation: 2, commandDedupV1: true }, resumed);
    expect(resumed).toHaveBeenCalledTimes(1);
    expect(intents.view()[0]?.state).toBe('committed');
  });
  it('suspends old-principal intents on logout and resumes only the same principal', async () => {
    const { intents } = owner(), record = await intents.prepare(admitted());
    intents.setPartition({ ...PARTITION, principal: 'different' });
    expect(intents.view()).toEqual([]);
    expect(() => intents.dispatch(record, { kind: 'initial', generation: 1, commandDedupV1: true }, vi.fn())).toThrow('principal suspended');
    intents.setPartition(PARTITION);
    await intents.dispatch(record, { kind: 'initial', generation: 2, commandDedupV1: true }, async () => receipt(record));
    expect(intents.view()[0]?.state).toBe('committed');
  });
  it('committed fact wins before a late pending receipt and no effect is applied twice', async () => {
    const { intents } = owner(), record = await intents.prepare(admitted());
    let complete!: (value: ReturnType<typeof receipt>) => void, sent!: () => void;
    const started = new Promise<void>(resolve => { sent = resolve; });
    const delayed = new Promise<ReturnType<typeof receipt>>(resolve => { complete = resolve; });
    const sending = intents.dispatch(record, { kind: 'initial', generation: 1, commandDedupV1: true }, async () => { sent(); return delayed; });
    await started;
    await intents.committedEffect(PARTITION, record.operation, record.id);
    complete(receipt(record, 'pending'));
    expect((await sending).state).toBe('committed');
  });
  it('cancel is permitted before send and cannot invent cancellation after send', async () => {
    const { intents } = owner(), record = await intents.prepare(admitted());
    expect((await intents.cancel(record)).state).toBe('cancelled');
    const send = vi.fn();
    expect((await intents.dispatch(record, { kind: 'initial', generation: 1, commandDedupV1: true }, send)).state).toBe('cancelled');
    expect(send).not.toHaveBeenCalled();
  });
  it('restores a crash during sending as UNKNOWN and preserves original identity/bytes', async () => {
    const { intents } = owner(), record = await intents.prepare(admitted());
    const restored = owner().intents;
    restored.restore([{ ...record, state: 'sending', sent: true }]);
    expect(restored.view()[0]).toMatchObject({ id: record.id, bytes: record.bytes, digest: record.digest, state: 'unknown' });
  });
  it('capacity refuses the 101st command synchronously without evicting uncertainty', async () => {
    const { intents } = owner();
    for (let index = 0; index < 100; index++) await intents.prepare({ wire: { operation: 'markRead', input: canonical({ roomId: 'room', messageId: String(index) }) }, isCurrent: () => true });
    expect(() => intents.prepare({ wire: { operation: 'markRead', input: canonical({ roomId: 'room', messageId: 'overflow' }) }, isCurrent: () => true })).toThrow('capacity');
    expect(intents.view()).toHaveLength(100);
  });
});
