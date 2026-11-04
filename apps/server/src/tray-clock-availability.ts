import type {SqlDatabase} from './database.js';
import type {LiveHub} from './live.js';
import {TRAY_CLOCK_OWNER_HEALTH_PREDICATE_SQL} from './tray-clock-health.js';

const STREAM='jobs:tray-clock-health';
type Position={epoch:string;through:number};
type State='new'|'opening'|'live'|'parked'|'closed';
export type TrayClockAvailabilityLoss='owner'|'listener'|'source';

/** One private consumer per application server, never per socket/Workspace.
 * Its callback only parks existing Tray consumers. Read admission remains
 * local demand plus the actual Workspace clock predicate at final enqueue. */
export class TrayClockAvailability {
  private state:State='new';
  private position?:Position;
  private healthy=false;
  private announced=false;
  private dirty=false;
  private version=0;
  private flight?:Promise<void>;
  private readonly releases:Array<()=>void>;

  constructor(private readonly database:SqlDatabase,private readonly live:LiveHub,
    private readonly options:{listenerReady:()=>boolean;unavailable:(reason:TrayClockAvailabilityLoss)=>void}) {
    this.releases=[
      live.subscribeJournal(streams=>{if((this.state==='live'||this.state==='opening')&&streams.includes(STREAM))this.wake();}),
      live.subscribeProjectionUnavailable(()=>this.park('listener')),
      live.subscribeResync(()=>{
        if(this.state==='closed'||this.state==='new'||!this.options.listenerReady())return;
        this.version++;this.position=undefined;this.state='opening';this.lose('listener');this.wake();
      }),
    ];
  }

  /** Initial server ownership acquisition only; later calls merely await work. */
  start():Promise<void> {
    if(this.state==='new'){this.state='opening';this.wake();}
    return this.flight??Promise.resolve();
  }
  ready():boolean{return this.state==='live'&&this.healthy;}
  async close():Promise<void>{
    this.state='closed';this.version++;this.dirty=false;this.healthy=false;
    for(const release of this.releases.splice(0))release();await this.flight;
  }
  private lose(reason:TrayClockAvailabilityLoss):void{
    this.healthy=false;
    if(!this.announced){
      this.announced=true;
      let delivered=this.live.trayClockUnavailable();
      try{this.options.unavailable(reason);}catch{delivered=false;}
      // Delivery failure grants no recovery or retry. All consumers were
      // attempted; only a subsequent real listener recovery can reopen us.
      if(!delivered)this.park('source');
    }
  }
  private park(reason:TrayClockAvailabilityLoss):void{
    if(this.state==='closed')return;
    this.state='parked';this.version++;this.dirty=false;this.position=undefined;this.lose(reason);
  }
  private wake():void{
    this.dirty=true;if(this.flight)return;
    const work=this.drain();this.flight=work;
    void work.finally(()=>{
      if(this.flight===work)this.flight=undefined;
      if(this.dirty&&(this.state==='opening'||this.state==='live'))this.wake();
    }).catch(()=>{});
  }
  private async drain():Promise<void>{
    // Only actual coalesced source/recovery events set dirty. A failure parks
    // and supplies neither another pass nor a deadline.
    while(this.dirty&&(this.state==='opening'||this.state==='live')){
      this.dirty=false;
      if(!this.options.listenerReady()){this.park('listener');return;}
      const version=this.version,previous=this.position;
      try{
        const result=await this.database.transaction(async db=>{
          await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
          const head=(await db.query<{epoch:string;sequence:string}>(
            'SELECT epoch,sequence::text FROM live_streams WHERE id=$1',[STREAM])).rows[0];
          const through=Number(head?.sequence);
          if(!head?.epoch||head.epoch.length>128||!Number.isSafeInteger(through)||through<0)throw new Error('Missing health source');
          const position={epoch:head.epoch,through};let invalidated=false;
          if(previous){
            if(previous.epoch!==position.epoch||through<previous.through||through-previous.through>1024)throw new Error('Health source gap');
            if(through===previous.through)return {position,unchanged:true as const};
            const rows=(await db.query<{sequence:string;event:Record<string,unknown>}>(
              'SELECT sequence::text,event FROM live_journal WHERE stream_id=$1 AND sequence>$2 AND sequence<=$3 ORDER BY sequence LIMIT 1024',
              [STREAM,previous.through,through])).rows;
            if(rows.length!==through-previous.through)throw new Error('Health source gap');
            for(let i=0;i<rows.length;i++){
              const row=rows[i]!,event=row.event;
              if(Number(row.sequence)!==previous.through+i+1||!event||Object.keys(event).length!==3||
                event.sourceTable!=='tray-clock-health'||event.version!==1||typeof event.invalidated!=='boolean')throw new Error('Unknown health source');
              invalidated ||= event.invalidated;
            }
          }
          const healthy=(await db.query<{healthy:boolean}>(`SELECT (${TRAY_CLOCK_OWNER_HEALTH_PREDICATE_SQL}) healthy`)).rows[0]?.healthy===true;
          return {position,unchanged:false as const,healthy,invalidated};
        });
        if(version!==this.version)continue;
        this.position=result.position;this.state='live';
        if(result.unchanged)continue;
        if(result.invalidated||!result.healthy)this.lose('owner');
        if(version!==this.version)continue;
        this.healthy=result.healthy;
        if(this.healthy)this.announced=false;
      }catch{if(version===this.version)this.park('source');}
    }
  }
}
