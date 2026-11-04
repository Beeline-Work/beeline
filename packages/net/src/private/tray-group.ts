import type { SavedRowPayload, SavedWindow } from '@beeline/api-contract/router-protocol';
import type { LaneAuthority, LaneBatch, LaneCut, LaneRequest, LaneSnapshot } from './read-lanes.js';
import type { CellSnapshot, GroupCell } from './projection-groups.js';
import { replaceSavedWindowRows, validateSavedWindow } from './saved-windows.js';
import { sameStream } from './lane-staging.js';
export const equal=(a:unknown,b:unknown):boolean=>JSON.stringify(a)===JSON.stringify(b);
export const trayClock=(value:unknown)=>typeof value==='string'?value.match(/^tray-clock-v1:([a-f0-9]{32}):(0|[1-9][0-9]{0,19})$/):null;
export const exactCut=(a:LaneCut,b:LaneCut):boolean=>sameStream(a,b)&&a.through===b.through;
export const trayFamily=(family:string):boolean=>['needs-you','needs-you-count','needs-you-tray','needs-you-saved-page'].includes(family);
export function trayCertificate(authority:LaneAuthority,reader:string,workspace:string,authorized:(value:LaneAuthority)=>boolean):boolean{
  const domains=[`reader:${reader}:workspace:${workspace}`,`reader:${reader}:workspace:${workspace}:visibility`];
  return authorized(authority)&&authority.scopes.length===2&&new Set(authority.scopes.map(scope=>scope.authorityScope)).size===2&&
    authority.scopes.every(scope=>domains.includes(scope.authorityScope));
}
export function checkTraySnapshot(cell:GroupCell,snapshot:LaneSnapshot,reader:string,workspace:string,
  valid:(request:LaneRequest,value:unknown)=>boolean,authorized:(value:LaneAuthority)=>boolean):void{
  if(snapshot.atomicGroup!==`needs-you:${workspace}:${reader}`||snapshot.cut.stream!==`workspace:${workspace}`||
    !trayClock(snapshot.clockVersion)||!trayCertificate(snapshot.authority,reader,workspace,authorized)||!valid(cell.request,snapshot.value))
    throw new Error('Invalid Tray baseline');
  if(cell.request.family==='needs-you-saved-page'&&(!validateSavedWindow(snapshot.value,workspace)||snapshot.value.before!==cell.request.before))
    throw new Error('Saved window query changed');
  if(cell.request.family==='needs-you-tray'&&!validateSavedWindow((snapshot.value as {saved?:unknown})?.saved,workspace))throw new Error('Invalid Tray Saved head');
}
/** Closed Tray value algebra only. All lifecycle, receipts, interval retention
 * and commit proposals are owned by ProjectionGroups for both cohorts. */
export function foldTray<T extends GroupCell>(members:readonly CellSnapshot<T>[],batch:LaneBatch,priorClock:string,workspace:string,
  valid:(request:LaneRequest,value:unknown)=>boolean):CellSnapshot<T>[]{
    const marker=batch.facts.find(fact=>fact.payload.kind==='tray-classification')!;
    if(marker.payload.kind!=='tray-classification')throw new Error('Missing Tray classification');
    const clockVersion=marker.payload.clockVersion;
    const nextClock=trayClock(clockVersion),previous=trayClock(priorClock);
    if(!nextClock||!previous||nextClock[1]!==previous[1]||BigInt(nextClock[2]!)<BigInt(previous[2]!))throw new Error('Unknown Tray clock');
    const rows=batch.facts.flatMap(fact=>fact.payload.kind==='saved-row-replace'||fact.payload.kind==='saved-row-remove'?[fact.payload as SavedRowPayload]:[]);
    const heads=batch.facts.filter(fact=>fact.payload.kind==='scope-replace'&&fact.payload.family==='needs-you-saved-page');
    if(heads.length>1)throw new Error('Conflicting Saved head');
    let head:SavedWindow|undefined;
    if(heads.length){
      const value=heads[0]!.payload.kind==='scope-replace'?heads[0]!.payload.value:undefined;
      if(!validateSavedWindow(value,workspace)||value.before!==undefined)throw new Error('Saved window refill');
      head=value;
    }
    const needs=batch.facts.filter(fact=>fact.payload.kind==='tray-needs-replace');
    if(needs.length>1)throw new Error('Conflicting Tray needs');
    return members.map(member=>{
      if(member.snapshot.authority.digest!==marker.authority.digest)throw new Error('Tray authority changed');
      let value=member.snapshot.value;
      const replacements=batch.facts.filter(fact=>fact.payload.kind==='scope-replace'&&fact.payload.family===member.cell.request.family&&fact.payload.family!=='needs-you-saved-page');
      if(replacements.length>1)throw new Error('Conflicting Tray replacement');
      if(member.cell.request.family==='needs-you-saved-page'){
        value=replaceSavedWindowRows(value as SavedWindow,workspace,rows);
        if(head&&member.cell.request.before===undefined){
          if(head.windowId!==(value as SavedWindow).windowId)throw new Error('Saved head query changed');
          value=JSON.parse(JSON.stringify(head));
        }
      }
      if(member.cell.request.family==='needs-you-tray'){
        const current=value as {needs:unknown;saved:SavedWindow};
        let updated=replaceSavedWindowRows(current.saved,workspace,rows);
        if(head){
          if(head.windowId!==current.saved.windowId)throw new Error('Saved head query changed');
          updated=JSON.parse(JSON.stringify(head)) as SavedWindow;
        }
        value={...current,saved:updated,...(needs[0]?.payload.kind==='tray-needs-replace'?{needs:JSON.parse(JSON.stringify(needs[0].payload.value)) as unknown}:{})};
      }
      if(replacements[0]?.payload.kind==='scope-replace'){
        const replacement=replacements[0].payload.value;
        if(member.cell.request.family==='needs-you-saved-page'||member.cell.request.family==='needs-you-tray'&&
          !equal((replacement as {saved?:unknown})?.saved,(value as {saved?:unknown})?.saved))throw new Error('Saved window refill');
        value=JSON.parse(JSON.stringify(replacement)) as unknown;
      }else if(member.cell.request.family==='needs-you'&&needs.length)throw new Error('Missing complete Needs head');
      if(!valid(member.cell.request,value))throw new Error('Invalid Tray group value');
      return{...member,snapshot:{...member.snapshot,value,cut:{...batch.to},clockVersion}};
    });
  }
