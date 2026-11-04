import React from 'react';
// @ts-expect-error Renderer declarations are absent in this workspace.
import {act,create} from 'react-test-renderer';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {isWorkspaceView,type WorkspaceView} from '@beeline/buzz-client';
const fixture=vi.hoisted(()=>({origin:'https://synthetic.invalid',storage:new Map<string,string>(),read:vi.fn(),error:vi.fn(),mode:'legacy' as 'legacy'|'router'|'pending',open:vi.fn(),acquire:vi.fn(),view:null as any,listeners:new Set<()=>void>()}));
vi.mock('react-native',()=>({AppState:{currentState:'active'}}));
vi.mock('./router-family',()=>({useRouterFamily:()=>fixture.mode}));
vi.mock('./router-owner',()=>({acquireRouterLane:(...args:any[])=>fixture.acquire(...args),acquireRouterRoomRoster:(...args:any[])=>fixture.open(...args),retryRouterLane:vi.fn()}));
vi.mock('@/auth/buzz-identity-storage',()=>({getEffectiveRelayUrl:async()=>fixture.origin}));
vi.mock('./surface-storage',async()=>{
  const {SurfaceRegistry}=await import('./surface-registry');
  const {SurfaceResponseCache}=await import('@beeline/buzz-client');
  return {mobileSurfaceCache:new SurfaceRegistry(new SurfaceResponseCache({get:async key=>fixture.storage.get(key)??null,
    set:async(key,value)=>{fixture.storage.set(key,value);},remove:async key=>{fixture.storage.delete(key);}})),
    surfaceAddress:(relayOrigin:string,viewerPubkey:string,endpoint:string,params:Record<string,string>)=>({relayOrigin,viewerPubkey,endpoint,params})};
});
import {useRoomRoster} from './use-room-roster';
import {mobileSurfaceCache,surfaceAddress} from './surface-storage';
import {resetClientState} from '@/sync/client-reset';
const workspace='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',viewer='a'.repeat(64);
function dto(id=workspace):WorkspaceView{
  const identity={pubkey:viewer,kind:'human' as const,name:'Reader',handle:'reader'};
  return {workspace:{id,name:'Roster',visibility:'invite-only',role:'owner',updatedAt:1,createdAt:1},members:[{identity,role:'owner'}],agents:[],
    viewer:{identity,role:'owner',permissions:{send:true,manage:true}},watchFilters:[],peopleTotal:1,agentTotal:0,membersTruncated:false,agentsTruncated:false};
}
let tree:any,openPicker:(()=>void)|undefined;const current:Array<WorkspaceView|null>=[],rendered:Array<string|null>=[];
function Picker({open=false,id=workspace,index=0,revision=0}:{open?:boolean;id?:string;index?:number;revision?:number}){
  const owner=useRoomRoster(id,viewer,open,fixture.read,fixture.error);openPicker=owner.open;current[index]=owner.value;rendered.push(current[index]?.workspace.id??null);return <span>{revision}</span>;
}
beforeEach(()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;resetClientState();mobileSurfaceCache.clear();fixture.storage.clear();
  fixture.origin='https://synthetic.invalid';fixture.mode='legacy';fixture.listeners.clear();fixture.view={state:'LIVE',value:{...dto(),revision:'1'},error:null,cut:null};current.length=0;rendered.length=0;vi.clearAllMocks();fixture.read.mockResolvedValue(dto());
  const handle=()=>({current:()=>fixture.view,release:vi.fn(),subscribe:(wake:()=>void)=>{fixture.listeners.add(wake);return()=>fixture.listeners.delete(wake);}});
  fixture.acquire.mockImplementation(handle);fixture.open.mockImplementation(handle);
});
afterEach(()=>{if(tree)act(()=>tree.unmount());tree=undefined;vi.unstubAllGlobals();});
describe('F25 actual Room picker owner with the real shared registry',()=>{
  it('negotiated picker mounts and closed renders admit nothing; only Open invokes its gesture owner and facts replace the visible DTO',async()=>{
    fixture.mode='router';await act(async()=>{tree=create(<Picker/>);});
    for(let n=0;n<1000;n++)await act(async()=>tree.update(<Picker revision={n}/>));
    expect(fixture.acquire).not.toHaveBeenCalled();expect(fixture.open).not.toHaveBeenCalled();expect(fixture.read).not.toHaveBeenCalled();
    await act(async()=>{openPicker!();tree.update(<Picker open/>);});
    expect(fixture.open).toHaveBeenCalledTimes(1);expect(fixture.open.mock.calls[0]?.[0]).toBe(workspace);
    expect(current[0]).toBe(fixture.view.value);expect(fixture.acquire).toHaveBeenCalledTimes(1);
    const next={...fixture.view.value,revision:'2',members:[]};
    await act(async()=>{fixture.view={...fixture.view,value:next};for(const wake of fixture.listeners)wake();});
    expect(current[0]).toBe(next);expect(fixture.read).not.toHaveBeenCalled();
    await act(async()=>tree.update(<Picker/>));expect(current[0]).toBeNull();
    fixture.mode='pending';await act(async()=>tree.update(<Picker open/>));expect(current[0]).toBeNull();expect(fixture.read).not.toHaveBeenCalled();
  });

  it('an unavailable held Room reports through the existing picker error state without a fallback read',async()=>{
    fixture.mode='router';fixture.open.mockImplementation(()=>{throw new Error('Roster Workspace is not held.');});
    await act(async()=>{tree=create(<Picker/>);});
    expect(()=>openPicker!()).not.toThrow();expect(fixture.error).toHaveBeenCalledTimes(1);
    expect(fixture.read).not.toHaveBeenCalled();expect(fixture.acquire).not.toHaveBeenCalled();
  });

  it('keeps a held roster visible for bylines but 1,000 closed-picker renders perform zero Workspace reads',async()=>{
    await mobileSurfaceCache.write(surfaceAddress(fixture.origin,viewer,'/workspace/:id',{workspaceId:workspace}),dto(),isWorkspaceView);
    await act(async()=>{tree=create(<Picker/>);});
    for(let n=1;n<=1000;n++)await act(async()=>tree.update(<Picker revision={n}/>));
    expect(current[0]?.workspace.id).toBe(workspace);expect(fixture.read).not.toHaveBeenCalled();
  });
  it('two concurrent visible pickers share one actual snapshot flight',async()=>{
    let finish!:(value:WorkspaceView)=>void;fixture.read.mockImplementation(()=>new Promise<WorkspaceView>(resolve=>{finish=resolve;}));
    await act(async()=>{tree=create(<><Picker open/><Picker open index={1}/></>);});
    await act(async()=>{await vi.waitFor(()=>expect(fixture.read).toHaveBeenCalledTimes(1));});
    await act(async()=>finish(dto()));
    expect(current.map(value=>value?.members[0]?.identity.pubkey)).toEqual([viewer,viewer]);
    expect(fixture.read).toHaveBeenCalledTimes(1);expect(fixture.error).not.toHaveBeenCalled();
  });
  it('a Workspace or connection-origin change hides the previous scope immediately and never borrows its cache key',async()=>{
    await mobileSurfaceCache.write(surfaceAddress(fixture.origin,viewer,'/workspace/:id',{workspaceId:workspace}),dto(),isWorkspaceView);
    await act(async()=>{tree=create(<Picker/>);});expect(current[0]?.workspace.id).toBe(workspace);
    const changedWorkspace=rendered.length;
    await act(async()=>tree.update(<Picker id={other}/>));expect(current[0]).toBeNull();expect(fixture.read).not.toHaveBeenCalled();
    expect(rendered.slice(changedWorkspace)).not.toContain(workspace);
    fixture.origin='https://other-synthetic.invalid';
    const changedOrigin=rendered.length;
    await act(async()=>{resetClientState();tree.update(<Picker id={workspace}/>);});
    expect(rendered.slice(changedOrigin).every(value=>value===null)).toBe(true);
    expect(current[0]).toBeNull();expect(fixture.read).not.toHaveBeenCalled();
  });
  it('yields optional roster reads to the mounted screen frame',async()=>{
    const frames:FrameRequestCallback[]=[];
    vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>frames.push(callback));
    await act(async()=>{tree=create(<Picker open/>);});
    expect(fixture.read).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    await act(async()=>{frames.shift()!(0);});
    expect(fixture.read).not.toHaveBeenCalled();
    await act(async()=>{frames.shift()!(16);await new Promise(resolve=>setTimeout(resolve,0));});
    expect(fixture.read).toHaveBeenCalledTimes(1);
    expect(current[0]?.workspace.id).toBe(workspace);
  });
  it('cancels optional roster work when the screen leaves before its frame',async()=>{
    const frames:FrameRequestCallback[]=[];
    vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>frames.push(callback));
    await act(async()=>{tree=create(<Picker open/>);});
    await act(async()=>{tree.unmount();tree=undefined;});
    await act(async()=>{frames.shift()!(0);frames.shift()!(16);await new Promise(resolve=>setTimeout(resolve,0));});
    expect(fixture.read).not.toHaveBeenCalled();
    expect(fixture.error).not.toHaveBeenCalled();
  });

});
