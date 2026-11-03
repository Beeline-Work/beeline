import type { LaneAuthority, LaneBatch, LaneCut, LaneRequest, LaneSnapshot, LaneView } from './read-lanes.js';
import { LaneStaging, intervalId, sameStream, type IntervalStage } from './lane-staging.js';
import { jsonBytes, stagingWithinBudget, remember } from './staging-bounds.js';
import { checkTraySnapshot, equal, exactCut, foldTray, trayCertificate, trayClock, trayFamily } from './tray-group.js';
import { foldNeedsYouRooms } from './needs-you-rooms.js';

export type GroupCell={key:string;request:LaneRequest;expectedWorkspace?:string;view:LaneView;
  snapshot?:LaneSnapshot;baseline?:Omit<LaneSnapshot,'value'>;classified?:LaneCut;flight?:Promise<void>;
  revision:number;connection:number;covered:boolean;committing:number;queued:IntervalStage;
  /** One admitted opening/receipt, not another per-family pending map. */
  opening?:LaneCut|true;incoming?:LaneSnapshot};
export type CellSnapshot<T extends GroupCell>=Readonly<{cell:T;snapshot:LaneSnapshot}>;
type Group={id:string;workspace:string;intervals:IntervalStage;history:Map<string,string>;
  progress?:LaneCut;clockVersion?:string;failed:boolean};
export type GroupProposal<T extends GroupCell>=Readonly<{id:string;group?:Group;items:readonly CellSnapshot<T>[];
  whole:readonly CellSnapshot<T>[];versions:readonly number[];cut?:LaneCut;clockVersion?:string}>;
const REPLACE='scope-replace',UNAVAILABLE='Projection unavailable; Retry.';
const room=(request:LaneRequest)=>request.family==='room-head'||request.family==='room-scheduled-work'||request.family==='room-workflows';
const scope=(request:LaneRequest)=>request.agentId??(room(request)?request.roomId!:request.workspaceId!);

/** The single local member/receipt/interval/proposal owner. ReadLanes alone
 * dispatches admitted reads and serializes storage/publication. Legacy members
 * keep independent continuity; only the closed Tray policy has a common cut. */
