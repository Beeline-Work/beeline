import {createHash,randomUUID} from 'node:crypto';
import {
  ROUTER_MAX_PART_BYTES,
  type RouterAuthorityFence,type RouterFact,type RouterSnapshot,type RouterSnapshotInput,
  type RouterUnavailable,type ScheduledWorkAuthorityFrame,type ScheduledWorkAuthorityPosition,
} from '@beeline/api-contract/router-protocol';
import type {SqlDatabase} from './database.js';
import type {LiveHub} from './live.js';
import {ROUTER_AUTHORITY_LOCK} from './router-authority-lock.js';
import {currentAuthorityFence,readAuthorityChanges} from './router-authority-fences.js';
import {currentScheduledWorkFence} from './scheduled-work-authority.js';
import {fenceRouterBatchInTransaction,readRouterAuthority,RouterProjectionUnavailable} from './router-projections.js';

type Fence=RouterAuthorityFence&{readonly mode:'deny'|'advance'};
type Head={epoch:string;sequence:string};
type State='opening'|'live'|'lost'|'closed';

/** Content-free controls share complete multipart delivery with
 * data batches. The commit/digest covers every fence, including empty intervals. */
export function encodeScheduledWorkAuthority(from:ScheduledWorkAuthorityPosition,to:ScheduledWorkAuthorityPosition,
  fences:readonly Fence[]):ScheduledWorkAuthorityFrame[]{
  if(from.stream!==to.stream||from.epoch!==to.epoch||from.segment!==to.segment||to.through<from.through||
    !Number.isSafeInteger(from.through)||!Number.isSafeInteger(to.through)||from.through<0||
    new Set(fences.map(f=>f.authorityScope)).size!==fences.length)throw new RouterProjectionUnavailable('dependency');
  if(!from.stream.startsWith('authority:')||from.stream.length>256||!from.epoch||from.epoch.length>128||!from.segment||from.segment.length>128||
    fences.some(f=>f.kind!=='authority-fence'||!['deny','advance'].includes(f.mode)||!f.authorityScope.startsWith('scheduled-work-')||
      !f.scope||f.scope.length>256||f.authorityScope.length>256||f.authority.scopes.length!==1||
      f.authority.scopes[0]!.authorityScope!==f.authorityScope||!/^\d{1,30}$/.test(f.authority.scopes[0]!.epoch)||
      createHash('sha256').update(JSON.stringify(f.authority.scopes)).digest('hex')!==f.authority.digest))throw new RouterProjectionUnavailable('authority');
  const batchId=randomUUID(),contentDigest=createHash('sha256').update(JSON.stringify(fences)).digest('hex');
  const parts:Fence[][]=[[]];
  const size=(part:readonly Fence[])=>Buffer.byteLength(JSON.stringify({kind:'scheduled-work-authority-part',batchId,from,to,
    partIndex:fences.length,partCount:fences.length,contentDigest,fences:part}));
  for(const fence of fences){
    if(parts.at(-1)!.length&&size([...parts.at(-1)!,fence])>ROUTER_MAX_PART_BYTES)parts.push([]);
    parts.at(-1)!.push(fence);
  }
  const frames:ScheduledWorkAuthorityFrame[]=parts.map((part,index)=>({kind:'scheduled-work-authority-part',batchId,from,to,
    partIndex:index,partCount:parts.length,contentDigest,fences:part}));
  frames.push({kind:'scheduled-work-authority-commit',batchId,from,to,partCount:parts.length,contentDigest});
  return frames;
}

/** One connection's existing authority-source delivery position, never its held
 * data inventory. Control drains and final data/snapshot enqueues share this
 * actor and the same short READ COMMITTED authority transaction. No timers,
 * provider work, DTO building or response cache lives here. */
