import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe,expect,it,vi } from 'vitest';
import { PostgresDatabase,type SqlDatabase } from './database.js';
import { OPERATOR_SYSTEM_DM_SCHEMA,deliverOperatorSystemDmBatch,flushOperatorSystemDms } from './operator-system-dm.js';

// The full System message producer is covered by the service/PGlite proof.
// This fixture retains the real delivery claim/receipt transaction and stable
// message ID, with one durable marker for the producer's transactional effect.
vi.mock('./system-line.js',async original=>({...await original<typeof import('./system-line.js')>(),
  sendSystemDirectMessage:async(db:SqlDatabase,workspace:string,recipient:string,text:string,id:string)=>{
    await db.query('INSERT INTO proof_dm_effects(id,workspace_id,recipient_id,text) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING',[id,workspace,recipient,text]);
  }}));
const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(url&&!['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname))throw new Error('System DM proofs require isolated loopback PostgreSQL');
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {resolve,promise};};
describe.skipIf(!url)('actual System DM deadline owner transfer',()=>{
  it.each(['commit','rollback'] as const)('waits for the old worker %s and leaves exactly one effect without another wake',async outcome=>{
    const tag=randomUUID().replaceAll('-',''),schema='system_dm_'+tag,application='system_dm_deadline_'+tag;
    const admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA ${schema}`);
    const config={connectionString:url,options:`-c search_path=${schema},public`,max:2};
    const oldDb=new PostgresDatabase('',2,{pool:new Pool(config)}),newDb=new PostgresDatabase('',2,{pool:new Pool({...config,application_name:application})});
    const held=deferred(),release=deferred();let oldAttempt:Promise<unknown>|undefined,newAttempt:Promise<unknown>|undefined;
    try{
      await oldDb.query(OPERATOR_SYSTEM_DM_SCHEMA);
      await oldDb.query('CREATE TABLE proof_dm_effects(id text PRIMARY KEY,workspace_id uuid,recipient_id text,text text)');
      const sendId=randomUUID(),workspace=randomUUID();
      await oldDb.query(`INSERT INTO operator_system_dm_sends(id,caller_id,owner_id,source_message_id,recipients,text_hash,text)
        VALUES($1,'synthetic-agent','synthetic-owner','synthetic-command','["synthetic-person"]','synthetic-hash','Synthetic transfer notice')`,[sendId]);
      await oldDb.query(`INSERT INTO operator_system_dm_deliveries(send_id,recipient_id,workspace_id) VALUES($1,'synthetic-person',$2)`,[sendId,workspace]);
      const oldWorker:SqlDatabase={query:(sql,values)=>oldDb.query(sql,values),transaction:work=>oldDb.transaction(tx=>work({
        transaction:nested=>tx.transaction(nested),query:async(sql,values)=>{
          const result=await tx.query(sql,values);
          if(sql.includes('UPDATE operator_system_dm_deliveries SET state=')){
            held.resolve();await release.promise;if(outcome==='rollback')throw new Error('Synthetic old worker rollback');
          }
          return result;
        },
      }))};
      oldAttempt=flushOperatorSystemDms(oldWorker).catch(error=>error);
      await held.promise;newAttempt=deliverOperatorSystemDmBatch(newDb);
      // Observe the real backend lock wait. A SKIP LOCKED regression must fail
      // this assertion even if the test scheduler has not yet drained promises.
      await vi.waitFor(async()=>{
        expect((await admin.query(`SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'`,[application])).rowCount).toBe(1);
      },{timeout:2000,interval:10});
      expect((await newDb.query(`SELECT count(*)::integer count FROM proof_dm_effects`)).rows[0]?.count).toBe(0);
      release.resolve();const oldResult=await oldAttempt;await newAttempt;
      if(outcome==='rollback')expect(oldResult).toBeInstanceOf(Error);else expect(oldResult).toBe(1);
      expect((await newDb.query('SELECT state FROM operator_system_dm_deliveries')).rows).toEqual([{state:'delivered'}]);
      expect((await newDb.query('SELECT count(*)::integer count FROM proof_dm_effects')).rows[0]?.count).toBe(1);
      expect(await deliverOperatorSystemDmBatch(newDb)).toBeUndefined();
    }finally{
      release.resolve();await Promise.allSettled([oldAttempt,newAttempt].filter((value):value is Promise<unknown>=>value!==undefined));
      await Promise.all([oldDb.close(),newDb.close()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
    }
  },20000);
});
