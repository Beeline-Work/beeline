import {readFile} from 'node:fs/promises';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {migratedDatabase,type PgliteDatabase} from './test-support.js';
import {postgresLiveSchema} from './postgres-live.js';
import {ROOM_SCHEDULES_CAPTURE_SCHEMA} from './room-schedules-capture.js';
import {routerSourcePlan} from './router-source-plan.js';
import {DurableLiveReplay} from './durable-live.js';
import {LiveHub} from './live.js';
const legacy=await readFile(new URL('./test-fixtures/scheduled-work-legacy-source.sql',import.meta.url),'utf8');
const OWNER='a'.repeat(64),AGENT='b'.repeat(64),WS='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
const PARENT='33333333-3333-4333-8333-333333333333',SECOND='44444444-4444-4444-8444-444444444444',OTHER_PARENT='55555555-5555-4555-8555-555555555555';
const CHILD='66666666-6666-4666-8666-666666666666',OTHER_CHILD='77777777-7777-4777-8777-777777777777',SUB='88888888-8888-4888-8888-888888888888',SCHEDULE='99999999-9999-4999-8999-999999999999';
type Event=Record<string,any>;
const clean=(event:Event)=>{const result={...event};delete result.trace;delete result.traceId;delete result.databaseAt;return result;};
describe('single canonical schedule/subscription Workspace source',()=>{
  let db:PgliteDatabase;
  beforeEach(async()=>{
    db=await migratedDatabase();
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Manager'),($2,'agent','Helper')`,[OWNER,AGENT]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'One'),($2,'Other')`,[WS,OTHER]);
    await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$4,$6,'Parent'),($2,$4,$6,'Second parent'),($3,$5,$6,'Other parent')`,[PARENT,SECOND,OTHER_PARENT,WS,OTHER,OWNER]);
    await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$3,$5,$7,'Child'),($2,$4,$6,$7,'Other child')`,[CHILD,OTHER_CHILD,WS,OTHER,PARENT,OTHER_PARENT,OWNER]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$4,'owner'),($2,NULL,$4,'owner'),($1,$3,$5,'member')`,[WS,OTHER,PARENT,OWNER,AGENT]);
    await db.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at)
      VALUES($1,$2,$3,$4,$5,'{"kind":"interval","everyMinutes":10}','Synthetic task','2099-01-01')`,[SCHEDULE,WS,CHILD,AGENT,OWNER]);
    await db.query(`INSERT INTO agent_subscriptions(id,workspace_id,room_id,agent_id,source,event,prompt) VALUES($1,$2,$3,$4,'webhook','webhook.called','Synthetic prompt')`,[SUB,WS,CHILD,AGENT]);
  });
  afterEach(async()=>{await db.close();});
  const heads=async()=>new Map((await db.query<{id:string;epoch:string;sequence:string}>(`SELECT id,epoch,sequence::text FROM live_streams`)).rows.map(row=>[row.id,{epoch:row.epoch,sequence:Number(row.sequence)}]));
  async function events(work:()=>Promise<unknown>){
    const before=await heads();await work();
    return (await db.query<{stream_id:string;sequence:string;event:Event}>(`SELECT stream_id,sequence::text,event FROM live_journal ORDER BY stream_id,live_journal.sequence`)).rows
      .filter(row=>Number(row.sequence)>(before.get(row.stream_id)?.sequence??0));
  }
  const canonical=(rows:Awaited<ReturnType<typeof events>>,ws=WS)=>rows.filter(row=>row.stream_id===`workspace:${ws}`&&row.event.scheduledWorkSource);
  async function observed(work:()=>Promise<unknown>){
    const payloads:Event[]=[];let done!:()=>void;const seen=new Promise<void>(resolve=>{done=resolve;});
    const stop=await db.client.listen('beeline_live_v1',raw=>{const payload=JSON.parse(raw);payloads.push(payload);if(['agent_schedules','agent_subscriptions'].includes(payload.table))done();});
    try{return {rows:await events(async()=>{await work();await seen;}),payloads};}finally{await stop();}
  }
  async function originalInstaller(){
    await db.query(legacy);
    for(const name of ['agent_schedules','agent_subscriptions'])await db.query(`ALTER TABLE ${name} DISABLE TRIGGER aa_beeline_scheduled_work_row_source;ALTER TABLE ${name} DISABLE TRIGGER zz_beeline_scheduled_work_capture`);
  }
  async function currentInstaller(){await db.query((await postgresLiveSchema()));await db.query(ROOM_SCHEDULES_CAPTURE_SCHEMA);}
  it.each(['agent_schedules','agent_subscriptions'])('preserves frozen older %s notifications, Room/parent journals and actual legacy replay while folding its Workspace cause',async table=>{
    const id=table==='agent_schedules'?SCHEDULE:SUB,column=table==='agent_schedules'?'message':'prompt';
    await originalInstaller();const old=await observed(()=>db.query(`UPDATE ${table} SET ${column}='First change' WHERE id=$1`,[id]));
    await currentInstaller();const before=await heads(),current=await observed(()=>db.query(`UPDATE ${table} SET ${column}='Second change' WHERE id=$1`,[id]));
    expect(current.payloads.filter(payload=>payload.table===table).map(clean)).toEqual(old.payloads.filter(payload=>payload.table===table).map(clean));
    expect(current.rows.filter(row=>row.stream_id.startsWith('room:')).map(row=>({stream:row.stream_id,event:clean(row.event)})))
      .toEqual(old.rows.filter(row=>row.stream_id.startsWith('room:')).map(row=>({stream:row.stream_id,event:clean(row.event)})));
    const rows=canonical(current.rows);expect(rows).toHaveLength(1);
    const {scheduledWorkSource,...oldShape}=rows[0]!.event;
    expect(oldShape).toEqual(old.rows.find(row=>row.stream_id===`workspace:${WS}`)!.event);
    expect(scheduledWorkSource).toEqual({version:1,classification:'complete',targets:[{roomId:PARENT,readers:null}]});
    const cursor=before.get(`workspace:${WS}`)!,replay=await new DurableLiveReplay(db,new LiveHub()).read(`workspace:${WS}`,{epoch:cursor.epoch,base:cursor.sequence,seen:[]});
    expect(replay.resumed).toBe(true);expect(replay.replay).toHaveLength(1);expect(replay.replay[0]!.event).toMatchObject({type:'invalidate',roomId:'',reason:'workspace-replay',sourceTable:table});
  });
  it('records the exact former/new Workspace parents once each on a cross-Workspace row move',async()=>{
    const rows=await events(()=>db.query(`UPDATE agent_schedules SET room_id=$1,workspace_id=$2 WHERE id=$3`,[OTHER_CHILD,OTHER,SCHEDULE]));
    expect(canonical(rows)).toHaveLength(1);expect(canonical(rows,OTHER)).toHaveLength(1);
    expect(canonical(rows)[0]!.event).toMatchObject({oldRoomId:CHILD,newRoomId:OTHER_CHILD,scheduledWorkSource:{targets:[{roomId:PARENT,readers:null}]}});
    expect(canonical(rows,OTHER)[0]!.event).toMatchObject({oldRoomId:CHILD,newRoomId:OTHER_CHILD,scheduledWorkSource:{targets:[{roomId:OTHER_PARENT,readers:null}]}});
    expect(JSON.stringify(canonical(rows)[0]!.event.scheduledWorkSource)).not.toContain(OTHER_PARENT);
  });
  it.each(['agent_schedules','agent_subscriptions'])('retains the frozen older %s move notifications and both physical Room journals',async table=>{
    const id=table==='agent_schedules'?SCHEDULE:SUB;
    const move=()=>db.query(`UPDATE ${table} SET room_id=$1,workspace_id=$2 WHERE id=$3`,[OTHER_CHILD,OTHER,id]);
    await originalInstaller();const old=await observed(move);
    await currentInstaller();await db.query(`UPDATE ${table} SET room_id=$1,workspace_id=$2 WHERE id=$3`,[CHILD,WS,id]);
    const current=await observed(move);
    expect(current.payloads.filter(payload=>payload.table===table).map(clean)).toEqual(old.payloads.filter(payload=>payload.table===table).map(clean));
    expect(current.rows.filter(row=>row.stream_id.startsWith('room:')).map(row=>({stream:row.stream_id,event:clean(row.event)})))
      .toEqual(old.rows.filter(row=>row.stream_id.startsWith('room:')).map(row=>({stream:row.stream_id,event:clean(row.event)})));
    for(const workspace of [WS,OTHER]){
      const {scheduledWorkSource,...oldShape}=canonical(current.rows,workspace)[0]!.event;
      expect(oldShape).toEqual(old.rows.find(row=>row.stream_id===`workspace:${workspace}`)!.event);expect(scheduledWorkSource.classification).toBe('complete');
    }
  });
  it.each(['agent_schedules','agent_subscriptions'])('captures %s DELETE and INSERT as one complete exact parent cause each',async table=>{
    const id=table==='agent_schedules'?SCHEDULE:SUB;
    let rows=await events(()=>db.query(`DELETE FROM ${table} WHERE id=$1`,[id]));
    expect(canonical(rows)).toHaveLength(1);expect(canonical(rows)[0]!.event).toMatchObject({operation:'DELETE',oldRoomId:CHILD,
      scheduledWorkSource:{classification:'complete',targets:[{roomId:PARENT,readers:null}]}});
    rows=await events(()=>table==='agent_schedules'?db.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at)
      VALUES($1,$2,$3,$4,$5,'{"kind":"interval","everyMinutes":10}','Synthetic task','2099-01-01')`,[SCHEDULE,WS,CHILD,AGENT,OWNER])
      :db.query(`INSERT INTO agent_subscriptions(id,workspace_id,room_id,agent_id,source,event,prompt) VALUES($1,$2,$3,$4,'webhook','webhook.called','Synthetic prompt')`,[SUB,WS,CHILD,AGENT]));
    expect(canonical(rows)).toHaveLength(1);expect(canonical(rows)[0]!.event).toMatchObject({operation:'INSERT',oldRoomId:null,
      scheduledWorkSource:{classification:'complete',targets:[{roomId:PARENT,readers:null}]}});
  });
  it('two affected parents in one Workspace are one stream increment with two closed targets',async()=>{
    const rows=await events(()=>db.query(`UPDATE agent_subscriptions SET room_id=$1 WHERE id=$2`,[SECOND,SUB]));
    expect(canonical(rows)).toHaveLength(1);expect(canonical(rows)[0]!.event.scheduledWorkSource.targets).toEqual([{roomId:PARENT,readers:null},{roomId:SECOND,readers:null}]);
    expect(rows.filter(row=>row.stream_id===`workspace:${WS}`)).toHaveLength(1);
  });
  it('secret-only subscription updates retain legacy notifications with explicit complete-empty projection work',async()=>{
    const current=await observed(()=>db.query(`UPDATE agent_subscriptions SET webhook_token='synthetic-token' WHERE id=$1`,[SUB]));
    const rows=canonical(current.rows);expect(rows).toHaveLength(1);expect(rows[0]!.event.scheduledWorkSource).toEqual({version:1,classification:'complete',targets:[]});
    expect(routerSourcePlan(rows.map(row=>row.event),OWNER).scheduledWorkCauses).toEqual([]);
    expect(current.payloads.some(payload=>payload.table==='agent_subscriptions'&&payload.scheduleId===SUB)).toBe(true);
    expect(JSON.stringify(current.rows)).not.toContain('synthetic-token');
  });
  it('uses private-reader candidates rather than converting JSON null or an unrepresentable policy to public/empty coverage',async()=>{
    await db.query(`UPDATE rooms SET direct_participants=$1::jsonb WHERE id=$2`,[JSON.stringify([OWNER,AGENT]),PARENT]);
    let rows=await events(()=>db.query(`UPDATE agent_schedules SET run_count=run_count+1 WHERE id=$1`,[SCHEDULE]));
    expect(canonical(rows)[0]!.event.scheduledWorkSource.targets).toEqual([{roomId:PARENT,readers:[OWNER,AGENT]}]);
    await db.query(`UPDATE rooms SET direct_participants='null'::jsonb WHERE id=$1`,[PARENT]);
    rows=await events(()=>db.query(`UPDATE agent_schedules SET run_count=run_count+1 WHERE id=$1`,[SCHEDULE]));
    expect(canonical(rows)[0]!.event.scheduledWorkSource).toEqual({version:1,classification:'unavailable',reason:'dependency'});
    // The production drain plans one Workspace stream; legacy Room replay
    // entries deliberately have no sourceTable and are not its input.
    expect(()=>routerSourcePlan(rows.filter(row=>row.stream_id===`workspace:${WS}`).map(row=>row.event),OWNER)).toThrow('dependency');
  });
  it('classifies all 101 source readers without trimming or refusing the interval',async()=>{
    await db.query(`UPDATE rooms SET direct_participants=$1::jsonb WHERE id=$2`,[JSON.stringify(Array.from({length:101},(_,n)=>String(n).padStart(64,'0'))),PARENT]);
    const rows=await events(()=>db.query(`UPDATE agent_schedules SET run_count=run_count+1 WHERE id=$1`,[SCHEDULE]));
    expect(canonical(rows)[0]!.event.scheduledWorkSource).toMatchObject({version:1,classification:'complete'});
    expect(canonical(rows)[0]!.event.scheduledWorkSource.targets[0].readers).toHaveLength(101);
    expect(()=>routerSourcePlan(rows.filter(row=>row.stream_id===`workspace:${WS}`).map(row=>row.event),OWNER)).not.toThrow();
  });
  it('retains inconsistent stored Workspace keys while binding actual display targets to their real parent Workspace',async()=>{
    const rows=await events(()=>db.query(`UPDATE agent_schedules SET workspace_id=$1 WHERE id=$2`,[OTHER,SCHEDULE]));
    expect(canonical(rows)).toHaveLength(1);expect(canonical(rows,OTHER)).toHaveLength(1);
    expect(canonical(rows)[0]!.event.scheduledWorkSource.targets).toEqual([{roomId:PARENT,readers:null}]);
    expect(canonical(rows,OTHER)[0]!.event.scheduledWorkSource.targets).toEqual([]);
  });
  it('a Room cascade that erased the row relationship emits unavailable, never invented empty-parent coverage',async()=>{
    const rows=await events(()=>db.query(`DELETE FROM rooms WHERE id=$1`,[CHILD]));
    const causes=canonical(rows);expect(causes.length).toBeGreaterThan(0);
    expect(causes.every(row=>row.event.scheduledWorkSource.classification==='unavailable'&&row.event.scheduledWorkSource.reason==='dependency')).toBe(true);
    expect(()=>routerSourcePlan(rows.filter(row=>row.stream_id===`workspace:${WS}`).map(row=>row.event),OWNER)).toThrow('dependency');
  });
  it('older migration restoration can add duplicates but cannot remove canonical coverage, and reinstall converges to one cause',async()=>{
    await db.query(legacy);
    let rows=await events(()=>db.query(`UPDATE agent_schedules SET run_count=run_count+1 WHERE id=$1`,[SCHEDULE]));
    expect(rows.filter(row=>row.stream_id===`workspace:${WS}`)).toHaveLength(3);expect(canonical(rows)).toHaveLength(1);
    expect(routerSourcePlan(rows.filter(row=>row.stream_id===`workspace:${WS}`).map(row=>row.event),OWNER).scheduledWorkCauses).toEqual([{roomId:PARENT,readers:null}]);
    await currentInstaller();rows=await events(()=>db.query(`UPDATE agent_schedules SET run_count=run_count+1 WHERE id=$1`,[SCHEDULE]));
    expect(rows.filter(row=>row.stream_id===`workspace:${WS}`)).toHaveLength(1);
  });
  it('an aborted source write leaves no canonical cause, Room journal or notification',async()=>{
    const before=await heads(),payloads:string[]=[],stop=await db.client.listen('beeline_live_v1',payload=>{payloads.push(payload);});
    try{await expect(db.transaction(async tx=>{await tx.query(`UPDATE agent_schedules SET run_count=run_count+1 WHERE id=$1`,[SCHEDULE]);throw new Error('synthetic rollback');})).rejects.toThrow('synthetic rollback');
      expect(await heads()).toEqual(before);expect(payloads).toEqual([]);
    }finally{await stop();}
  });
});
