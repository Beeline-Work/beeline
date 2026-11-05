import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { RouterSnapshot, RouterSnapshotInput } from '@beeline/api-contract/router-protocol';
const fixture = vi.hoisted(() => ({
  authorityReady: true,commandsReady:true,
  state: 'active', events: [] as ((state: string) => void)[],
  storage: { floor: vi.fn(async () => {}), subscribeFloors: () => () => {}, write: vi.fn(async () => {}), fence: vi.fn(async () => {}), remove: vi.fn(async () => {}), subscribeFences: () => () => {} },
}));
vi.mock('react-native', () => ({ AppState: { get currentState() { return fixture.state; }, addEventListener: (_event: string, listener: (state: string) => void) => {
  fixture.events.push(listener); return { remove: () => {} };
} } }));
vi.mock('@/auth/buzz-identity-storage', () => ({
  loadBuzzIdentity: async () => ({ publicKey: 'ada' }), getEffectiveRelayUrl: async () => 'https://example.test',
}));
vi.mock('./surface-storage', () => ({ routerLaneStorage: () => fixture.storage, routerAuthorityStorageReady: () => fixture.authorityReady,routerCommandStorageReady:()=>fixture.commandsReady }));
import { resetClientState } from '@/sync/client-reset';
import { acquireRouterLane, acquireRouterSavedContinuation, acquireRouterRosterQuery, routerOwnerNegotiated, routerOwnerNavigation,
  readRouterToolPage, admitRouterTrayCommand, routerOwnerReceive, retryRouterLane } from './router-owner';
const hash = (value: unknown) => bytesToHex(sha256(utf8ToBytes(JSON.stringify(value))));
const scopes = [{ authorityScope: 'reader:ada:workspace:w', epoch: '1' }];
const authority = { digest: hash(scopes), scopes };
const snapshot = (value = 1): RouterSnapshot<'needs-you-count'> => ({ kind: 'snapshot', family: 'needs-you-count', scope: 'w',
  value: { count: value }, cut: { stream: 'workspace:w', epoch: 'stream', protocol: 1, through: value },
  authority, atomicGroup: 'needs:w:ada' });
const settle = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
beforeEach(() => { fixture.authorityReady = true;fixture.commandsReady=true; fixture.state = 'active'; resetClientState(); vi.clearAllMocks(); });

