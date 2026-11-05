import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresDatabase, type SqlDatabase } from './database.js';
import { VoiceAudioMeter, VoiceBudgetStore } from './voice-budget.js';

const url=process.env.BEELINE_VOICE_TEST_POSTGRES_URL;
if(url&&!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))
  throw new Error('Voice ownership proofs require isolated loopback PostgreSQL');
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};

describe.skipIf(!url)('F17 voice durable admission and final owner fence, real PostgreSQL',()=>{
  it('retains charged admission, denies a prior takeover and holds the exact owner row through synchronous enqueue',async()=>{
    const schema=`voice_meter_${randomUUID().replaceAll('-','')}`;
    const admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA ${schema}`);
    const config={connectionString:url,options:`-c search_path=${schema},public`,max:2};
    const first=new PostgresDatabase('',2,{pool:new Pool(config)}),second=new PostgresDatabase('',2,{pool:new Pool(config)});
    const now=Date.now(),entered=deferred(),release=deferred();let pause=false;
    const wrap=(database:SqlDatabase):SqlDatabase=>({
      transaction:work=>database.transaction(tx=>work(wrap(tx))),
      query:async(sql,values)=>{const result=await database.query(sql,values);
        if(pause&&sql.includes('ended_at IS NULL FOR SHARE')){pause=false;entered.resolve();await release.promise;}return result;},
    });
    try{
      await first.query(`CREATE TABLE rooms(id text PRIMARY KEY,workspace_id text);
        CREATE TABLE voice_calls(id text PRIMARY KEY,room_id text,runtime_owner text,runtime_until timestamptz,ended_at timestamptz);
        CREATE TABLE voice_workspace_usage(workspace_id text,call_id text,day_start bigint,audio int8multirange DEFAULT '{}',PRIMARY KEY(workspace_id,call_id,day_start));
        INSERT INTO rooms VALUES('room','workspace');
        INSERT INTO voice_calls VALUES('call','room','owner',clock_timestamp()+interval '1 minute',NULL);`);
      const budget=new VoiceBudgetStore(wrap(first),10_000,()=>now),replacement=new VoiceBudgetStore(second,10_000,()=>now);
      await budget.record('call','owner','workspace',[[now-20,now]]);
      await second.query("UPDATE voice_calls SET runtime_owner='successor' WHERE id='call'");
      let enqueues=0;expect(await budget.fence('call','owner',()=>{enqueues++;})).toBe(false);
      expect(enqueues).toBe(0);expect((await replacement.read('workspace')).remainingMs).toBe(9980);
      await second.query("UPDATE voice_calls SET runtime_owner='owner' WHERE id='call'");
      pause=true;const guarded=budget.fence('call','owner',()=>{enqueues++;});await entered.promise;
      await expect(second.transaction(async tx=>{
        await tx.query("SET LOCAL lock_timeout='100ms'");
        await tx.query("UPDATE voice_calls SET runtime_owner='successor' WHERE id='call'");
      })).rejects.toMatchObject({code:'55P03'});
      expect(enqueues).toBe(0);release.resolve();expect(await guarded).toBe(true);expect(enqueues).toBe(1);
      await second.query("UPDATE voice_calls SET runtime_owner='successor' WHERE id='call'");
      expect(await budget.fence('call','owner',()=>{enqueues++;})).toBe(false);expect(enqueues).toBe(1);
      expect((await replacement.read('workspace')).remainingMs).toBe(9980);
    }finally{release.resolve();await Promise.all([first.close(),second.close()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
  });

  it('survives a crash boundary after durable commit but before acknowledgment without unbilled forwarding or a duplicate charge',async()=>{
    const schema=`voice_crash_${randomUUID().replaceAll('-','')}`;
    const admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA ${schema}`);
    const config={connectionString:url,options:`-c search_path=${schema},public`,max:2};
    const first=new PostgresDatabase('',2,{pool:new Pool(config)}),second=new PostgresDatabase('',2,{pool:new Pool(config)});
    const now=Date.now(),committed=deferred(),ack=deferred();let meter:VoiceAudioMeter|undefined;
    try{
      await first.query(`CREATE TABLE rooms(id text PRIMARY KEY,workspace_id text);
        CREATE TABLE voice_calls(id text PRIMARY KEY,room_id text,runtime_owner text,runtime_until timestamptz,ended_at timestamptz);
        CREATE TABLE voice_workspace_usage(workspace_id text,call_id text,day_start bigint,audio int8multirange DEFAULT '{}',PRIMARY KEY(workspace_id,call_id,day_start));
        INSERT INTO rooms VALUES('room','workspace');
        INSERT INTO voice_calls VALUES('call','room','owner',clock_timestamp()+interval '1 minute',NULL);`);
      const store=new VoiceBudgetStore(first,10_000,()=>now),restored=new VoiceBudgetStore(second,10_000,()=>now);
      const record=store.record.bind(store);store.record=async(...args)=>{const result=await record(...args);committed.resolve();await ack.promise;return result;};
      let sent=0;meter=new VoiceAudioMeter(store,'call','owner','workspace',await store.read('workspace'),()=>{},()=>{},()=>now);
      meter.capture(new Int16Array(320),now,()=>{sent++;});const flush=meter.flush();await committed.promise;
      expect((await restored.read('workspace')).remainingMs).toBe(9980);expect(sent).toBe(0);
      const closed=meter.close();ack.resolve();await Promise.all([flush,closed]);expect(sent).toBe(0);
      await restored.record('call','owner','workspace',[[now-20,now]]);
      expect((await restored.read('workspace')).remainingMs).toBe(9980);
    }finally{ack.resolve();await meter?.close();await Promise.all([first.close(),second.close()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
  });
});
