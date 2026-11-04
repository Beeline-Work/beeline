import {useCallback,useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {isWorkspaceView,type WorkspaceView,type SurfaceCacheAddress} from '@beeline/buzz-client';
import {getEffectiveRelayUrl} from '@/auth/buzz-identity-storage';
import {mobileSurfaceCache,surfaceAddress} from './surface-storage';
import {useWorkspaceRecords,workspaceRecordScope,workspaceRows} from './workspace-records';
import {shouldReadWorkspaceRoster} from './room-participants';
import {appErrorCopy} from './app-error-copy';
import {useRoutedResource} from './router-resource';
import {acquireRouterRoomRoster} from './router-owner';
import {clientResetGeneration,subscribeClientReset} from '@/sync/client-reset';

/** The Room's existing picker owner. Closed sheets can observe a held roster
 * for bylines; only a visible picker can ask for the Workspace snapshot. */
export function useRoomRoster(workspaceId:string|null|undefined,viewer:string|null|undefined,visible:boolean,
  read:((workspaceId:string)=>Promise<WorkspaceView>)|undefined,onError:(reason:string)=>void){
  const routed=useRoutedResource('workspace-roster',workspaceId?{family:'workspace-roster',workspaceId}:undefined,visible);
  const showing=useRef(visible);showing.current=visible;
  const error=useRef(onError);error.current=onError;
  const gesture=useRef<ReturnType<typeof acquireRouterRoomRoster>|null>(null);
  useEffect(()=>{if(!visible){gesture.current?.release();gesture.current=null;}return()=>{gesture.current?.release();gesture.current=null;};},[visible,workspaceId]);
  const open=useCallback(()=>{if(routed.mode==='router'&&workspaceId){
    try{showing.current=true;gesture.current?.release();
      gesture.current=acquireRouterRoomRoster(workspaceId,()=>showing.current,()=>{});}
    catch(reason){error.current(appErrorCopy(reason,'Could not read the Workspace roster.'));}
  }},[routed.mode,workspaceId]);
  const generation=useSyncExternalStore(subscribeClientReset,clientResetGeneration);
  const [held,setHeld]=useState<WorkspaceView|null>(null),[resolved,setResolved]=useState<{address:SurfaceCacheAddress;generation:number}|null>(null);
  const address=resolved?.generation===generation&&resolved.address.viewerPubkey===viewer&&resolved.address.params?.workspaceId===workspaceId?resolved.address:null;
  const scoped=address?workspaceRecordScope(address.relayOrigin,address.viewerPubkey,String(address.params?.workspaceId)):null;
  const records=useWorkspaceRecords(scoped),cached=useRef<string|null>(null);
  useEffect(()=>{
    cached.current=null;setHeld(null);setResolved(null);
    if(routed.mode!=='legacy'||!workspaceId||!viewer)return;
    let cancelled=false,release:(()=>void)|undefined;
    void(async()=>{
      const next=surfaceAddress(await getEffectiveRelayUrl(),viewer,'/workspace/:id',{workspaceId});
      if(cancelled)return;
      const paint=()=>{if(!cancelled)setHeld(mobileSurfaceCache.peek(next,isWorkspaceView));};
      release=mobileSurfaceCache.subscribe(next,paint);await mobileSurfaceCache.read(next,isWorkspaceView);paint();
      if(!cancelled)setResolved({address:next,generation});
    })().catch(()=>undefined);
    return()=>{cancelled=true;release?.();};
  },[workspaceId,viewer,generation,routed.mode]);
  useEffect(()=>{
    if(routed.mode!=='legacy'||!read||!workspaceId||!address||!shouldReadWorkspaceRoster({activeWorkspaceId:workspaceId,cachedWorkspaceId:cached.current,rosterSurfaceVisible:visible}))return;
    let cancelled=false;
    void mobileSurfaceCache.fetch(address,isWorkspaceView,()=>read(workspaceId)).then(()=>{
      if(!cancelled)cached.current=workspaceId;
    }).catch(reason=>{if(!cancelled&&visible)error.current(appErrorCopy(reason,'Could not read the Workspace roster.'));});
    return()=>{cancelled=true;};
  },[workspaceId,visible,read,address,routed.mode]);
  // The records version re-selects canonical rows after another surface writes.
  const cachedValue=useMemo(()=>held&&scoped?{...held,members:workspaceRows<WorkspaceView['members'][number]>(scoped,held.members.map(row=>row.identity.pubkey)),
    agents:workspaceRows<WorkspaceView['agents'][number]>(scoped,held.agents.map(row=>row.identity.pubkey))}:null,[held,scoped,records]);
  return {value:routed.mode==='legacy'?cachedValue:routed.value,open};
}