export class ScheduledWorkAuthorityDelivery{
  private state:State='opening';
  private position:ScheduledWorkAuthorityPosition|undefined;
  private initial:ScheduledWorkAuthorityPosition|undefined;
  private serial:Promise<void>=Promise.resolve();
  private dirty=false;private pumping=false;private recovering=false;private revision=0;
  private readonly releases:Array<()=>void>=[];
  private constructor(private readonly database:SqlDatabase,live:LiveHub,private readonly viewer:string,
    private readonly enqueue:(frame:RouterAuthorityFence|ScheduledWorkAuthorityFrame)=>undefined,
    private readonly unavailable:(reason:RouterUnavailable['reason'])=>void,private readonly ready:Promise<void>){
    this.releases.push(live.subscribeJournal(streams=>{if(streams.includes(`authority:${viewer}`)){this.dirty=true;this.pump();}}),
      live.subscribeProjectionUnavailable(()=>this.lose('listener')),
      live.subscribeResync(()=>{if(this.state==='lost')this.recover();else{this.dirty=true;this.pump();}}));
  }
  static async open(database:SqlDatabase,live:LiveHub,viewer:string,
    enqueue:(frame:RouterAuthorityFence|ScheduledWorkAuthorityFrame)=>undefined,
    unavailable:(reason:RouterUnavailable['reason'])=>void,ready:Promise<void>=Promise.resolve()):Promise<ScheduledWorkAuthorityDelivery>{
    const owner=new ScheduledWorkAuthorityDelivery(database,live,viewer,enqueue,unavailable,ready);
    try{
      const head=await owner.head(database);
      if(owner.state!=='opening')throw new RouterProjectionUnavailable('listener');
      owner.position=owner.makePosition(head,randomUUID());owner.initial=owner.position;owner.state='live';owner.pump();return owner;
    }catch(error){owner.close();throw error;}
  }
  get start():ScheduledWorkAuthorityPosition{if(!this.initial)throw new RouterProjectionUnavailable('listener');return this.initial;}
  get segment():string|undefined{return this.state==='live'?this.position?.segment:undefined;}
  close():void{this.state='closed';this.revision++;this.dirty=false;for(const release of this.releases.splice(0))release();}
  private async head(db:SqlDatabase):Promise<Head>{
    const row=(await db.query<Head>(`SELECT epoch,sequence::text FROM live_streams WHERE id=$1`,[`authority:${this.viewer}`])).rows[0];
    if(!row||!row.epoch||row.epoch.length>128||!Number.isSafeInteger(Number(row.sequence))||Number(row.sequence)<0)
      throw new RouterProjectionUnavailable('retention');
    return row;
  }
  private makePosition(head:Head,segment:string):ScheduledWorkAuthorityPosition{
    const position:ScheduledWorkAuthorityPosition={stream:`authority:${this.viewer}`,epoch:head.epoch,segment,through:Number(head.sequence),protocol:1};
    return Object.freeze(position);
  }
  private assertLive(revision:number):void{
    if(this.state!=='live'||revision!==this.revision)throw new RouterProjectionUnavailable('listener');
  }
  private lose(reason:RouterUnavailable['reason']):void{
    if(this.state==='closed'||this.state==='lost')return;
    this.state='lost';this.revision++;this.dirty=false;this.unavailable(reason);
  }
  private queue(work:()=>Promise<void>):Promise<void>{
    if(this.state==='closed')return Promise.reject(new RouterProjectionUnavailable('listener'));
    const next=this.serial.then(work);
    // A stale datum/snapshot is a group refusal, not evidence that the control
    // source was lost. Only the control phase below can retire this actor.
    this.serial=next.catch(()=>{});
    return next;
  }
  private pump():void{
    if(this.state!=='live'||!this.dirty||this.pumping)return;this.pumping=true;
    const run=this.queue(async()=>{
      await this.ready;
      while(this.dirty&&this.state==='live'){
        this.dirty=false;await this.fenced(async()=>{});
      }
    });
    void run.catch(()=>{}).finally(()=>{this.pumping=false;this.pump();});
  }
  private recover():void{
    if(this.recovering||this.state!=='lost')return;this.recovering=true;
    const run=this.queue(async()=>{
      await this.ready;if(this.state!=='lost')return;
      const revision=this.revision;
      await this.database.transaction(async db=>{
        await db.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[ROUTER_AUTHORITY_LOCK]);
        const head=await this.head(db);
        if(this.state!=='lost'||revision!==this.revision)return;
        const start=this.makePosition(head,randomUUID());
        this.enqueue({kind:'scheduled-work-authority-restart',start});
        // A restart is explicitly discontinuous. The client hides old-segment
        // data; only a later independent permitted snapshot establishes data.
        this.position=start;this.state='live';
      });
    });
    void run.catch(()=>{}).finally(()=>{this.recovering=false;this.pump();});
  }
  private async flush(db:SqlDatabase,revision:number):Promise<ScheduledWorkAuthorityPosition>{
    this.assertLive(revision);const from=this.position!;
    const head=await this.head(db),to=this.makePosition(head,from.segment);
    if(to.epoch!==from.epoch||to.through<from.through)throw new RouterProjectionUnavailable('retention');
    if(to.through===from.through){this.assertLive(revision);return from;}
    const rows=await readAuthorityChanges(db,this.viewer,to.epoch,from.through,to.through);
    const domains=new Map<string,string>();
    for(const {event}of rows){
      if(event.kind!=='authority-change'||typeof event.scope!=='string'||!event.scope||event.scope.length>256||
        typeof event.authorityScope!=='string'||event.authorityScope.length>256)throw new RouterProjectionUnavailable('dependency');
      if(domains.has(event.authorityScope)&&domains.get(event.authorityScope)!==event.scope)throw new RouterProjectionUnavailable('dependency');
      domains.set(event.authorityScope,event.scope);
    }
    const fences:Fence[]=[],other:RouterAuthorityFence[]=[];
    for(const [domain,scope]of domains){
      if(domain.startsWith('scheduled-work-')){
        const frame=await currentScheduledWorkFence(db,this.viewer,scope,domain);
        if(!frame||!frame.mode)throw new RouterProjectionUnavailable('dependency');
        // Allowed-after-regrant still retires every older certificate. Do not
        // use the older optional/deny-only resolver as a coverage witness.
        fences.push({...frame,mode:frame.mode});
      }else{
        if(![ `room:${scope}`,`object:${scope}`,`reader:${this.viewer}:workspace:${scope}`,
          `reader:${this.viewer}:workspace:${scope}:visibility` ].includes(domain))throw new RouterProjectionUnavailable('dependency');
        const frame=await currentAuthorityFence(db,this.viewer,scope,domain);if(frame)other.push(frame);
      }
    }
    const frames=encodeScheduledWorkAuthority(from,to,fences);
    this.assertLive(revision);
    for(const frame of other){this.assertLive(revision);this.enqueue(frame);}
    for(const frame of frames){this.assertLive(revision);this.enqueue(frame);}
    this.assertLive(revision);this.position=to;return to;
  }
  private async fenced(work:(db:SqlDatabase,barrier:ScheduledWorkAuthorityPosition)=>Promise<void>):Promise<void>{
    const revision=this.revision;this.assertLive(revision);
    let controls=true;
    try{await this.database.transaction(async db=>{
      await db.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[ROUTER_AUTHORITY_LOCK]);
      const barrier=await this.flush(db,revision);this.assertLive(revision);controls=false;
      await work(db,barrier);this.assertLive(revision);
    });}catch(error){
      if(controls)this.lose(error instanceof RouterProjectionUnavailable?error.reason:'projection');
      throw error;
    }
  }
  /** Fixed server-owned enqueue, not a generic network/read executor. */
  fenceBatch(workspace:string,facts:readonly RouterFact[],expectedSegment:string,
    enqueue:(safe:readonly RouterFact[],barrier:ScheduledWorkAuthorityPosition)=>undefined):Promise<void>{
    return this.queue(async()=>{
      await this.ready;
      if(!this.segment)throw new RouterProjectionUnavailable('listener');
      if(this.segment!==expectedSegment)throw new RouterProjectionUnavailable('dependency');
      await this.fenced(async(db,barrier)=>{
        // A classifier has no data or authority grant of its own. With zero
        // explicit groups, the complete control barrier is its only fence.
        if(!facts.length){enqueue([],barrier);return;}
        await fenceRouterBatchInTransaction(db,workspace,this.viewer,facts,safe=>enqueue(safe,barrier));
      });
    });
  }
  fenceSnapshot(input:RouterSnapshotInput,snapshot:RouterSnapshot<'room-scheduled-work'>,expectedSegment:string,
    enqueue:(safe:RouterSnapshot<'room-scheduled-work'>)=>undefined):Promise<void>{
    return this.queue(async()=>{
      await this.ready;
      if(this.segment!==expectedSegment)throw new RouterProjectionUnavailable('dependency');
      await this.fenced(async(db,barrier)=>{
        if((await readRouterAuthority(db,input,this.viewer)).digest!==snapshot.authority.digest)throw new RouterProjectionUnavailable('authority');
        const safe={...snapshot,authorityBarrier:barrier};
        enqueue(safe);
      });
    });
  }
}
