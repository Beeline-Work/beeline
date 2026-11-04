import React from 'react';
// @ts-expect-error React renderer declarations are absent in this workspace.
import {act,create} from 'react-test-renderer';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
type View={state:string;value:any;error:string|null;cut:null};
const fixture=vi.hoisted(()=>({
  mode:'pending' as 'pending'|'router'|'legacy',focused:true,
  entries:new Map<string,{view:View;listeners:Set<()=>void>}>(),
  active:new Set<object>(),acquire:vi.fn(),retry:vi.fn(),admit:vi.fn(),prepare:vi.fn(),deliver:vi.fn(),
  read:vi.fn(),write:vi.fn(),fetch:vi.fn(),register:vi.fn(),enabled:[] as boolean[],
}));
vi.mock('react-native',()=>({AppState:{currentState:'active'}}));
vi.mock('./use-surface-focus',()=>({useSurfaceFocus:()=>fixture.focused}));
vi.mock('./router-family',()=>({useRouterFamily:()=>fixture.mode}));
vi.mock('./router-owner',()=>({
  routerFamilyMode:()=>fixture.mode,
  acquireRouterLane:(request:any,visible:()=>boolean)=>fixture.acquire(request,visible),
  retryRouterLane:(request:any)=>fixture.retry(request),
  admitRouterScheduledStop:(...args:any[])=>fixture.admit(...args),
}));
vi.mock('./command-owner',()=>({activeCommandOwner:()=>({canPrepare:()=>true,prepare:(cap:unknown)=>fixture.prepare(cap),deliver:(id:string)=>fixture.deliver(id)})}));
vi.mock('@/auth/buzz-identity-storage',()=>({loadBuzzIdentity:async()=>({publicKey:'synthetic'}),getEffectiveRelayUrl:async()=>'https://synthetic.test'}));
vi.mock('@/sync/transport/monolith-operation',()=>({monolithPhoneOperation:(...args:any[])=>fixture.read(...args),MonolithPhoneOperationError:class extends Error{}}));
vi.mock('@/sync/transport/live-connection',()=>({sharedLiveConnection:()=>({register:(...args:any[])=>fixture.register(...args)})}));
vi.mock('./surface-storage',()=>({surfaceAddress:()=>({}),mobileSurfaceCache:{write:(...args:any[])=>fixture.write(...args),fetch:(...args:any[])=>fixture.fetch(...args),peek:()=>({roomName:'old disk',agentNames:[],schedules:[],subscriptions:[]})}}));
vi.mock('./use-shared-surface',()=>({useSharedSurface:(_endpoint:unknown,_params:unknown,_guard:unknown,_read:unknown,enabled:boolean)=>{
  fixture.enabled.push(enabled);return {value:{roomName:'old legacy cache',agentNames:[],schedules:[],subscriptions:[]},address:null,loading:false,error:null,setError:()=>{},refresh:fixture.read};
}}));
import {useScheduledWork,stopSchedule,stopSubscription} from './scheduled-work';
const ROOM_A='11111111-1111-4111-8111-111111111111',ROOM_B='22222222-2222-4222-8222-222222222222';
const SCHEDULE='33333333-3333-4333-8333-333333333333';
const value=(name:string)=>({roomName:name,isDirectMessage:false,agentNames:[],schedules:[],subscriptions:[]});
let tree:any,current:ReturnType<typeof useScheduledWork>,renders:{room:string;name:string|undefined}[];
function entry(room:string){let held=fixture.entries.get(room);if(!held){held={view:{state:'ABSENT',value:null,error:null,cut:null},listeners:new Set()};fixture.entries.set(room,held);}return held;}
function publish(room:string,view:Partial<View>){const held=entry(room);held.view={...held.view,...view};for(const wake of held.listeners)wake();}
function Reader({room=ROOM_A}:{room?:string}){current=useScheduledWork(room,false);renders.push({room,name:current.work?.roomName??undefined});return null;}
beforeEach(()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;fixture.mode='pending';fixture.focused=true;fixture.entries.clear();fixture.active.clear();fixture.enabled=[];renders=[];
  for(const mock of [fixture.acquire,fixture.retry,fixture.admit,fixture.prepare,fixture.deliver,fixture.read,fixture.write,fixture.fetch,fixture.register])mock.mockReset();
  fixture.acquire.mockImplementation((request:any,visible:()=>boolean)=>{
    const held=entry(request.roomId),token={visible};fixture.active.add(token);
    return {current:()=>held.view,subscribe:(wake:()=>void)=>{held.listeners.add(wake);return()=>held.listeners.delete(wake);},release:()=>{fixture.active.delete(token);}};
  });
  fixture.admit.mockReturnValue({capability:'closed-stop'});fixture.prepare.mockResolvedValue({id:'durable-stop'});fixture.deliver.mockResolvedValue({});
});
afterEach(async()=>{if(tree)await act(async()=>tree.unmount());tree=undefined;});
describe('actual Scheduled Work consumer with negotiated lane ownership',()=>{
  it('pending negotiation paints no retained legacy value and performs no read or observer registration',async()=>{
    await act(async()=>{tree=create(<Reader/>);});
    expect(current.work).toBeNull();expect(current.loading).toBe(true);expect(fixture.acquire).not.toHaveBeenCalled();
    expect(fixture.enabled.every(value=>!value)).toBe(true);expect(fixture.read).not.toHaveBeenCalled();expect(fixture.register).not.toHaveBeenCalled();
  });
  it('id-only router scope renders the complete server value; source delivery performs no legacy read or reducer write',async()=>{
    fixture.mode='router';entry(ROOM_A).view={state:'LIVE',value:value('First'),error:null,cut:null};
    await act(async()=>{tree=create(<Reader/>);});expect(current.work?.roomName).toBe('First');
    await act(async()=>publish(ROOM_A,{value:value('Committed replacement')}));expect(current.work?.roomName).toBe('Committed replacement');
    expect(fixture.acquire).toHaveBeenCalledTimes(1);expect(fixture.enabled.every(value=>!value)).toBe(true);
    expect(fixture.read).not.toHaveBeenCalled();expect(fixture.fetch).not.toHaveBeenCalled();expect(fixture.write).not.toHaveBeenCalled();expect(fixture.register).not.toHaveBeenCalled();
  });
  it('Room replacement and retained blur cannot paint the former target or keep its observer',async()=>{
    fixture.mode='router';entry(ROOM_A).view={state:'LIVE',value:value('A private'),error:null,cut:null};
    await act(async()=>{tree=create(<Reader/>);});renders=[];
    await act(async()=>tree.update(<Reader room={ROOM_B}/>));
    expect(renders.filter(row=>row.room===ROOM_B).every(row=>row.name!=='A private')).toBe(true);expect(current.work).toBeNull();expect(entry(ROOM_A).listeners.size).toBe(0);
    await act(async()=>publish(ROOM_A,{value:value('Late A')}));expect(current.work).toBeNull();
    await act(async()=>publish(ROOM_B,{state:'LIVE',value:value('B current')}));expect(current.work?.roomName).toBe('B current');
    fixture.focused=false;await act(async()=>tree.update(<Reader room={ROOM_B}/>));expect(current.work).toBeNull();expect(fixture.active.size).toBe(0);
    await act(async()=>publish(ROOM_B,{value:value('Hidden update')}));expect(current.work).toBeNull();expect(fixture.read).not.toHaveBeenCalled();
  });
  it('parked errors use the existing explicit Retry; render, source error and hidden retry mint no read',async()=>{
    fixture.mode='router';entry(ROOM_A).view={state:'PARKED',value:null,error:'Scheduled Work unavailable. Retry.',cut:null};
    await act(async()=>{tree=create(<Reader/>);});expect(current.error).toContain('Retry');expect(fixture.retry).not.toHaveBeenCalled();
    current.retry();expect(fixture.retry).toHaveBeenCalledTimes(1);fixture.focused=false;
    await act(async()=>tree.update(<Reader/>));current.retry();expect(fixture.retry).toHaveBeenCalledTimes(1);expect(fixture.read).not.toHaveBeenCalled();
  });
  it.each(['schedule','subscription'] as const)('%s stop reserves its closed durable intent before awaiting; completion and blur perform no read, cache edit or fabricated removal',async kind=>{
    fixture.mode='router';const original={...value('A'),schedules:[{id:SCHEDULE}]};entry(ROOM_A).view={state:'LIVE',value:original,error:null,cut:null};
    await act(async()=>{tree=create(<Reader/>);});let resolve!:(value:{id:string})=>void;
    fixture.prepare.mockImplementation(()=>new Promise(done=>{resolve=done;}));
    const stopped=kind==='schedule'?stopSchedule(ROOM_A,SCHEDULE):stopSubscription(ROOM_A,SCHEDULE);
    expect(fixture.admit).toHaveBeenCalledWith(kind==='schedule'?'deleteRoomSchedule':'deleteRoomSubscription',ROOM_A,SCHEDULE);expect(fixture.prepare).toHaveBeenCalledTimes(1);expect(fixture.deliver).not.toHaveBeenCalled();
    fixture.focused=false;await act(async()=>tree.update(<Reader/>));resolve({id:'durable-stop'});expect(await stopped).toBe('stopped');
    expect(fixture.deliver).toHaveBeenCalledWith('durable-stop');expect(entry(ROOM_A).view.value).toBe(original);
    expect(fixture.read).not.toHaveBeenCalled();expect(fixture.write).not.toHaveBeenCalled();expect(fixture.fetch).not.toHaveBeenCalled();
  });
  it('StrictMode effect replay leaves one current observer and never admits commands during render',async()=>{
    fixture.mode='router';await act(async()=>{tree=create(<React.StrictMode><Reader/></React.StrictMode>);});
    expect(fixture.active.size).toBe(1);expect(fixture.admit).not.toHaveBeenCalled();expect(fixture.prepare).not.toHaveBeenCalled();expect(fixture.read).not.toHaveBeenCalled();
    await act(async()=>tree.unmount());tree=undefined;expect(fixture.active.size).toBe(0);expect(entry(ROOM_A).listeners.size).toBe(0);
  });
});
