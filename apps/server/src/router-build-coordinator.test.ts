import type {QueryResultRow} from 'pg';
import {describe,expect,it} from 'vitest';
import type {RouterSnapshotInput} from '@beeline/api-contract/router-protocol';
import type {QueryResult,SqlDatabase} from './database.js';
import {readRouterBuildTicket,RouterBuildCoordinator,type RouterBuilderBasis} from './router-build-coordinator.js';
import type {RouterValueBuilder} from './router-projections.js';
const input={family:'needs-you-count' as const,workspaceId:'11111111-1111-4111-8111-111111111111'};
const basis:RouterBuilderBasis={schema:1,databaseScope:'primary-fixture',version:'phone-dto-v1',publicOrigin:'https://example.test',clockVersion:'committed-clock-1'};
class ReadSnapshot implements SqlDatabase{
  constructor(readonly through=1,readonly authorityEpoch='1',readonly epoch='stream-1',readonly isolation='repeatable read'){}
  async query<Row extends QueryResultRow=QueryResultRow>(sql:string,args:unknown[]=[]):Promise<QueryResult<Row>>{
    let rows:Record<string,unknown>[];
    if(sql.includes('current_setting'))rows=[{isolation:this.isolation,read_only:'on'}];
    else if(sql.includes('FROM router_authority'))rows=(args[0] as string[]).map(scope=>({scope,epoch:this.authorityEpoch}));
    else if(sql.includes('FROM live_streams'))rows=[{sequence:String(this.through),epoch:this.epoch}];
    else if(sql.includes('SELECT parent_id'))rows=[{parent_id:null}];
    else if(sql.includes('SELECT workspace_id FROM rooms'))rows=[{workspace_id:input.workspaceId}];
    else if(sql.includes('FROM memberships'))rows=[{allowed:1}];
    else throw new Error(`Unexpected fixture query: ${sql}`);
    return {rows:rows as Row[],rowCount:rows.length};
  }
  transaction<T>(work:(db:SqlDatabase)=>Promise<T>):Promise<T>{return work(this);}
}
const ticket=(db:SqlDatabase=new ReadSnapshot(),request:RouterSnapshotInput=input,reader='reader',version:RouterBuilderBasis=basis)=>
  readRouterBuildTicket(db,request,reader,version);
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}

