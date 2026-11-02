import type {RouterAuthorityCertificate,RouterCut,RouterSnapshot,RouterSnapshotInput} from '@beeline/api-contract/router-protocol';
import type {SqlDatabase} from './database.js';
import {readRouterAuthority,readRouterCut,resolveRouterInput,routerAtomicGroup,RouterProjectionUnavailable,type RouterValueBuilder} from './router-projections.js';
import {readTrayClockBasis} from './tray-clock-basis.js';

/** Immutable server configuration and committed clock-source version. A raw
 * Date.now()/transaction timestamp is not a declared durable clock basis. */
export type RouterBuilderBasis=Readonly<{schema:1;databaseScope:string;version:string;publicOrigin:string;clockVersion:string}>;
const TICKET=Symbol('router-build-ticket');
export type RouterBuildTicket=Readonly<{[TICKET]:true;input:RouterSnapshotInput;reader:string;
  cut:RouterCut;authority:RouterAuthorityCertificate;basis:RouterBuilderBasis;trayClockVersion?:string}>;
const transactions=new WeakMap<RouterBuildTicket,SqlDatabase>();

/** This read-only transaction stays alive until build(ticket, ...) resolves.
 * The coordinator invokes the builder with this exact handle, never a newer
 * connection and never a cache result relabeled at a later cut. */
export async function readRouterBuildTicket(db:SqlDatabase,input:RouterSnapshotInput,reader:string,basis:RouterBuilderBasis,
  options?:{readonly trayClock?:true}):Promise<RouterBuildTicket>{
  if(!reader||reader.length>128||basis.schema!==1||!basis.databaseScope||basis.databaseScope.length>128||!basis.version||basis.version.length>128||
    !basis.publicOrigin||basis.publicOrigin.length>2048||!basis.clockVersion||basis.clockVersion.length>256)
    throw new RouterProjectionUnavailable('dependency');
  const settings=(await db.query<{isolation:string;read_only:string}>(`SELECT current_setting('transaction_isolation') isolation,
    current_setting('transaction_read_only') read_only`)).rows[0];
  if(settings?.isolation!=='repeatable read'||settings.read_only!=='on')throw new RouterProjectionUnavailable('dependency');
  const resolved=await resolveRouterInput(db,input);
  const clock=options?.trayClock?await readTrayClockBasis(db,resolved.workspaceId):undefined;
  if(options?.trayClock&&(!input.family.startsWith('needs-you')||!clock?.ready))throw new RouterProjectionUnavailable('dependency');
  const authority=await readRouterAuthority(db,resolved,reader),cut=await readRouterCut(db,resolved.workspaceId);
  const ticket:RouterBuildTicket=Object.freeze({[TICKET]:true as const,
    input:Object.freeze({...resolved}) as RouterSnapshotInput,reader,
    authority:Object.freeze({digest:authority.digest,scopes:Object.freeze(authority.scopes.map(scope=>Object.freeze({...scope})))}),
    cut:Object.freeze({...cut}),basis:Object.freeze({...basis,...(clock?{clockVersion:clock.clockVersion}:{})}),
    ...(clock?{trayClockVersion:clock.clockVersion}:{})});
  transactions.set(ticket,db);return ticket;
}

type Settled={encoded:string;bytes:number;authority:RouterAuthorityCertificate};
type Flight={promise:Promise<string>;waiters:number;generation:number;authority:RouterAuthorityCertificate;cacheable:boolean};
export type RouterBuildCoordinatorLimits={readonly entries?:number;readonly bytes?:number;readonly flights?:number;readonly waiters?:number};

/** Shared per-process reader projections, never per-socket DTO state. Exact
 * immutable identities permit staggered sockets to reuse the same canonical
 * result. LRU limits and source changes, rather than time, control retention. */
export class RouterBuildCoordinator{
  private readonly settled=new Map<string,Settled>();
  private readonly flights=new Map<string,Flight>();
  private retainedBytes=0;
  private generation=0;
  private readonly limits:{entries:number;bytes:number;flights:number;waiters:number};
  private builds=0;private joins=0;private hits=0;private evictions=0;
  constructor(limits:RouterBuildCoordinatorLimits={}){
    this.limits={entries:limits.entries??64,bytes:limits.bytes??8*1024*1024,flights:limits.flights??16,waiters:limits.waiters??64};
    if(Object.values(this.limits).some(value=>!Number.isSafeInteger(value)||value<1))throw new Error('Invalid projection coordinator limits');
  }

