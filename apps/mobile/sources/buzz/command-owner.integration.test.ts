import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
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
import { activateCommandOwner, suspendCommandOwner, canonical } from './command-owner';
import { prepareRouterMessageGesture } from './command-message-gesture';

import { resetClientState } from '@/sync/client-reset';
import { MessageOutbox } from './message-outbox';
const ORIGIN = 'https://command.test', PRINCIPAL = 'c'.repeat(64);
const ROOM = '22222222-2222-4222-8222-222222222222';
const input = { roomId: ROOM, principal: PRINCIPAL, text: 'A prepared command', attachments: [], mentions: [] };
const bridge = (requestCommand: ReturnType<typeof vi.fn>) => ({ commandState: () => ({ ready: fixture.ready, commandDedupV1: fixture.capable, generation: fixture.generation }), requestCommand });
const committed = (_operation: string, _args: unknown, command: { id: string }): RouterCommandReceipt => ({ v: 1, operation: _operation, commandId: command.id, state: 'committed' });
beforeEach(async () => {
  suspendCommandOwner(); resetClientState(); fixture.disk.clear(); fixture.random = 1; fixture.write = undefined;
  fixture.ready = true; fixture.capable = true; fixture.generation += 1;
});
describe('actual mobile prepared-command owner and existing outbox', () => {
  it('durable Scheduled Work stop reserves in the gesture, persists before dispatch and survives blur without a display read',async()=>{
    const trace:string[]=[];
    const send=vi.fn(async(...args:Parameters<typeof committed>)=>{trace.push('network');return committed(...args);});
    const owner=activateCommandOwner(ORIGIN,PRINCIPAL,bridge(send));fixture.write=()=>trace.push('persisted');
    const schedule='33333333-3333-4333-8333-333333333333';
    const pending=owner.prepare(scheduledStop('deleteRoomSchedule',ROOM,schedule));

    const record=await pending;await owner.deliver(record.id);
    expect(trace.indexOf('persisted')).toBeLessThan(trace.indexOf('network'));
    expect(send).toHaveBeenCalledWith('deleteRoomSchedule',{roomId:ROOM,scheduleId:schedule},{v:1,id:record.id},undefined);
    expect(owner.find(record.id)?.state).toBe('committed');
  });
  it('a lost subscription-stop receipt resumes the exact durable identity once on a real negotiated generation',async()=>{
    let effects=0;
    const send=vi.fn(async(...args:Parameters<typeof committed>)=>{if(++effects===1)throw new Error('committed result dropped');return committed(...args);});
    const owner=activateCommandOwner(ORIGIN,PRINCIPAL,bridge(send));
    const record=await owner.prepare(scheduledStop('deleteRoomSubscription',ROOM,'legacy:'+ROOM+':helper:joined'));
    await expect(owner.deliver(record.id)).rejects.toThrow('dropped');expect(owner.find(record.id)?.state).toBe('unknown');
    fixture.generation++;await owner.negotiated();await owner.negotiated();
    expect(send).toHaveBeenCalledTimes(2);expect(send.mock.calls[0]![2]).toEqual(send.mock.calls[1]![2]);expect(owner.find(record.id)?.state).toBe('committed');
  });
  it('a stop admitted before connection loss remains prepared and sends once at the next actual connection',async()=>{
    const send=vi.fn(async(...args:Parameters<typeof committed>)=>committed(...args));
    const owner=activateCommandOwner(ORIGIN,PRINCIPAL,bridge(send));
    const record=await owner.prepare(scheduledStop('deleteRoomSchedule',ROOM,'33333333-3333-4333-8333-333333333333'));
    fixture.ready=false;await expect(owner.deliver(record.id)).rejects.toThrow();expect(owner.find(record.id)?.state).toBe('prepared');expect(send).not.toHaveBeenCalled();
    fixture.ready=true;fixture.generation++;await owner.negotiated();await owner.negotiated();expect(send).toHaveBeenCalledTimes(1);
  });
  it('negotiated send persists immutable intent before the existing outbox can send', async () => {
    const trace: string[] = [], send = vi.fn(async (...args: Parameters<typeof committed>) => { trace.push('network'); return committed(...args); });
    const commands = activateCommandOwner(ORIGIN, PRINCIPAL, bridge(send));
    fixture.write = () => { trace.push('intent-persisted'); };
    const gesture = prepareRouterMessageGesture(input)!;
    // Blur immediately after the synchronous handler prefix; admitted immutable
    // persistence survives while a delayed admission would now be refused.

    trace.push('gesture-returned');
    expect(send).not.toHaveBeenCalled();
    const record = await gesture.persisted;
    const legacy = vi.fn(async () => ({ messageId: 'legacy' }));
    const outbox = new MessageOutbox({ load: async () => [], save: async () => {}, rejection: () => undefined,
      send: event => commands.find(event.id) ? commands.deliver(event.id) : legacy() });
    await outbox.enqueue(gesture.event, { id: gesture.event.id, text: gesture.event.content, createdAt: gesture.event.created_at,
      author: { pubkey: PRINCIPAL, kind: 'human', name: 'Synthetic Reader' }, presentation: 'message' });
    await outbox.connectionChanged(true);
    expect(send).toHaveBeenCalledTimes(1); expect(legacy).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[2]).toEqual({ v: 1, id: record.id });
    expect(trace.indexOf('intent-persisted')).toBeLessThan(trace.indexOf('network'));
    expect(trace[0]).toBe('gesture-returned'); expect(outbox.list()).toEqual([]); outbox.dispose();
  });
  it('incapable legacy negotiation does not create or transmit a command envelope', () => {
    fixture.capable = false;
    const send = vi.fn(async (...args: Parameters<typeof committed>) => committed(...args));
    activateCommandOwner(ORIGIN, PRINCIPAL, bridge(send));
    expect(prepareRouterMessageGesture(input)).toBeUndefined();
    expect(fixture.disk.size).toBe(0); expect(send).not.toHaveBeenCalled();
  });
  it('atomic intent storage failure prevents network and existing outbox enqueue', async () => {
    const send = vi.fn(async (...args: Parameters<typeof committed>) => committed(...args));
    activateCommandOwner(ORIGIN, PRINCIPAL, bridge(send));
    fixture.write = () => { throw new Error('synthetic storage full'); };
    const gesture = prepareRouterMessageGesture(input)!;
    await expect(gesture.persisted).rejects.toThrow('synthetic storage full');
    expect(send).not.toHaveBeenCalled(); expect(fixture.disk.size).toBe(0);
  });
  it('unknown intent never downgrades to legacy when the next server is incapable', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('receipt lost')).mockImplementation(committed);
    const commands = activateCommandOwner(ORIGIN, PRINCIPAL, bridge(send)), gesture = prepareRouterMessageGesture(input)!;
    const record = await gesture.persisted;
    await expect(commands.deliver(record.id)).rejects.toThrow('receipt lost');
    expect(commands.find(record.id)?.state).toBe('unknown');
    fixture.capable = false; fixture.generation += 1;
    const legacy = vi.fn(async () => ({ messageId: 'wrong-path' }));
    const outbox = new MessageOutbox({ load: async () => [], save: async () => {}, rejection: () => undefined,
      send: event => commands.find(event.id) ? commands.deliver(event.id) : legacy() });
    await outbox.enqueue(gesture.event, { id: record.id, text: input.text, createdAt: 1,
      author: { pubkey: PRINCIPAL, kind: 'human', name: 'Synthetic Reader' }, presentation: 'message' });
    await commands.negotiated(); await outbox.connectionChanged(true);
    expect(send).toHaveBeenCalledTimes(1); expect(legacy).not.toHaveBeenCalled(); expect(outbox.list()).toHaveLength(1);
    fixture.capable = true; fixture.generation += 1;
    await commands.negotiated(); await commands.negotiated();
    expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[1]?.[2]).toEqual({ v: 1, id: record.id }); outbox.dispose();
  });
  it('matching committed fact wins before a delayed pending receipt', async () => {
    let started!: () => void, finish!: (receipt: RouterCommandReceipt) => void;
    const sending = new Promise<void>(resolve => { started = resolve; });
    const delayed = new Promise<RouterCommandReceipt>(resolve => { finish = resolve; });
    const send = vi.fn(async () => { started(); return delayed; });
    const commands = activateCommandOwner(ORIGIN, PRINCIPAL, bridge(send)), gesture = prepareRouterMessageGesture(input)!;
    const record = await gesture.persisted, result = commands.deliver(record.id);
    await sending; await commands.committedMessage(record.id);
    finish({ v: 1, operation: record.operation, commandId: record.id, state: 'pending' });
    expect(await result).toEqual({ messageId: record.id }); expect(commands.find(record.id)?.state).toBe('committed'); expect(send).toHaveBeenCalledTimes(1);
  });
  it('reset suspends late writes and same-principal return preserves both uncertain and new intent', async () => {
    let started!: () => void, finish!: (receipt: RouterCommandReceipt) => void;
    const sending = new Promise<void>(resolve => { started = resolve; });
    const delayed = new Promise<RouterCommandReceipt>(resolve => { finish = resolve; });
    const old = activateCommandOwner(ORIGIN, PRINCIPAL, bridge(vi.fn(async () => { started(); return delayed; })));
    const first = await prepareRouterMessageGesture(input)!.persisted;
    const pending = old.deliver(first.id); void pending.catch(() => undefined); await sending;
    const current = activateCommandOwner(ORIGIN, PRINCIPAL, bridge(vi.fn(async (...args: Parameters<typeof committed>) => committed(...args))));
    const second = await prepareRouterMessageGesture({ ...input, text: 'A new explicit action' })!.persisted;
    finish({ v: 1, operation: first.operation, commandId: first.id, state: 'committed' });
    await expect(pending).rejects.toThrow('suspended');
    const saved = JSON.parse([...fixture.disk.values()][0]!) as { id: string; state: string }[];
    expect(saved.some(record => record.id === second.id)).toBe(true);
    expect(current.find(first.id)?.state).toBe('unknown'); expect(old.find(first.id)).toBeUndefined();
  });
  it('existing Send/Enter/dictation handler prepares before its first await', () => {
    const source = readFileSync(new URL('../app/(app)/beeline/chat/_chat-surface.tsx', import.meta.url), 'utf8');
    const start = source.indexOf('const handleSend = useCallback('), end = source.indexOf('const handleSendRef', start);
    const handler = source.slice(start, end);
    expect(handler.indexOf('prepareRouterMessageGesture(')).toBeGreaterThan(0);
    expect(handler.indexOf('prepareRouterMessageGesture(')).toBeLessThan(handler.search(/\bawait\s+/));
    expect(handler.indexOf('await routerPrepared.persisted')).toBeLessThan(handler.indexOf('await activeOutbox.enqueue('));
  });
});

function scheduledStop(operation:string,roomId:string,id:string) {
  const input=operation==='deleteRoomSchedule'?{roomId,scheduleId:id}:{roomId,subscriptionId:id};
  return {wire:{operation,input:canonical(input)},isCurrent:()=>true};
}
