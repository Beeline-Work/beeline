import { usageCellSnapshot } from './agent-usage-cell';
import { mediaMetadataFor, mediaCertificateCurrent } from './media-cache-connection';
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
vi.mock('./router-family', () => ({holdRouterConnection: () => () => {}, useRouterFamily: () => 'router'}));
import { acquireChatList } from './chat-list-store';
import { resetClientState } from '@/sync/client-reset';
import { acquireRouterLane, acquireRouterSavedContinuation, acquireRouterRosterQuery, acquireRouterRoomRoster, routerOwnerNegotiated, routerOwnerNavigation, routerOwnerDisconnected,
  readRouterToolPage, admitRouterTrayCommand, admitRouterTrayPaint, routerOwnerListPanel, routerOwnerCapabilities, routerFamilyMode, routerOwnerReceive, retryRouterLane, routerOwnerArtifactViewport, routerOwnerUsageProfile } from './router-owner';
const request = { family: 'needs-you-count' as const, workspaceId: 'w' };
const hash = (value: unknown) => bytesToHex(sha256(utf8ToBytes(JSON.stringify(value))));
const scopes = [{ authorityScope: 'reader:ada:workspace:w', epoch: '1' }];
const authority = { digest: hash(scopes), scopes };
const snapshot = (value = 1): RouterSnapshot<'needs-you-count'> => ({ kind: 'snapshot', family: 'needs-you-count', scope: 'w',
  value: { count: value }, cut: { stream: 'workspace:w', epoch: 'stream', protocol: 1, through: value },
  authority, atomicGroup: 'needs:w:ada' });
const navigation = (key = 'channels') => ({ routes: [{ key, name: 'beeline/channels' }] });
const settle = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
beforeEach(() => { fixture.authorityReady = true;fixture.commandsReady=true; fixture.state = 'active'; resetClientState(); vi.clearAllMocks(); });

