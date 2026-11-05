import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouterCommandReceipt } from '@beeline/api-contract/router-command';
const fixture = vi.hoisted(() => ({
  disk: new Map<string, string>(), random: 1, write: undefined as (() => void) | undefined,
  ready: true, capable: true, generation: 1,
}));
vi.mock('@/utils/web-storage', () => ({ webRuntimeStorage: () => undefined }));
vi.mock('react-native-mmkv', () => ({ MMKV: class {
  getString(key: string) { return fixture.disk.get(key); }
  set(key: string, value: string) { fixture.write?.(); fixture.disk.set(key, value); }
  delete(key: string) { fixture.disk.delete(key); }
  getAllKeys() { return [...fixture.disk.keys()]; }
} }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length).fill(fixture.random++) }));
import { activateCommandOwner, suspendCommandOwner } from './command-owner';
const ORIGIN = 'https://command.test', PRINCIPAL = 'c'.repeat(64);
const ROOM = '22222222-2222-4222-8222-222222222222';
const bridge = (requestCommand: ReturnType<typeof vi.fn>) => ({ commandState: () => ({ ready: fixture.ready, commandDedupV1: fixture.capable, generation: fixture.generation }), requestCommand });
const committed = (operation: string, _args: unknown, command: { id: string }): RouterCommandReceipt => ({ v: 1, operation, commandId: command.id, state: 'committed' });
beforeEach(() => {
  suspendCommandOwner(); fixture.disk.clear(); fixture.random = 1; fixture.write = undefined;
  fixture.ready = true; fixture.capable = true; fixture.generation += 1;
});
describe('general phone writes share durable command ownership', () => {
  it('persists wallet intent before network, joins simultaneous calls and preserves the typed result', async () => {
    const trace: string[] = [];
    fixture.write = () => { trace.push('persist'); };
    const request = vi.fn(async (operation, args, command) => {
      trace.push('network');
      return { ...committed(operation, args, command), result: { sent: true } };
    });
    const owner = activateCommandOwner(ORIGIN, PRINCIPAL, bridge(request));
    const input = { amount: '1', destination: 'synthetic' } as never;
    const results = await Promise.all([owner.execute('sendFromWallet', input), owner.execute('sendFromWallet', input)]);
    expect(results).toEqual([{ sent: true }, { sent: true }]);
    expect(request).toHaveBeenCalledOnce();
    expect(trace.indexOf('persist')).toBeLessThan(trace.indexOf('network'));
    expect(JSON.parse([...fixture.disk.values()][0]!)[0]).toMatchObject({ operation: 'sendFromWallet', state: 'committed' });
  });
  it('a lost wallet reply keeps its immutable identity when the person explicitly checks again', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('reply lost')).mockImplementation(async (operation, args, command) => ({
      ...committed(operation, args, command), result: { sent: true },
    }));
    const owner = activateCommandOwner(ORIGIN, PRINCIPAL, bridge(request));
    const input = { amount: '1', destination: 'synthetic' } as never;
    await expect(owner.execute('sendFromWallet', input)).rejects.toThrow('reply lost');
    await expect(owner.execute('sendFromWallet', input)).resolves.toEqual({ sent: true });
    expect(request.mock.calls[0]![2]).toEqual(request.mock.calls[1]![2]);
  });
  it('general writes fail closed on persistence failure without sending', async () => {
    const request = vi.fn();
    const owner = activateCommandOwner(ORIGIN, PRINCIPAL, bridge(request));
    fixture.write = () => { throw new Error('storage full'); };
    await expect(owner.execute('createWorkspace', { name: 'Synthetic' })).rejects.toThrow('storage full');
    expect(request).not.toHaveBeenCalled();
  });
});

it('assigns a missing message identity before persistence and preserves keyed committed replay', async () => {
  const request = vi.fn(committed);
  const owner = activateCommandOwner(ORIGIN, PRINCIPAL, bridge(request));
  const result = await owner.execute('sendRoomMessage', { roomId: ROOM, text: 'Forwarded' });
  const args = request.mock.calls[0]![1] as { roomId: string; text: string; messageId: string };
  expect(args.messageId).toMatch(/^[0-9a-f]{64}$/);
  expect(result).toEqual({ messageId: args.messageId });
  await expect(owner.execute('sendRoomMessage', args)).resolves.toEqual(result);
  expect(request).toHaveBeenCalledOnce();
  await expect(owner.execute('sendRoomMessage', { ...args, text: 'Changed bytes' })).rejects.toThrow('identity already used');
});

it('holds a cold-start action behind persistence and the existing negotiation event', async () => {
  fixture.ready = false; fixture.capable = false;
  const listeners = new Set<() => void>();
  const request = vi.fn(async (operation, args, command) => ({ ...committed(operation, args, command), result: { id: 'workspace' } }));
  const owner = activateCommandOwner(ORIGIN, PRINCIPAL, { ...bridge(request),
    subscribeCommandCapabilities: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } });
  const pending = owner.execute('createWorkspace', { name: 'Cold start' });
  await vi.waitFor(() => expect(listeners.size).toBe(1));
  expect(request).not.toHaveBeenCalled();
  expect(JSON.parse([...fixture.disk.values()][0]!)[0].state).toBe('prepared');
  fixture.ready = true; fixture.capable = true; fixture.generation++;
  for (const listener of listeners) listener();
  await expect(pending).resolves.toEqual({ id: 'workspace' });
  expect(request).toHaveBeenCalledOnce(); expect(listeners.size).toBe(0);
});

it('cancels a cold-start action aborted before socket admission so reload cannot resurrect it', async () => {
  fixture.ready = false; fixture.capable = false;
  const listeners = new Set<() => void>(), request = vi.fn(), controller = new AbortController();
  const owner = activateCommandOwner(ORIGIN, PRINCIPAL, { ...bridge(request),
    subscribeCommandCapabilities: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } });
  const pending = owner.execute('voiceJoin', { roomId: ROOM }, { signal: controller.signal });
  void pending.catch(() => undefined);
  await vi.waitFor(() => expect(listeners.size).toBe(1));
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(JSON.parse([...fixture.disk.values()][0]!)[0].state).toBe('cancelled');
  fixture.ready = true; fixture.capable = true; fixture.generation++;
  await owner.negotiated();
  expect(request).not.toHaveBeenCalled(); expect(listeners.size).toBe(0);
});
