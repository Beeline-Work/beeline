import type {SqlDatabase} from './database.js';
import type {LiveHub} from './live.js';
import type {BackgroundLeaderHooks,LeaderConnection} from './background-leader.js';
import {BackgroundOwnership,type BackgroundEpoch} from './background-ownership.js';
import {TrayClockOwner,type TrayClockDrain,type TrayDeadline} from './tray-clock-owner.js';
import {TrayChoiceClockOwner,type TrayChoiceDrain} from './tray-choice-clock-owner.js';
import {readTrayClockWake} from './tray-clock-source.js';

/** Migration only, after durable/source schemas. No read path initializes a
 * stream or invents a source cause, revision, lease or deadline. */
export const TRAY_CLOCK_WORK_SCHEMA=`INSERT INTO live_streams(id) VALUES('jobs:tray-clock') ON CONFLICT DO NOTHING;`;
type Database=SqlDatabase&{onRecovery?(listener:()=>void):()=>void};
type Position={epoch:string;through:number};
type Deadline=TrayDeadline|NonNullable<TrayChoiceDrain['next']>;
type Domain={pending:boolean;next?:{claim:Deadline;at:number}};
type State='inactive'|'opening'|'live'|'parked'|'closed';
export type TrayClockWorkLoss='listener'|'owner'|'retention'|'source'|'work';
class SourceLost extends Error{
  constructor(readonly reason:'retention'|'source'){super(`Tray clock ${reason} unavailable`);}
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
  private readonly releases:Array<()=>void>=[];
  private readonly now:()=>number;
  private state:State='inactive';private version=0;
  private connection?:LeaderConnection;private connectionSignal?:AbortSignal;private stopConnection?:()=>void;
  private epoch?:BackgroundEpoch;private stopEpoch?:()=>void;
  private position?:Position;private sourceDirty=false;private recoveryPending=false;
  private displayJob:Domain={pending:false};private choiceJob:Domain={pending:false};
  private flight?:Promise<number>;

  constructor(private readonly database:Database,live:LiveHub,private readonly ownership:BackgroundOwnership,
    private readonly options:TrayClockWorkOptions){
    this.now=options.now??(()=>performance.now());
    this.display=new TrayClockOwner(ownership);this.choice=new TrayChoiceClockOwner(ownership);
    this.leadership={acquired:async(connection,signal)=>{
      this.retireConnection();this.connection=connection;this.connectionSignal=signal;
      const lost=()=>{if(this.connection===connection)this.retireConnection();};
      signal.addEventListener('abort',lost,{once:true});this.stopConnection=()=>signal.removeEventListener('abort',lost);
      if(signal.aborted){this.retireConnection();return;}
      await this.acquire();
    },lost:connection=>{if(this.connection===connection)this.retireConnection();}};
    this.releases.push(live.subscribeJournal(streams=>{
      if(this.state!=='live'||!streams.includes('jobs:tray-clock'))return;
      this.sourceDirty=true;this.options.wake();
    }),live.subscribeProjectionUnavailable(()=>this.park('listener')),live.subscribeResync(()=>this.recover()));
    const releaseRecovery=database.onRecovery?.(()=>this.recover());if(releaseRecovery)this.releases.push(releaseRecovery);
  }

