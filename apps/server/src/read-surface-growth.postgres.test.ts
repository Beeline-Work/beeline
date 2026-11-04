import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import type {SqlDatabase} from './database.js';
import type {RouterFact} from '@beeline/api-contract/router-protocol';
import {createHash} from 'node:crypto';
import {RouterBatchAssembly} from '../../../packages/net/src/private/batch-assembly.js';
import {ROUTER_PROJECTION_SCHEMA} from './router-projection-schema.js';
import {readRouterRoomAudience} from './router-room-audience.js';
import {migrate,PostgresDatabase} from './database.js';
import {PhoneService} from './phone-service.js';
import {buildRouterSnapshot,fenceRouterEnqueue,fenceRouterBatch,encodeRouterBatch,readRouterCut} from './router-projections.js';
import {RouterBuildCoordinator,readRouterBuildTicket} from './router-build-coordinator.js';
import {subscribeAuthorityFences} from './router-authority-fences.js';
import {readTrayClockBasis} from './tray-clock-basis.js';
import {LiveHub} from './live.js';
import {routerSocketProtocol} from './router-socket.js';
import {readTraySavedTargets,buildTraySavedFacts} from './tray-saved-projection.js';
import {routerSourcePlan} from './router-source-plan.js';
import {requireScheduledWorkManager} from './subscription-webhooks.js';

const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(url&&!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))throw new Error('read growth proofs require isolated loopback PostgreSQL');
const VIEWER='a'.repeat(64),AGENT='b'.repeat(64),WS='11111111-1111-4111-8111-111111111111',ROOM='22222222-2222-4222-8222-222222222222';
const id=(n:number)=>`33333333-3333-4333-8333-${String(n).padStart(12,'0')}`;
const origin='https://synthetic.test';