describe('phone growth and recovery', () => {
  it('retains more than sixteen Saved pages without refusing the next continuation', async () => {
    const cursor = (n: number) => `saved1.${Buffer.from(String(n)).toString('base64url')}`;
    const tray = { family: 'needs-you-tray' as const, workspaceId: 'w' };
    const scopeList = [...scopes, { authorityScope: 'reader:ada:workspace:w:visibility', epoch: '1' }];
    const base = { kind: 'snapshot' as const, scope: 'w', cut: snapshot().cut, atomicGroup: 'needs-you:w:ada',
      authority: { scopes: scopeList, digest: hash(scopeList) }, clockVersion: `tray-clock-v1:${'a'.repeat(32)}:0` };
    const execute = vi.fn(async (input: RouterSnapshotInput): Promise<RouterSnapshot> => {
      if (input.family === 'needs-you-tray') return { ...base, family: input.family,
        value: { needs: { items: [] }, saved: { windowId: `saved1:${'b'.repeat(64)}`, rows: [], next: cursor(0) } } };
      const before = (input as { before: string }).before;
      const index = Number(Buffer.from(before.slice(7), 'base64url').toString());
      return { ...base, family: 'needs-you-saved-page', value: { windowId: `saved1:${index.toString(16).padStart(64, '0')}`,
        before, rows: [], next: cursor(index + 1) } };
    });
    routerOwnerNavigation({ routes: [{ key: 'tray', name: 'beeline/tray', params: { communityId: 'w' } }] });
    const head = acquireRouterLane(tray, () => true, () => {});
    await routerOwnerNegotiated({ generation: 1, families: ['needs-you-tray', 'needs-you-saved-page'], authorityFencesV1: true, execute }); await settle();
    const pages: ReturnType<typeof acquireRouterSavedContinuation>[] = [];
    for (let index = 0; index < 32; index++) {
      const page = acquireRouterSavedContinuation('w', cursor(index), () => true, () => {}); pages.push(page); await settle();
      expect(page.current().state).toBe('LIVE');
    }
    for (let index = 0; index < 1895; index++) expect(admitRouterTrayCommand('w', { operation: 'setMessageBookmark',
      input: { roomId: 'room', messageId: String(index), bookmarked: true } }).wire.operation).toBe('setMessageBookmark');
    pages.forEach(page => page.release()); head.release();
  });
  it('F03 roster query observers cannot admit reads; Submit binds a held revision and source controls retire it without reading',async()=>{
    const ws='11111111-1111-4111-8111-111111111111',head={family:'workspace-roster' as const,workspaceId:ws};
    const input={...head,query:{revision:'1',q:'Reader'}};
    const person={pubkey:'a'.repeat(64),kind:'human' as const,name:'Reader'};
    const value={revision:'1',workspace:{id:ws,name:'Roster',visibility:'invite-only' as const,role:'owner' as const,updatedAt:1,createdAt:1},
      members:[{identity:person,role:'owner' as const}],agents:[],viewer:{identity:person,role:'owner' as const,permissions:{send:true,manage:true}},
      watchFilters:[],peopleTotal:1,agentTotal:0,membersTruncated:false,agentsTruncated:false};
    const certScopes=[{authorityScope:`reader:ada:workspace:${ws}`,epoch:'1'},{authorityScope:`roster:${ws}`,epoch:'1'}];
    const execute=vi.fn(async(request:RouterSnapshotInput):Promise<RouterSnapshot>=>({...snapshot(),family:'workspace-roster',scope:ws,
      value,atomicGroup:`workspace-roster:${ws}:ada${'query'in request?':query:sealed':''}`,
      authority:{scopes:certScopes,digest:hash(certScopes)},cut:{...snapshot().cut,stream:`workspace:${ws}`}}));
    routerOwnerNavigation({routes:[{key:'members',name:'beeline/members',params:{}}]});
    const root=acquireRouterLane(head,()=>true,()=>{});
    await routerOwnerNegotiated({generation:1,families:['workspace-roster'],authorityFencesV1:true,execute});await settle();
    const observer=acquireRouterLane(input,()=>true,()=>{});await settle();expect(execute).toHaveBeenCalledTimes(1);
    expect(()=>acquireRouterRosterQuery({...input,query:{revision:'2',q:'forged'}},()=>true,()=>{})).toThrow('no longer held');
    const page=acquireRouterRosterQuery(input,()=>true,()=>{});await settle();expect(execute).toHaveBeenCalledTimes(2);
    expect(page.current()).toMatchObject({state:'LIVE',value});
    const extraPages=[];
    for(let index=0;index<32;index++){
      const extra=acquireRouterRosterQuery({...input,query:{revision:'1',q:`Reader ${index}`}},()=>true,()=>{});
      extraPages.push(extra);await settle();expect(extra.current().state).toBe('LIVE');
    }
    extraPages.forEach(extra=>extra.release());
    const readCount=execute.mock.calls.length;
    const nextScopes=[{authorityScope:`roster:${ws}`,epoch:'2'}];
    routerOwnerReceive({kind:'authority-fence',scope:ws,authorityScope:`roster:${ws}`,mode:'advance',authority:{scopes:nextScopes,digest:hash(nextScopes)}});
    await settle();expect(page.current()).toMatchObject({state:'PARKED',value:null});expect(execute).toHaveBeenCalledTimes(readCount);
    page.release();observer.release();root.release();
  });
});
it('Room foreground automatically refreshes its unverified head with the current observation owner',async()=>{
  const room={family:'room-head' as const,roomId:'11111111-1111-4111-8111-111111111111',workspaceId:'w'};
  const roomScopes=[...scopes,{authorityScope:'room:11111111-1111-4111-8111-111111111111',epoch:'1'}];
  const current={...snapshot(),family:'room-head',scope:'11111111-1111-4111-8111-111111111111',value:{room:{id:'11111111-1111-4111-8111-111111111111'},messages:[]},
    authority:{scopes:roomScopes,digest:hash(roomScopes)},atomicGroup:'room-head:room:ada'} as unknown as RouterSnapshot<'room-head'>;
  const execute=vi.fn(async()=>current);
  routerOwnerNavigation({routes:[{key:'room',name:'beeline/chat/[channelId]',params:{channelId:'11111111-1111-4111-8111-111111111111',communityId:'w'}}]});
  const lane=acquireRouterLane(room,()=>true,()=>{});
  await routerOwnerNegotiated({generation:1,families:['room-head'],execute});await settle();
  expect(lane.current().state).toBe('LIVE');expect(execute).toHaveBeenCalledTimes(1);
  fixture.state='background';fixture.events.forEach(listener=>listener('background'));
  fixture.state='active';fixture.events.forEach(listener=>listener('active'));await settle();
  expect(execute).toHaveBeenCalledTimes(2);
  expect(lane.current().state).toBe('LIVE');
  retryRouterLane(room);await settle();expect(execute).toHaveBeenCalledTimes(3);expect(lane.current().state).toBe('LIVE');
  lane.release();
});
it('F07: actual focused owner coalesces tool demand and refuses a completion after navigation',async()=>{
  const roomId='22222222-2222-4222-8222-222222222222',workspaceId='11111111-1111-4111-8111-111111111111';
  const request={family:'room-head' as const,roomId,workspaceId};
  const execute=vi.fn(async()=>({...snapshot(),family:'room-head',scope:roomId,value:{room:{id:roomId},messages:[]},
    cut:{...snapshot().cut,stream:`workspace:${workspaceId}`},atomicGroup:`room-head:${roomId}:ada`,
    authority:{scopes:[{authorityScope:`reader:ada:workspace:${workspaceId}`,epoch:'1'},{authorityScope:`room:${roomId}`,epoch:'1'}],digest:hash([{authorityScope:`reader:ada:workspace:${workspaceId}`,epoch:'1'},{authorityScope:`room:${roomId}`,epoch:'1'}])},
  } as RouterSnapshot));
  let finish!:(value:unknown)=>void;
  const releases:Array<(value:unknown)=>void>=[];
  const executeTools=vi.fn(()=>new Promise<any>(resolve=>{finish=resolve;releases.push(resolve);}));
  routerOwnerNavigation({routes:[{key:'room',name:'beeline/chat/[channelId]',params:{channelId:roomId,communityId:workspaceId}}]});
  const head=acquireRouterLane(request,()=>true,()=>{});
  await routerOwnerNegotiated({generation:1,families:['room-head'],execute,executeTools});await settle();
  expect(head.current().state).toBe('LIVE');
  const burst=Array.from({length:32},(_,index)=>readRouterToolPage({roomId,anchor:index.toString(16).padStart(64,'0')}));
  expect(executeTools).toHaveBeenCalledTimes(16);
  releases.splice(0).forEach(resolve=>resolve({roomId,messages:[]}));await settle();
  expect(executeTools).toHaveBeenCalledTimes(32);
  releases.splice(0).forEach(resolve=>resolve({roomId,messages:[]}));await Promise.all(burst);executeTools.mockClear();
  const input={roomId,anchor:'a'.repeat(64)};
  const first=readRouterToolPage(input),second=readRouterToolPage(input);
  const results=Promise.allSettled([first,second]);expect(executeTools).toHaveBeenCalledTimes(1);
  routerOwnerNavigation({ routes: [{ key: 'channels', name: 'beeline/channels' }] });
  finish({roomId,messages:[]});expect((await results).every(result=>result.status==='rejected')).toBe(true);
  await expect(readRouterToolPage(input)).rejects.toThrow('unavailable');expect(executeTools).toHaveBeenCalledTimes(1);head.release();
});