describe('real mobile router owner', () => {
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
    routerOwnerNavigation({routes:[{key:'members',name:'beeline/members',params:{communityId:ws}}]});
    const root=acquireRouterLane(head,()=>true,()=>{});
    await routerOwnerNegotiated({generation:1,families:['workspace-roster'],authorityFencesV1:true,execute});await settle();
    const observer=acquireRouterLane(input,()=>true,()=>{});await settle();expect(execute).toHaveBeenCalledTimes(1);
    expect(()=>acquireRouterRosterQuery({...input,query:{revision:'2',q:'forged'}},()=>true,()=>{})).toThrow('no longer held');
    const page=acquireRouterRosterQuery(input,()=>true,()=>{});await settle();expect(execute).toHaveBeenCalledTimes(2);
    expect(page.current()).toMatchObject({state:'LIVE',value});
    const nextScopes=[{authorityScope:`roster:${ws}`,epoch:'2'}];
    routerOwnerReceive({kind:'authority-fence',scope:ws,authorityScope:`roster:${ws}`,mode:'advance',authority:{scopes:nextScopes,digest:hash(nextScopes)}});
    await settle();expect(page.current()).toMatchObject({state:'PARKED',value:null});expect(execute).toHaveBeenCalledTimes(2);
    page.release();observer.release();root.release();
  });

  it('F25 a Room roster opens only on its picker gesture, rejects another Workspace and closed pickers stay absent from recovery',async()=>{
    const ws='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
    const person={pubkey:'a'.repeat(64),kind:'human' as const,name:'Reader'};
    const roster={revision:'1',workspace:{id:ws,name:'Roster',visibility:'invite-only',role:'owner',updatedAt:1,createdAt:1},
      members:[{identity:person,role:'owner'}],agents:[],viewer:{identity:person,role:'owner',permissions:{send:true,manage:true}},
      watchFilters:[],membersTruncated:false,agentsTruncated:false};
    const execute=vi.fn(async(input:RouterSnapshotInput):Promise<RouterSnapshot>=>{
      const room=input.family==='room-head',certScopes=[{authorityScope:`reader:ada:workspace:${ws}`,epoch:'1'},
        {authorityScope:room?`room:${id}`:`roster:${ws}`,epoch:'1'}];
      return {...snapshot(),family:input.family,scope:room?id:ws,value:room?{room:{id,workspaceId:ws},messages:[]}:roster,
        cut:{...snapshot().cut,stream:`workspace:${ws}`},atomicGroup:room?`room-head:${id}:ada`:`workspace-roster:${ws}:ada`,
        authority:{scopes:certScopes,digest:hash(certScopes)}} as RouterSnapshot;
    });
    routerOwnerNavigation({routes:[{key:'room',name:'beeline/chat/[channelId]',params:{channelId:id,communityId:ws}}]});
    const room=acquireRouterLane({family:'room-head',roomId:id,workspaceId:ws},()=>true,()=>{});
    await routerOwnerNegotiated({generation:1,families:['room-head','workspace-roster'],authorityFencesV1:true,execute});await settle();
    expect(execute.mock.calls.map(([input])=>input.family)).toEqual(['room-head']);
    expect(()=>acquireRouterRoomRoster('33333333-3333-4333-8333-333333333333',()=>true,()=>{})).toThrow('not held');
    const picker=acquireRouterRoomRoster(ws,()=>true,()=>{});await settle();
    expect(picker.current().state).toBe('LIVE');expect(execute).toHaveBeenCalledTimes(2);
    const second=acquireRouterRoomRoster(ws,()=>true,()=>{});await settle();
    expect(second.current().state).toBe('LIVE');expect(execute).toHaveBeenCalledTimes(2);
    picker.release();expect(second.current().state).toBe('LIVE');second.release();
    await routerOwnerNegotiated({generation:2,families:['room-head','workspace-roster'],authorityFencesV1:true,execute});await settle();
    expect(execute.mock.calls.map(([input])=>input.family)).toEqual(['room-head','workspace-roster','room-head']);room.release();
  });

  it('two actual list consumers share the router and cannot fall back on an incapable replacement',async()=>{
    const workspace='11111111-1111-4111-8111-111111111111';
    const key={workspaceId:workspace,relayUrl:'https://example.test',viewerPubkey:'ada'};
    const value={workspace:{id:workspace,name:'Synthetic',role:'member' as const,updatedAt:1},chats:[],
      viewer:{pubkey:'a'.repeat(64),kind:'human' as const,name:'Reader'},truncated:false,watchFilters:[]};
    const certScopes=[{authorityScope:`reader:ada:workspace:${workspace}`,epoch:'1'},
      {authorityScope:`reader:ada:workspace:${workspace}:visibility`,epoch:'1'}];
    const execute=vi.fn(async()=>({kind:'snapshot' as const,family:'room-list' as const,scope:workspace,value,
      cut:{...snapshot().cut,stream:`workspace:${workspace}`},authority:{scopes:certScopes,digest:hash(certScopes)},
      atomicGroup:`room-list:${workspace}:ada`}));
    const first=acquireChatList(key,{visible:()=>true}),second=acquireChatList(key,{visible:()=>true});
    try{
      await settle();expect(execute).not.toHaveBeenCalled();expect(first.current()).toBeNull();
      routerOwnerNavigation({routes:[{key:'rooms',name:'beeline/channels',params:{communityId:workspace}}]});
      await routerOwnerNegotiated({generation:1,families:['room-list'],authorityFencesV1:true,execute});await settle();
      expect(execute).toHaveBeenCalledTimes(1);expect(first.current()).toEqual(value);expect(second.current()).toEqual(value);
      first.force();second.catchUp();await settle();expect(execute).toHaveBeenCalledTimes(1);
      routerOwnerDisconnected();await settle();expect(first.current()).toBeNull();
      await routerOwnerNegotiated({generation:2,families:[],execute});await settle();
      expect(first.current()).toBeNull();expect(second.current()).toBeNull();expect(execute).toHaveBeenCalledTimes(1);
    }finally{first.release();second.release();}
  });
  it('refuses an additive family until its local assembly is implemented without minting a read',async()=>{
    const execute=vi.fn(async()=>snapshot());
    expect(routerOwnerCapabilities().families).toContain('needs-you-saved-page');
    await expect(routerOwnerNegotiated({generation:1,families:['unimplemented' as never],execute})).rejects.toThrow('Unsupported router family');
    expect(execute).not.toHaveBeenCalled();
    expect(fixture.storage.write).not.toHaveBeenCalled();
  });
  it.each(['live','opening'] as const)('re-reads %s Tray on shared clock loss while keeping the visible Room list',async phase=>{
    const workspace='11111111-1111-4111-8111-111111111111';
    const tray={family:'needs-you-tray',workspaceId:workspace} as const,list={family:'room-list',workspaceId:workspace} as const;
    const certScopes=[{authorityScope:`reader:ada:workspace:${workspace}`,epoch:'1'},
      {authorityScope:`reader:ada:workspace:${workspace}:visibility`,epoch:'1'}];
    const base={kind:'snapshot' as const,scope:workspace,cut:{...snapshot().cut,stream:`workspace:${workspace}`},
      authority:{scopes:certScopes,digest:hash(certScopes)}};
    const listValue={workspace:{id:workspace,name:'Synthetic',role:'member' as const,updatedAt:1},chats:[],
      viewer:{pubkey:'a'.repeat(64),kind:'human' as const,name:'Reader'},truncated:false,watchFilters:[]};
    let open!:()=>void;const pending=new Promise<void>(resolve=>{open=resolve;});if(phase==='live')open();
    const execute=vi.fn(async(input:RouterSnapshotInput):Promise<RouterSnapshot>=>{if(input.family==='needs-you-tray')await pending;return input.family==='needs-you-tray'
      ?{...base,family:'needs-you-tray',atomicGroup:`needs-you:${workspace}:ada`,clockVersion:`tray-clock-v1:${'a'.repeat(32)}:0`,
        value:{needs:{items:[]},saved:{windowId:`saved1:${'b'.repeat(64)}`,rows:[]}}}
      :{...base,family:'room-list',atomicGroup:`room-list:${workspace}:ada`,value:listValue};});
    routerOwnerNavigation({routes:[{key:'tray',name:'beeline/tray',params:{communityId:workspace}}]});routerOwnerListPanel(true);
    const head=acquireRouterLane(tray,()=>true,()=>{}),rooms=acquireRouterLane(list,()=>true,()=>{});
    await routerOwnerNegotiated({generation:1,families:['room-list','needs-you-tray','needs-you-count','needs-you-saved-page'],authorityFencesV1:true,execute});await settle();
    expect(head.current().state).toBe(phase==='live'?'LIVE':'OPENING');expect(rooms.current().state).toBe('LIVE');const count=execute.mock.calls.length;
    routerOwnerReceive({kind:'router-unavailable',stream:'control:tray-clock',families:['needs-you-tray','needs-you-count','needs-you-saved-page'],reason:'dependency'});
    expect(head.current().state).toBe('OPENING');expect(rooms.current()).toMatchObject({state:'LIVE',value:listValue});
    open();await settle();expect(head.current().state).toBe('LIVE');expect(execute.mock.calls).toHaveLength(count+1);
    head.release();rooms.release();routerOwnerListPanel(false);
  });
  it('opens a Saved continuation only from its held cursor and never from an attached page observer',async()=>{
    const before='saved1.Y3Vyc29y',tray={family:'needs-you-tray',workspaceId:'w'} as const;
    const page={family:'needs-you-saved-page',workspaceId:'w',before} as const;
    const scopeList=[...scopes,{authorityScope:'reader:ada:workspace:w:visibility',epoch:'1'}];
    const base={kind:'snapshot' as const,scope:'w',cut:snapshot().cut,atomicGroup:'needs-you:w:ada',
      authority:{scopes:scopeList,digest:hash(scopeList)},clockVersion:`tray-clock-v1:${'a'.repeat(32)}:0`};
    const execute=vi.fn(async(input:RouterSnapshotInput):Promise<RouterSnapshot>=>input.family==='needs-you-tray'
      ?{...base,family:'needs-you-tray',value:{needs:{items:[]},saved:{windowId:`saved1:${'b'.repeat(64)}`,rows:[],next:before}}}
      :{...base,family:'needs-you-saved-page',value:{windowId:`saved1:${'c'.repeat(64)}`,before,rows:[]}});
    routerOwnerNavigation({routes:[{key:'tray',name:'beeline/tray',params:{communityId:'w'}}]});
    const head=acquireRouterLane(tray,()=>true,()=>{}),observer=acquireRouterLane(page,()=>true,()=>{});
    await routerOwnerNegotiated({generation:1,families:['needs-you-tray','needs-you-saved-page'],authorityFencesV1:true,execute});await settle();
    expect(execute.mock.calls.map(call=>call[0].family)).toEqual(['needs-you-tray']);
    expect(()=>acquireRouterSavedContinuation('w','saved1.Zm9yZ2Vk',()=>true,()=>{})).toThrow('not held');
    const opened=acquireRouterSavedContinuation('w',before,()=>true,()=>{});await settle();
    expect(execute.mock.calls.map(call=>call[0].family)).toEqual(['needs-you-tray','needs-you-saved-page']);
    expect(opened.current().state).toBe('LIVE');expect(observer.current().cut).toEqual(head.current().cut);
    routerOwnerNavigation(navigation());await settle();
    expect(()=>acquireRouterSavedContinuation('w',before,()=>true,()=>{})).toThrow('not focused');
    opened.release();observer.release();head.release();
  });
  it('applies classified group controls only after a complete commit, keeps the allowed Room, and restores a fresh aggregate without reading', async () => {
    const room={family:'room-head' as const,roomId:'11111111-1111-4111-8111-111111111111',workspaceId:'w'};
    const visibility='reader:ada:workspace:w:visibility';
    const cert=(scopes: {authorityScope:string;epoch:string}[])=>({scopes,digest:hash(scopes)});
    const countAuthority=cert([...scopes,{authorityScope:visibility,epoch:'1'}]);
    const roomAuthority=cert([...scopes,{authorityScope:`room:${room.roomId}`,epoch:'1'}]);
    const roomValue={room:{id:room.roomId},messages:[]};
    const roomSnapshot={...snapshot(),family:'room-head',scope:room.roomId,value:roomValue,
      authority:roomAuthority,atomicGroup:`room-head:${room.roomId}:ada`} as unknown as RouterSnapshot<'room-head'>;
    const execute=vi.fn(async(input:RouterSnapshotInput)=>input.family==='room-head'?roomSnapshot:
      {...snapshot(),authority:countAuthority,atomicGroup:'needs-you:w:ada'});
    routerOwnerNavigation({routes:[{key:'room',name:'beeline/chat/[channelId]',params:{channelId:room.roomId,communityId:'w'}}]});
    const head=acquireRouterLane(room,()=>true,()=>{}),badge=acquireRouterLane(request,()=>true,()=>{});
    await routerOwnerNegotiated({generation:1,families:['room-head','needs-you-count'],execute});await settle();
    expect(head.current().state).toBe('LIVE');expect(badge.current().value).toEqual({count:1});
    const current=cert([...scopes,{authorityScope:visibility,epoch:'2'}]);
    const facts=[{atomicGroup:roomSnapshot.atomicGroup,authority:roomAuthority,
      payload:{kind:'scope-replace',family:'room-head',scope:room.roomId,value:roomValue}},
      {atomicGroup:'needs-you:w:ada',authority:current,payload:{kind:'authority-fence',scope:'w',authorityScope:visibility,mode:'advance'}}];
    const frame={batchId:'classified',from:snapshot().cut,to:snapshot(2).cut,partCount:1,contentDigest:hash(facts)};
    routerOwnerReceive({...frame,kind:'push-part',partIndex:0,facts});await settle();
    expect(badge.current().value).toEqual({count:1});
    routerOwnerReceive({...frame,kind:'push-commit'});await settle();
    expect(head.current()).toMatchObject({state:'LIVE',value:roomValue,cut:{through:2}});
    expect(badge.current()).toMatchObject({value:null,cut:{through:1}});
    expect(fixture.storage.floor).toHaveBeenCalledWith(visibility,'2');
    const replacement=[{atomicGroup:'needs-you:w:ada',authority:current,payload:{kind:'scope-replace',family:'needs-you-count',scope:'w',value:{count:0}}}];
    const next={batchId:'fresh',from:snapshot(2).cut,to:snapshot(3).cut,partCount:1,contentDigest:hash(replacement)};
    routerOwnerReceive({...next,kind:'push-commit'});routerOwnerReceive({...next,kind:'push-part',partIndex:0,facts:replacement});await settle();
    expect(badge.current()).toMatchObject({state:'LIVE',value:{count:0},cut:{through:3}});
    const unknown=[{atomicGroup:'needs-you:w:ada',authority:current,payload:{kind:'group-unavailable',scope:'w',reason:'authority'}}];
    const unavailable={batchId:'unknown',from:snapshot(3).cut,to:snapshot(4).cut,partCount:1,contentDigest:hash(unknown)};
    routerOwnerReceive({...unavailable,kind:'push-part',partIndex:0,facts:unknown});routerOwnerReceive({...unavailable,kind:'push-commit'});await settle();
    expect(badge.current()).toMatchObject({state:'PARKED',value:null,cut:null});expect(head.current().state).toBe('LIVE');
    expect(fixture.storage.remove).toHaveBeenCalledWith(JSON.stringify(['https://example.test','ada','needs-you:w:ada']));
    expect(execute).toHaveBeenCalledTimes(2);head.release();badge.release();
  });
  it('requests no projected families without durable authority storage', () => {
    fixture.authorityReady = false;
    expect(routerOwnerCapabilities()).toEqual({ families: [], authorityFencesV1: false, scheduledWorkCoverageV1:false });
    fixture.authorityReady = true;
    expect(routerOwnerCapabilities()).toEqual({ families: ['room-list', 'needs-you-count', 'room-head','room-workflows','workspace-roster','agent-profile','owner-workbench','owner-wallet','room-scheduled-work','needs-you-tray','needs-you-saved-page'], authorityFencesV1: true,scheduledWorkCoverageV1:true });
    fixture.commandsReady=false;
    expect(routerOwnerCapabilities()).toEqual({families:['room-list','needs-you-count','room-head','room-workflows','workspace-roster','agent-profile','owner-workbench','owner-wallet'],authorityFencesV1:true,scheduledWorkCoverageV1:false});
  });
  it('mount alone creates no pass; committed navigation admits one count-only read', async () => {
    const execute = vi.fn(async (_input: RouterSnapshotInput) => snapshot());
    const lane = acquireRouterLane(request, () => true, () => {});
    await routerOwnerNegotiated({ generation: 1, families: ['needs-you-count'], execute }); await settle();
    expect(execute).not.toHaveBeenCalled();
    routerOwnerNavigation(navigation()); await settle();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(request);
    expect(lane.current().value).toEqual({ count: 1 });
    lane.release();
  });
  it('StrictMode observer cleanup and setup joins the same navigation pass and flight', async () => {
    const execute = vi.fn(async () => snapshot());
    routerOwnerNavigation(navigation());
    await routerOwnerNegotiated({ generation: 1, families: ['needs-you-count'], execute });
    const old = acquireRouterLane(request, () => true, () => {}); old.release();
    const next = acquireRouterLane(request, () => true, () => {}); await settle();
    routerOwnerNavigation(navigation()); await settle();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(next.current().value).toEqual({ count: 1 });
    next.release();
  });
  it('duplicate observers share one lane and one release leaves the other live', async () => {
    const execute = vi.fn(async () => snapshot());
    routerOwnerNavigation(navigation());
    const first = acquireRouterLane(request, () => true, () => {});
    const second = acquireRouterLane(request, () => true, () => {});
    await routerOwnerNegotiated({ generation: 1, families: ['needs-you-count'], execute }); await settle();
    first.release();
    expect(second.current().state).toBe('LIVE'); expect(execute).toHaveBeenCalledTimes(1);
    second.release();
  });
  it('new negotiated connection recovers one demanded key and legacy remains a separate path', async () => {
    const execute = vi.fn(async () => snapshot());
    routerOwnerNavigation(navigation());
    const lane = acquireRouterLane(request, () => true, () => {});
    await routerOwnerNegotiated({ generation: 1, families: ['needs-you-count'], execute }); await settle();
    routerOwnerDisconnected(); expect(lane.current().value).toBeNull();
    await routerOwnerNegotiated({ generation: 2, families: ['needs-you-count'], execute }); await settle();
    expect(execute).toHaveBeenCalledTimes(2);
    routerOwnerDisconnected(); await routerOwnerNegotiated({ generation: 3, families: [], execute }); await settle();
    expect(routerFamilyMode('needs-you-count')).toBe('pending'); expect(execute).toHaveBeenCalledTimes(2);
    lane.release();
  });
  it('background revokes reads while healthy foreground only resumes observation', async () => {
    const execute = vi.fn(async () => snapshot());
    routerOwnerNavigation(navigation());
    const lane = acquireRouterLane(request, () => true, () => {});
    await routerOwnerNegotiated({ generation: 1, families: ['needs-you-count'], execute }); await settle();
    fixture.state = 'background'; fixture.events.forEach(listener => listener('background'));
    fixture.state = 'active'; fixture.events.forEach(listener => listener('active')); await settle();
    expect(execute).toHaveBeenCalledTimes(1);
    lane.release();
  });
  it('a failed read waits for a synchronous explicit Retry and never repeats itself', async () => {
    const execute = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(snapshot());
    routerOwnerNavigation(navigation());
    const lane = acquireRouterLane(request, () => true, () => {});
    await routerOwnerNegotiated({ generation: 1, families: ['needs-you-count'], execute }); await settle();
    expect(lane.current().state).toBe('PARKED'); expect(execute).toHaveBeenCalledTimes(1);
    retryRouterLane(request); await settle();
    expect(execute).toHaveBeenCalledTimes(2); expect(lane.current().state).toBe('LIVE'); lane.release();
  });
  it('purges a server-shaped Workspace removal through the exact denied authority domain', async () => {
    const execute = vi.fn(async () => snapshot());
    routerOwnerNavigation({ routes: [{ key: 'room', name: 'beeline/chat/[channelId]', params: { channelId: 'room', communityId: 'w' } }] });
    const lane = acquireRouterLane(request, () => true, () => {});
    const objectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const mediaScopes = [{ authorityScope: `object:${objectId}`, epoch: '1' }, ...scopes];
    const executeMetadata = vi.fn(async () => ({ objectId, sha256: 'a'.repeat(64), size: 1,
      mimeType: 'image/png', expiresAt: Date.now() + 60_000, authority: { scopes: mediaScopes, digest: hash(mediaScopes) } }));
    await routerOwnerNegotiated({ generation: 1, families: ['needs-you-count'], execute,
      authorityFencesV1: true, mediaMetadataV1: true, executeMetadata }); await settle();
    routerOwnerArtifactViewport('room', [objectId]);
    const media = await mediaMetadataFor('https://example.test', 'ada', objectId);
    expect(mediaCertificateCurrent(media!)).toBe(true);
    const removedScopes = [{ authorityScope: 'reader:ada:workspace:w', epoch: '2' }];
    const facts = [{ atomicGroup: 'workspace-authority', authority: { digest: hash(removedScopes), scopes: removedScopes },
      payload: { kind: 'authority', scope: 'w', authorityScope: 'reader:ada:workspace:w', allowed: false } }];
    const frame = { batchId: 'revoke', from: snapshot().cut, to: snapshot(2).cut, partCount: 1, contentDigest: hash(facts) };
    routerOwnerReceive({ ...frame, kind: 'push-part', partIndex: 0, facts });
    expect(mediaCertificateCurrent(media!)).toBe(true);
    routerOwnerReceive({ ...frame, kind: 'push-commit' });
    await settle();
    expect(lane.current()).toMatchObject({ state: 'REVOKED', value: null });
    expect(fixture.storage.fence).toHaveBeenCalledWith('reader:ada:workspace:w', '2');
    expect(mediaCertificateCurrent(media!)).toBe(false);
    expect(executeMetadata).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    lane.release();
  });
  it('purges a metadata-only object without a read-family subscription or invented data cut', async () => {
    const execute = vi.fn(async () => snapshot());
    const objectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const mediaScopes = [{ authorityScope: `object:${objectId}`, epoch: '1' }];
    const executeMetadata = vi.fn(async () => ({ objectId, sha256: 'a'.repeat(64), size: 1,
      mimeType: 'image/png', expiresAt: Date.now() + 60_000, authority: { scopes: mediaScopes, digest: hash(mediaScopes) } }));
    routerOwnerNavigation({ routes: [{ key: 'room', name: 'beeline/chat/[channelId]', params: { channelId: 'room', communityId: 'w' } }] });
    await routerOwnerNegotiated({ generation: 1, families: [], execute, executeMetadata, mediaMetadataV1: true, authorityFencesV1: true });
    routerOwnerArtifactViewport('room', [objectId]);
    const media = await mediaMetadataFor('https://example.test', 'ada', objectId);
    expect(mediaCertificateCurrent(media!)).toBe(true);
    const removed = [{ authorityScope: `object:${objectId}`, epoch: '2' }];
    routerOwnerReceive({ kind: 'authority-fence', scope: objectId, authorityScope: removed[0]!.authorityScope,
      authority: { scopes: removed, digest: hash(removed) } });
    await settle();
    expect(mediaCertificateCurrent(media!)).toBe(false);
    expect(executeMetadata).toHaveBeenCalledTimes(1); expect(execute).not.toHaveBeenCalled();
  });
  it('advances object authority without denying metadata at the current epoch', async () => {
    const objectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const mediaScopes = [{ authorityScope: `object:${objectId}`, epoch: '2' }];
    const executeMetadata = vi.fn(async () => ({ objectId, sha256: 'a'.repeat(64), size: 1,
      mimeType: 'image/png', expiresAt: Date.now() + 60_000, authority: { scopes: mediaScopes, digest: hash(mediaScopes) } }));
    routerOwnerNavigation({ routes: [{ key: 'room', name: 'beeline/chat/[channelId]', params: { channelId: 'room', communityId: 'w' } }] });
    await routerOwnerNegotiated({ generation: 1, families: [], execute: async () => snapshot(), executeMetadata, mediaMetadataV1: true, authorityFencesV1: true });
    routerOwnerArtifactViewport('room', [objectId]);
    const media = await mediaMetadataFor('https://example.test', 'ada', objectId);
    routerOwnerReceive({ kind: 'authority-fence', mode: 'advance', scope: objectId,
      authorityScope: mediaScopes[0]!.authorityScope, authority: { scopes: mediaScopes, digest: hash(mediaScopes) } });
    await settle();
    expect(mediaCertificateCurrent(media!)).toBe(true);
    const next = [{ authorityScope: mediaScopes[0]!.authorityScope, epoch: '3' }];
    routerOwnerReceive({ kind: 'authority-fence', mode: 'advance', scope: objectId,
      authorityScope: next[0]!.authorityScope, authority: { scopes: next, digest: hash(next) } });
    await settle();
    expect(mediaCertificateCurrent(media!)).toBe(false);
    expect(executeMetadata).toHaveBeenCalledTimes(1);
  });
  it('adopts content-free authority independently of data cuts and fails closed on authority feed loss', async () => {
    const execute = vi.fn(async () => snapshot());
    routerOwnerNavigation(navigation());
    const lane = acquireRouterLane(request, () => true, () => {});
    await routerOwnerNegotiated({ generation: 1, families: ['needs-you-count'], authorityFencesV1: true, execute }); await settle();
    const before = lane.current().cut;
    const removed = [{ authorityScope: 'reader:ada:workspace:w', epoch: '2' }];
    routerOwnerReceive({ kind: 'authority-fence', scope: 'w', authorityScope: removed[0]!.authorityScope,
      authority: { scopes: removed, digest: hash(removed) } });
    await settle();
    expect(before?.through).toBe(1);
    expect(lane.current()).toMatchObject({ state: 'REVOKED', cut: null, value: null });
    expect(fixture.storage.fence).toHaveBeenCalledWith(removed[0]!.authorityScope, '2');
    expect(execute).toHaveBeenCalledTimes(1);
    routerOwnerReceive({ kind: 'router-unavailable', stream: 'authority:ada', families: [], reason: 'listener' });
    retryRouterLane(request); await settle();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(lane.current().value).toBeNull();
    lane.release();
  });
  it('malformed wire never throws and re-reads only its affected stream', async () => {
    const execute = vi.fn(async () => snapshot());
    routerOwnerNavigation(navigation());
    const lane = acquireRouterLane(request, () => true, () => {});
    await routerOwnerNegotiated({ generation: 1, families: ['needs-you-count'], execute }); await settle();
    for (const value of [null, {}, { kind: 'push-part' }, { kind: 'push-part', to: snapshot().cut, facts: null },
      { kind: 'router-unavailable', stream: 'workspace:w', families: null }]) expect(() => routerOwnerReceive(value)).not.toThrow();
    await settle(); expect(execute).toHaveBeenCalledTimes(2); lane.release();
  });
});

