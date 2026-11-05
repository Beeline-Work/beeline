import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {migrate,PostgresDatabase} from './database.js';
import {PhoneService} from './phone-service.js';
import {requireScheduledWorkManager} from './subscription-webhooks.js';

const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(url&&!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))throw new Error('read growth proofs require isolated loopback PostgreSQL');
const VIEWER='a'.repeat(64),AGENT='b'.repeat(64),WS='11111111-1111-4111-8111-111111111111',ROOM='22222222-2222-4222-8222-222222222222';
const id=(n:number)=>`33333333-3333-4333-8333-${String(n).padStart(12,'0')}`;
const origin='https://synthetic.test';

describe.skipIf(!url)('complete plain read surfaces (real PostgreSQL)',()=>{
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
    const value=await phone.execute('readScheduledWork',{roomId:ROOM},VIEWER);
    expect(value).toMatchObject({schedules:expect.any(Array),agentNames:expect.any(Array)});
    expect((value as {schedules:unknown[]}).schedules).toHaveLength(51);
    expect((value as {agentNames:unknown[]}).agentNames).toHaveLength(102);
    expect((value as {subscriptions:{recentCalls?:unknown[]}[]}).subscriptions.flatMap(row=>row.recentCalls??[])).toHaveLength(52);
    expect((await phone.execute('readScheduledWork',{roomId:ROOM},VIEWER)).subscriptions).toHaveLength(2);
    expect((await phone.execute('listRoomSchedules',{roomId:ROOM},VIEWER)).schedules).toHaveLength(51);
    expect((await phone.execute('listRoomSubscriptions',{roomId:ROOM},VIEWER)).subscriptions).toHaveLength(2);
    expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(64*1024);
    await expect(requireScheduledWorkManager(db,ROOM,VIEWER)).rejects.toThrow('workspace admins only');
    await expect(phone.execute('deleteRoomSchedule',{roomId:ROOM,scheduleId:id(1)},VIEWER)).rejects.toThrow('workspace admins only');
    await expect(phone.execute('revealWebhookToken',{roomId:ROOM,subscriptionId:id(9001)},VIEWER)).rejects.toThrow('Workspace admin required');
    await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,[ROOM,VIEWER]);
    for(const op of ['readScheduledWork','listRoomSchedules','listRoomSubscriptions'] as const)
      await expect(phone.execute(op,{roomId:ROOM},VIEWER)).rejects.toThrow('room membership required');
    await db.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2`,[ROOM,VIEWER]);
  });

  it('reads, counts, and marks all 501 questions and checks each item deadline',async()=>{
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) SELECT 'ask-'||n,$1,$2,'@reader Please review question '||n||'?' FROM generate_series(1,501) n`,[ROOM,AGENT]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES('expired-ask',$1,$2,'@reader Please review?',now()-interval '8 days')`,[ROOM,AGENT]);
    const input={workspaceId:WS,markSeen:false};
    const needs=await phone.execute('readNeedsYou',input,VIEWER);
    expect(needs.items).toHaveLength(501);
    expect(needs.items.some(item=>item.messageId==='expired-ask')).toBe(false);
    expect(await phone.execute('countNeedsYou',{workspaceId:WS},VIEWER)).toEqual({count:501});
    expect((await phone.execute('readTray',input,VIEWER)).needs?.items).toHaveLength(501);
    const seen=await phone.execute('markNeedsYouSeen',{workspaceId:WS,messageIds:needs.items.map(item=>item.messageId)},VIEWER);
    expect(seen.seen).toHaveLength(501);
    await db.query(`UPDATE needs_you_marks SET first_seen_at=now()-interval '2 days' WHERE message_id='ask-1' AND identity_id=$1`,[VIEWER]);
    expect((await phone.execute('readNeedsYou',input,VIEWER)).items).toHaveLength(500);
    expect(await phone.execute('countNeedsYou',{workspaceId:WS},VIEWER)).toEqual({count:500});
  });
});
