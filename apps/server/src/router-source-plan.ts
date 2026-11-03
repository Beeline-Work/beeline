import {readTrayClockCause,readTrayClockBasisCause} from './tray-clock-protocol.js';
import type { RouterFamily } from '@beeline/api-contract/router-protocol';
import { readTrayMutableCause } from './tray-mutable-source.js';
import { readTraySavedWindowCause } from './tray-saved-window.js';
import { readTraySavedSourceCause } from './tray-saved-source.js';
import type { TraySavedTarget } from './tray-saved-projection.js';
import { RouterProjectionUnavailable } from './router-projections.js';

/** Explicit dependency classification. Unknown journal shapes park; they never
 * mean 'refresh everything'. This table is not a claim of schema closure. */
const dependencies: Readonly<Record<string, readonly RouterFamily[]>> = {
  messages: ['room-list','needs-you','needs-you-tray','needs-you-count','room-head'],
  memberships: ['room-list','needs-you','needs-you-tray','needs-you-count','room-head','room-workflows'],
  identities: ['room-list','needs-you','needs-you-tray','needs-you-count','room-head','room-workflows'],
  rooms: ['room-list','needs-you','needs-you-tray','needs-you-count','room-head','room-workflows'],
  // The roster includes the canonical Workspace header and manager settings.
  // The dedicated roster cause in the same transaction coalesces in this Set.
  workspaces: ['room-list','workspace-roster'],
  room_read_marks: ['room-list','room-head'],
  needs_you_marks: ['needs-you','needs-you-tray','needs-you-count'],
  agent_commands: ['room-list','room-head'],
  agent_turns: ['room-list','room-head'],
  corner_facts: ['room-list','room-head'],
  corner_person_state: ['room-list','room-head'],
  corner_owed: ['room-list','room-head'],
  corner_follows: ['room-list'],
  corner_brief_revisions: ['room-list','room-head'],
  corner_merge_holds: ['room-list','room-head'],
  agent_grants: ['needs-you','needs-you-tray','needs-you-count','room-head'],
  permission_authority: ['needs-you','needs-you-tray','needs-you-count','room-head'],
  message_bookmarks: ['room-head','needs-you-tray'],
  feedback_items: ['room-head'],
  objects: ['room-head'],
  object_expirations: ['room-head'],
  voice_calls: ['room-list','room-head'],
  chat_dismissals: ['room-list'],
  // These tables do not enter any of the first four DTOs.
  agent_schedules: [], agent_subscriptions: [],
  'tray-clock':['needs-you','needs-you-tray','needs-you-count'],
  'tray-clock-basis':[], 'tray-clock-readiness':[],
  'tray-projection':['needs-you','needs-you-tray','needs-you-count'],
  'scheduled-work-projection':['room-scheduled-work'],
  'tray-saved-window':['needs-you-saved-page'],
  'tray-saved-source':['needs-you-saved-page'],
  'profile-projection':['agent-profile'],
  'roster-projection':['workspace-roster'],
};
export function routerSourcePlan(causes: readonly Record<string,unknown>[], viewer: string, workspaceId?:string) {
  const families = new Set<RouterFamily>(), rooms = new Set<string>(), removedRooms = new Set<string>();
  const profiles=new Set<string>();let allProfiles=false;
  const authorityRooms=new Set<string>(),priorRooms:{id:string;oldParentId:string|null}[]=[];
  const scheduledWorkCauses:{roomId:string;readers:readonly string[]|null}[]=[];
  const scheduledWorkKeys=new Set<string>();
  const savedKeys=new Map<string,TraySavedTarget>();
  let savedUnavailable:'budget'|'dependency'|undefined;
  let savedHeadChanged=false;
  const addSaved=(target:TraySavedTarget)=>{
    if(savedUnavailable)return;
    const old=savedKeys.get(target.bookmarkId);
    if(old&&old.messageId!==target.messageId){savedUnavailable='dependency';savedKeys.clear();return;}
    savedKeys.set(target.bookmarkId,target);
    if(savedKeys.size>256){savedUnavailable='budget';savedKeys.clear();}
  };
  const addScheduled=(roomId:string,readers:readonly string[]|null)=>{
    const normalized=readers===null?null:[...new Set(readers)].sort();
    const key=JSON.stringify([roomId,normalized]);
    if(!scheduledWorkKeys.has(key)){scheduledWorkKeys.add(key);scheduledWorkCauses.push({roomId,readers:normalized});}
    families.add('room-scheduled-work');
  };
  let allRooms = false;
  for (const cause of causes) {
    const table = cause.sourceTable;
    if (typeof table !== 'string' || !Object.hasOwn(dependencies,table))
      throw new RouterProjectionUnavailable('dependency');
    if(table==='profile-projection'){
      if(typeof cause.profileAgentId!=='string'||!cause.profileAgentId||cause.profileAgentId.length>128)throw new RouterProjectionUnavailable('dependency');
      profiles.add(cause.profileAgentId);for(const family of dependencies[table]!)families.add(family);continue;
    }
    if(table==='memberships'&&cause.identityId===viewer||table==='rooms'||table==='workspaces'||table==='corner_facts'||table==='corner_github_cache'){
      allProfiles=true;families.add('agent-profile');
    }
    if(table==='tray-clock-basis'||table==='tray-clock-readiness'){
      const source=readTrayClockBasisCause(cause);
      if(!source||!workspaceId||source.trayWorkspaceId!==workspaceId)throw new RouterProjectionUnavailable('dependency');
      // The committed basis is read once by the joint group producer. A basis
      // transition alone carries no changed cells and never queries a page.
      continue;
    }
    if(table==='tray-clock'){
      const source=readTrayClockCause(cause);
      if(!source||!workspaceId||source.trayWorkspaceId!==workspaceId)throw new RouterProjectionUnavailable('dependency');
      if(source.trayReaderId===viewer)for(const family of dependencies[table]!)families.add(family);
      continue;
    }
    if(table==='tray-saved-window'){
      const source=readTraySavedWindowCause(cause);
      if(!source||!workspaceId||source.trayWorkspaceId!==workspaceId)throw new RouterProjectionUnavailable('dependency');
      if(source.trayReaderId!==viewer)continue;
      families.add('needs-you-saved-page');
      if(source.oldReaderId===viewer&&source.oldWorkspaceId===workspaceId)addSaved({bookmarkId:source.oldBookmarkId!,messageId:source.oldMessageId!});
      if(source.newReaderId===viewer&&source.newWorkspaceId===workspaceId){
        addSaved({bookmarkId:source.newBookmarkId!,messageId:source.newMessageId!});
        if(source.newBookmarkId!==source.oldBookmarkId)savedHeadChanged=true;
      }
      continue;
    }
    if(table==='tray-saved-source'){
      const source=readTraySavedSourceCause(cause);
      if(!source||!workspaceId||source.trayWorkspaceId!==workspaceId)throw new RouterProjectionUnavailable('dependency');
      if(source.trayReaderId!==viewer)continue;
      families.add('needs-you-saved-page');
      if(source.classification==='unavailable'){savedUnavailable=source.reason;savedKeys.clear();}
      else for(const target of source.targets)addSaved(target);
      continue;
    }
    if(Object.hasOwn(cause,'scheduledWorkSource')){
      if(table!=='agent_schedules'&&table!=='agent_subscriptions')throw new RouterProjectionUnavailable('dependency');
      const source=cause.scheduledWorkSource;
      if(!source||typeof source!=='object'||Array.isArray(source))throw new RouterProjectionUnavailable('dependency');
      const metadata=source as Record<string,unknown>;
      if(metadata.version!==1)throw new RouterProjectionUnavailable('dependency');
      if(metadata.classification==='unavailable'&&Object.keys(metadata).length===3&&
        (metadata.reason==='dependency'||metadata.reason==='budget'))throw new RouterProjectionUnavailable(metadata.reason);
      if(metadata.classification!=='complete'||Object.keys(metadata).length!==3||!Array.isArray(metadata.targets)||metadata.targets.length>2)
        throw new RouterProjectionUnavailable('dependency');
      for(const value of metadata.targets){
        if(!value||typeof value!=='object'||Array.isArray(value))throw new RouterProjectionUnavailable('dependency');
        const target=value as Record<string,unknown>;
        if(Object.keys(target).length!==2||typeof target.roomId!=='string'||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(target.roomId)||
          !(target.readers===null||Array.isArray(target.readers)&&target.readers.length<=100&&
            target.readers.every(reader=>typeof reader==='string'&&reader.length<=256)))throw new RouterProjectionUnavailable('dependency');
        addScheduled(target.roomId,target.readers as readonly string[]|null);
      }
      continue;
    }
    if(table==='tray-projection'){
      const dependency=readTrayMutableCause(cause);
      if(!dependency||!workspaceId||dependency.trayWorkspaceId!==workspaceId)throw new RouterProjectionUnavailable('dependency');
      if(dependency.trayReaderId!==viewer)continue;
      for(const family of dependencies[table]!)families.add(family);
      continue;
    }
    if(table==='scheduled-work-projection'){
      if(typeof cause.sourceRoomId!=='string'||!(cause.scheduledWorkReaders===null||Array.isArray(cause.scheduledWorkReaders)&&
        cause.scheduledWorkReaders.length<=100&&cause.scheduledWorkReaders.every(reader=>typeof reader==='string')))
        throw new RouterProjectionUnavailable('dependency');
      addScheduled(cause.sourceRoomId,cause.scheduledWorkReaders as readonly string[]|null);continue;
    }
    if (['room_read_marks','needs_you_marks','message_bookmarks','chat_dismissals'].includes(table) &&
      typeof cause.identityId === 'string' && cause.identityId !== viewer) continue;
    if(table==='messages'&&cause.workflowRunsChanged===true)families.add('room-workflows');
    for (const family of dependencies[table]!) families.add(family);
    if (typeof cause.sourceRoomId === 'string') {
      rooms.add(cause.sourceRoomId);
      if (cause.sourceRemoved===true || (table==='rooms' && cause.operation==='DELETE') || (table==='memberships' && cause.removed===true && cause.identityId===viewer)) removedRooms.add(cause.sourceRoomId);
    }
    if (typeof cause.oldRoomId === 'string') rooms.add(cause.oldRoomId);
    if (typeof cause.newRoomId === 'string') rooms.add(cause.newRoomId);
    if (typeof cause.parentRoomId === 'string') rooms.add(cause.parentRoomId);
    if(typeof cause.oldParentRoomId==='string')rooms.add(cause.oldParentRoomId);
    if(typeof cause.newParentRoomId==='string')rooms.add(cause.newParentRoomId);
    if(table==='memberships'&&cause.identityId===viewer){
      for(const id of [cause.sourceRoomId,cause.oldRoomId,cause.newRoomId])if(typeof id==='string')authorityRooms.add(id);
    }
    if(table==='rooms'){
      const id=cause.oldRoomId??cause.sourceRoomId;
      if(typeof id==='string')priorRooms.push({id,oldParentId:typeof cause.oldParentRoomId==='string'?cause.oldParentRoomId:null});
    }
    if(table==='identities'||dependencies[table]!.includes('room-head')&&!cause.sourceRoomId)allRooms=true;
  }
  return {families,rooms,removedRooms,allRooms,authorityRooms,priorRooms,scheduledWorkCauses,profiles,allProfiles,
    savedTargets:[...savedKeys.values()].sort((a,b)=>a.bookmarkId.localeCompare(b.bookmarkId)),savedUnavailable,savedHeadChanged};
}