it('retains committed profile selection before initialization and owns one cell read per connection', async () => {
  const cell = { v: 1 as const, agentId: 'agent', ownerId: 'ada', generation: 'a'.repeat(32), revision: 1, allowed: true as const, usage: null };
  const executeUsageCell = vi.fn(async () => cell);
  routerOwnerUsageProfile('agent');
  routerOwnerNavigation({ routes: [{ key: 'profile', name: 'beeline/agent-profile', params: { agentId: 'agent' } }] });
  await routerOwnerNegotiated({ generation: 1, families: [], usageCellV1: true, executeUsageCell, execute: async () => snapshot() });
  await settle();
  expect(executeUsageCell).toHaveBeenCalledTimes(1);
  expect(usageCellSnapshot('agent').cell).toEqual(cell);
  routerOwnerUsageProfile('agent'); await settle(); expect(executeUsageCell).toHaveBeenCalledTimes(1);
  routerOwnerReceive({ kind: 'usage-cell', cell: { ...cell, revision: 2, allowed: false, usage: undefined } });
  expect(usageCellSnapshot('agent').cell?.allowed).toBe(false);
  routerOwnerDisconnected(); expect(usageCellSnapshot('agent').cell).toBeNull();
  await routerOwnerNegotiated({ generation: 2, families: [], usageCellV1: true, executeUsageCell, execute: async () => snapshot() });
  await settle(); expect(executeUsageCell).toHaveBeenCalledTimes(2);
});

