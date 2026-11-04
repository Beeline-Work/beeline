import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SqlDatabase} from './database.js';
import {migratedDatabase,type PgliteDatabase} from './test-support.js';
import {PhoneService} from './phone-service.js';
import {LiveHub} from './live.js';
import {routerSocketProtocol} from './router-socket.js';
import {SCHEDULED_WORK_AUTHORITY_SCHEMA} from './scheduled-work-authority.js';
import {ROOM_SCHEDULES_CAPTURE_SCHEMA} from './room-schedules-capture.js';
const VIEWER='a'.repeat(64),AGENT='b'.repeat(64),WS='11111111-1111-4111-8111-111111111111';
const ROOM='22222222-2222-4222-8222-222222222222',DM='33333333-3333-4333-8333-333333333333';
const SCHEDULE='55555555-5555-4555-8555-555555555555';
const input=(roomId=ROOM)=>({family:'room-scheduled-work' as const,roomId});
describe('negotiated compact Scheduled Work complete interval',()=>{
  let db:PgliteDatabase;
  const protocols:Array<ReturnType<typeof routerSocketProtocol>>=[];
  beforeEach(async()=>{
    db=await migratedDatabase();await db.query(SCHEDULED_WORK_AUTHORITY_SCHEMA);await db.query(ROOM_SCHEDULES_CAPTURE_SCHEMA);
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Manager'),($2,'agent','Helper')`,[VIEWER,AGENT]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`,[WS]);
    await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name,direct_participants) VALUES($1,$3,$4,'Public A',NULL),($2,$3,$4,'Own DM B',$5::jsonb)`,[ROOM,DM,WS,VIEWER,JSON.stringify([VIEWER,AGENT])]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$4,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member'),($1,$3,$4,'member'),($1,$3,$5,'member')`,[WS,ROOM,DM,VIEWER,AGENT]);
    await db.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at)
      VALUES($1,$2,$3,$4,$5,'{"kind":"interval","everyMinutes":10}','Initial task','2099-01-01')`,[SCHEDULE,WS,ROOM,AGENT,VIEWER]);
  });
  afterEach(async()=>{for(const protocol of protocols.splice(0))protocol.close();await db.close();});
  function connection(configured:boolean|undefined=true,omitPolicy=false,mixedAuthority=false){
    const queries:string[]=[];let queryRows=0,queryBytes=0;
    const wrap=(database:SqlDatabase):SqlDatabase=>({transaction:work=>database.transaction(tx=>work(wrap(tx))),query:async(sql,args)=>{
      queries.push(sql);const result=await database.query(sql,args);queryRows+=result.rows.length;queryBytes+=Buffer.byteLength(JSON.stringify(result.rows));return result;
    }});
    const observed=wrap(db),phone=new PhoneService(observed,'https://synthetic.test'),builds=vi.spyOn(phone,'buildRouterValue');
    const live=new LiveHub(),frames:Record<string,any>[]=[];let complete:(()=>void)|undefined,failed:((error:Error)=>void)|undefined,reads=0;
    const families=mixedAuthority?['room-scheduled-work','needs-you-count'] as const:['room-scheduled-work'] as const;
    const protocol=routerSocketProtocol(observed,VIEWER,raw=>{const frame=JSON.parse(raw);frames.push(frame);if(frame.kind==='push-commit')complete?.();
      if(frame.kind==='router-unavailable')failed?.(new Error(`Projection unavailable: ${frame.reason}`));},
      {families,listenerReady:()=>true,commandDedupV1:true,...(omitPolicy?{}:{scheduledWorkCoverageV1:configured})},
      {live,phone,mediaMetadataV1:mixedAuthority,rooms:()=>{throw new Error('No client inventory');}});protocols.push(protocol);
    const start=(requested=true)=>protocol.handle({type:'router-negotiate',protocol:1,families,authorityFencesV1:true,...(requested?{scheduledWorkCoverageV1:true}:{})});
    const snapshot=async(roomId=ROOM)=>{
      reads++;const result=await protocol.snapshot(input(roomId));let reply:unknown=result;
      await protocol.fenceReply('readRouterSnapshot',input(roomId),result,safe=>{reply=safe??result;return undefined;});return reply;
    };
    const change=async(work:()=>Promise<unknown>)=>{
      const done=new Promise<void>((resolve,reject)=>{complete=resolve;failed=reject;});frames.length=0;queries.length=0;queryRows=0;queryBytes=0;builds.mockClear();
      await work();live.journalChanged([`workspace:${WS}`]);await done;
      // Test-only DB scheduling barrier after synchronous enqueue. No phone
      // request, timer, source event or production query is admitted here.
      await db.query('SELECT 1');
      return frames.filter(frame=>frame.kind==='push-part').flatMap(frame=>frame.facts);
    };
    return {protocol,start,snapshot,change,frames,queries,builds,live,reads:()=>reads,stats:()=>({queries:queries.length,queryRows,queryBytes})};
  }
  it.each([16,128])('one changed scope among %s authorized Rooms supplies one DTO plus one closed classifier without an unchanged audience scan',async count=>{
    await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name)
      SELECT ('44444444-4444-4444-8444-'||lpad(n::text,12,'0'))::uuid,$1,$2,'Other '||n FROM generate_series(1,$3::int)n`,[WS,VIEWER,count-2]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) SELECT $1,id,$2,'member' FROM rooms
      WHERE workspace_id=$1 AND id NOT IN($3::uuid,$4::uuid)`,[WS,AGENT,ROOM,DM]);
    const c=connection();await c.start();expect(c.frames[0]).toMatchObject({type:'router-capabilities',scheduledWorkCoverageV1:{version:1}});
    const baseline=await c.snapshot();expect(baseline).toMatchObject({authorityBarrier:c.frames[0]!.scheduledWorkCoverageV1.authorityStart});
    const records=await c.change(()=>db.query(`UPDATE agent_schedules SET message='Changed task' WHERE id=$1`,[SCHEDULE]));
    expect(records).toHaveLength(2);expect(records.filter(record=>record.payload?.kind==='scope-replace')).toEqual([
      expect.objectContaining({atomicGroup:`room-scheduled-work:${ROOM}:${VIEWER}`,payload:expect.objectContaining({value:expect.objectContaining({schedules:[expect.objectContaining({message:'Changed task'})]})})}),
    ]);
    expect(records.filter(record=>record.kind==='scheduled-work-classification')).toHaveLength(1);expect(c.builds).toHaveBeenCalledTimes(1);expect(c.reads()).toBe(1);
    expect(c.queries.some(sql=>sql.includes('SELECT room.id FROM rooms room CROSS JOIN manager'))).toBe(false);
    const wire=c.frames.filter(frame=>frame.kind==='push-part'||frame.kind==='push-commit');
    expect(wire.every(frame=>frame.from.stream===`workspace:${WS}`&&frame.to.stream===`workspace:${WS}`)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThanOrEqual(64*1024);
    console.log('SCHEDULED_COVERAGE_SOURCE',JSON.stringify({authorizedRooms:count,records:records.length,builders:c.builds.mock.calls.length,wireBytes:Buffer.byteLength(JSON.stringify(wire)),...c.stats(),gate:'whole-server/WAL/native/cohort budgets remain OPEN'}));
  });
  it('an unrelated source produces only its explicit complete classifier, with no DTO or Room-authority audience query',async()=>{
    const c=connection();await c.start();await c.snapshot();
    const records=await c.change(()=>db.query(`UPDATE workspaces SET name='Unrelated header' WHERE id=$1`,[WS]));
    expect(records).toEqual([expect.objectContaining({kind:'scheduled-work-classification',version:1})]);expect(c.builds).not.toHaveBeenCalled();expect(c.reads()).toBe(1);
    expect(c.queries.some(sql=>sql.includes('WITH manager AS'))).toBe(false);
  });
  it.each([[false,true],[true,false],[true,undefined]] as const)('keeps established per-group wire when requested=%s and configured=%s',async(requested,configured)=>{
    const c=connection(configured,configured===undefined);await c.start(requested);expect(c.frames[0]).not.toHaveProperty('scheduledWorkCoverageV1');
    expect(await c.snapshot()).not.toHaveProperty('authorityBarrier');
    const records=await c.change(()=>db.query(`UPDATE workspaces SET name='Header for old cohort' WHERE id=$1`,[WS]));
    expect(records).toHaveLength(2);expect(records.every(record=>record.payload?.kind==='authority-fence')).toBe(true);
    expect(c.frames.some(frame=>frame.kind.startsWith('scheduled-work-authority-'))).toBe(false);
  });
  it('a source revoke flushes its complete current authority barrier before the complete Workspace batch',async()=>{
    const c=connection();await c.start();const b=await c.protocol.snapshot(input(DM));
    const records=await c.change(()=>db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,[DM,VIEWER]));
    const auth=c.frames.findIndex(frame=>frame.kind==='scheduled-work-authority-commit'),data=c.frames.findIndex(frame=>frame.kind==='push-part');
    expect(auth).toBeGreaterThanOrEqual(0);expect(data).toBeGreaterThan(auth);
    const barrier=c.frames[auth]!.to;expect(records).toContainEqual({kind:'scheduled-work-classification',version:1,authorityBarrier:barrier});
    const send=vi.fn(()=>undefined);await expect(c.protocol.fenceReply('readRouterSnapshot',input(DM),b,send)).rejects.toMatchObject({reason:'authority'});expect(send).not.toHaveBeenCalled();
    expect(await c.snapshot()).toMatchObject({value:{roomName:'Public A'},authorityBarrier:barrier});
  });
  it('a snapshot opened before a negotiated generation switch cannot acquire the new generation barrier',async()=>{
    const c=connection();await c.start();const old=await c.protocol.snapshot(input());await c.start();const send=vi.fn(()=>undefined);
    await expect(c.protocol.fenceReply('readRouterSnapshot',input(),old,send)).rejects.toMatchObject({status:503});expect(send).not.toHaveBeenCalled();
  });
  it('the compact actor reports actual source loss for every authority consumer, including negotiated count and media',async()=>{
    const c=connection(true,false,true);await c.start();
    expect(c.frames[0]).toMatchObject({families:['needs-you-count','room-scheduled-work'],authorityFencesV1:true,
      mediaMetadataV1:true,scheduledWorkCoverageV1:{version:1}});
    await c.snapshot();c.frames.length=0;c.live.projectionUnavailable();await Promise.resolve();
    expect(c.frames.filter(frame=>frame.kind==='router-unavailable'&&frame.stream===`authority:${VIEWER}`)).toEqual([
      {kind:'router-unavailable',stream:`authority:${VIEWER}`,families:[],reason:'listener'},
    ]);
    expect(c.reads()).toBe(1);
  });
});