  async build(ticket:RouterBuildTicket,builder:RouterValueBuilder):Promise<RouterSnapshot>{
    const db=transactions.get(ticket);if(!db)throw new RouterProjectionUnavailable('dependency');
    const key=JSON.stringify([ticket.reader,ticket.input.family,ticket.input.workspaceId,ticket.input.roomId??'',
      ticket.input.family==='needs-you-saved-page'?ticket.input.before??null:null,
      ticket.trayClockVersion??null,
      ticket.cut.stream,ticket.cut.epoch,ticket.cut.through,ticket.cut.protocol,ticket.authority.digest,
      ticket.authority.scopes.map(scope=>[scope.authorityScope,scope.epoch]),
      ticket.basis.schema,ticket.basis.databaseScope,ticket.basis.version,ticket.basis.publicOrigin,ticket.basis.clockVersion]);
    if(Buffer.byteLength(key)>8192)throw new RouterProjectionUnavailable('budget');
    const cached=this.settled.get(key);
    if(cached){
      this.hits++;this.settled.delete(key);this.settled.set(key,cached);
      return JSON.parse(cached.encoded) as RouterSnapshot;
    }
    let flight=this.flights.get(key);
    if(flight){
      if(flight.waiters>=this.limits.waiters)throw new RouterProjectionUnavailable('budget');
      this.joins++;flight.waiters++;
    }else{
      if(this.flights.size>=this.limits.flights)throw new RouterProjectionUnavailable('budget');
      const generation=this.generation;this.builds++;
      const promise=Promise.resolve().then(async()=>{
        const value=await builder(db,ticket.input,ticket.reader);
        if(value===null)throw new RouterProjectionUnavailable('authority');
        const snapshot={kind:'snapshot' as const,family:ticket.input.family,scope:ticket.input.roomId??ticket.input.workspaceId,
          value,cut:ticket.cut,authority:ticket.authority,atomicGroup:routerAtomicGroup(ticket.input,ticket.reader),
          ...(ticket.trayClockVersion?{clockVersion:ticket.trayClockVersion}:{})};
        const encoded=JSON.stringify(snapshot),wireBytes=Buffer.byteLength(encoded),bytes=wireBytes+Buffer.byteLength(key);
        const maximum=ticket.input.family==='needs-you-count'?1024:['room-head','room-scheduled-work','needs-you-tray','needs-you-saved-page'].includes(ticket.input.family)?64*1024:256*1024;
        if(wireBytes>maximum||bytes>this.limits.bytes)throw new RouterProjectionUnavailable('budget');
        if(generation===this.generation&&this.flights.get(key)?.cacheable)this.remember(key,{encoded,bytes,authority:ticket.authority});
        return encoded;
      });
      flight={promise,waiters:1,generation,authority:ticket.authority,cacheable:true};this.flights.set(key,flight);
      const owned=flight;
      void promise.finally(()=>{if(this.flights.get(key)===owned)this.flights.delete(key);}).catch(()=>{});
    }
    try{return JSON.parse(await flight.promise) as RouterSnapshot;}
    finally{flight.waiters--;}
  }

  /** Authorization/source owners may eagerly purge known obsolete results.
   * This operation creates no work or delivery and cancels no other reader. */
  invalidateAuthority(scope:string,minimumEpoch:string):void{
    if(!/^\d+$/.test(minimumEpoch))return;
    for(const [key,value]of this.settled){
      const authority=value.authority.scopes.find(item=>item.authorityScope===scope);
      if(authority&&BigInt(authority.epoch)<BigInt(minimumEpoch)){
        this.settled.delete(key);this.retainedBytes-=value.bytes;
      }
    }
    for(const flight of this.flights.values()){
      const authority=flight.authority.scopes.find(item=>item.authorityScope===scope);
      if(authority&&BigInt(authority.epoch)<BigInt(minimumEpoch))flight.cacheable=false;
    }
  }
  clear():void{this.generation++;this.settled.clear();this.retainedBytes=0;}
  stats(){return {builds:this.builds,joins:this.joins,hits:this.hits,evictions:this.evictions,
    entries:this.settled.size,bytes:this.retainedBytes,flights:this.flights.size};}
  private remember(key:string,value:Settled):void{
    while(this.settled.size>=this.limits.entries||this.retainedBytes+value.bytes>this.limits.bytes){
      const oldest=this.settled.entries().next().value;if(!oldest)break;
      this.settled.delete(oldest[0]);this.retainedBytes-=oldest[1].bytes;this.evictions++;
    }
    this.settled.set(key,value);this.retainedBytes+=value.bytes;
  }
}
