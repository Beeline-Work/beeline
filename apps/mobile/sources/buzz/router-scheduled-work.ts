import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {AppState} from 'react-native';
import type {ScheduledWorkResult} from '@beeline/api-contract/phone';
import {acquireRouterLane,retryRouterLane,routerFamilyMode,admitRouterScheduledStop} from './router-owner';
import {useRouterFamily} from './router-family';
import {activeCommandOwner} from './command-owner';
const empty=Object.freeze({state:'ABSENT' as const,value:null,error:null,cut:null});
const noop=()=>{};
export function useRoutedScheduledWork(roomId:string|undefined,focused:boolean){
  const mode=useRouterFamily('room-scheduled-work');
  const visible=useRef(focused);visible.current=focused;
  const request=useMemo(()=>roomId?{family:'room-scheduled-work' as const,roomId}:undefined,[roomId]);
  const [lane,setLane]=useState<{roomId:string;handle:ReturnType<typeof acquireRouterLane>}>();
  useEffect(()=>{
    if(mode!=='router'||!focused||!request){setLane(undefined);return;}
    const held=acquireRouterLane(request,()=>visible.current&&AppState.currentState==='active',noop);
    setLane({roomId:request.roomId,handle:held});return()=>{held.release();};
  },[mode,focused,request]);
  const current=mode==='router'&&focused&&lane&&lane.roomId===roomId?lane.handle:undefined;
  const view=useSyncExternalStore(current?.subscribe??(()=>noop),()=>current?.current()??empty,()=>empty);
  return {mode,value:mode==='router'?view.value as ScheduledWorkResult|null:null,
    error:mode==='router'?view.error:null,loading:mode==='pending'||mode==='router'&&(view.state==='ABSENT'||view.state==='OPENING'),
    retry:()=>{if(request&&focused&&mode==='router')retryRouterLane(request);}};
}
/** Admission and durable reservation happen before the caller's first await.
 * Known completion navigates normally; uncertain outcome remains parked in
 * the existing durable command owner, with no read or provider replay. */
export function prepareScheduledStop(operation:'deleteRoomSchedule'|'deleteRoomSubscription',roomId:string,id:string):Promise<void>{
  if(routerFamilyMode('room-scheduled-work')!=='router')throw new Error('Scheduled Work command delivery is unavailable.');
  const owner=activeCommandOwner();
  if(!owner?.canPrepare())throw new Error('Scheduled Work command delivery is unavailable.');
  const prepared=owner.prepare(admitRouterScheduledStop(operation,roomId,id));
  return prepared.then(async record=>{await owner.deliver(record.id);});
}
