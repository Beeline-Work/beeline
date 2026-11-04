import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  const disk = new Map<string, string>();
  return {
    disk, random: 1, quota: false,
    storage: {
      get length() { return disk.size; },
      key: (index: number) => [...disk.keys()][index] ?? null,
      getItem: (key: string) => disk.get(key) ?? null,
      setItem(key: string, value: string) {
        if (fixture.quota) throw new Error('storage full');
        disk.set(key, value);
      },
      removeItem: (key: string) => { disk.delete(key); },
      clear: () => disk.clear(),
    },
  };
});
vi.mock('@/utils/web-storage', () => ({ webRuntimeStorage: () => ({ storage: fixture.storage }) }));
vi.mock('react-native-mmkv', () => ({ MMKV: class {} }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length).fill(fixture.random++) }));

import { CommandAwaitingConfirmation, MobileCommandOwner } from './command-owner';
import type { CommandIntent } from '@beeline/net/owner';
import type { RouterCommandReceipt } from '@beeline/api-contract/router-command';

const ORIGIN = 'https://commands.test', PRINCIPAL = 'c'.repeat(64);
const admitted = (workspaceId: string) => ({
  wire: { operation: 'clearNeedsYouSection', input: JSON.stringify({ workspaceId }) },
  isCurrent: () => true,
});
const committed = (operation: string, _args: unknown, command: { id: string }): RouterCommandReceipt =>
  ({ v: 1, operation, commandId: command.id, state: 'committed' });
const owner = (requestCommand = vi.fn(async (...args: Parameters<typeof committed>) => committed(...args))) =>
  new MobileCommandOwner(ORIGIN, PRINCIPAL, {
    commandState: () => ({ ready: true, commandDedupV1: true, generation: 1 }), requestCommand,
  });
const saved = (): CommandIntent[] => JSON.parse([...fixture.disk.values()][0] ?? '[]');

beforeEach(() => {
  fixture.disk.clear(); fixture.random = 1; fixture.quota = false;
  const locks = new Map<string, Promise<unknown>>();
  const held = new Set<string>();
  vi.stubGlobal('navigator', { locks: {
    request: (name: string, options: { ifAvailable?: boolean }, work: (lock: object | null) => unknown) => {
      if (options.ifAvailable) {
        if (held.has(name)) return Promise.resolve(work(null));
        held.add(name);
        return Promise.resolve().then(() => work({ name })).finally(() => { held.delete(name); });
      }
      const next = (locks.get(name) ?? Promise.resolve()).then(() => work({ name }));
      locks.set(name, next.catch(() => undefined));
      return next;
    },
  } });
});

afterEach(() => vi.unstubAllGlobals());

