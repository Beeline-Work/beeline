import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {migratedDatabase,type PgliteDatabase} from "../../../tests/helpers/server.js";
import {PhoneService} from './phone-service.js';
import {LiveHub} from './live.js';
import {createPhoneOperationDispatcher} from './phone-operations.js';
import {phoneReadLimits} from './phone-read-limit.js';
import {SCHEDULED_WORK_AUTHORITY_SCHEMA} from './scheduled-work-authority.js';
import {ROOM_SCHEDULES_CAPTURE_SCHEMA} from './room-schedules-capture.js';
import type {ServerOptions} from './server.js';
import type {ComposioApps} from './composio-apps.js';
const OWNER='a'.repeat(64),AGENT='b'.repeat(64),READER='c'.repeat(64);
const WS='11111111-1111-4111-8111-111111111111',ROOM='22222222-2222-4222-8222-222222222222';
const SCHEDULE='33333333-3333-4333-8333-333333333333',SUB='44444444-4444-4444-8444-444444444444';
describe('Scheduled Work durable stop adapters',()=>{
  let db:PgliteDatabase;
  beforeEach(async()=>{
    db=await migratedDatabase();await db.query(SCHEDULED_WORK_AUTHORITY_SCHEMA);await db.query(ROOM_SCHEDULES_CAPTURE_SCHEMA);
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Manager'),($2,'agent','Helper'),($3,'human','Reader')`,[OWNER,AGENT,READER]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Synthetic')`,[WS]);
    await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Room')`,[ROOM,WS,OWNER]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,NULL,$4,'member'),($1,$2,$4,'member'),($1,$2,$5,'member')`,[WS,ROOM,OWNER,READER,AGENT]);
    await db.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at)
      VALUES($1,$2,$3,$4,$5,'{"kind":"interval","everyMinutes":10}','Do work','2099-01-01')`,[SCHEDULE,WS,ROOM,AGENT,OWNER]);
  });
  afterEach(async()=>{await db.close();});
  function server(provider?:Pick<ComposioApps,'deleteWebhookTrigger'>){
    const phone=new PhoneService(db,'https://synthetic.test',undefined,undefined,undefined,false,db,undefined,undefined,undefined,provider as ComposioApps|undefined);
    const reads=vi.spyOn(phone as unknown as {readScheduledWork(...args:unknown[]):Promise<unknown>},'readScheduledWork'),snapshot=vi.spyOn(phone,'readRouterSnapshot'),live=new LiveHub();
    const dispatch=createPhoneOperationDispatcher({database:db,phone,live} as ServerOptions,phoneReadLimits(),phone.execute);
    return {dispatch,reads,snapshot,live};
  }
  it('a manager without transcript membership stops once across dispatchers; the committed outcome performs no projection read',async()=>{
    const first=server(),second=server(),args={roomId:ROOM,scheduleId:SCHEDULE},identity={v:1 as const,id:'stop-once'};
    const initial=await first.dispatch('deleteRoomSchedule',args,OWNER,undefined,undefined,undefined,identity);
    expect(initial).toMatchObject({state:'committed',operation:'deleteRoomSchedule',commandId:identity.id});
    expect(initial).not.toHaveProperty('coverage');
    const publish=vi.spyOn(second.live,'publish');
    expect(await second.dispatch('deleteRoomSchedule',args,OWNER,undefined,undefined,undefined,identity)).toEqual(initial);
    expect((await db.query(`SELECT 1 FROM agent_schedules WHERE id=$1`,[SCHEDULE])).rowCount).toBe(0);
    expect((await db.query(`SELECT 1 FROM router_commands`)).rowCount).toBe(1);
    expect(first.reads).not.toHaveBeenCalled();expect(first.snapshot).not.toHaveBeenCalled();expect(second.reads).not.toHaveBeenCalled();expect(publish).not.toHaveBeenCalled();
    await expect(second.dispatch('deleteRoomSchedule',{...args,scheduleId:SUB},OWNER,undefined,undefined,undefined,identity)).rejects.toMatchObject({status:409});
  });
  it('refuses a transcript-only reader atomically and preserves legacy missing-row semantics without command metadata',async()=>{
    const s=server(),args={roomId:ROOM,scheduleId:SCHEDULE};
    await expect(s.dispatch('deleteRoomSchedule',args,READER,undefined,undefined,undefined,{v:1,id:'not-manager'})).rejects.toThrow();
    expect((await db.query(`SELECT 1 FROM router_commands`)).rowCount).toBe(0);
    expect((await db.query(`SELECT 1 FROM agent_schedules WHERE id=$1`,[SCHEDULE])).rowCount).toBe(1);
    await s.dispatch('deleteRoomSchedule',args,OWNER);
    await expect(s.dispatch('deleteRoomSchedule',args,OWNER)).rejects.toThrow('schedule not found');
    expect((await db.query(`SELECT 1 FROM router_commands`)).rowCount).toBe(0);
  });
  it('a distinct desired-state stop of an already absent row commits without a read',async()=>{
    await db.query(`DELETE FROM agent_schedules WHERE id=$1`,[SCHEDULE]);const s=server();
    expect(await s.dispatch('deleteRoomSchedule',{roomId:ROOM,scheduleId:SCHEDULE},OWNER,undefined,undefined,undefined,{v:1,id:'already-stopped'})).toMatchObject({state:'committed'});
    expect(s.reads).not.toHaveBeenCalled();expect(s.snapshot).not.toHaveBeenCalled();
  });
  it('provider response loss retains UNKNOWN and never dispatches provider cleanup twice or reads after the stop',async()=>{
    await db.query(`INSERT INTO agent_subscriptions(id,workspace_id,room_id,agent_id,source,event,repository,prompt,trigger_id)
      VALUES($1,$2,$3,$4,'repository','issue.opened','synthetic/repo','React to the event','legacy-provider-trigger')`,[SUB,WS,ROOM,AGENT]);
    const cleanup=vi.fn(async()=>{throw new Error('provider response lost');}),s=server({deleteWebhookTrigger:cleanup});
    const args={roomId:ROOM,subscriptionId:SUB},identity={v:1 as const,id:'stop-provider-once'};
    await expect(s.dispatch('deleteRoomSubscription',args,OWNER,undefined,undefined,undefined,identity)).rejects.toThrow('provider response lost');
    expect((await db.query(`SELECT 1 FROM agent_subscriptions WHERE id=$1`,[SUB])).rowCount).toBe(0);
    expect(await server({deleteWebhookTrigger:cleanup}).dispatch('deleteRoomSubscription',args,OWNER,undefined,undefined,undefined,identity)).toMatchObject({state:'unknown'});
    expect(cleanup).toHaveBeenCalledTimes(1);expect(s.reads).not.toHaveBeenCalled();expect(s.snapshot).not.toHaveBeenCalled();
  });
});