describe('shared DB-derived canonical projection builds',()=>{
  it('keeps distinct ordinary Saved cursors in the cache key while sharing equal windows',async()=>{
    const coordinator=new RouterBuildCoordinator(),seen:Array<string|undefined>=[];
    const build:RouterValueBuilder=async(_db,args)=>{
      if(args.family!=='needs-you-saved-page')throw new Error('wrong fixture family');
      seen.push(args.before);return{windowId:args.before??'head',rows:[]};
    };
    const request=(before?:string):RouterSnapshotInput=>({family:'needs-you-saved-page',workspaceId:input.workspaceId,...(before?{before}:{})});
    const head=await coordinator.build(await ticket(new ReadSnapshot(),request()),build);
    const first=await coordinator.build(await ticket(new ReadSnapshot(),request('saved1.first')),build);
    const second=await coordinator.build(await ticket(new ReadSnapshot(),request('saved1.second')),build);
    expect([head.value,first.value,second.value]).toEqual([{windowId:'head',rows:[]},{windowId:'saved1.first',rows:[]},{windowId:'saved1.second',rows:[]}]);
    expect((await coordinator.build(await ticket(new ReadSnapshot(),request('saved1.first')),build)).value).toEqual(first.value);
    expect(seen).toEqual([undefined,'saved1.first','saved1.second']);
  });
  it('joins concurrent sockets, reuses a settled result for a slower socket, and gives consumers independent immutable wire copies',async()=>{
    const coordinator=new RouterBuildCoordinator(),blocked=deferred<{count:number}>();let builds=0,started!:()=>void;
    const began=new Promise<void>(done=>{started=done;}),firstDb=new ReadSnapshot();
    const firstTicket=await ticket(firstDb),secondTicket=await ticket(new ReadSnapshot());
    const build:RouterValueBuilder=async(db)=>{expect(db).toBe(firstDb);builds++;started();return blocked.promise;};
    const first=coordinator.build(firstTicket,build);await began;
    const second=coordinator.build(secondTicket,async()=>{throw new Error('Duplicate base build');});
    blocked.resolve({count:7});const [a,b]=await Promise.all([first,second]);
    expect(a).toEqual(b);(a.value as {count:number}).count=99;expect(b.value).toEqual({count:7});
    const slow=await coordinator.build(await ticket(),async()=>{throw new Error('Staggered duplicate base build');});
    expect(slow.value).toEqual({count:7});expect(builds).toBe(1);
    expect(coordinator.stats()).toMatchObject({builds:1,joins:1,hits:1,entries:1,flights:0});
  });
  it.each(['cut','stream epoch','authority','reader','scope','family','builder','origin','clock','database'] as const)
    ('never shares across a different %s basis',async(change)=>{
      const coordinator=new RouterBuildCoordinator();let builds=0;
      const build:RouterValueBuilder=async(_db,args)=>{builds++;return args.family==='needs-you'?{count:builds,items:[]}:{count:builds};};
      await coordinator.build(await ticket(),build);
      const db=new ReadSnapshot(change==='cut'?2:1,change==='authority'?'2':'1',change==='stream epoch'?'stream-2':'stream-1');
      const request=change==='scope'?{...input,workspaceId:'22222222-2222-4222-8222-222222222222'}:
        change==='family'?{...input,family:'needs-you' as const}:input;
      const variant={...basis,...(change==='builder'?{version:'phone-dto-v2'}:{}),...(change==='origin'?{publicOrigin:'https://other.test'}:{}),
        ...(change==='clock'?{clockVersion:'committed-clock-2'}:{}),...(change==='database'?{databaseScope:'different-source'}:{})};
      const result=await coordinator.build(await ticket(db,request,change==='reader'?'other-reader':'reader',variant),build);
      expect(builds).toBe(2);expect(result.value).toMatchObject({count:2});
    });
  it('bounds settled identities and bytes with LRU reuse and never retries failed builders',async()=>{
    const coordinator=new RouterBuildCoordinator({entries:2,bytes:4096});let builds=0;
    const build:RouterValueBuilder=async()=>({count:++builds});
    const a=await ticket(new ReadSnapshot(1)),b=await ticket(new ReadSnapshot(2)),c=await ticket(new ReadSnapshot(3));
    await coordinator.build(a,build);await coordinator.build(b,build);await coordinator.build(a,build);await coordinator.build(c,build);
    expect(builds).toBe(3);await coordinator.build(b,build);expect(builds).toBe(4);
    expect(coordinator.stats()).toMatchObject({entries:2,evictions:2});expect(coordinator.stats().bytes).toBeLessThanOrEqual(4096);
    const failure=await ticket(new ReadSnapshot(4));
    await expect(coordinator.build(failure,async()=>{throw new Error('source unavailable');})).rejects.toThrow('source unavailable');
    expect(coordinator.stats().flights).toBe(0);
    await coordinator.build(failure,build);expect(builds).toBe(5);
  });
  it('bounds waiting sockets and active identities without cancelling admitted shared work',async()=>{
    const coordinator=new RouterBuildCoordinator({flights:1,waiters:2}),blocked=deferred<{count:number}>();
    const current=await ticket(),other=await ticket(new ReadSnapshot(2));let builds=0;
    const first=coordinator.build(current,async()=>{builds++;return blocked.promise;});
    const joined=coordinator.build(current,async()=>{throw new Error('Unexpected duplicate');});
    await expect(coordinator.build(current,async()=>({count:0}))).rejects.toMatchObject({reason:'budget'});
    await expect(coordinator.build(other,async()=>({count:0}))).rejects.toMatchObject({reason:'budget'});
    blocked.resolve({count:1});await Promise.all([first,joined]);expect(builds).toBe(1);
  });
  it('rejects a noncoherent transaction and retains the complete snapshot beyond the retired display budget',async()=>{
    await expect(ticket(new ReadSnapshot(1,'1','epoch','read committed'))).rejects.toMatchObject({reason:'dependency'});
    const coordinator=new RouterBuildCoordinator();
    const value={count:1,padding:'x'.repeat(1024)};
    expect((await coordinator.build(await ticket(),async()=>value)).value).toEqual(value);
    expect((await coordinator.build(await ticket(),async()=>{throw new Error('Unexpected duplicate build');})).value).toEqual(value);
    expect(coordinator.stats()).toMatchObject({entries:1,flights:0,hits:1});
  });
  it('does not retain a stale in-flight result after a known authority invalidation',async()=>{
    const coordinator=new RouterBuildCoordinator(),blocked=deferred<{count:number}>();const current=await ticket();
    const pending=coordinator.build(current,async()=>blocked.promise);
    coordinator.invalidateAuthority(current.authority.scopes[0]!.authorityScope,'2');blocked.resolve({count:1});await pending;
    expect(coordinator.stats().entries).toBe(0);
    await coordinator.build(await ticket(new ReadSnapshot(1,'2')),async()=>({count:2}));expect(coordinator.stats().entries).toBe(1);
    coordinator.clear();expect(coordinator.stats()).toMatchObject({entries:0,bytes:0});
  });
});
