import type {SqlDatabase} from './database.js';
import type {LiveHub} from './live.js';
import type {BackgroundLeaderHooks,LeaderConnection} from './background-leader.js';
import {BackgroundOwnership,type BackgroundEpoch} from './background-ownership.js';
import {TrayClockOwner,type TrayClockDrain,type TrayDeadline} from './tray-clock-owner.js';
import {TrayChoiceClockOwner,type TrayChoiceDrain} from './tray-choice-clock-owner.js';
import {readTrayClockWake} from './tray-clock-source.js';
import {TrayClockHealth} from './tray-clock-health.js';
import {TrayClockReadinessOwner} from './tray-clock-readiness-owner.js';

/** Migration only, after durable/source schemas. No read path initializes a
 * stream or invents a source cause, revision, lease or deadline. */
export const TRAY_CLOCK_WORK_SCHEMA=`INSERT INTO live_streams(id) VALUES('jobs:tray-clock'),('jobs:tray-clock-readiness') ON CONFLICT DO NOTHING;`;
type Database=SqlDatabase&{onRecovery?(listener:()=>void):()=>void};
type Position={epoch:string;through:number};
type SourceStream='jobs:tray-clock'|'jobs:tray-clock-readiness';
type Deadline=TrayDeadline|NonNullable<TrayChoiceDrain['next']>;
type Domain={pending:boolean;next?:{claim:Deadline;at:number}};
type State='inactive'|'opening'|'live'|'parked'|'closed';
export type TrayClockWorkLoss='listener'|'owner'|'retention'|'source'|'work';
class SourceLost extends Error{
  constructor(readonly reason:'retention'|'source'){super(`Tray clock ${reason} unavailable`);}
}
/** Private closed lifecycle cause; it carries no projection/authority grant. */
function readinessWake(value:Record<string,unknown>):boolean|undefined{
  if(value.sourceTable!=='tray-clock-readiness-work'||value.version!==1||Object.keys(value).length!==5||
    typeof value.workspaceId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.workspaceId)||
    typeof value.generation!=='string'||!/^[a-f0-9]{32}$/.test(value.generation)||
    !['sources','messages','seen','choices','publish','done'].includes(String(value.phase)))return;
  return value.phase!=='done';
}
export type TrayClockWorkOptions={
  /** Existing committed LISTEN health, never a new readiness setting. */
  listenerReady:()=>boolean;
  wake:()=>void;
  unavailable:(reason:TrayClockWorkLoss)=>void;
  now?:()=>number;
};

/** Unselected private composition. This owns no connection, lock, renewal,
 * provider or timer: the existing BackgroundLeader supplies its real lock
 * backend and arms only this runner's returned actual minimum delay. */
export class TrayClockWork{
  readonly leadership:BackgroundLeaderHooks;
  private readonly display:TrayClockOwner;
  private readonly choice:TrayChoiceClockOwner;
  private readonly readiness:TrayClockReadinessOwner;
  private readonly health:TrayClockHealth;private healthPublished=false;
  private readonly releases:Array<()=>void>=[];
  private readonly now:()=>number;
  private state:State='inactive';private version=0;
  private connection?:LeaderConnection;private connectionSignal?:AbortSignal;private stopConnection?:()=>void;
  private epoch?:BackgroundEpoch;private stopEpoch?:()=>void;
  private position?:Position;private readinessPosition?:Position;
  private sourceDirty=false;private readinessDirty=false;private readinessPending=false;private recoveryPending=false;
  private displayJob:Domain={pending:false};private choiceJob:Domain={pending:false};
  private flight?:Promise<number>;
  private retirement:Promise<void>=Promise.resolve();
  private retirementFailed=false;

  constructor(private readonly database:Database,live:LiveHub,private readonly ownership:BackgroundOwnership,
    private readonly options:TrayClockWorkOptions){
    this.now=options.now??(()=>performance.now());
    this.display=new TrayClockOwner(ownership);this.choice=new TrayChoiceClockOwner(ownership);
    this.readiness=new TrayClockReadinessOwner(ownership);this.health=new TrayClockHealth(ownership);
    this.leadership={acquired:async(connection,signal)=>{
      this.retireConnection();this.connection=connection;this.connectionSignal=signal;
      const lost=()=>{if(this.connection===connection)this.retireConnection();};
      signal.addEventListener('abort',lost,{once:true});this.stopConnection=()=>signal.removeEventListener('abort',lost);
      if(signal.aborted){this.retireConnection();return;}
      await this.acquire();
    },lost:connection=>{if(this.connection===connection)this.retireConnection();}};
    this.releases.push(live.subscribeJournal(streams=>{
      if(this.state!=='live'&&this.state!=='opening')return;
      let changed=false;
      if(streams.includes('jobs:tray-clock')){this.sourceDirty=true;changed=true;}
      if(streams.includes('jobs:tray-clock-readiness')){this.readinessDirty=true;changed=true;}
      // Preserve a bounded dirty bit during acquisition. A source commit
      // between head SELECT and local adoption cannot fall through a gap.
      if(changed&&this.state==='live')this.options.wake();
    }),live.subscribeProjectionUnavailable(()=>this.park('listener')),live.subscribeResync(()=>this.recover()));
    const releaseRecovery=database.onRecovery?.(()=>this.recover());if(releaseRecovery)this.releases.push(releaseRecovery);
  }

