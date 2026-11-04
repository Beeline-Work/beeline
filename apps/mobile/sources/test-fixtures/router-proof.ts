/** UI proofs install complete canonical DTOs. Real owner suites cover transport,
 * authority, ordering and durability. Import only the proof's mocked producers. */
export function canonicalRouterProofShims(families: readonly string[] = []): Record<string, string> {
  const loaders: string[] = [], imports: string[] = [];
  if (families.includes('owner-workbench')) {
    imports.push(`import * as navigation from 'expo-router'; import * as auth from '@/auth/buzz-identity-storage';`);
    loaders.push(`if(input.family==='owner-workbench') {
      const params=navigation.useLocalSearchParams?.()??{};
      const {getWorkbenchSource}=await import('@/buzz/workbench-source');
      return getWorkbenchSource().readWorkbench({workspaceId:params.workspaceId??'',viewerId:params.viewerId??(await auth.loadBuzzIdentity?.())?.publicKey??''});
    }`);
  }
  if (families.includes('owner-wallet')) loaders.push(`if(input.family==='owner-wallet') {
    const {getWalletSource}=await import('@/buzz/wallet-source');
    const wallet=await getWalletSource().readWallet({workspaceId:globalThis.__params?.workspaceId??'workspace-1'});
    return {wallet,summary:null,observedAt:Date.now()};
  }`);
  const operations: Record<string,string> = {'room-scheduled-work':'readScheduledWork','room-workflows':'listRoomWorkflowRuns','needs-you-count':'countNeedsYou'};
  if(families.some(family=>operations[family]||family==='needs-you-tray')) {
    imports.push(`import {monolithPhoneOperation} from '@/sync/transport/monolith-operation';`);
    for(const family of families) if(operations[family]) loaders.push(`if(input.family==='${family}')return monolithPhoneOperation('${operations[family]}',${family==='needs-you-count'?'{workspaceId:input.workspaceId}':'{roomId:input.roomId}'});`);
    if(families.includes('needs-you-tray')) loaders.push(`if(input.family==='needs-you-tray') {
      const value=await monolithPhoneOperation('readTray',{workspaceId:input.workspaceId});
      return {...value,needs:value.needs??{items:[]},saved:{rows:(value.saved?.bookmarks??[]).map((value,index)=>({bookmarkId:value.messageId,order:index+',row',value})),next:null}};
    }`);
  }
  if(families.some(family=>family==='room-list'||family==='room-head')) {
    imports.push(`import * as roomAuth from '@/auth/buzz-identity-storage'; import {RoomViewClient} from '@/sync/transport/room-view-client';`);
    loaders.push(`if(input.family==='room-list'||input.family==='room-head') {
      const client=new RoomViewClient({baseUrl:await roomAuth.getEffectiveRelayUrl(),identity:await roomAuth.loadBuzzIdentity()});
      return input.family==='room-head'?client.room(input.roomId):client.chats(undefined,input.workspaceId);
    }`);
  }
  const owner = `import {canonicalRouterFixture} from '@/test/canonical-router-fixture';
    ${imports.join('\n')}
    const fixture=window.__routerFixture??=canonicalRouterFixture(async input=>{${loaders.join('\n')}return null;});
    window.__routerFixture=fixture;
    export const {routerFamilyMode,subscribeRouterOwner,routerLaneSnapshot,acquireRouterLane,retryRouterLane,
      routerOwnerListPanel,routerOwnerUsageProfile,routerOwnerArtifactAction,routerOwnerArtifactViewport,
      routerOwnerNavigation,routerOwnerDisconnected}=fixture;
    const forbidden=()=>{throw new Error('UI fixture cannot mint production authority');};
    export const routerOwnerCapabilities=()=>({families:[],authorityFencesV1:false,scheduledWorkCoverageV1:false});
    export const routerOwnerNegotiated=forbidden,routerOwnerReceive=forbidden,readRouterToolPage=forbidden,
      acquireRouterForwardList=forbidden,acquireRouterRosterQuery=forbidden,acquireRouterRoomRoster=forbidden,acquireRouterSavedContinuation=forbidden,admitRouterScheduledStop=forbidden,admitRouterTrayCommand=forbidden,admitRouterTrayPaint=forbidden;`;
  const family = `export const useRouterFamily=()=>'router'; export const holdRouterConnection=()=>()=>{};`;
  const result: Record<string,string> = {
    '@/buzz/router-owner':owner,'./router-owner':owner,
    '@/buzz/router-family':family,'./router-family':family,
  };
  if(families.includes('room-scheduled-work')) {
    const scheduled=`export {useRoutedScheduledWork} from '${process.cwd()}/sources/buzz/router-scheduled-work';
      import {monolithPhoneOperation} from '@/sync/transport/monolith-operation';
      export async function prepareScheduledStop(operation,roomId,id) {
        try {await monolithPhoneOperation(operation,{roomId,[operation==='deleteRoomSchedule'?'scheduleId':'subscriptionId']:id});}
        catch(error) {if(error?.status!==404||error?.code!==(operation==='deleteRoomSchedule'?'schedule not found':'subscription not found'))throw error;}
      }`;
    result['@/buzz/router-scheduled-work']=scheduled;result['./router-scheduled-work']=scheduled;
  }
  if(families.includes('needs-you-tray')) {
    const tray=`export {useRoutedTray} from '${process.cwd()}/sources/buzz/router-tray';
      import {monolithPhoneOperation} from '@/sync/transport/monolith-operation';
      export function prepareTrayCommand(workspaceId,command) {
        let cancelled=false,delivery;
        return {ready:Promise.resolve(),cancel:async()=>{cancelled=true;},deliver:()=>delivery??=(async()=>{
          if(cancelled)return;await monolithPhoneOperation(command.operation,command.input);
          await Promise.all(['needs-you-tray','needs-you-count'].map(family=>window.__routerFixture.pushServer({family,workspaceId})));
        })()};
      }
      export const acknowledgeRoutedTrayPaint=async()=>{};`;
    result['@/buzz/router-tray']=tray;result['./router-tray']=tray;
  }
  return result;
}
