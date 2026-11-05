import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
vi.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } }));
vi.mock('@/auth/buzz-identity-storage', () => ({ loadBuzzIdentity: async () => ({ publicKey: 'c'.repeat(64) }), getEffectiveRelayUrl: async () => 'https://command.test' }));
vi.mock('./surface-storage', () => ({routerAuthorityStorageReady:()=>true,routerCommandStorageReady:()=>true,
  routerLaneStorage: () => ({ write: async () => {}, fence: async () => {},floor:async()=>{}, remove: async () => {}, subscribeFences: () => () => {},subscribeFloors:()=>()=>{} }) }));
import { activateCommandOwner, suspendCommandOwner } from './command-owner';
import { prepareRouterMessageGesture } from './command-message-gesture';
import { routerOwnerNavigation, routerOwnerNegotiated } from './router-owner';
import { resetClientState } from '@/sync/client-reset';
const ORIGIN = 'https://command.test', PRINCIPAL = 'c'.repeat(64);
const ROOM = '22222222-2222-4222-8222-222222222222';
const input = { roomId: ROOM, principal: PRINCIPAL, text: 'A prepared command', attachments: [], mentions: [] };
const bridge = (requestCommand: ReturnType<typeof vi.fn>) => ({ commandState: () => ({ ready: fixture.ready, commandDedupV1: fixture.capable, generation: fixture.generation }), requestCommand });
const committed = (_operation: string, _args: unknown, command: { id: string }): RouterCommandReceipt => ({ v: 1, operation: _operation, commandId: command.id, state: 'committed' });
async function focus() {
  routerOwnerNavigation({ routes: [{ key: 'room', name: 'beeline/chat/[channelId]', params: { channelId: ROOM } }] });
  await routerOwnerNegotiated({ generation: fixture.generation, families: [], execute: async () => { throw new Error('no read expected'); } });
}
beforeEach(async () => {
  suspendCommandOwner(); resetClientState(); fixture.disk.clear(); fixture.random = 1; fixture.write = undefined;
  fixture.ready = true; fixture.capable = true; fixture.generation += 1;
  await focus();
});
afterEach(() => { suspendCommandOwner(); vi.useRealTimers(); });
describe('phone growth and recovery', () => {
  it('automatically retries a lost receipt with the exact ID and bytes on the same socket', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockRejectedValueOnce(new Error('receipt lost')).mockImplementation(committed);
    const owner = activateCommandOwner(ORIGIN, PRINCIPAL, bridge(send));
    const record = await prepareRouterMessageGesture(input)!.persisted;
    await expect(owner.deliver(record.id)).rejects.toThrow('receipt lost');
    await vi.advanceTimersByTimeAsync(499); expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
    expect(owner.find(record.id)?.state).toBe('committed');
    await vi.advanceTimersByTimeAsync(60_000); expect(send).toHaveBeenCalledTimes(2);
  });
  it('suspension cancels automatic retries of an uncertain command', async () => {
    vi.useFakeTimers(); const send = vi.fn().mockRejectedValue(new Error('offline'));
    const owner = activateCommandOwner(ORIGIN, PRINCIPAL, bridge(send));
    const record = await prepareRouterMessageGesture(input)!.persisted;
    await expect(owner.deliver(record.id)).rejects.toThrow('offline');
    owner.suspend(); await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
