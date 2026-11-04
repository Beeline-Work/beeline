import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {buildRoomSchedulesProjection} from './room-schedules-projection.js';
import {PhoneService} from './phone-service.js';
import {migratedDatabase,type PgliteDatabase} from './test-support.js';
const OWNER='a'.repeat(64),MEMBER='b'.repeat(64),AGENT='c'.repeat(64);
const WORKSPACE='11111111-1111-4111-8111-111111111111',ROOM='22222222-2222-4222-8222-222222222222';
describe('complete pure Scheduled Work projection',()=>{
  let db:PgliteDatabase;
  beforeEach(async()=>{
    db=await migratedDatabase();
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'human','Member'),($3,'agent','Helper')`,[OWNER,MEMBER,AGENT]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`,[WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Room')`,[ROOM,WORKSPACE,OWNER]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role,event_subscriptions) VALUES
      ($1,NULL,$3,'owner','[]'),($1,$2,$3,'owner','[]'),($1,NULL,$4,'member','[]'),($1,$2,$4,'member','[]'),($1,$2,$5,'member','[]')`,[WORKSPACE,ROOM,OWNER,MEMBER,AGENT]);
  });
  afterEach(async()=>{await db.close();});
  const build=()=>db.transaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return buildRoomSchedulesProjection(tx,ROOM,OWNER,'https://example.test');
  });
  async function schedules(count:number,text='Do the scheduled task'){
    await db.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at)
      SELECT md5('schedule:'||n)::uuid,$1,$2,$3,$4,'{"kind":"interval","everyMinutes":10}'::jsonb,$5,'2099-01-01' FROM generate_series(1,$6::int)n`,[WORKSPACE,ROOM,AGENT,OWNER,text,count]);
  }
  it('matches the complete existing display DTO inside a read-only transaction without advancing any source',async()=>{
    await schedules(1);
    const subscription='33333333-3333-4333-8333-333333333333',call='44444444-4444-4444-8444-444444444444';
    await db.query(`INSERT INTO agent_subscriptions(id,workspace_id,room_id,agent_id,source,event,prompt,webhook_suffix,webhook_token_created_at)
      VALUES($1,$2,$3,$4,'webhook','webhook.called','Handle this event','stub','2026-01-01')`,[subscription,WORKSPACE,ROOM,AGENT]);
    await db.query(`INSERT INTO subscription_webhook_calls(id,subscription_id,outcome,byte_size,reason) VALUES($1,$2,'refused',12,'synthetic reason')`,[call,subscription]);
    const expected=await new PhoneService(db,'https://example.test').execute('readScheduledWork',{roomId:ROOM},OWNER);
    const before=(await db.query(`SELECT sum(sequence)::text head FROM live_streams`)).rows[0]!.head;
    const actual=await build();expect(actual).toEqual(expected);
    expect(actual.subscriptions[0]).toMatchObject({id:subscription,webhook:{tokenSuffix:'stub'},recentCalls:[{id:call,outcome:'refused'}]});
    expect((await db.query(`SELECT sum(sequence)::text head FROM live_streams`)).rows[0]!.head).toBe(before);
  });
  it('requires the actual Workspace manager even when a Room member can read the transcript',async()=>{
    await expect(buildRoomSchedulesProjection(db,ROOM,MEMBER,'https://example.test')).rejects.toThrow('workspace admins only');
  });
  it('returns all fifty-one entries',async()=>{
    await schedules(51);expect((await build()).schedules).toHaveLength(51);
  });
  it('accepts fifty small entries at the declared bound',async()=>{
    await schedules(50);expect((await build()).schedules).toHaveLength(50);
  });
  it('keeps a large scheduled prompt visible',async()=>{
    await schedules(1,'x'.repeat(65*1024));expect((await build()).schedules[0]!.message).toHaveLength(65*1024);
  });
  it('returns every agent name above one hundred',async()=>{
    await db.query(`INSERT INTO identities(id,kind,name) SELECT md5('helper:'||n)||md5('helper:'||n),'agent','Helper '||n FROM generate_series(1,100)n`);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      SELECT $1,$2,md5('helper:'||n)||md5('helper:'||n),'member' FROM generate_series(1,100)n`,[WORKSPACE,ROOM]);
    expect((await build()).agentNames).toHaveLength(101);
  });
  it('keeps the surface available above fifty webhook calls',async()=>{
    const first='33333333-3333-4333-8333-333333333333',second='44444444-4444-4444-8444-444444444444';
    await db.query(`INSERT INTO agent_subscriptions(id,workspace_id,room_id,agent_id,source,event,prompt,webhook_suffix,webhook_token_created_at,service_channel_id)
      VALUES($1,$3,$4,$5,'webhook','webhook.called','First','stub','2026-01-01',$6),($2,$3,$4,$5,'webhook','webhook.called','Second','stub','2026-01-01',$7)`,[first,second,WORKSPACE,ROOM,AGENT,first,second]);
    await db.query(`INSERT INTO subscription_webhook_calls(id,subscription_id,outcome,byte_size)
      SELECT md5('bounded-call:'||n)::uuid,CASE WHEN n<=30 THEN $1::uuid ELSE $2::uuid END,'skipped',1 FROM generate_series(1,51)n`,[first,second]);
    const value=await build();
    expect(value.subscriptions.flatMap(subscription=>subscription.recentCalls??[])).toHaveLength(51);
  });
});
