import React from 'react';
// @ts-expect-error React renderer declarations are absent in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('./command-owner',()=>({activeCommandOwner:()=>undefined}));
vi.mock('./router-owner',async()=> (await import('@/test/canonical-router-fixture')).canonicalRouterFixture(fixture.read));
vi.mock('./router-family',()=>({useRouterFamily:()=> 'router',holdRouterConnection:()=>()=>{}}));
const fixture=vi.hoisted(()=>({
  read:vi.fn(async()=>({roomName:'Room',agentNames:[],schedules:[],subscriptions:[]})),
  focus:new Map<string,()=>void>(),blur:new Map<string,()=>void>(),current:'',
}));
vi.mock('expo-router',()=>({useFocusEffect:(effect:()=>()=>void)=>{
  const id=fixture.current;
  React.useEffect(()=>{fixture.focus.set(id,effect);const blur=effect();fixture.blur.set(id,blur);return blur;},[effect]);
}}));
vi.mock('react-native',()=>({AppState:{currentState:'active'}}));
import {useScheduledWork} from './scheduled-work';
let tree:any;
const owner=async()=>await import('./router-owner') as any;
beforeEach(async()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;(await owner()).resetFixture();fixture.read.mockClear();fixture.focus.clear();fixture.blur.clear();});
afterEach(async()=>{if(tree)await act(async()=>tree.unmount());tree=undefined;});
function Reader({id}:{id:string}){fixture.current=id;useScheduledWork(id);return null;}
it('unmounted schedules release observers and make no reads on later canonical changes',async()=>{
  await act(async()=>{tree=create(<Reader id="room-a"/>);});
  expect(fixture.read).toHaveBeenCalledTimes(1);expect((await owner()).observerCount()).toBeGreaterThan(0);
  await act(async()=>tree.unmount());tree=undefined;
  expect((await owner()).observerCount()).toBe(0);
  (await owner()).publish({family:'room-scheduled-work',roomId:'room-a'},await fixture.read.mock.results[0]!.value);
  expect(fixture.read).toHaveBeenCalledTimes(1);
});
it('a retained hidden schedule releases its observer and resumes the canonical value without another read',async()=>{
  await act(async()=>{tree=create(<Reader id="room-a"/>);});
  await act(async()=>fixture.blur.get('room-a')!());
  expect((await owner()).observerCount()).toBe(0);
  await act(async()=>{fixture.focus.get('room-a')!();});
  expect((await owner()).observerCount()).toBeGreaterThan(0);
  expect(fixture.read).toHaveBeenCalledTimes(1);
});
it('sixteen unmounted Rooms leave no observers and reuse the held canonical value on return',async()=>{
  for(let n=0;n<16;n++){
    await act(async()=>{tree=create(<Reader id={`room-${n}`}/>);});
    await act(async()=>tree.unmount());tree=undefined;
  }
  expect(fixture.read).toHaveBeenCalledTimes(16);expect((await owner()).observerCount()).toBe(0);
  await act(async()=>{tree=create(<Reader id="room-0"/>);});
  expect(fixture.read).toHaveBeenCalledTimes(16);
});