  /** Existing aggregate evidence extends only the current opaque epoch. In
   * particular, a routine renewal never claims or retries a parked owner. */
  observeServerLease(instance:string,renewedAt:number,removed=false):void{
    this.ownership.observeServerLease(instance,renewedAt,removed);
  }
  status():Readonly<{state:State;retirementFailed?:true;generation?:string;source?:Position;readinessSource?:Position;display?:Deadline;choice?:Deadline}>{
    return {state:this.state,...(this.retirementFailed?{retirementFailed:true as const}:{}),...(this.epoch?{generation:this.epoch.generation}:{}),
      ...(this.position?{source:{...this.position}}:{}),...(this.readinessPosition?{readinessSource:{...this.readinessPosition}}:{}),
      ...(this.displayJob.next?{display:this.displayJob.next.claim}:{}),
      ...(this.choiceJob.next?{choice:this.choiceJob.next.claim}:{})};
  }
  async close():Promise<void>{
    if(this.state!=='closed'){
      this.retireConnection();this.state='closed';this.version++;
      for(const release of this.releases.splice(0))release();
    }
    await this.flight;await this.retirement;
  }
  private dropEpoch():void{
    this.stopEpoch?.();this.stopEpoch=undefined;
    const epoch=this.epoch;this.epoch=undefined;
    if(epoch){
      // release revokes synchronously before its one causal durable write.
      // A different server must not mistake a parked local epoch for health.
      this.retirement=this.ownership.release(epoch).catch(()=>{this.retirementFailed=true;});
    }
  }
  private retireConnection():void{
    this.stopConnection?.();this.stopConnection=undefined;this.connection=undefined;this.connectionSignal=undefined;
    if(this.state==='closed')return;this.park('owner');
  }
  private park(reason:TrayClockWorkLoss,wake=true):void{
    if(this.state==='closed')return;
    const already=this.state==='parked'||this.state==='inactive';
    this.state='parked';this.version++;this.recoveryPending=false;this.sourceDirty=false;this.position=undefined;
    this.readinessDirty=false;this.readinessPending=false;this.readinessPosition=undefined;this.readiness.clear();this.healthPublished=false;
    this.displayJob={pending:false};this.choiceJob={pending:false};this.dropEpoch();
    if(!already)this.options.unavailable(reason);
    // Cancel an already armed leader deadline without admitting any DB read.
    if(!already&&wake)this.options.wake();
  }
  private recover():void{
    if(this.state==='closed'||!this.connection||this.connectionSignal?.aborted||!this.options.listenerReady())return;
    if(this.state==='live'){this.sourceDirty=true;this.readinessDirty=true;}
    else if(this.state==='parked')this.recoveryPending=true;
    else return;
    this.options.wake();
  }
  private current(version:number,epoch?:BackgroundEpoch):boolean{
    return this.state!=='closed'&&version===this.version&&Boolean(this.connection)&&!this.connectionSignal?.aborted&&
      (!epoch||this.epoch===epoch&&!epoch.signal.aborted);
  }
  private async head(db:SqlDatabase,stream:SourceStream):Promise<Position>{
    const row=(await db.query<{epoch:string;sequence:string}>(`SELECT epoch,sequence::text FROM live_streams WHERE id=$1`,[stream])).rows[0];
    const through=Number(row?.sequence);
    if(!row?.epoch||row.epoch.length>128||!Number.isSafeInteger(through)||through<0)throw new Error('Tray clock source unavailable');
    return {epoch:row.epoch,through};
  }
  private async acquire():Promise<void>{
    if(!this.connection||this.connectionSignal?.aborted||this.state==='closed')return;
    this.dropEpoch();const version=++this.version;this.state='opening';this.recoveryPending=false;
    await this.retirement;
    if(!this.current(version))return;
    // Only this real acquisition/recovery can replace a failed retirement;
    // routine lease evidence and journal hints never retry the write.
    this.retirementFailed=false;
    this.sourceDirty=false;this.readinessDirty=false;this.readinessPending=false;this.readiness.clear();this.healthPublished=false;
    this.displayJob={pending:false};this.choiceJob={pending:false};
    if(!this.options.listenerReady()){this.park('listener',false);return;}
    let epoch:BackgroundEpoch|undefined;
    try{
      epoch=await this.ownership.claim(this.connection);
      if(!this.current(version)){this.ownership.revoke(epoch);return;}
      this.epoch=epoch;const lost=()=>{if(this.epoch===epoch)this.park('owner');};
      epoch.signal.addEventListener('abort',lost,{once:true});this.stopEpoch=()=>epoch!.signal.removeEventListener('abort',lost);
      const head=await this.head(this.database,'jobs:tray-clock');
      if(!this.current(version,epoch))return;
      const readinessHead=await this.head(this.database,'jobs:tray-clock-readiness');
      if(!this.current(version,epoch))return;
      this.position=head;this.readinessPosition=readinessHead;this.readinessPending=true;
      this.displayJob.pending=true;this.choiceJob.pending=true;this.state='live';
    }catch{
      if(this.current(version))this.park('source',false);
      else if(epoch)this.ownership.revoke(epoch);
    }
  }
  private async source(stream:SourceStream):Promise<void>{
    const position=(stream==='jobs:tray-clock'?this.position:this.readinessPosition)!,version=this.version;
    const result=await this.database.transaction(async db=>{
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');const to=await this.head(db,stream);
      if(to.epoch!==position.epoch||to.through<position.through||to.through-position.through>1024)throw new SourceLost('retention');
      const rows=(await db.query<{sequence:string;event:Record<string,unknown>}>(`SELECT sequence::text,event FROM live_journal
        WHERE stream_id=$1 AND sequence>$2 AND sequence<=$3 ORDER BY live_journal.sequence`,[stream,position.through,to.through])).rows;
      if(rows.length!==to.through-position.through||rows.some((row,index)=>Number(row.sequence)!==position.through+index+1)||
        Buffer.byteLength(JSON.stringify(rows))>4*1024*1024)throw new SourceLost('retention');
      if(stream==='jobs:tray-clock-readiness'){
        const causes=rows.map(({event})=>readinessWake(event));if(causes.some(cause=>cause===undefined))throw new SourceLost('source');
        return {to,display:false,choice:false,readiness:causes.some(Boolean)};
      }
      const causes=rows.map(({event})=>readTrayClockWake(event));if(causes.some(cause=>!cause))throw new SourceLost('source');
      return {to,display:causes.some(cause=>cause?.sourceKind!=='choice'),choice:causes.some(cause=>cause?.sourceKind==='choice'),readiness:false};
    });
    if(!this.current(version,this.epoch))return;
    if(stream==='jobs:tray-clock')this.position=result.to;else this.readinessPosition=result.to;
    if(result.display)this.displayJob.pending=true;if(result.choice)this.choiceJob.pending=true;
    if(result.readiness)this.readinessPending=true;
  }
  private adopt(job:Domain,result:TrayClockDrain|TrayChoiceDrain):void{
    const next=result.next;
    if(!next){if(result.continuation)throw new Error('Invalid Tray clock continuation');job.next=undefined;return;}
    if(!Number.isFinite(next.remainingMs)||result.continuation!==(next.remainingMs<=0))throw new Error('Invalid Tray clock deadline');
    // remainingMs comes only from the adapter's exact DB minimum/version.
    // Returning after COMMIT can make this conservative/later, never earlier.
    job.next={claim:next,at:this.now()+Math.max(0,next.remainingMs)};
  }
  run():Promise<number>{
    if(this.flight)return this.flight;
    const next=this.cycle().then(async delay=>{await this.retirement;return delay;});this.flight=next;void next.finally(()=>{if(this.flight===next)this.flight=undefined;}).catch(()=>{});return next;
  }
  private async cycle():Promise<number>{
    if(this.recoveryPending)await this.acquire();
    if(this.state!=='live'||!this.epoch)return Infinity;
    if(!this.options.listenerReady()){this.park('listener',false);return Infinity;}
    const version=this.version,epoch=this.epoch;
    try{
      if(this.sourceDirty){this.sourceDirty=false;await this.source('jobs:tray-clock');}
      if(!this.current(version,epoch))return Infinity;
      if(this.readinessDirty){this.readinessDirty=false;await this.source('jobs:tray-clock-readiness');}
      if(!this.current(version,epoch))return Infinity;
      if(this.readinessPending){
        this.readinessPending=false;const result=await this.readiness.run(epoch);
        if(!this.current(version,epoch))return Infinity;this.readinessPending=result.continuation;
      }
      for(const [job,adapter]of [[this.displayJob,this.display],[this.choiceJob,this.choice]] as const){
        if(!job.pending&&(!job.next||job.next.at>this.now()))continue;
        job.pending=false;job.next=undefined;const result=await adapter.drain(epoch);
        if(!this.current(version,epoch))return Infinity;this.adopt(job,result);
      }
      if(this.sourceDirty||this.readinessDirty||this.readinessPending)return 0;
      if(!this.healthPublished&&[this.displayJob,this.choiceJob].every(job=>!job.pending&&(!job.next||job.next.claim.remainingMs>0))){
        await this.health.publish(epoch);
        if(!this.current(version,epoch))return Infinity;this.healthPublished=true;
      }
      return Math.max(0,Math.min(this.displayJob.next?.at??Infinity,this.choiceJob.next?.at??Infinity)-this.now());
    }catch(error){
      // A failed pass supplies neither a deadline nor a synthetic wake. Only
      // an independently observed loss/recovery can admit a later execution.
      if(this.current(version,epoch))this.park(error instanceof SourceLost?error.reason:'work',false);return Infinity;
    }
  }
}