describe('browser command persistence across tabs', () => {
  it('allows browser actions and preserves both tabs commands through concurrent saves', async () => {
    const first = owner(), second = owner();
    expect(first.canPrepare()).toBe(true); expect(second.canPrepare()).toBe(true);
    const [a, b] = await Promise.all([first.prepare(admitted('workspace-a')), second.prepare(admitted('workspace-b'))]);
    expect(saved().map(record => record.id).sort()).toEqual([a.id, b.id].sort());
    await Promise.all([first.deliver(a.id), second.deliver(b.id)]);
    expect(saved().every(record => record.state === 'committed')).toBe(true);
    await first.prepare(admitted('workspace-c'));
    expect(saved()).toHaveLength(3);
    expect(saved().filter(record => record.state === 'committed')).toHaveLength(2);
    const next = await first.prepare(admitted('workspace-b'));
    expect(next.id).not.toBe(b.id);
  });

  it('cannot overwrite another tabs committed outcome with a late lost receipt', async () => {
    let rejectFirst!: (error: Error) => void, started!: () => void;
    const sending = new Promise<void>(resolve => { started = resolve; });
    const dropped = new Promise<RouterCommandReceipt>((_resolve, reject) => { rejectFirst = reject; });
    const firstSend = vi.fn(async () => { started(); return dropped; });
    const first = owner(firstSend), record = await first.prepare(admitted('workspace-a'));
    const inFlight = first.deliver(record.id); void inFlight.catch(() => undefined); await sending;
    const secondSend = vi.fn(async (...args: Parameters<typeof committed>) => committed(...args));
    const second = owner(secondSend);
    await second.deliver(record.id);
    rejectFirst(new Error('receipt dropped'));
    await expect(inFlight).rejects.toThrow('dropped');
    expect(saved().find(value => value.id === record.id)?.state).toBe('committed');
    await first.deliver(record.id);
    expect(firstSend).toHaveBeenCalledTimes(1); expect(secondSend).toHaveBeenCalledTimes(1);
  });

  it('leaves a live tabs unsent Undo command with that gesture and adopts its cancellation', async () => {
    const first = owner(), record = await first.prepare(admitted('workspace-a'));
    const send = vi.fn(async (...args: Parameters<typeof committed>) => committed(...args));
    const second = owner(send);
    await second.negotiated();
    expect(send).not.toHaveBeenCalled();
    await first.cancel(record.id);
    await expect(second.deliver(record.id)).rejects.toBeInstanceOf(CommandAwaitingConfirmation);
    expect(send).not.toHaveBeenCalled(); expect(saved()[0]?.state).toBe('cancelled');
  });

  it('recovers an abandoned prepared Tray command with its original identity and bytes', async () => {
    const first = owner(), record = await first.prepare(admitted('workspace-a'));
    const send = vi.fn(async (...args: Parameters<typeof committed>) => committed(...args));
    const replacement = owner(send);
    await replacement.negotiated();
    expect(send).not.toHaveBeenCalled();
    first.suspend();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await replacement.negotiated();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(record.operation, JSON.parse(record.bytes), { v: 1, id: record.id });
    expect(saved()[0]).toMatchObject({ id: record.id, bytes: record.bytes, state: 'committed' });
    await replacement.negotiated();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('preserves a live tabs delayed dispatch when a replacement negotiates', async () => {
    const send = vi.fn(async (...args: Parameters<typeof committed>) => committed(...args));
    const first = owner(send), record = await first.prepare(admitted('workspace-a'));
    const replacementSend = vi.fn(async (...args: Parameters<typeof committed>) => committed(...args));
    const replacement = owner(replacementSend);
    await replacement.negotiated();
    await first.deliver(record.id);
    await replacement.negotiated();
    expect(send).toHaveBeenCalledTimes(1);
    expect(replacementSend).not.toHaveBeenCalled();
    expect(saved()[0]?.state).toBe('committed');
  });

  it('refuses before sending when atomic storage is unavailable or full', async () => {
    const send = vi.fn(async (...args: Parameters<typeof committed>) => committed(...args)), current = owner(send);
    fixture.quota = true;
    await expect(current.prepare(admitted('workspace-a'))).rejects.toThrow('storage full');
    expect(send).not.toHaveBeenCalled(); expect(fixture.disk.size).toBe(0);
    vi.stubGlobal('navigator', {});
    expect(current.canPrepare()).toBe(false);
    await expect(current.prepare(admitted('workspace-b'))).rejects.toThrow('Atomic command storage');
    expect(send).not.toHaveBeenCalled();
  });

  it.each([false, true])('serializes another tabs Undo against dispatch (cancel first=%s)', async cancelFirst => {
    const send = vi.fn(async (...args: Parameters<typeof committed>) => committed(...args));
    const first = owner(send), record = await first.prepare(admitted('workspace-a')), second = owner();
    const attempts = cancelFirst
      ? [second.cancel(record.id), first.deliver(record.id)]
      : [first.deliver(record.id), second.cancel(record.id)];
    await Promise.allSettled(attempts);
    if (saved()[0]?.state === 'cancelled') expect(send).not.toHaveBeenCalled();
    else {
      expect(saved()[0]?.state).toBe('committed');
      expect(send).toHaveBeenCalledOnce();
    }
  });
});