export class ProjectionGroups<T extends GroupCell>{
  readonly cells=new Map<string,T>();
  private readonly groups=new Map<string,Group>();
  private strict=false;
  constructor(private readonly reader:string,private readonly valid:(request:LaneRequest,value:unknown)=>boolean,
    private readonly authorized:(authority:LaneAuthority)=>boolean,private readonly staging:LaneStaging,
    private readonly park:(cell:T,error:string)=>void){}
  group(workspace:string):string{return `needs-you:${workspace}:${this.reader}`;}
  joint(cell:T):boolean{return this.strict&&trayFamily(cell.request.family);}
  configure(strict:boolean):void{this.clear();this.strict=strict;}
  private members(state:Group):T[]{return [...this.cells.values()].filter(cell=>this.joint(cell)&&cell.request.workspaceId===state.workspace);}
  private state(workspace:string):Group{
    const id=this.group(workspace);let state=this.groups.get(id);
    if(!state){state={id,workspace,intervals:this.staging.stage(),history:new Map(),failed:false};this.groups.set(id,state);}
    return state;
  }
  begin(cell:T):boolean{
    cell.incoming=undefined;
    if(!this.joint(cell)){cell.opening=true;return false;}
    const workspace=cell.request.workspaceId!,id=this.group(workspace),reset=this.groups.get(id)?.failed===true;
    if(reset)this.clear(id,`workspace:${workspace}`);
    const state=this.state(workspace);
    cell.opening=state.progress?{...state.progress}:true;return reset;
  }
  cancel(cell:T):void{
    cell.opening=undefined;cell.incoming=undefined;cell.queued.clear();
    const state=this.groups.get(this.group(cell.request.workspaceId!));if(state)this.trim(state);
  }
  drop(cell:T):void{this.cancel(cell);this.cells.delete(cell.key);this.retain();}
  clear(id?:string,stream?:string):void{
    for(const[key,state]of this.groups)if((!id||state.id===id)&&(!stream||stream===`workspace:${state.workspace}`)){
      state.intervals.clear();this.groups.delete(key);
      for(const cell of this.members(state)){cell.incoming=undefined;cell.opening=undefined;}
    }
  }
  retain():void{for(const state of this.groups.values())if(!this.members(state).length)this.clear(state.id,`workspace:${state.workspace}`);}
  fail(id:string):void{
    const state=this.groups.get(id);if(!state)return;
    state.failed=true;state.intervals.clear();
    for(const cell of this.members(state)){cell.incoming=undefined;cell.opening=undefined;}
  }
  prune():void{
    for(const cell of this.cells.values())if(cell.incoming&&!this.authorized(cell.incoming.authority)){
      if(this.joint(cell))this.clear(this.group(cell.request.workspaceId!),`workspace:${cell.request.workspaceId}`);else cell.incoming=undefined;
    }
  }
  snapshot(cell:T,response:LaneSnapshot):GroupProposal<T>|undefined{
    const workspace=cell.expectedWorkspace??cell.request.workspaceId;
    if(response.kind!=='snapshot'||response.cut.protocol!==1||!Number.isSafeInteger(response.cut.through)||response.cut.through<0||!response.cut.epoch||
      (workspace?response.cut.stream!==`workspace:${workspace}`:!response.cut.stream.startsWith('workspace:'))||
      !this.authorized(response.authority)||!this.valid(cell.request,response.value))throw new Error('Invalid snapshot; Retry.');
    let state:Group|undefined;
    if(this.joint(cell)){
      if(response.atomicGroup!==this.group(cell.request.workspaceId!))throw new Error('Invalid Tray group');
      state=this.state(cell.request.workspaceId!);if(state.failed)throw new Error('Projection group is parked');
      checkTraySnapshot(cell,response,this.reader,state.workspace,this.valid,this.authorized);
      if(cell.opening&&cell.opening!==true&&(!sameStream(cell.opening,response.cut)||response.cut.through<cell.opening.through))throw new Error('Unknown Tray snapshot prefix');
    }
    cell.incoming=JSON.parse(JSON.stringify(response)) as LaneSnapshot;
    if(!state)return this.proposal(response.atomicGroup,response.cut.stream,[{cell,snapshot:cell.incoming}]);
    this.bound(state);return this.prepare(state);
  }
  stage(batch:LaneBatch,replay:boolean,generation:number,scheduled:boolean,current:()=>boolean):{proposals:GroupProposal<T>[];unavailable:string[]}{
    const proposals:GroupProposal<T>[]=[],unavailable:string[]=[],items:CellSnapshot<T>[]=[];
    const roomGroups=new Set(batch.facts.filter(fact=>fact.payload.kind==='needs-you-rooms-replace').map(fact=>fact.atomicGroup));
    const openingGroups=new Set([...this.cells.values()].filter(cell=>cell.flight&&
      (cell.request.family==='needs-you'||cell.request.family==='needs-you-count'))
      .map(cell=>cell.snapshot?.atomicGroup??this.group(cell.request.workspaceId!)).filter(group=>roomGroups.has(group)));
    if(this.strict&&!replay){
      try{for(const state of this.groups.values())if(current()&&!state.failed&&batch.to.stream===`workspace:${state.workspace}`){
        this.stageTray(state,batch);const proposal=this.prepare(state);if(proposal)proposals.push(proposal);
      }}catch{for(const cell of this.cells.values())if(current()&&this.joint(cell)&&batch.to.stream===`workspace:${cell.request.workspaceId}`)this.park(cell,UNAVAILABLE);}
    }
    for(const cell of this.cells.values()){
      if(!current())return{proposals:[],unavailable:[]};
      if(this.joint(cell)||cell.view.state==='PARKED')continue;
      const held=cell.snapshot??cell.baseline;
      const group=held?.atomicGroup??this.group(cell.request.workspaceId!);
      if(openingGroups.has(group)){
        try{cell.queued.add(batch,batch.facts.filter(fact=>fact.atomicGroup===group));}
        catch{this.park(cell,'Projection queue overflow; Retry.');}continue;
      }
      if(cell.flight){
        if(cell.request.workspaceId?batch.to.stream!==`workspace:${cell.request.workspaceId}`:
          !batch.facts.some(fact=>fact.payload.kind===REPLACE&&fact.payload.family===cell.request.family&&fact.payload.scope===scope(cell.request)))continue;
        const related=new Set(batch.facts.filter(fact=>fact.payload.kind===REPLACE&&fact.payload.family===cell.request.family&&
          fact.payload.scope===scope(cell.request)).map(fact=>fact.atomicGroup));if(held)related.add(held.atomicGroup);
        try{cell.queued.add(batch,batch.facts.filter(fact=>fact.payload.kind!==REPLACE||related.has(fact.atomicGroup)));}
        catch{this.park(cell,'Projection queue overflow; Retry.');}continue;
      }
      if(!held||held.cut.stream!==batch.to.stream)continue;
      if(!sameStream(held.cut,batch.to)){this.park(cell,'Projection version changed; Retry.');continue;}
      if(batch.to.through<=held.cut.through)continue;
      const progress=cell.classified??held.cut;
      if(cell.view.state==='REVOKED'&&!batch.facts.some(fact=>fact.atomicGroup===held.atomicGroup&&fact.payload.kind===REPLACE&&
        fact.payload.family===cell.request.family&&fact.payload.scope===scope(cell.request)&&this.authorized(fact.authority)))continue;
      if(batch.from.through>progress.through){
        if(!cell.snapshot&&cell.view.value===null){unavailable.push(held.atomicGroup);continue;}
        const facts=batch.facts.filter(fact=>fact.atomicGroup===held.atomicGroup);
        if(!facts.length&&!(scheduled&&cell.request.family==='room-scheduled-work'&&batch.scheduledWorkClassification))continue;
        try{cell.queued.add(batch,facts,jsonBytes(batch),true);}catch{this.park(cell,'Projection gap; Retry.');}continue;
      }
      const roomChanges=cell.request.family==='needs-you'?batch.facts.filter(fact=>fact.payload.kind==='needs-you-rooms-replace'&&fact.payload.scope===scope(cell.request)):[];
      if(roomChanges.length){
        const fact=roomChanges[0]!;
        try{
          if(roomChanges.length!==1||fact.payload.kind!=='needs-you-rooms-replace'||!this.authorized(fact.authority))throw new Error('Invalid Needs-you group');
          const value=foldNeedsYouRooms(cell.snapshot?.value,fact.payload);
          if(!this.valid(cell.request,value))throw new Error('Invalid Needs-you value');
          items.push({cell,snapshot:{kind:'snapshot',value,cut:batch.to,atomicGroup:fact.atomicGroup,authority:fact.authority}});
        }catch{this.park(cell,'Incomplete Needs-you coverage; Retry.');}continue;
      }
      const facts=batch.facts.filter(fact=>fact.payload.kind===REPLACE&&fact.payload.family===cell.request.family&&fact.payload.scope===scope(cell.request));
      const fact=facts.at(-1);
      if(!fact){
        if(scheduled&&batch.scheduledWorkClassification&&cell.request.family==='room-scheduled-work'&&cell.snapshot&&cell.covered&&
          cell.connection===generation&&(cell.view.state==='LIVE'||cell.view.state==='INACTIVE_CACHED')&&this.authorized(cell.snapshot.authority)&&
          !batch.facts.some(record=>record.atomicGroup===held.atomicGroup)&&batch.from.through<=progress.through&&batch.to.through>progress.through)cell.classified=batch.to;
        continue;
      }
      if(fact.payload.kind!==REPLACE||!this.authorized(fact.authority)||!this.valid(cell.request,fact.payload.value)){
        this.park(cell,'Invalid projection; Retry.');continue;
      }
      items.push({cell,snapshot:{kind:'snapshot',value:fact.payload.value,cut:batch.to,atomicGroup:fact.atomicGroup,authority:fact.authority}});
    }
    const changed=new Map<string,CellSnapshot<T>[]>();
    for(const item of items){const id=item.snapshot.atomicGroup,list=changed.get(id)??[];list.push(item);changed.set(id,list);}
    for(const[id,list]of changed)proposals.push(this.proposal(id,batch.to.stream,list));
    return{proposals,unavailable};
  }
  /** Both legacy openings and gaps use one lease. After an admitted reply its
   * opening tail replays that lease; ordinary source progress drains only gaps. */
  ready():LaneBatch[]{
    const ready=new Map<string,LaneBatch>();
    for(const cell of this.cells.values()){
      if(this.joint(cell)||cell.flight||cell.view.state==='PARKED')continue;
      const cut=cell.classified??cell.snapshot?.cut??cell.baseline?.cut;if(!cut)continue;
      for(const[id,{batch}]of cell.queued){
        if(batch.from.through>cut.through)continue;cell.queued.delete(id);
        if(batch.to.through<=cut.through)continue;
        const key=intervalId(batch),prior=ready.get(key);
        const facts=new Map([...(prior?.facts??[]),...batch.facts].map(fact=>[JSON.stringify(fact),fact]));
        ready.set(key,{...batch,facts:[...facts.values()],...(prior?.scheduledWorkClassification?{scheduledWorkClassification:prior.scheduledWorkClassification}:{})});
      }
    }
    return[...ready.values()];
  }
  salvage(cell:T,id:string):LaneBatch[]|undefined{
    const safe:LaneBatch[]=[];let bytes=0;
    for(const{batch}of cell.queued.values()){
      const facts=batch.facts.filter(fact=>fact.atomicGroup===id);
      if(!facts.length||facts.some(fact=>fact.payload.kind===REPLACE&&!this.authorized(fact.authority)))continue;
      const kept={...batch,facts};bytes+=jsonBytes(kept);if(safe.length>=16||bytes>256*1024)return;
      safe.push(kept);
    }
    return safe;
  }
  current(proposal:GroupProposal<T>):boolean{return (!proposal.group||this.groups.get(proposal.id)===proposal.group&&!proposal.group.failed)&&
    proposal.whole.every(({cell,snapshot},index)=>cell.revision===proposal.versions[index]&&this.authorized(snapshot.authority));}
  committed(proposal:GroupProposal<T>):boolean{
    if(!this.current(proposal))return false;
    for(const{cell,snapshot}of proposal.items){
      cell.snapshot=snapshot;cell.baseline=undefined;cell.classified=undefined;cell.covered=true;cell.incoming=undefined;cell.opening=undefined;
    }
    if(proposal.group&&proposal.cut){proposal.group.progress={...proposal.cut};proposal.group.clockVersion=proposal.clockVersion;this.trim(proposal.group);}
    return true;
  }
  private proposal(id:string,stream:string,items:readonly CellSnapshot<T>[],group?:Group,cut?:LaneCut,clockVersion?:string):GroupProposal<T>{
    const retained=new Map([...this.cells.values()].filter(cell=>cell.snapshot?.atomicGroup===id&&cell.snapshot.cut.stream===stream)
      .map(cell=>[cell.key,{cell,snapshot:cell.snapshot!}]));
    for(const item of items)retained.set(item.cell.key,item);
    const whole=[...retained.values()];return{id,group,items,whole,versions:whole.map(item=>item.cell.revision),cut,clockVersion};
  }
  private stageTray(state:Group,batch:LaneBatch):void{
    const facts=batch.facts.filter(fact=>fact.atomicGroup===state.id),markers=facts.filter(fact=>fact.payload.kind==='tray-classification'),marker=markers[0];
    if(markers.length!==1||marker?.payload.kind!=='tray-classification'||marker.payload.scope!==state.workspace||marker.payload.version!==1||
      !trayClock(marker.payload.clockVersion)||!trayCertificate(marker.authority,this.reader,state.workspace,this.authorized))throw new Error('Invalid Tray classification');
    if(!sameStream(batch.from,batch.to)||!Number.isSafeInteger(batch.from.through)||!Number.isSafeInteger(batch.to.through)||batch.from.protocol!==1||
      !batch.from.epoch||batch.from.epoch.length>128||batch.from.through<0||batch.to.through<batch.from.through||state.progress&&!sameStream(state.progress,batch.to))throw new Error('Tray stream changed');
    for(const fact of facts)if(!trayCertificate(fact.authority,this.reader,state.workspace,this.authorized)||fact.authority.digest!==marker.authority.digest||
      fact.payload.scope!==state.workspace)throw new Error('Invalid Tray group authority');
    if(typeof batch.contentDigest!=='string'||!/^[a-f0-9]{64}$/.test(batch.contentDigest))throw new Error('Unverified Tray interval');
    const prior=state.history.get(intervalId(batch));if(prior&&prior!==batch.contentDigest)throw new Error('Conflicting Tray interval');
    state.intervals.add(batch,facts);this.bound(state);
  }
  private prepare(state:Group):GroupProposal<T>|undefined{
    const cells=this.members(state),held=cells.filter(cell=>cell.snapshot).map(cell=>({cell,snapshot:cell.snapshot!})),
      pending=cells.filter(cell=>cell.incoming).map(cell=>({cell,snapshot:cell.incoming!}));
    const first=held[0]??pending[0];if(!first||state.failed)return;
    for(const item of held){checkTraySnapshot(item.cell,item.snapshot,this.reader,state.workspace,this.valid,this.authorized);
      if(!exactCut(item.snapshot.cut,first.snapshot.cut)||item.snapshot.clockVersion!==first.snapshot.clockVersion||
        item.snapshot.authority.digest!==first.snapshot.authority.digest)throw new Error('Mixed Tray group baseline');}
    let{members,cut,version,changed}=this.replay(state,held.length?held:[first],state.progress??first.snapshot.cut,state.clockVersion??first.snapshot.clockVersion!);
    changed ||=held.length===0;
    const merged=new Map(members.map(member=>[member.cell.key,member]));
    for(const incoming of pending){
      if(!sameStream(incoming.snapshot.cut,cut))throw new Error('Tray snapshot epoch changed');if(incoming.snapshot.cut.through>cut.through)continue;
      const replay=this.replay(state,[incoming],incoming.snapshot.cut,incoming.snapshot.clockVersion!,cut.through);
      if(replay.cut.through!==cut.through)continue;if(replay.version!==version)throw new Error('Tray snapshot clock changed');
      const item=replay.members[0]!,prior=merged.get(item.cell.key);
      if(prior&&exactCut(incoming.snapshot.cut,prior.snapshot.cut)){
        const before=item.cell.request.family==='needs-you-tray'?(prior.snapshot.value as {needs:unknown}).needs:prior.snapshot.value,
          after=item.cell.request.family==='needs-you-tray'?(incoming.snapshot.value as {needs:unknown}).needs:incoming.snapshot.value;
        if(item.cell.request.family!=='needs-you-saved-page'&&!equal(before,after))throw new Error('Conflicting Tray snapshot');
      }
      if(!prior||!equal(prior.snapshot,item.snapshot))changed=true;merged.set(item.cell.key,item);
    }
    if(!changed){state.progress={...cut};state.clockVersion=version;for(const cell of cells)if(cell.snapshot)cell.classified=cut;this.trim(state);return;}
    const current=[...merged.values()].map(item=>({...item,snapshot:{...item.snapshot,cut:{...cut},clockVersion:version}}));
    return this.proposal(state.id,`workspace:${state.workspace}`,current,state,cut,version);
  }
  private replay(state:Group,members:CellSnapshot<T>[],cut:LaneCut,version:string,ceiling=Infinity):
    {members:CellSnapshot<T>[];cut:LaneCut;version:string;changed:boolean}{
    let changed=false;
    while(true){
      const next=[...state.intervals.values()].find(({batch})=>sameStream(batch.from,cut)&&batch.from.through<=cut.through&&batch.to.through>cut.through&&batch.to.through<=ceiling);
      if(!next)return{members,cut,version,changed};
      const previous=members;members=foldTray(members,next.batch,version,state.workspace,this.valid);
      changed ||=members.some((member,index)=>!equal(member.snapshot.value,previous[index]!.snapshot.value));cut=next.batch.to;version=members[0]!.snapshot.clockVersion!;
    }
  }
  private bound(state:Group):void{
    const values=[...[...state.intervals.values()].map(value=>value.bytes),...this.members(state).flatMap(cell=>cell.incoming?[jsonBytes(cell.incoming)]:[])];
    if(!stagingWithinBudget(values,value=>value))throw new Error('Tray group staging overflow');
  }
  private trim(state:Group):void{
    const openings=this.members(state).flatMap(cell=>cell.opening?[cell.opening]:[]);if(openings.includes(true))return;
    const floor=openings.length?Math.min(...openings.map(value=>(value as LaneCut).through)):state.progress?.through;if(floor===undefined)return;
    for(const[id,value]of state.intervals)if(value.batch.to.through<=floor){remember(state.history,id,value.batch.contentDigest!);state.intervals.delete(id);}
  }
}
