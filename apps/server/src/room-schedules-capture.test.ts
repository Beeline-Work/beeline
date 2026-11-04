import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {migratedDatabase,type PgliteDatabase} from './test-support.js';
import {ROOM_SCHEDULES_CAPTURE_SCHEMA} from './room-schedules-capture.js';
import {SCHEDULED_WORK_AUTHORITY_SCHEMA} from './scheduled-work-authority.js';
import {buildRoomSchedulesProjection} from './room-schedules-projection.js';
const OWNER='a'.repeat(64),AGENT='b'.repeat(64);
const WS='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
const PARENT='33333333-3333-4333-8333-333333333333',ROOM='44444444-4444-4444-8444-444444444444';
const OTHER_PARENT='55555555-5555-4555-8555-555555555555',OTHER_ROOM='66666666-6666-4666-8666-666666666666';
const SUB='77777777-7777-4777-8777-777777777777',OTHER_SUB='88888888-8888-4888-8888-888888888888';
const HOOK='99999999-9999-4999-8999-999999999999',CALL='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONNECTOR='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',APP='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SERVICE='dddddddd-dddd-4ddd-8ddd-dddddddddddd',SCHEDULE='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
describe('complete Scheduled Work source/clock closure',()=>{
  let db:PgliteDatabase;
  beforeEach(async()=>{
    db=await migratedDatabase();await db.query(SCHEDULED_WORK_AUTHORITY_SCHEMA);await db.query(ROOM_SCHEDULES_CAPTURE_SCHEMA);
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Helper')`,[OWNER,AGENT]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[AGENT,OWNER]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Old scope'),($2,'New scope')`,[WS,OTHER]);
    await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$3,$5,'Parent'),($2,$4,$5,'Other parent')`,[PARENT,OTHER_PARENT,WS,OTHER,OWNER]);
    await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$3,$5,$7,'Child'),($2,$4,$6,$7,'Other child')`,[ROOM,OTHER_ROOM,WS,OTHER,PARENT,OTHER_PARENT,OWNER]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role,event_subscriptions) VALUES
      ($1,NULL,$5,'owner','[]'),($2,NULL,$5,'owner','[]'),($1,$3,$5,'owner','[]'),($2,$4,$5,'owner','[]'),
      ($1,$3,$6,'member','[]'),($2,$4,$6,'member','[]')`,[WS,OTHER,PARENT,OTHER_PARENT,OWNER,AGENT]);
    await db.query(`INSERT INTO workspace_connectors(id,workspace_id,owner_identity_id,connector_type,helper_agent_id,status)
      VALUES($1,$2,$3,'registry-mcp',$4,'connected')`,[CONNECTOR,WS,OWNER,AGENT]);
    await db.query(`INSERT INTO workspace_apps(id,workspace_id,owner_identity_id,app_key,display_name,transport,route,connector_id)
      VALUES($1,$2,$3,'stripe','Stripe','registry-mcp','registry-mcp',$4)`,[APP,WS,OWNER,CONNECTOR]);
    await db.query(`INSERT INTO provider_webhooks(id,app_id,connector_id,service,event,receiver_url,status,signing_secret)
      VALUES($1,$2,$3,'stripe','payment_intent.succeeded','https://synthetic.test/events','registering','synthetic-secret')`,[HOOK,APP,CONNECTOR]);
    await db.query(`INSERT INTO agent_subscriptions(id,workspace_id,room_id,agent_id,source,event,prompt,webhook_suffix,webhook_token_created_at,service_channel_id)
      VALUES($1,$3,$5,$7,'webhook','webhook.called','First','stub','2026-01-01',$8),($2,$4,$6,$7,'webhook','webhook.called','Second','stub','2026-01-01',$9)`,[SUB,OTHER_SUB,WS,OTHER,ROOM,OTHER_ROOM,AGENT,SUB,OTHER_SUB]);
    await db.query(`INSERT INTO agent_subscriptions(id,workspace_id,room_id,agent_id,source,event,prompt,service_app_id,trigger_id)
      VALUES($1,$2,$3,$4,'service','payment_intent.succeeded','Service',$5,$6)`,[SERVICE,WS,PARENT,AGENT,APP,HOOK]);
    await db.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at)
      VALUES($1,$2,$3,$4,$5,'{"kind":"interval","everyMinutes":10}','Task','2099-01-01')`,[SCHEDULE,WS,ROOM,AGENT,OWNER]);
  });
  afterEach(async()=>{await db.close();});
  const head=async(ws=WS)=>Number((await db.query<{sequence:string}>(`SELECT sequence::text FROM live_streams WHERE id=$1`,[`workspace:${ws}`])).rows[0]!.sequence);
  const causes=async(from:number,ws=WS)=>(await db.query<{event:Record<string,any>}>(`SELECT event FROM live_journal WHERE stream_id=$1 AND sequence>$2
    AND(event->>'sourceTable'='scheduled-work-projection' OR event ? 'scheduledWorkSource') ORDER BY live_journal.sequence`,[`workspace:${ws}`,from])).rows.flatMap(({event})=>
      event.scheduledWorkSource?event.scheduledWorkSource.targets?.map((target:Record<string,unknown>)=>({sourceTable:'scheduled-work-projection',
        originTable:event.sourceTable,operation:event.operation,sourceRoomId:target.roomId,scheduledWorkReaders:target.readers}))??[]:[event]);
  const build=(room=PARENT)=>db.transaction(async tx=>{await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');return buildRoomSchedulesProjection(tx,room,OWNER,'https://synthetic.test');});
  it('provider status changes exactly its owning surface; signing secrets never enter causes or create a display wake',async()=>{
    const before=await head(),other=await head(OTHER);
    await db.query(`UPDATE provider_webhooks SET signing_secret='rewrapped-synthetic-secret' WHERE id=$1`,[HOOK]);expect(await head()).toBe(before);
    const old=await build();await db.query(`UPDATE provider_webhooks SET status='active' WHERE id=$1`,[HOOK]);
    expect(await build()).not.toEqual(old);expect(await head(OTHER)).toBe(other);
    expect(await causes(before)).toEqual([expect.objectContaining({originTable:'provider_webhooks',sourceRoomId:PARENT})]);
    expect(JSON.stringify(await causes(before))).not.toContain('secret');expect(JSON.stringify(await causes(before))).not.toContain('active');
  });
  it('displayed webhook calls capture old/new parent Workspaces across a move; private dedupe-only writes stay silent',async()=>{
    await db.query(`INSERT INTO subscription_webhook_calls(id,subscription_id,outcome,byte_size,reason) VALUES($1,$2,'refused',12,'Synthetic refusal')`,[CALL,SUB]);
    const before=await head(),other=await head(OTHER),old=await build();
    await db.query(`UPDATE subscription_webhook_calls SET delivery_hash='synthetic-dedupe' WHERE id=$1`,[CALL]);expect(await head()).toBe(before);
    await db.query(`UPDATE subscription_webhook_calls SET subscription_id=$2 WHERE id=$1`,[CALL,OTHER_SUB]);
    expect(await build()).not.toEqual(old);expect((await causes(before))[0]).toMatchObject({sourceRoomId:PARENT});
    expect((await causes(other,OTHER))[0]).toMatchObject({sourceRoomId:OTHER_PARENT});
    const after=await head(OTHER);await db.query(`DELETE FROM subscription_webhook_calls WHERE id=$1`,[CALL]);expect(await head(OTHER)).toBeGreaterThan(after);
  });
  it('agent names alter both affected displays, while a human public-profile change produces zero Scheduled Work causes',async()=>{
    const first=await head(),second=await head(OTHER),old=await build();
    await db.query(`UPDATE identities SET name='Renamed owner' WHERE id=$1`,[OWNER]);expect(await causes(first)).toEqual([]);expect(await build()).toEqual(old);
    await db.query(`UPDATE identities SET name='Renamed helper' WHERE id=$1`,[AGENT]);expect(await build()).not.toEqual(old);
    expect(await causes(first)).toContainEqual(expect.objectContaining({sourceRoomId:PARENT}));
    expect(await causes(second,OTHER)).toContainEqual(expect.objectContaining({sourceRoomId:OTHER_PARENT}));
  });
  it('captures inherited membership subscriptions and per-corner overrides at the parent surface',async()=>{
    const before=await head(),old=await build();
    await db.query(`UPDATE memberships SET event_subscriptions='["joined"]' WHERE room_id=$1 AND identity_id=$2`,[PARENT,AGENT]);
    const changed=await build();expect(changed).not.toEqual(old);expect(await causes(before)).toContainEqual(expect.objectContaining({sourceRoomId:PARENT}));
    const next=await head();await db.query(`INSERT INTO corner_person_state(corner_id,identity_id,event_subscriptions) VALUES($1,$2,'[]')
      ON CONFLICT(corner_id,identity_id) DO UPDATE SET event_subscriptions='[]'`,[ROOM,AGENT]);
    expect(await build()).not.toEqual(changed);expect(await causes(next)).toContainEqual(expect.objectContaining({originTable:'corner_person_state',sourceRoomId:PARENT}));
  });
  it('reviewer selection changes legacy check subscriptions and advances the owning surface',async()=>{
    await db.query(`UPDATE memberships SET event_subscriptions='["check-passed"]' WHERE room_id=$1 AND identity_id=$2`,[PARENT,AGENT]);
    const before=await head(),old=await build();await db.query(`UPDATE rooms SET reviewer_agent_id=$1 WHERE id=$2`,[AGENT,PARENT]);
    expect(await build()).not.toEqual(old);expect(await causes(before)).toContainEqual(expect.objectContaining({originTable:'rooms',sourceRoomId:PARENT}));
  });
  it('captures both old and new parents when a child moves between Workspaces',async()=>{
    const first=await head(),second=await head(OTHER),old=await build();
    await db.query(`UPDATE rooms SET parent_id=$1,workspace_id=$2 WHERE id=$3`,[OTHER_PARENT,OTHER,ROOM]);
    expect(await build()).not.toEqual(old);expect(await causes(first)).toContainEqual(expect.objectContaining({sourceRoomId:PARENT}));
    expect(await causes(second,OTHER)).toContainEqual(expect.objectContaining({sourceRoomId:OTHER_PARENT}));
  });
  it('captures both parent scopes when a subscription moves between child Rooms',async()=>{
    const first=await head(),second=await head(OTHER),old=await build();
    await db.query(`UPDATE agent_subscriptions SET room_id=$1,workspace_id=$2 WHERE id=$3`,[OTHER_ROOM,OTHER,SUB]);
    expect(await build()).not.toEqual(old);expect(await causes(first)).toContainEqual(expect.objectContaining({sourceRoomId:PARENT}));
    expect(await causes(second,OTHER)).toContainEqual(expect.objectContaining({sourceRoomId:OTHER_PARENT}));
  });
  it('captures both parents when an unchanged event override moves to another corner',async()=>{
    await db.query(`UPDATE memberships SET event_subscriptions='["joined"]' WHERE identity_id=$1 AND room_id IS NOT NULL`,[AGENT]);
    await db.query(`INSERT INTO corner_person_state(corner_id,identity_id,event_subscriptions) VALUES($1,$2,'[]')`,[ROOM,AGENT]);
    const old=await build(),otherOld=await build(OTHER_PARENT),first=await head(),second=await head(OTHER);
    await db.query(`UPDATE corner_person_state SET corner_id=$1 WHERE corner_id=$2 AND identity_id=$3`,[OTHER_ROOM,ROOM,AGENT]);
    expect(await build()).not.toEqual(old);expect(await build(OTHER_PARENT)).not.toEqual(otherOld);
    expect(await causes(first)).toContainEqual(expect.objectContaining({originTable:'corner_person_state',sourceRoomId:PARENT}));
    expect(await causes(second,OTHER)).toContainEqual(expect.objectContaining({originTable:'corner_person_state',sourceRoomId:OTHER_PARENT}));
  });
  it('captures both parents when an unchanged reviewer override moves to another corner',async()=>{
    await db.query(`UPDATE memberships SET event_subscriptions='["check-passed"]' WHERE identity_id=$1 AND room_id IS NOT NULL`,[AGENT]);
    await db.query(`INSERT INTO corner_facts(corner_id,reviewer_agent_id) VALUES($1,$2)`,[ROOM,AGENT]);
    const old=await build(),otherOld=await build(OTHER_PARENT),first=await head(),second=await head(OTHER);
    await db.query(`UPDATE corner_facts SET corner_id=$1 WHERE corner_id=$2`,[OTHER_ROOM,ROOM]);
    expect(await build()).not.toEqual(old);expect(await build(OTHER_PARENT)).not.toEqual(otherOld);
    expect(await causes(first)).toContainEqual(expect.objectContaining({originTable:'corner_facts',sourceRoomId:PARENT}));
    expect(await causes(second,OTHER)).toContainEqual(expect.objectContaining({originTable:'corner_facts',sourceRoomId:OTHER_PARENT}));
  });
  it('a displayed webhook-call identity change advances the owning surface even with unchanged call fields',async()=>{
    await db.query(`INSERT INTO subscription_webhook_calls(id,subscription_id,outcome,byte_size) VALUES($1,$2,'skipped',12)`,[CALL,SUB]);
    const old=await build(),first=await head();
    await db.query(`UPDATE subscription_webhook_calls SET id=$1 WHERE id=$2`,[CONNECTOR,CALL]);
    expect(await build()).not.toEqual(old);expect(await causes(first)).toContainEqual(expect.objectContaining({originTable:'subscription_webhook_calls',sourceRoomId:PARENT}));
  });
  it('a displayed schedule identity change advances the owning surface even with unchanged schedule fields',async()=>{
    const old=await build(),first=await head();await db.query(`UPDATE agent_schedules SET id=$1 WHERE id=$2`,[CALL,SCHEDULE]);
    expect(await build()).not.toEqual(old);expect(await causes(first)).toContainEqual(expect.objectContaining({originTable:'agent_schedules',sourceRoomId:PARENT}));
  });
  it('a provider identity move captures the former text-linked subscription status dependency',async()=>{
    await db.query(`UPDATE provider_webhooks SET status='active' WHERE id=$1`,[HOOK]);
    const old=await build(),first=await head();await db.query(`UPDATE provider_webhooks SET id=$1 WHERE id=$2`,[CALL,HOOK]);
    expect(await build()).not.toEqual(old);expect(await causes(first)).toContainEqual(expect.objectContaining({originTable:'provider_webhooks',sourceRoomId:PARENT}));
  });
  it('captures an agent deletion before FK cascades erase its old membership audience',async()=>{
    // Scheduled rows retain a restrictive agent reference. Retire that work
    // first, then exercise the actual permitted identity/cascade transition.
    await db.query(`DELETE FROM agent_schedules WHERE agent_id=$1`,[AGENT]);
    const first=await head(),second=await head(OTHER),old=await build();await db.query(`DELETE FROM identities WHERE id=$1`,[AGENT]);
    expect(await build()).not.toEqual(old);expect(await causes(first)).toContainEqual(expect.objectContaining({originTable:'identities',sourceRoomId:PARENT}));
    expect(await causes(second,OTHER)).toContainEqual(expect.objectContaining({originTable:'identities',sourceRoomId:OTHER_PARENT}));
  });
  it('stored due/run progress changes the display; pure reads do not discover time or mutate a journal',async()=>{
    const old=await build(),before=await head();
    await db.query(`UPDATE agent_schedules SET next_run_at='2100-01-01',run_count=1 WHERE id=$1`,[SCHEDULE]);
    const changed=await build();expect(changed).not.toEqual(old);expect(await causes(before)).toContainEqual(expect.objectContaining({sourceRoomId:PARENT}));
    await db.query(`CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS 'SELECT ''2030-01-01''::timestamptz'; SET search_path=public,pg_catalog`);
    const fixed=await build(),position=await head();
    await db.query(`CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS 'SELECT ''2150-01-01''::timestamptz'`);
    expect((await db.query(`SELECT extract(year FROM now())::int AS clock_year`)).rows[0]!.clock_year).toBe(2150);
    expect(await build()).toEqual(fixed);expect(await head()).toBe(position);
  });
});