it('a healthy Room foreground resumes observation without a new pass and exposes explicit Retry for its unverified head',async()=>{
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
  expect(execute).toHaveBeenCalledTimes(1);
  expect(lane.current()).toMatchObject({state:'PARKED',value:null,error:expect.stringContaining('Retry')});
  retryRouterLane(room);await settle();expect(execute).toHaveBeenCalledTimes(2);expect(lane.current().state).toBe('LIVE');
  lane.release();
});


it('negotiated Room continuity resumes the same owner after an inactive authoritative delta without a read', async () => {
  const room = { family: 'room-head' as const, roomId: '11111111-1111-4111-8111-111111111111', workspaceId: 'w' };
  const roomScopes = [...scopes, { authorityScope: `room:${room.roomId}`, epoch: '1' }];
  const certificate = { scopes: roomScopes, digest: hash(roomScopes) };
  const value = { room: { id: room.roomId }, messages: [] };
  const initial = { ...snapshot(), family: 'room-head', scope: room.roomId, value,
    authority: certificate, atomicGroup: `room-head:${room.roomId}:ada` } as unknown as RouterSnapshot<'room-head'>;
  const execute = vi.fn(async () => initial);
  routerOwnerNavigation({ routes: [{ key: 'room', name: 'beeline/chat/[channelId]', params: { channelId: room.roomId, communityId: 'w' } }] });
  const lane = acquireRouterLane(room, () => true, () => {});
  await routerOwnerNegotiated({ generation: 1, families: ['room-head'], authorityFencesV1: true, roomHeadContinuityV1: true, execute });
  await settle(); expect(lane.current().state).toBe('LIVE');
  fixture.state = 'background'; fixture.events.forEach(listener => listener('background'));
  const nextValue = { ...value, messages: [{ id: 'committed' }] };
  const facts = [{ atomicGroup: initial.atomicGroup, authority: certificate,
    payload: { kind: 'scope-replace', family: 'room-head', scope: room.roomId, value: nextValue } }];
  const frame = { batchId: 'inactive-room', from: snapshot().cut, to: snapshot(2).cut, partCount: 1, contentDigest: hash(facts) };
  routerOwnerReceive({ ...frame, kind: 'push-part', partIndex: 0, facts });
  routerOwnerReceive({ ...frame, kind: 'push-commit' }); await settle();
  fixture.state = 'active'; fixture.events.forEach(listener => listener('active')); await settle();
  expect(lane.current()).toMatchObject({ state: 'LIVE', value: nextValue, cut: { through: 2 } });
  expect(execute).toHaveBeenCalledTimes(1); lane.release();
});


