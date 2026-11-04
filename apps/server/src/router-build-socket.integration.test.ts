import type {QueryResultRow} from 'pg';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {QueryResult,SqlDatabase} from './database.js';
import {migratedDatabase,type PgliteDatabase} from './test-support.js';
import {PhoneService} from './phone-service.js';
import {LiveHub} from './live.js';
import {routerSocketProtocol,type RouterProjectionPolicy} from './router-socket.js';
import {RouterBuildCoordinator} from './router-build-coordinator.js';
const VIEWER='a'.repeat(64),PEER='b'.repeat(64),WORKSPACE='11111111-1111-4111-8111-111111111111',ROOM='22222222-2222-4222-8222-222222222222';
const input={family:'needs-you-count' as const,workspaceId:WORKSPACE};
/** The fixture owns a literal database clock. Production cannot guess this
 * basis: it must provide its actual committed clock-source generation. */
class FixedClock implements SqlDatabase{
  constructor(private readonly database:SqlDatabase){}
  query<Row extends QueryResultRow=QueryResultRow>(sql:string,args?:unknown[]):Promise<QueryResult<Row>>{
    return this.database.query<Row>(sql.replaceAll('now()','to_timestamp(2000000000)'),args);
  }
  transaction<T>(work:(db:SqlDatabase)=>Promise<T>):Promise<T>{return this.database.transaction(tx=>work(new FixedClock(tx)));}
}
describe('shared reader projection execution through socket protocol',()=>{
  let database:PgliteDatabase,db:SqlDatabase,phone:PhoneService,live:LiveHub,builds:number;
  const protocols:Array<ReturnType<typeof routerSocketProtocol>>=[];
  beforeEach(async()=>{
    database=await migratedDatabase();db=new FixedClock(database);live=new LiveHub();builds=0;
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Reader','reader'),($2,'human','Peer','peer')`,[VIEWER,PEER]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`,[WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`,[ROOM,WORKSPACE]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'member'),($1,$2,$3,'member'),($1,NULL,$4,'member'),($1,$2,$4,'member')`,[WORKSPACE,ROOM,VIEWER,PEER]);
    phone=new PhoneService(db,'https://example.test');const build=phone.buildRouterValue.bind(phone);
    vi.spyOn(phone,'buildRouterValue').mockImplementation(async(...args)=>{builds++;return build(...args);});
  });
  afterEach(async()=>{for(const protocol of protocols.splice(0))protocol.close();await database.close();});
  function policy(families:RouterProjectionPolicy['families']=['needs-you-count']):RouterProjectionPolicy{return {families,listenerReady:()=>true,
    sharedBuilds:{coordinator:new RouterBuildCoordinator(),basis:{schema:1,databaseScope:'isolated-socket-fixture',version:'pure-count-v1',
      publicOrigin:'https://example.test',clockVersion:'literal-db-clock-2000000000'}}};}
  function protocol(shared:RouterProjectionPolicy,onFrame:(frame:Record<string,any>)=>void=()=>{}){
    const result=routerSocketProtocol(db,VIEWER,raw=>onFrame(JSON.parse(raw)),shared,{live,phone,rooms:()=>[]});
    protocols.push(result);return result;
  }
  const negotiate=(socket:ReturnType<typeof routerSocketProtocol>,families:RouterProjectionPolicy['families']=['needs-you-count'])=>socket.handle({type:'router-negotiate',protocol:1,families,authorityFencesV1:true});
  it('two initial Tray count snapshots remain fresh after the first build settles',async()=>{
    const shared=policy(),first=protocol(shared),second=protocol(shared);await negotiate(first);await negotiate(second);
    const a=await first.snapshot(input),b=await second.snapshot(input);expect(a).toEqual(b);expect(a.value).toEqual({count:0});
    let sent=0;await first.fenceReply('readRouterSnapshot',input,a,()=>{sent++;return undefined;});
    await second.fenceReply('readRouterSnapshot',input,b,()=>{sent++;return undefined;});
    expect(sent).toBe(2);expect(builds).toBe(2);expect(shared.sharedBuilds!.coordinator.stats()).toMatchObject({builds:2,hits:0,entries:0});
  });
  it('one committed source interval delivers fresh counts to two independently draining same-reader sockets',async()=>{
    const shared=policy(),frames:Record<string,any>[][]=[[],[]];let doneA!:()=>void,doneB!:()=>void;
    const completed=[new Promise<void>(done=>{doneA=done;}),new Promise<void>(done=>{doneB=done;})];
    const first=protocol(shared,frame=>{frames[0]!.push(frame);if(frame.kind==='push-commit')doneA();});
    const second=protocol(shared,frame=>{frames[1]!.push(frame);if(frame.kind==='push-commit')doneB();});
    await negotiate(first);await negotiate(second);await first.snapshot(input);await second.snapshot(input);expect(builds).toBe(2);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES('new-ask',$1,$2,'@reader please review',to_timestamp(2000000000)-interval '1 hour')`,[ROOM,PEER]);
    live.journalChanged([`workspace:${WORKSPACE}`]);await Promise.all(completed);await db.query('SELECT 1');
    expect(builds).toBe(4);
    const values=frames.map(socket=>socket.filter(frame=>frame.kind==='push-part').flatMap(frame=>frame.facts));
    expect(values[0]).toEqual(values[1]);expect(values[0]).toHaveLength(1);
    expect(values[0]![0]).toMatchObject({payload:{kind:'scope-replace',family:'needs-you-count',scope:WORKSPACE,value:{count:1}}});
    expect(frames[0]!.find(frame=>frame.kind==='push-commit').to).toEqual(frames[1]!.find(frame=>frame.kind==='push-commit').to);
    expect((await db.query(`SELECT 1 FROM needs_you_marks`)).rowCount).toBe(0);
  });
  it('still reuses a settled Saved page across same-reader sockets without time-sensitive eligibility',async()=>{
    const families=['needs-you-saved-page'] as const,shared=policy(families),first=protocol(shared),second=protocol(shared);
    await negotiate(first,families);await negotiate(second,families);
    const saved={family:'needs-you-saved-page' as const,workspaceId:WORKSPACE};
    const a=await first.snapshot(saved),b=await second.snapshot(saved);
    expect(a).toEqual(b);expect(a.value).toMatchObject({rows:[]});
    expect(builds).toBe(1);expect(shared.sharedBuilds!.coordinator.stats()).toMatchObject({builds:1,hits:1});
  });
  it('keeps sharing disabled when no explicit server policy is supplied',async()=>{
    const plain:RouterProjectionPolicy={families:['needs-you-count'],listenerReady:()=>true},first=protocol(plain),second=protocol(plain);
    await negotiate(first);await negotiate(second);
    const queries=vi.spyOn(db,'query');
    const a=await first.snapshot(input),b=await second.snapshot(input);
    expect(a).toEqual(b);expect(a.value).toEqual({count:0});
    // Cold scalar badges have their own single-statement projection; both
    // sockets must still execute it when no shared coordinator is selected.
    expect(queries.mock.calls.filter(([sql])=>sql.includes('SELECT counted.*,head.epoch'))).toHaveLength(2);
    expect(builds).toBe(0);
  });
});
