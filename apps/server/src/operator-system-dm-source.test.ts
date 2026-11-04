import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import type { SqlDatabase } from './database.js';
import { migratedDatabase,type PgliteDatabase } from './test-support.js';
import { BackgroundWork } from './background-work.js';
import { BackgroundJobRunner } from './background.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { claimAgentCommand,createAgentCommand } from './agent-command.js';
import { COMMAND_COMPLETION_CHANNEL,notifyCommandCompletion,recoverCommandCompletions } from './command-completion.js';
import { OPERATOR_OWNER_ID as OWNER,OPERATOR_SYSTEM_DM_SCHEMA,deliverOperatorSystemDmBatch,subscribeOperatorSystemDmDeliveries } from './operator-system-dm.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
vi.mock('./sentry.js',async original=>({...await original<typeof import('./sentry.js')>(),captureServerError:vi.fn()}));
const agent='c'.repeat(64),person='d'.repeat(64),workspace='11111111-1111-4111-8111-111111111111',room='22222222-2222-4222-8222-222222222222';
const observed=(database:SqlDatabase,queries:string[]):SqlDatabase=>({
  query:(sql,values)=>{queries.push(sql);return database.query(sql,values);},
  transaction:work=>database.transaction(tx=>work(observed(tx,queries))),
});