describe('actual Tray gesture and painted ownership',()=>{
  it('correlates commands/paint with the held canonical Workspace and never reads after commands or hidden paint',async()=>{
    const tray={family:'needs-you-tray' as const,workspaceId:'w'};
    const value={needs:{items:[{messageId:'q',workspaceId:'w',roomId:'r',roomName:'Room',roomKind:'room' as const,text:'Please review?',createdAt:1}]},
      saved:{windowId:`saved1:${'a'.repeat(64)}`,rows:[]}};
    const certScopes=[...scopes,{authorityScope:'reader:ada:workspace:w:visibility',epoch:'1'}];
    const response={...snapshot(),family:'needs-you-tray' as const,value,authority:{scopes:certScopes,digest:hash(certScopes)},atomicGroup:'needs-you:w:ada'};
    const execute=vi.fn(async()=>response);
    routerOwnerNavigation({routes:[{key:'tray',name:'beeline/tray',params:{communityId:'w'}}]});
    const lane=acquireRouterLane(tray,()=>true,()=>{});
    await routerOwnerNegotiated({generation:1,families:['needs-you-tray'],authorityFencesV1:true,execute});await settle();
    expect(lane.current().value).toEqual(value);
    expect(admitRouterTrayPaint('w',['foreign','q']).map(item=>JSON.parse(item.wire.input))).toEqual([{workspaceId:'w',messageIds:['q']}]);
    expect(admitRouterTrayPaint('w',['q'])).toEqual([]);
    expect(()=>admitRouterTrayCommand('other',{operation:'clearNeedsYou',input:{workspaceId:'other',messageId:'q'}})).toThrow();
    expect(()=>admitRouterTrayCommand('w',{operation:'clearNeedsYou',input:{workspaceId:'w',messageId:'foreign'}})).toThrow();
    const clear=admitRouterTrayCommand('w',{operation:'clearNeedsYou',input:{workspaceId:'w',messageId:'q'}});
    expect(clear.wire.operation).toBe('clearNeedsYou');
    expect(()=>admitRouterTrayCommand('w',{operation:'answerChoice',input:{choiceId:'c',optionId:'o'}})).toThrow('unavailable');
    routerOwnerNavigation(navigation());await settle();
    expect(()=>admitRouterTrayPaint('w',['q'])).toThrow('not focused');
    expect(execute).toHaveBeenCalledTimes(1);lane.release();
  });
});




