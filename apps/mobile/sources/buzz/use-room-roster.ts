import {useCallback,useEffect,useRef} from 'react';
import type {WorkspaceView} from '@beeline/buzz-client';
import {appErrorCopy} from './app-error-copy';
import {useRoutedResource} from './router-resource';
import {acquireRouterRoomRoster} from './router-owner';

/** The Room's existing picker owner. Closed sheets can observe a held roster
 * for bylines; only a visible picker can ask for the Workspace snapshot. */
export function useRoomRoster(workspaceId:string|null|undefined,_viewer:string|null|undefined,visible:boolean,
  _read:((workspaceId:string)=>Promise<WorkspaceView>)|undefined,onError:(reason:string)=>void){
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
  return {value:routed.value,open};
}
