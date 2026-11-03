import {describe,expect,it} from 'vitest';
import {routerSourcePlan} from './router-source-plan.js';
const VIEWER='a'.repeat(64),OTHER='b'.repeat(64),ROOM='11111111-1111-4111-8111-111111111111',SECOND='22222222-2222-4222-8222-222222222222';
const target={roomId:ROOM,readers:null};
const cause=(metadata:unknown)=>({sourceTable:'agent_schedules',sourceRoomId:SECOND,scheduledWorkSource:metadata});
const complete=(targets:unknown[]=[target])=>({version:1,classification:'complete',targets});
describe('closed canonical Scheduled Work row-source planning',()=>{
  it('classifies canonical parent targets, independently of legacy physical Room keys',()=>{
    const plan=routerSourcePlan([cause(complete([target,{roomId:SECOND,readers:[VIEWER,OTHER]}]))],VIEWER);
    expect([...plan.families]).toEqual(['room-scheduled-work']);expect(plan.scheduledWorkCauses).toEqual([
      target,{roomId:SECOND,readers:[VIEWER,OTHER]},
    ]);expect(plan.rooms.size).toBe(0);expect(plan.allRooms).toBe(false);
  });
  it('deduplicates canonical/standalone causes and repeated readers after an older migrator restores duplicate emitters',()=>{
    const plan=routerSourcePlan([cause(complete([{roomId:ROOM,readers:[OTHER,VIEWER,VIEWER]}])),
      {sourceTable:'agent_schedules',sourceRoomId:SECOND,operation:'UPDATE'},
      {sourceTable:'scheduled-work-projection',sourceRoomId:ROOM,scheduledWorkReaders:[VIEWER,OTHER]},
      cause(complete([{roomId:ROOM,readers:[VIEWER,OTHER]}]))],VIEWER);
    expect(plan.scheduledWorkCauses).toEqual([{roomId:ROOM,readers:[VIEWER,OTHER]}]);
  });
  it('retains distinct public/private OLD+NEW audiences even for the same parent',()=>{
    expect(routerSourcePlan([cause(complete([target,{roomId:ROOM,readers:[VIEWER]}]))],VIEWER).scheduledWorkCauses).toEqual([target,{roomId:ROOM,readers:[VIEWER]}]);
  });
  it('accepts explicit complete-empty projection changes while retaining independent family causes',()=>{
    const plan=routerSourcePlan([cause(complete([])),{sourceTable:'workspaces'}],VIEWER);
    expect(plan.scheduledWorkCauses).toEqual([]);expect([...plan.families]).toEqual(['agent-profile','room-list','workspace-roster']);
  });
  it.each(['dependency','budget'])('never interprets explicit %s unavailability as complete-empty coverage',reason=>{
    expect(()=>routerSourcePlan([cause({version:1,classification:'unavailable',reason})],VIEWER)).toThrow(reason);
  });
  it.each([null,{},complete([{},target]),{...complete(),extra:'unclassified'},
    {...complete(),version:2},complete([{...target,readers:[1]}]),complete([{...target,readers:Array(101).fill(VIEWER)}]),
    complete([{...target,roomId:'not-a-room'}]),complete([{...target,extra:true}]),complete([target,target,target])])('refuses malformed/unknown closed metadata %j',metadata=>{
    expect(()=>routerSourcePlan([cause(metadata)],VIEWER)).toThrow('dependency');
  });
  it('does not permit source extensions to smuggle undeclared table dependencies',()=>{
    expect(()=>routerSourcePlan([{...cause(complete()),sourceTable:'messages'}],VIEWER)).toThrow('dependency');
  });
});