it('authority-source loss re-reads current count and invalidates old media without losing the connection',async()=>{
  const execute=vi.fn(async()=>snapshot()),objectId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const mediaScopes=[{authorityScope:`object:${objectId}`,epoch:'1'},...scopes];
  const executeMetadata=vi.fn(async()=>({objectId,sha256:'a'.repeat(64),size:1,mimeType:'image/png',expiresAt:Date.now()+60_000,
    authority:{scopes:mediaScopes,digest:hash(mediaScopes)}}));
  const start={stream:'authority:ada' as const,epoch:'authority',segment:'initial',through:0,protocol:1 as const};
  routerOwnerNavigation({routes:[{key:'room',name:'beeline/chat/[channelId]',params:{channelId:'room',communityId:'w'}}]});
  const lane=acquireRouterLane(request,()=>true,()=>{});
  await routerOwnerNegotiated({generation:1,families:['needs-you-count','room-scheduled-work'],authorityFencesV1:true,
    scheduledWorkCoverageV1:{version:1,authorityStart:start},mediaMetadataV1:true,executeMetadata,execute});await settle();
  routerOwnerArtifactViewport('room',[objectId]);const media=await mediaMetadataFor('https://example.test','ada',objectId);
  expect(lane.current().value).toEqual({count:1});expect(mediaCertificateCurrent(media!)).toBe(true);
  routerOwnerReceive({kind:'router-unavailable',stream:'authority:ada',families:[],reason:'listener'});await settle();
  expect(lane.current().value).toEqual({count:1});expect(mediaCertificateCurrent(media!)).toBe(false);
  routerOwnerReceive({kind:'scheduled-work-authority-restart',start:{...start,segment:'recovered',through:4}});await settle();
  await settle();expect(lane.current().value).toEqual({count:1});expect(mediaCertificateCurrent(media!)).toBe(false);
  expect(execute).toHaveBeenCalledTimes(2);expect(executeMetadata).toHaveBeenCalledTimes(1);lane.release();
});

