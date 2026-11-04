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
vi.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } }));
vi.mock('@/auth/buzz-identity-storage', () => ({ loadBuzzIdentity: async () => ({ publicKey: 'c'.repeat(64) }), getEffectiveRelayUrl: async () => 'https://command.test' }));
vi.mock('./surface-storage', () => ({routerAuthorityStorageReady:()=>true,routerCommandStorageReady:()=>true,
  routerLaneStorage: () => ({ write: async () => {}, fence: async () => {},floor:async()=>{}, remove: async () => {}, subscribeFences: () => () => {},subscribeFloors:()=>()=>{} }) }));
import { activateCommandOwner, suspendCommandOwner } from './command-owner';
import { routerOwnerNavigation, routerOwnerNegotiated,admitRouterScheduledStop } from './router-owner';
import { resetClientState } from '@/sync/client-reset';
const ORIGIN = 'https://command.test', PRINCIPAL = 'c'.repeat(64);
const ROOM = '22222222-2222-4222-8222-222222222222';
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
describe('actual mobile prepared-command owner', () => {
  async function scheduleFocus(){
    routerOwnerNavigation({routes:[{key:'scheduled',name:'beeline/settings/schedule',params:{roomId:ROOM}}]});
    await routerOwnerNegotiated({generation:++fixture.generation,families:['room-scheduled-work'],authorityFencesV1:true,
      execute:async()=>{throw new Error('A stop must never read a display');}});
  }
  it('durable Scheduled Work stop reserves in the gesture, persists before dispatch and survives blur without a display read',async()=>{
    await scheduleFocus();const trace:string[]=[];
    const send=vi.fn(async(...args:Parameters<typeof committed>)=>{trace.push('network');return committed(...args);});
    const owner=activateCommandOwner(ORIGIN,PRINCIPAL,bridge(send));fixture.write=()=>trace.push('persisted');
    const schedule='33333333-3333-4333-8333-333333333333';
    const pending=owner.prepare(admitRouterScheduledStop('deleteRoomSchedule',ROOM,schedule));
    routerOwnerNavigation({routes:[{key:'elsewhere',name:'beeline/channels'}]});trace.push('gesture-returned');
    const record=await pending;await owner.deliver(record.id);
    expect(trace.indexOf('persisted')).toBeLessThan(trace.indexOf('network'));
    expect(send).toHaveBeenCalledWith('deleteRoomSchedule',{roomId:ROOM,scheduleId:schedule},{v:1,id:record.id},undefined);
    expect(owner.find(record.id)?.state).toBe('committed');
  });
  it('a lost subscription-stop receipt resumes the exact durable identity once on a real negotiated generation',async()=>{
    await scheduleFocus();let effects=0;
    const send=vi.fn(async(...args:Parameters<typeof committed>)=>{if(++effects===1)throw new Error('committed result dropped');return committed(...args);});
    const owner=activateCommandOwner(ORIGIN,PRINCIPAL,bridge(send));
    const record=await owner.prepare(admitRouterScheduledStop('deleteRoomSubscription',ROOM,'legacy:'+ROOM+':helper:joined'));
    await expect(owner.deliver(record.id)).rejects.toThrow('dropped');expect(owner.find(record.id)?.state).toBe('unknown');
    fixture.generation++;await owner.negotiated();await owner.negotiated();
    expect(send).toHaveBeenCalledTimes(2);expect(send.mock.calls[0]![2]).toEqual(send.mock.calls[1]![2]);expect(owner.find(record.id)?.state).toBe('committed');
  });
  it('a stop admitted before connection loss remains prepared and sends once at the next actual connection',async()=>{
    await scheduleFocus();const send=vi.fn(async(...args:Parameters<typeof committed>)=>committed(...args));
    const owner=activateCommandOwner(ORIGIN,PRINCIPAL,bridge(send));
    const record=await owner.prepare(admitRouterScheduledStop('deleteRoomSchedule',ROOM,'33333333-3333-4333-8333-333333333333'));
    fixture.ready=false;await expect(owner.deliver(record.id)).rejects.toThrow();expect(owner.find(record.id)?.state).toBe('prepared');expect(send).not.toHaveBeenCalled();
    fixture.ready=true;fixture.generation++;await owner.negotiated();await owner.negotiated();expect(send).toHaveBeenCalledTimes(1);
  });
  it('atomic intent storage failure prevents command dispatch', async () => {
    await scheduleFocus();
    const send = vi.fn(async (...args: Parameters<typeof committed>) => committed(...args));
    const owner = activateCommandOwner(ORIGIN, PRINCIPAL, bridge(send));
    fixture.write = () => { throw new Error('synthetic storage full'); };
    await expect(owner.prepare(admitRouterScheduledStop('deleteRoomSchedule', ROOM,
      '33333333-3333-4333-8333-333333333333'))).rejects.toThrow('synthetic storage full');
    expect(send).not.toHaveBeenCalled(); expect(fixture.disk.size).toBe(0);
  });

  it('keeps an uncertain stop parked on an incapable connection and resumes the same identity', async () => {
    await scheduleFocus();
    const send = vi.fn().mockRejectedValueOnce(new Error('receipt lost')).mockImplementation(committed);
    const owner = activateCommandOwner(ORIGIN, PRINCIPAL, bridge(send));
    const record = await owner.prepare(admitRouterScheduledStop('deleteRoomSchedule', ROOM,
      '33333333-3333-4333-8333-333333333333'));
    await expect(owner.deliver(record.id)).rejects.toThrow('receipt lost');
    expect(owner.find(record.id)?.state).toBe('unknown');
    fixture.capable = false; fixture.generation++;
    expect(owner.canPrepare()).toBe(false);
    await owner.negotiated();
    await expect(owner.deliver(record.id)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
    fixture.capable = true; fixture.generation++;
    await owner.negotiated(); await owner.negotiated();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[2]).toEqual(send.mock.calls[0]?.[2]);
  });

  it('reset suspends late writes and same-principal return preserves uncertain and new intents', async () => {
    await scheduleFocus();
    let started!: () => void, finish!: (receipt: RouterCommandReceipt) => void;
    const sending = new Promise<void>(resolve => { started = resolve; });
    const delayed = new Promise<RouterCommandReceipt>(resolve => { finish = resolve; });
    const old = activateCommandOwner(ORIGIN, PRINCIPAL, bridge(vi.fn(async () => { started(); return delayed; })));
    const first = await old.prepare(admitRouterScheduledStop('deleteRoomSchedule', ROOM,
      '33333333-3333-4333-8333-333333333333'));
    const pending = old.deliver(first.id); void pending.catch(() => undefined); await sending;
    const current = activateCommandOwner(ORIGIN, PRINCIPAL,
      bridge(vi.fn(async (...args: Parameters<typeof committed>) => committed(...args))));
    const second = await current.prepare(admitRouterScheduledStop('deleteRoomSchedule', ROOM,
      '44444444-4444-4444-8444-444444444444'));
    finish({ v: 1, operation: first.operation, commandId: first.id, state: 'committed' });
    await expect(pending).rejects.toThrow('suspended');
    const saved = JSON.parse([...fixture.disk.values()][0]!) as { id: string; state: string }[];
    expect(saved.some(record => record.id === second.id)).toBe(true);
    expect(current.find(first.id)?.state).toBe('unknown'); expect(old.find(first.id)).toBeUndefined();
  });
});