  /** Existing aggregate evidence extends only the current opaque epoch. In
   * particular, a routine renewal never claims or retries a parked owner. */
  observeServerLease(instance:string,renewedAt:number,removed=false):void{
    this.ownership.observeServerLease(instance,renewedAt,removed);
  }
  status():Readonly<{state:State;generation?:string;source?:Position;display?:Deadline;choice?:Deadline}>{
    return {state:this.state,...(this.epoch?{generation:this.epoch.generation}:{}),
      ...(this.position?{source:{...this.position}}:{}),...(this.displayJob.next?{display:this.displayJob.next.claim}:{}),
      ...(this.choiceJob.next?{choice:this.choiceJob.next.claim}:{})};
  }
  close():void{
    if(this.state==='closed')return;this.retireConnection();this.state='closed';this.version++;
    for(const release of this.releases.splice(0))release();
  }
  private dropEpoch():void{
    this.stopEpoch?.();this.stopEpoch=undefined;
    const epoch=this.epoch;this.epoch=undefined;if(epoch)this.ownership.revoke(epoch);
  }
  private retireConnection():void{
    this.stopConnection?.();this.stopConnection=undefined;this.connection=undefined;this.connectionSignal=undefined;
    if(this.state==='closed')return;this.park('owner');
  }
  private park(reason:TrayClockWorkLoss,wake=true):void{
    if(this.state==='closed')return;
    const already=this.state==='parked'||this.state==='inactive';
    this.state='parked';this.version++;this.recoveryPending=false;this.sourceDirty=false;this.position=undefined;
    this.displayJob={pending:false};this.choiceJob={pending:false};this.dropEpoch();
    if(!already)this.options.unavailable(reason);
    // Cancel an already armed leader deadline without admitting any DB read.
    if(!already&&wake)this.options.wake();
  }
  private recover():void{
    if(this.state==='closed'||!this.connection||this.connectionSignal?.aborted||!this.options.listenerReady())return;
    if(this.state==='live')this.sourceDirty=true;
    else if(this.state==='parked')this.recoveryPending=true;
    else return;
    this.options.wake();
  }
  private current(version:number,epoch?:BackgroundEpoch):boolean{
    return this.state!=='closed'&&version===this.version&&Boolean(this.connection)&&!this.connectionSignal?.aborted&&
      (!epoch||this.epoch===epoch&&!epoch.signal.aborted);
  }
  private async head(db:SqlDatabase):Promise<Position>{
    const row=(await db.query<{epoch:string;sequence:string}>(`SELECT epoch,sequence::text FROM live_streams WHERE id='jobs:tray-clock'`)).rows[0];
    const through=Number(row?.sequence);
    if(!row?.epoch||row.epoch.length>128||!Number.isSafeInteger(through)||through<0)throw new Error('Tray clock source unavailable');
    return {epoch:row.epoch,through};
  }
  private async acquire():Promise<void>{
    if(!this.connection||this.connectionSignal?.aborted||this.state==='closed')return;
    this.dropEpoch();const version=++this.version;this.state='opening';this.recoveryPending=false;
    this.displayJob={pending:false};this.choiceJob={pending:false};
    if(!this.options.listenerReady()){this.park('listener',false);return;}
    let epoch:BackgroundEpoch|undefined;
    try{
      epoch=await this.ownership.claim(this.connection);
      if(!this.current(version)){this.ownership.revoke(epoch);return;}
      this.epoch=epoch;const lost=()=>{if(this.epoch===epoch)this.park('owner');};
      epoch.signal.addEventListener('abort',lost,{once:true});this.stopEpoch=()=>epoch!.signal.removeEventListener('abort',lost);
      const head=await this.head(this.database);
      if(!this.current(version,epoch))return;
      this.position=head;this.displayJob.pending=true;this.choiceJob.pending=true;this.state='live';
    }catch{
      if(this.current(version))this.park('source',false);
      else if(epoch)this.ownership.revoke(epoch);
    }
  }
  private async source():Promise<void>{
    const position=this.position!,version=this.version;
    const result=await this.database.transaction(async db=>{
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');const to=await this.head(db);
      if(to.epoch!==position.epoch||to.through<position.through||to.through-position.through>1024)throw new SourceLost('retention');
      const rows=(await db.query<{sequence:string;event:Record<string,unknown>}>(`SELECT sequence::text,event FROM live_journal
        WHERE stream_id='jobs:tray-clock' AND sequence>$1 AND sequence<=$2 ORDER BY live_journal.sequence`,[position.through,to.through])).rows;
      if(rows.length!==to.through-position.through||rows.some((row,index)=>Number(row.sequence)!==position.through+index+1)||
        Buffer.byteLength(JSON.stringify(rows))>4*1024*1024)throw new SourceLost('retention');
      const causes=rows.map(({event})=>readTrayClockWake(event));if(causes.some(cause=>!cause))throw new SourceLost('source');
      return {to,display:causes.some(cause=>cause?.sourceKind!=='choice'),choice:causes.some(cause=>cause?.sourceKind==='choice')};
    });
    if(!this.current(version,this.epoch))return;
    this.position=result.to;if(result.display)this.displayJob.pending=true;if(result.choice)this.choiceJob.pending=true;
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
    const next=this.cycle();this.flight=next;void next.finally(()=>{if(this.flight===next)this.flight=undefined;}).catch(()=>{});return next;
  }
  private async cycle():Promise<number>{
    if(this.recoveryPending)await this.acquire();
    if(this.state!=='live'||!this.epoch)return Infinity;
    if(!this.options.listenerReady()){this.park('listener',false);return Infinity;}
    const version=this.version,epoch=this.epoch;
    try{
      if(this.sourceDirty){this.sourceDirty=false;await this.source();}
      if(!this.current(version,epoch))return Infinity;
      for(const [job,adapter]of [[this.displayJob,this.display],[this.choiceJob,this.choice]] as const){
        if(!job.pending&&(!job.next||job.next.at>this.now()))continue;
        job.pending=false;job.next=undefined;const result=await adapter.drain(epoch);
        if(!this.current(version,epoch))return Infinity;this.adopt(job,result);
      }
      if(this.sourceDirty)return 0;
      return Math.max(0,Math.min(this.displayJob.next?.at??Infinity,this.choiceJob.next?.at??Infinity)-this.now());
    }catch(error){
      // A failed pass supplies neither a deadline nor a synthetic wake. Only
      // an independently observed loss/recovery can admit a later execution.
      if(this.current(version,epoch))this.park(error instanceof SourceLost?error.reason:'work',false);return Infinity;
    }
  }
}