it('admits only the exact three DB decision actions offered in the held canonical Tray, with no follow-up read',async()=>{
  const agentId='c'.repeat(64),grantId='44444444-4444-4444-8444-444444444444',choiceId='55555555-5555-4555-8555-555555555555';
  const actions=[{kind:'grant' as const,label:'Allow once',grantId,decision:'once' as const},
    {kind:'write-access' as const,label:'Allow',permissionId:'permission',requestId:'request',agentId,repository:'repo',decision:'allow' as const},
    {kind:'skip-choice' as const,label:'Skip',choiceId}];
  const value={needs:{items:[{messageId:'q',workspaceId:'w',roomId:'r',roomName:'Room',roomKind:'room' as const,text:'Decision',createdAt:1,
    approval:{kind:'grant' as const,actor:'Helper',ask:'asks',subject:'Decision',literal:false,actions}}]},saved:{windowId:`saved1:${'a'.repeat(64)}`,rows:[]}};
  const response={...snapshot(),family:'needs-you-tray' as const,value,atomicGroup:'needs-you:w:ada'};
  const execute=vi.fn(async()=>response);
  routerOwnerNavigation({routes:[{key:'tray',name:'beeline/tray',params:{communityId:'w'}}]});
  const lane=acquireRouterLane({family:'needs-you-tray',workspaceId:'w'},()=>true,()=>{});
  await routerOwnerNegotiated({generation:1,families:['needs-you-tray'],authorityFencesV1:true,execute});await settle();
  expect(lane.current().state).toBe('LIVE');
  for(const command of [{operation:'decideAgentGrant' as const,input:{grantId,decision:'once' as const}},
    {operation:'decideWritePermission' as const,input:{roomId:'r',permissionId:'permission',requestId:'request',agentId,repository:'repo',decision:'allow' as const}},
    {operation:'skipChoice' as const,input:{choiceId}}]){
    const admitted=admitRouterTrayCommand('w',command);expect(admitted.wire.operation).toBe(command.operation);expect(JSON.parse(admitted.wire.input)).toEqual(command.input);
  }
  expect(()=>admitRouterTrayCommand('w',{operation:'decideAgentGrant',input:{grantId,decision:'always'}})).toThrow();
  expect(()=>admitRouterTrayCommand('w',{operation:'skipChoice',input:{choiceId:'other'}})).toThrow();
  expect(()=>admitRouterTrayCommand('w',{operation:'decideWritePermission',input:{roomId:'r',permissionId:'permission',requestId:'stale',agentId,repository:'repo',decision:'allow'}})).toThrow();
  expect(()=>admitRouterTrayCommand('w',{operation:'skipChoice',input:{choiceId,extra:true} as never})).toThrow();
  expect(()=>admitRouterTrayCommand('w',{operation:'answerChoice',input:{choiceId,optionId:'option'}})).toThrow('unavailable');
  expect(execute).toHaveBeenCalledTimes(1);lane.release();
});


