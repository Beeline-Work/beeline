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

describe('projection build capacity',()=>{
  it('queues distinct builds and shares unlimited waiters while limiting active builders',async()=>{
    const coordinator=new RouterBuildCoordinator({flights:1,waiters:2}),blocked=deferred<{count:number}>();
    const current=await ticket(),other=await ticket(new ReadSnapshot(2));let builds=0,active=0,maxActive=0;
    const build:RouterValueBuilder=async()=>{builds++;maxActive=Math.max(maxActive,++active);const value=await blocked.promise;active--;return value;};
    const first=coordinator.build(current,build);
    const joined=Array.from({length:128},()=>coordinator.build(current,build));
    const queued=Array.from({length:128},()=>coordinator.build(other,build));
    await Promise.resolve();expect(builds).toBe(1);
    blocked.resolve({count:1});expect(await Promise.all([first,...joined,...queued])).toHaveLength(257);
    expect(builds).toBe(2);expect(maxActive).toBe(1);
  });

  it('validates coherent cuts but returns a result larger than the optional cache without retaining it',async()=>{
    await expect(ticket(new ReadSnapshot(1,'1','epoch','read committed'))).rejects.toMatchObject({reason:'dependency'});
    const coordinator=new RouterBuildCoordinator({bytes:1024}),value={count:1,padding:'x'.repeat(1024*1024)};
    expect((await coordinator.build(await ticket(),async()=>value)).value).toEqual(value);
    expect(coordinator.stats()).toMatchObject({entries:0,flights:0,bytes:0});
  });

});
