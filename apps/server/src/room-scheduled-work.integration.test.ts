import {createHash} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {ReadLanes,type LaneBatch} from '../../../packages/net/src/private/read-lanes.js';
import {RouterBatchAssembly} from '../../../packages/net/src/private/batch-assembly.js';
import {migratedDatabase,type PgliteDatabase} from './test-support.js';
import {PhoneService} from './phone-service.js';
import {LiveHub} from './live.js';
import {routerSocketProtocol} from './router-socket.js';
import {SCHEDULED_WORK_AUTHORITY_SCHEMA} from './scheduled-work-authority.js';
import {ROOM_SCHEDULES_CAPTURE_SCHEMA} from './room-schedules-capture.js';
import {createPhoneOperationDispatcher} from './phone-operations.js';
import {phoneReadLimits} from './phone-read-limit.js';
import type {ServerOptions} from './server.js';
const OWNER='a'.repeat(64),AGENT='b'.repeat(64);
const WS='11111111-1111-4111-8111-111111111111',ROOM='22222222-2222-4222-8222-222222222222',DM='33333333-3333-4333-8333-333333333333';
const SCHEDULE='44444444-4444-4444-8444-444444444444';
const input=(roomId=ROOM)=>({family:'room-scheduled-work' as const,roomId});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
const settle=async()=>{for(let i=0;i<50;i++)await Promise.resolve();};
describe('complete negotiated Scheduled Work family',()=>{
  let db:PgliteDatabase,phone:PhoneService;
  beforeEach(async()=>{
    db=await migratedDatabase();await db.query(SCHEDULED_WORK_AUTHORITY_SCHEMA);await db.query(ROOM_SCHEDULES_CAPTURE_SCHEMA);
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Helper')`,[OWNER,AGENT]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`,[WS]);
    await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Public Room')`,[ROOM,WS,OWNER]);
    await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name,direct_participants) VALUES($1,$2,$3,'Own DM',$4::jsonb)`,[DM,WS,OWNER,JSON.stringify([OWNER,AGENT])]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$4,'owner'),($1,$2,$5,'member'),($1,$3,$4,'member'),($1,$3,$5,'member')`,[WS,ROOM,DM,OWNER,AGENT]);
    phone=new PhoneService(db,'https://synthetic.test');
  });
  afterEach(async()=>{await db.close();});
  function connection(){
    const live=new LiveHub(),frames:Record<string,any>[]=[],batches:LaneBatch[]=[],applications:Promise<void>[]=[];
    const lanes=new ReadLanes({origin:'https://synthetic.test',principal:OWNER,sessionEpoch:1},()=>true);
    let onCommit:(()=>void)|undefined,reads=0,builds=0;
    const original=phone.buildRouterValue.bind(phone);phone.buildRouterValue=async(...args)=>{builds++;return original(...args);};
    const assembly=new RouterBatchAssembly(facts=>createHash('sha256').update(JSON.stringify(facts)).digest('hex'),batch=>{
      batches.push(batch);applications.push(lanes.accept(batch));
    },()=>{throw new Error('Unexpected batch fault');});
    const protocol=routerSocketProtocol(db,OWNER,raw=>{
      const frame=JSON.parse(raw);frames.push(frame);
      if(frame.kind==='push-part'||frame.kind==='push-commit')assembly.accept(frame);
      if(frame.kind==='authority-fence'){
        const epoch=frame.authority.scopes.find((item:any)=>item.authorityScope===frame.authorityScope).epoch;
        applications.push(frame.mode==='advance'?lanes.advance(frame.authorityScope,epoch):lanes.revoke(frame.authorityScope,epoch));
      }
      if(frame.kind==='push-commit')onCommit?.();
    },{families:['room-scheduled-work'],listenerReady:()=>true,commandDedupV1:true},{live,phone,rooms:()=>{throw new Error('No transport inventory');}});
    const start=async()=>{
      await protocol.handle({type:'router-negotiate',protocol:1,families:['room-scheduled-work'],authorityFencesV1:true});
      lanes.connected(1,['room-scheduled-work'],async args=>{
        reads++;const value=await protocol.snapshot(args);await protocol.fenceReply('readRouterSnapshot',{...args},value,()=>undefined);return value;
      });
    };
    const demand=async(room=ROOM)=>{
      const done=deferred(),request=input(room);const stop=lanes.subscribe(request,()=>{if(lanes.peek(request).state==='LIVE')done.resolve();});
      const release=lanes.demand(request,{}, {isCurrent:()=>true});await done.promise;await settle();stop();return release;
    };
    const change=async(work:()=>Promise<unknown>)=>{
      const done=deferred();onCommit=done.resolve;await work();live.journalChanged([`authority:${OWNER}`,`workspace:${WS}`]);
      await done.promise;await Promise.all(applications);await settle();return batches.at(-1)!;
    };
    return {live,frames,batches,lanes,protocol,start,demand,change,reads:()=>reads,builds:()=>builds};
  }
  it('a committed schedule update supplies the complete display at its cut with one initial read',async()=>{
    const c=connection();try{
      await c.start();expect(c.frames[0]).toMatchObject({type:'router-capabilities',families:['room-scheduled-work']});await c.demand();
      const batch=await c.change(()=>db.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at)
        VALUES($1,$2,$3,$4,$5,'{"kind":"interval","everyMinutes":10}','Do the scheduled work','2099-01-01')`,[SCHEDULE,WS,ROOM,AGENT,OWNER]));
      expect(c.lanes.peek(input())).toMatchObject({state:'LIVE',value:{roomName:'Public Room',schedules:[{id:SCHEDULE,message:'Do the scheduled work'}],subscriptions:[]},cut:batch.to});
      expect(c.reads()).toBe(1);expect(c.batches.at(-1)!.facts.every(fact=>fact.atomicGroup===`room-scheduled-work:${ROOM}:${OWNER}`||fact.atomicGroup===`room-scheduled-work:${DM}:${OWNER}`)).toBe(true);
    }finally{c.protocol.close();}
  });
  it('an unrelated Workspace header source runs zero Scheduled Work builders and supplies only classification',async()=>{
    const c=connection();try{
      await c.start();await c.demand();const builds=c.builds(),cut=c.lanes.peek(input()).cut;
      const batch=await c.change(()=>db.query(`UPDATE workspaces SET name='Unrelated header' WHERE id=$1`,[WS]));
      expect(batch.facts.every(fact=>fact.payload.kind==='authority-fence')).toBe(true);expect(c.builds()).toBe(builds);
      expect(c.lanes.peek(input())).toMatchObject({state:'LIVE',cut});expect(c.reads()).toBe(1);
    }finally{c.protocol.close();}
  });
  it('an actual durable Stop completion settles the command while its committed source supplies the complete display without another read',async()=>{
    await db.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at)
      VALUES($1,$2,$3,$4,$5,'{"kind":"interval","everyMinutes":10}','Stop this task','2099-01-01')`,[SCHEDULE,WS,ROOM,AGENT,OWNER]);
    const c=connection(),dispatch=createPhoneOperationDispatcher({database:db,phone,live:c.live} as ServerOptions,phoneReadLimits());
    try{
      await c.start();await c.demand();expect((c.lanes.peek(input()).value as {schedules:unknown[]}).schedules).toHaveLength(1);
      const args={roomId:ROOM,scheduleId:SCHEDULE},command={v:1 as const,id:'actual-scheduled-stop'};
      let receipt:unknown;
      const batch=await c.change(async()=>{receipt=await dispatch('deleteRoomSchedule',args,OWNER,undefined,undefined,command);});
      expect(receipt).toMatchObject({state:'committed',operation:'deleteRoomSchedule',commandId:command.id});
      expect(c.lanes.peek(input())).toMatchObject({state:'LIVE',value:{schedules:[],subscriptions:[]},cut:batch.to});expect(c.reads()).toBe(1);
      const head=(await db.query(`SELECT sequence::text FROM live_streams WHERE id=$1`,[`workspace:${WS}`])).rows[0]!.sequence;
      expect(await dispatch('deleteRoomSchedule',args,OWNER,undefined,undefined,command)).toEqual(receipt);
      expect((await db.query(`SELECT sequence::text FROM live_streams WHERE id=$1`,[`workspace:${WS}`])).rows[0]!.sequence).toBe(head);expect(c.reads()).toBe(1);
    }finally{c.protocol.close();}
  });
  it('regrant after an intentionally omitted interval parks only the public group; own DM continues and explicit Retry owns its sole replacement read',async()=>{
    const c=connection();try{
      await c.start();await c.demand();await c.demand(DM);
      await c.change(()=>db.query(`UPDATE memberships SET role='member' WHERE room_id IS NULL AND identity_id=$1`,[OWNER]));
      expect(c.lanes.peek(input())).toMatchObject({state:'REVOKED',value:null});expect(c.lanes.peek(input(DM)).state).toBe('LIVE');
      await c.change(()=>db.query(`UPDATE workspaces SET name='Intervening unrelated source' WHERE id=$1`,[WS]));
      await c.change(()=>db.query(`UPDATE memberships SET role='admin' WHERE room_id IS NULL AND identity_id=$1`,[OWNER]));
      expect(c.lanes.peek(input())).toMatchObject({state:'PARKED',value:null,error:expect.stringContaining('Retry')});expect(c.reads()).toBe(2);
      await c.change(()=>db.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at)
        VALUES($1,$2,$3,$4,$5,'{"kind":"interval","everyMinutes":10}','DM continues','2099-01-01')`,[SCHEDULE,WS,DM,AGENT,OWNER]));
      expect(c.lanes.peek(input(DM))).toMatchObject({state:'LIVE',value:{schedules:[{message:'DM continues'}]}});expect(c.reads()).toBe(2);
      const ready=deferred(),stop=c.lanes.subscribe(input(),()=>{if(c.lanes.peek(input()).state==='LIVE')ready.resolve();});
      c.lanes.retry(input(),{isCurrent:()=>true});await ready.promise;stop();expect(c.reads()).toBe(3);
    }finally{c.protocol.close();}
  });
  it.each([false,true])('unsupported command/authority cohort (%s) stays unadvertised and refuses a new-family snapshot',async command=>{
    const frames:Record<string,any>[]=[],live=new LiveHub();
    const protocol=routerSocketProtocol(db,OWNER,raw=>frames.push(JSON.parse(raw)),
      {families:['room-scheduled-work'],listenerReady:()=>true,commandDedupV1:command},{live,phone,rooms:()=>[]});
    try{
      await protocol.handle({type:'router-negotiate',protocol:1,families:['room-scheduled-work'],authorityFencesV1:!command});
      expect(frames[0]).toMatchObject({type:'router-capabilities',families:[]});await expect(protocol.snapshot(input())).rejects.toMatchObject({status:409});
    }finally{protocol.close();}
  });
});