it('F07: actual focused owner coalesces tool demand and refuses a completion after navigation',async()=>{
  const roomId='22222222-2222-4222-8222-222222222222',workspaceId='11111111-1111-4111-8111-111111111111';
  const request={family:'room-head' as const,roomId,workspaceId};
  const execute=vi.fn(async()=>({...snapshot(),family:'room-head',scope:roomId,value:{room:{id:roomId},messages:[]},
    cut:{...snapshot().cut,stream:`workspace:${workspaceId}`},atomicGroup:`room-head:${roomId}:ada`,
    authority:{scopes:[{authorityScope:`reader:ada:workspace:${workspaceId}`,epoch:'1'},{authorityScope:`room:${roomId}`,epoch:'1'}],digest:hash([{authorityScope:`reader:ada:workspace:${workspaceId}`,epoch:'1'},{authorityScope:`room:${roomId}`,epoch:'1'}])},
  } as RouterSnapshot));
  let finish!:(value:unknown)=>void;
  const executeTools=vi.fn(()=>new Promise<any>(resolve=>{finish=resolve;}));
  routerOwnerNavigation({routes:[{key:'room',name:'beeline/chat/[channelId]',params:{channelId:roomId,communityId:workspaceId}}]});
  const head=acquireRouterLane(request,()=>true,()=>{});
  await routerOwnerNegotiated({generation:1,families:['room-head'],execute,executeTools});await settle();
  expect(head.current().state).toBe('LIVE');
  const input={roomId,anchor:'a'.repeat(64)};
  const first=readRouterToolPage(input),second=readRouterToolPage(input);
  const results=Promise.allSettled([first,second]);expect(executeTools).toHaveBeenCalledTimes(1);
  routerOwnerNavigation(navigation());
  finish({roomId,messages:[]});expect((await results).every(result=>result.status==='rejected')).toBe(true);
  await expect(readRouterToolPage(input)).rejects.toThrow('unavailable');expect(executeTools).toHaveBeenCalledTimes(1);head.release();
});