describe('System DM committed delivery source without minute discovery',()=>{
  let db:PgliteDatabase,daemon:DaemonService,releaseListen:()=>Promise<void>;
  const notifications:string[]=[];
  beforeAll(async()=>{
    db=await migratedDatabase();await db.query(OPERATOR_SYSTEM_DM_SCHEMA);
    releaseListen=await db.client.listen(COMMAND_COMPLETION_CHANNEL,payload=>{notifications.push(payload);notifyCommandCompletion(payload);});
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Operator','synthetic-operator'),
      ($2,'agent','Worker','synthetic-worker'),($3,'human','Recipient','synthetic-recipient')`,[OWNER,agent,person]);
    await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)',[agent,OWNER]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'System DM source proof')`,[workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Source proof')`,[room,workspace]);
    for(const identity of [OWNER,agent,person])await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`,[workspace,identity,room]);
    daemon=new DaemonService(db,new LiveHub(),undefined,undefined,false,undefined,false,undefined,undefined,undefined,
      {enabled:false},undefined,undefined,undefined,{config:{repository:'Beeline-Work/beeline',systemSenders:[OWNER]}});
  },60000);
  afterAll(async()=>{vi.useRealTimers();await releaseListen();await db.close();});
  const send=async(recipients:string,text:string)=>{
    const id=randomUUID();await db.query('INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)',[id,room,OWNER,'Synthetic System DM command']);
    const command=await createAgentCommand(db,{roomId:room,agentId:agent,sourceMessageId:id,reason:'human_tag'}),generation=randomUUID();
    await claimAgentCommand(db,room,agent,command!.id,generation);
    return daemon.execute('sendOperatorSystemDm',{agentId:agent,roomId:room,requestId:command!.turn_request_id,generationId:generation,recipients,text},agent);
  };
  it('reads once at acquisition, emits only after real commit, delivers once, and performs zero idle-day queue reads',async()=>{
    vi.useFakeTimers();let now=0,wake!:()=>void;const queries:string[]=[],work=new BackgroundWork(()=>now,()=>{});
    work.addDeadline('system-dm',()=>deliverOperatorSystemDmBatch(observed(db,queries)));
    const stop=subscribeOperatorSystemDmDeliveries(()=>{work.wake('system-dm');wake?.();});
    try{
      expect(await work.run(true)).toBe(Infinity);const initial=queries.length;
      await vi.advanceTimersByTimeAsync(86_400_000);now+=86_400_000;
      expect(await work.run(false)).toBe(Infinity);expect(queries).toHaveLength(initial);
      const changed=new Promise<void>(resolve=>{wake=resolve;});
      const text='Synthetic committed notice',sent=await send(person,text);await changed;
      expect(await work.run(false)).toBe(Infinity);
      expect((await db.query('SELECT state FROM operator_system_dm_deliveries WHERE send_id=$1',[sent.sendId])).rows).toEqual([{state:'delivered'}]);
      expect((await db.query('SELECT id FROM messages WHERE author_id=$1 AND text=$2',[SYSTEM_IDENTITY_ID,text])).rows).toHaveLength(1);
      expect(notifications.map(payload=>JSON.parse(payload)).filter(key=>key.principal==='system-dm')).toEqual([{principal:'system-dm',operation:'deliver',commandId:'pending'}]);
      const settled=queries.length,notificationCount=notifications.length;
      await expect(db.transaction(async tx=>{await tx.query(`UPDATE operator_system_dm_deliveries SET state='pending' WHERE send_id=$1`,[sent.sendId]);throw new Error('Synthetic rollback');})).rejects.toThrow('Synthetic rollback');
      expect(notifications).toHaveLength(notificationCount);expect(await work.run(false)).toBe(Infinity);expect(queries).toHaveLength(settled);
      await vi.advanceTimersByTimeAsync(86_400_000);now+=86_400_000;
      expect(await work.run(false)).toBe(Infinity);expect(queries).toHaveLength(settled);
    }finally{stop();vi.useRealTimers();}
  });
  it('resumes only from an actual source/recovery and drains remaining real recipients in bounded batches',async()=>{
    let now=0,fail=false,wake!:()=>void;const queries:string[]=[],work=new BackgroundWork(()=>now,()=>{}),runner=new BackgroundJobRunner();
    const storage:SqlDatabase={query:(sql,values)=>db.query(sql,values),transaction:callback=>{if(fail){fail=false;throw new Error('Synthetic checkout failure');}return db.transaction(callback);}};
    work.addDeadline('system-dm',async()=>{const result=await runner.run('system-dm-source-proof',()=>deliverOperatorSystemDmBatch(observed(storage,queries)));if(result.ok)return result.value;});
    const stop=subscribeOperatorSystemDmDeliveries(()=>{work.wake('system-dm');wake?.();}),error=vi.spyOn(console,'error').mockImplementation(()=>{});
    try{
      expect(await work.run(true)).toBe(Infinity);
      for(let index=0;index<12;index++){
        const identity=(100+index).toString(16).padStart(64,'0');
        await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Synthetic recipient')`,[identity]);
        await db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member')`,[workspace,identity]);
      }
      const changed=new Promise<void>(resolve=>{wake=resolve;}),sent=await send('all','Synthetic bounded source recovery');await changed;
      fail=true;expect(await work.run(false)).toBe(Infinity);const parked=queries.length;now+=86_400_000;
      expect(await work.run(false)).toBe(Infinity);expect(queries).toHaveLength(parked);
      expect((await db.query(`SELECT count(*)::integer count FROM operator_system_dm_deliveries WHERE send_id=$1 AND state='pending'`,[sent.sendId])).rows[0]?.count).toBe(14);
      recoverCommandCompletions();expect(await work.run(false)).toBe(0);
      expect((await db.query(`SELECT count(*)::integer count FROM operator_system_dm_deliveries WHERE send_id=$1 AND state='delivered'`,[sent.sendId])).rows[0]?.count).toBeLessThanOrEqual(10);
      let next:number=0;
      for(let batch=0;batch<20&&next===0;batch++)next=await work.run(false);
      expect(next).toBe(Infinity);
      expect((await db.query(`SELECT count(*)::integer count FROM operator_system_dm_deliveries WHERE send_id=$1 AND state='delivered'`,[sent.sendId])).rows[0]?.count).toBe(14);
      expect((await db.query('SELECT id FROM messages WHERE author_id=$1 AND text=$2',[SYSTEM_IDENTITY_ID,'Synthetic bounded source recovery'])).rows).toHaveLength(14);
    }finally{stop();error.mockRestore();}
  });
});
