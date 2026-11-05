import {useEffect,useMemo,useSyncExternalStore} from 'react';
import type {RouterSnapshotInput,RouterValues} from '@beeline/api-contract/router-protocol';
import {useRoutedResource} from './router-resource';
import {clientResetGeneration,subscribeClientReset} from '@/sync/client-reset';
import {acquireRouterRosterQuery} from './router-owner';

type Query=NonNullable<Extract<RouterSnapshotInput,{family:'workspace-roster'}>['query']>;
type Page={query:Query;handle:ReturnType<typeof acquireRouterRosterQuery>;stop:()=>void};
/** Canonical server windows only. Text editing never enters this owner. */
export function useRoutedRoster(workspaceId:string|undefined,focused:boolean){
  const generation=useSyncExternalStore(subscribeClientReset,clientResetGeneration);
  const root=useRoutedResource('workspace-roster',workspaceId?{family:'workspace-roster',workspaceId}:undefined,focused);
  const windows=useMemo(()=>{
    const listeners=new Set<()=>void>();let pages:Page[]=[],version=0,query='';
    const notify=()=>{version++;for(const listener of listeners)listener();};
    const clear=()=>{for(const page of pages){page.stop();page.handle.release();}pages=[];};
    return {subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
      snapshot:()=>version,pages:()=>pages,query:()=>query,
      open:(input:Extract<RouterSnapshotInput,{family:'workspace-roster'}>,append:boolean)=>{
        const next=input.query!;
        if(!append){clear();query=next.q??'';}
        if(pages.some(page=>JSON.stringify(page.query)===JSON.stringify(next)))return;
        const handle=acquireRouterRosterQuery(input,()=>focused,()=>{});
        const page={query:next,handle,stop:handle.subscribe(notify)};pages=[...pages,page];notify();
      },dispose:()=>{clear();query='';notify();}};
  },[workspaceId,focused,generation]);
  useEffect(()=>()=>windows.dispose(),[windows]);
  useSyncExternalStore(windows.subscribe,windows.snapshot,windows.snapshot);
  const head=root.value,query=windows.query();
  const pages=windows.pages().filter(page=>page.query.revision===head?.revision);
  let value=head;
  if(pages.length){
    const first=pages.find(page=>!page.query.kind)?.handle.current();
    const base=first?.value as RouterValues['workspace-roster']|null|undefined;
    value=query?base??null:head;
    if(value){
      let members=[...value.members],agents=[...value.agents];
      let membersTruncated=value.membersTruncated,agentsTruncated=value.agentsTruncated;
      for(const page of pages){
        if(!page.query.kind)continue;
        const next=page.handle.current().value as RouterValues['workspace-roster']|null;
        if(!next)continue;
        if(page.query.kind==='human'){members.push(...next.members);membersTruncated=next.membersTruncated;}
        else{agents.push(...next.agents);agentsTruncated=next.agentsTruncated;}
      }
      value={...value,members,agents,membersTruncated,agentsTruncated};
    }
  }else if(query)value=null;
  const queryLoading=pages.some(page=>['ABSENT','OPENING'].includes(page.handle.current().state));
  const queryError=pages.map(page=>page.handle.current().error).find(Boolean)??
    (head&&windows.pages().length&&!pages.length?'Roster changed; Retry the search.':null);
  return {...root,retry:()=>{if(query&&head&&workspaceId)windows.open({family:'workspace-roster',workspaceId,
      query:{revision:head.revision,q:query}},false);else{windows.dispose();root.retry();}},value,query,loading:root.loading||queryLoading,error:root.error??queryError,
    search:(q:string)=>{
      if(!workspaceId||!head)throw new Error('Roster is unavailable.');
      if(!q){windows.dispose();return;}
      windows.open({family:'workspace-roster',workspaceId,query:{revision:head.revision,q}},false);
    },more:(kind:'human'|'agent')=>{
      if(!workspaceId||!head||!value)throw new Error('Roster is unavailable.');
      windows.open({family:'workspace-roster',workspaceId,query:{revision:head.revision,q:query,kind,
        offset:kind==='human'?value.members.length:value.agents.length}},true);
    }};
}