describe.skipIf(!url)('complete server read surfaces in a large Workspace (real PostgreSQL)',()=>{
  let admin:Pool,db:PostgresDatabase,phone:PhoneService,name:string;
  beforeAll(async()=>{
    admin=new Pool({connectionString:url,max:1});name=`read_growth_${randomUUID().replaceAll('-','')}`;
    await admin.query(`CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8'`);
    const target=new URL(url!);target.pathname=`/${name}`;
    db=new PostgresDatabase(target.toString(),2);
    await migrate(db,{deferData:true});phone=new PhoneService(db,origin);
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Reader','reader'),($2,'agent','Helper','helper')`,[VIEWER,AGENT]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Large Workspace')`,[WS]);
    await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Room')`,[ROOM,WS,VIEWER]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member'),($1,$3,$2,'member'),($1,$3,$4,'member')`,[WS,VIEWER,ROOM,AGENT]);
  },120_000);
  afterAll(async()=>{await db?.close();if(name)await admin?.query(`DROP DATABASE ${name}`);await admin?.end();});

  it('reads more than 50 schedules and 100 agent names as an ordinary Room member; management and revocation still apply',async()=>{
    const agents=Array.from({length:101},(_,n)=>(n+100).toString(16).padStart(64,'0'));
    await db.query(`INSERT INTO identities(id,kind,name) SELECT agent,'agent','Helper '||agent FROM unnest($1::text[]) agent`,[agents]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) SELECT $1,$2,agent,'member' FROM unnest($3::text[]) agent`,[WS,ROOM,agents]);
    await db.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at)
      SELECT schedule,$1,$2,$3,$4,'{"kind":"interval","everyMinutes":10}',repeat('scheduled context ',100),'2099-01-01'
      FROM unnest($5::uuid[]) schedule`,[WS,ROOM,AGENT,VIEWER,Array.from({length:51},(_,n)=>id(n+1))]);
    await db.query(`INSERT INTO agent_subscriptions(id,workspace_id,room_id,agent_id,source,event,prompt,webhook_suffix,webhook_token_created_at)
      VALUES($1,$3,$4,$5,'webhook','webhook.called','Read the event','suffix',now()),
        ($2,$3,$4,$6,'webhook','webhook.called','Read the other event','suffix',now())`,[id(9001),id(9002),WS,ROOM,AGENT,agents[0]]);
    await db.query(`INSERT INTO subscription_webhook_calls(id,subscription_id,outcome,byte_size)
      SELECT gen_random_uuid(),CASE WHEN n<=26 THEN $1::uuid ELSE $2::uuid END,'skipped',1 FROM generate_series(1,52) n`,[id(9001),id(9002)]);
    const input={family:'room-scheduled-work' as const,roomId:ROOM};
    const snapshot=await phone.readRouterSnapshot(input,VIEWER);
    expect(snapshot.value).toMatchObject({schedules:expect.any(Array),agentNames:expect.any(Array)});
    expect((snapshot.value as {schedules:unknown[]}).schedules).toHaveLength(51);
    expect((snapshot.value as {agentNames:unknown[]}).agentNames).toHaveLength(102);
    expect((snapshot.value as {subscriptions:{recentCalls?:unknown[]}[]}).subscriptions.flatMap(row=>row.recentCalls??[])).toHaveLength(52);
    expect((await phone.execute('readScheduledWork',{roomId:ROOM},VIEWER)).subscriptions).toHaveLength(2);
    expect((await phone.execute('listRoomSchedules',{roomId:ROOM},VIEWER)).schedules).toHaveLength(51);
    expect((await phone.execute('listRoomSubscriptions',{roomId:ROOM},VIEWER)).subscriptions).toHaveLength(2);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeGreaterThan(64*1024);
    await expect(requireScheduledWorkManager(db,ROOM,VIEWER)).rejects.toThrow('workspace admins only');
    await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,[ROOM,VIEWER]);
    await expect(fenceRouterEnqueue(db,input,VIEWER,snapshot.authority,()=>undefined)).rejects.toMatchObject({reason:'authority'});
    await expect(phone.readRouterSnapshot(input,VIEWER)).rejects.toMatchObject({reason:'authority'});
    await db.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2`,[ROOM,VIEWER]);
  });

  it('returns every one of 501 questions and excludes an expired item even without global Tray clock readiness',async()=>{
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) SELECT 'ask-'||n,$1,$2,'@reader Please review question '||n||'?' FROM generate_series(1,501) n`,[ROOM,AGENT]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES('expired-ask',$1,$2,'@reader Please review?',now()-interval '8 days')`,[ROOM,AGENT]);
    await db.query(`UPDATE tray_clock_state SET ready=false WHERE workspace_id=$1`,[WS]);
    const count=await phone.readRouterSnapshot({family:'needs-you-count',workspaceId:WS},VIEWER,{trayClock:true});
    const tray=await phone.readRouterSnapshot({family:'needs-you-tray',workspaceId:WS},VIEWER,{trayClock:true});
    expect(count.value).toEqual({count:501});
    const value=tray.value as {needs:{items:{messageId:string}[]}};
    expect(value.needs.items).toHaveLength(501);expect(value.needs.items.some(item=>item.messageId==='expired-ask')).toBe(false);
    expect((await readTrayClockBasis(db,WS))?.ready).toBe(true);
    await db.query('DELETE FROM tray_clock_state WHERE workspace_id=$1',[WS]);
    expect((await phone.readRouterSnapshot({family:'needs-you-count',workspaceId:WS},VIEWER,{trayClock:true})).value).toEqual({count:501});
    const live=new LiveHub(),frames:Record<string,any>[]=[];
    const protocol=routerSocketProtocol(db,VIEWER,raw=>frames.push(JSON.parse(raw)),
      {families:['needs-you-tray','needs-you-count','needs-you-saved-page'],listenerReady:()=>true},{live,phone,rooms:()=>[]});
    try{
      await protocol.handle({type:'router-negotiate',protocol:1,families:['needs-you-tray','needs-you-count','needs-you-saved-page'],authorityFencesV1:true});
      expect(frames.find(frame=>frame.type==='router-capabilities')?.families).toContain('needs-you-tray');
      live.trayClockUnavailable();
      expect(frames.some(frame=>frame.kind==='router-unavailable')).toBe(false);
      expect((await protocol.snapshot({family:'needs-you-count',workspaceId:WS})).value).toEqual({count:501});
    }finally{protocol.close();}
  });

  it('delivers all 257 changed Saved targets and accepts a page above the old byte ceiling',async()=>{
    await db.query(`INSERT INTO message_bookmarks(identity_id,message_id,workspace_id,room_id,message_created_at,source_room_name,source_room_kind)
      SELECT $1,id,$2,$3,created_at,'Room','room' FROM messages WHERE id LIKE 'ask-%' ORDER BY id LIMIT 257`,[VIEWER,WS,ROOM]);
    await db.query(`UPDATE identities SET name=repeat('Large name ',1000) WHERE id=$1`,[AGENT]);
    const causes=(await db.query<{event:Record<string,unknown>}>(`SELECT event FROM live_journal WHERE stream_id=$1 AND event->>'sourceTable'='tray-saved-source' ORDER BY sequence DESC LIMIT 1`,[`workspace:${WS}`])).rows;
    expect(causes).toHaveLength(1);
    const plan=routerSourcePlan(causes.map(row=>row.event),VIEWER,WS);
    expect(plan.savedUnavailable).toBeUndefined();expect(plan.savedTargets).toHaveLength(257);
    expect(readTraySavedTargets(plan.savedTargets)).toHaveLength(257);
    const facts=await buildTraySavedFacts(db,WS,VIEWER,plan.savedTargets,row=>({id:row.id,kind:row.kind,name:row.name}));
    expect(facts).toHaveLength(257);
    const page=await phone.readRouterSnapshot({family:'needs-you-saved-page',workspaceId:WS},VIEWER);
    expect((page.value as {rows:unknown[]}).rows).toHaveLength(30);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeGreaterThan(64*1024);
  });

  it('rebases a roster query at the current revision after an unrelated membership edit',async()=>{
    const head=await phone.readRouterSnapshot({family:'workspace-roster',workspaceId:WS},VIEWER);
    const revision=(head.value as {revision:string}).revision;
    await db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member')`,[WS,AGENT]);
    const result=await phone.readRouterSnapshot({family:'workspace-roster',workspaceId:WS,query:{revision,q:'Helper'}},VIEWER);
    expect((result.value as {revision:string}).revision).not.toBe(revision);
    await expect(fenceRouterEnqueue(db,{family:'workspace-roster',workspaceId:WS},VIEWER,result.authority,()=>undefined)).resolves.toBeUndefined();
  });

  it('catches up 1,895 authority domains even when the bounded journal rotates',async()=>{
    const live=new LiveHub(),frames:unknown[]=[],failures:string[]=[];
    let complete!:()=>void;const delivered=new Promise<void>(done=>{complete=done;});
    const release=await subscribeAuthorityFences(db,live,VIEWER,frame=>{frames.push(frame);if(frames.length===1895)complete();return undefined;},reason=>{failures.push(reason);complete();});
    try{
      await db.transaction(async tx=>{
        // These are actual principal-addressed DB causes; the index is updated
        // transactionally by the production writer, not by a test side channel.
        for(let n=0;n<1895;n++){
          const domain=`reader:${VIEWER}:workspace:${id(10000+n)}:visibility`;
          await tx.query(`WITH added AS (INSERT INTO router_authority(scope) VALUES($1) RETURNING scope) SELECT beeline_authority_hint($2,$3,scope) FROM added`,[domain,VIEWER,id(10000+n)]);
        }
      });
      live.journalChanged([`authority:${VIEWER}`]);await delivered;
      expect(failures).toEqual([]);expect(frames).toHaveLength(1895);
    }finally{release();}
  },60_000);

  it('fences and delivers all 1,895 Rooms including archived corners through the real net assembly',async()=>{
    // Seed only this throwaway test database on one checked-out connection.
    // The production read/fence path runs with normal trigger settings.
    await db.transaction(async tx=>{
      await tx.query('SET LOCAL session_replication_role = replica');
      await tx.query(`INSERT INTO rooms(id,workspace_id,parent_id,created_by,name,archived_at)
        SELECT ('44444444-4444-4444-8444-'||lpad(n::text,12,'0'))::uuid,$1,$2,$3,'Corner '||n,
          CASE WHEN n%2=0 THEN now() END FROM generate_series(1,1894) n`,[WS,ROOM,VIEWER]);
    });
    // The normal production installer supplies the seeded Room certificates.
    await db.query(ROUTER_PROJECTION_SCHEMA);
    expect((await db.query(`SELECT current_setting('session_replication_role') role`)).rows[0]!.role).toBe('origin');
    const audience=await readRouterRoomAudience(db,WS,VIEWER,routerSourcePlan([],VIEWER,WS));
    expect(audience).toHaveLength(1895);
    const facts:RouterFact[]=audience.map(row=>({atomicGroup:`room-head:${row.roomId}:${VIEWER}`,authority:row.authority,
      payload:{kind:'authority-fence',scope:row.roomId,authorityScope:`room:${row.roomId}`,mode:'advance'}}));
    const cut=await readRouterCut(db,WS);let delivered=0,faults=0;
    const assembly=new RouterBatchAssembly(value=>createHash('sha256').update(JSON.stringify(value)).digest('hex'),
      batch=>{delivered=batch.facts.length;},()=>{faults++;});
    await fenceRouterBatch(db,WS,VIEWER,facts,safe=>{
      expect(safe).toHaveLength(1895);
      const frames=encodeRouterBatch({...cut,through:cut.through-1},cut,safe);
      expect(frames[0]!.partCount).toBeGreaterThan(16);
      for(const frame of frames)assembly.accept(frame);
      return undefined;
    });
    expect(faults).toBe(0);expect(delivered).toBe(1895);
  },60_000);

  it('rechecks item deadlines at the same durable cut instead of reusing an expired cached Tray count',async()=>{
    const created=(await db.query<{created_at:Date}>("SELECT created_at FROM messages WHERE id='ask-1'")).rows[0]!.created_at;
    const coordinator=new RouterBuildCoordinator(),input={family:'needs-you-count' as const,workspaceId:WS};
    const read=(offset:number)=>db.transaction(async tx=>{
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const asOf=new Date(created.getTime()+offset).toISOString();
      const timed:SqlDatabase={query:(sql,args)=>tx.query(sql.replaceAll('now()',`TIMESTAMPTZ '${asOf}'`),args),transaction:work=>tx.transaction(work)};
      const ticket=await readRouterBuildTicket(timed,input,VIEWER,{schema:1,databaseScope:'expiry',version:'1',publicOrigin:origin,clockVersion:'none'},{trayClock:true});
      return coordinator.build(ticket,(tx,args,reader)=>phone.buildRouterValue(tx,args,reader,{trayClock:true}));
    });
    const before=await read(60_000),after=await read(8*24*60*60*1000);
    expect(before.value).toEqual({count:501});expect(after.value).toEqual({count:0});
    expect(after.cut).toEqual(before.cut);expect(after.clockVersion).toBe(before.clockVersion);
    expect(coordinator.stats()).toMatchObject({entries:0,builds:2});
  });

  it('serves a projection larger than the shared cache budget without retaining it',async()=>{
    const input={family:'room-list' as const,workspaceId:WS};
    const value={rooms:[],large:'x'.repeat(9*1024*1024)} as any;
    expect((await buildRouterSnapshot(db,input,VIEWER,async()=>value)).value).toEqual(value);
    const coordinator=new RouterBuildCoordinator({bytes:1024});
    const snapshot=await db.transaction(async tx=>{
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const ticket=await readRouterBuildTicket(tx,input,VIEWER,{schema:1,databaseScope:'growth',version:'1',publicOrigin:origin,clockVersion:'none'});
      return coordinator.build(ticket,async()=>value);
    });
    expect(snapshot.value).toEqual(value);expect(coordinator.stats()).toMatchObject({entries:0,bytes:0});
  });
});
