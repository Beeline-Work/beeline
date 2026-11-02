import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresDatabase, type SqlDatabase } from './database.js';
import { BackgroundOwnership, BACKGROUND_OWNERSHIP_SCHEMA, BACKGROUND_LEADER_LOCK_KEY } from './background-ownership.js';
import { DURABLE_LIVE_SCHEMA } from './durable-live.js';
import { ROUTER_AUTHORITY_LOCK } from './router-projection-schema.js';
import { TrayChoiceClockOwner } from './tray-choice-clock-owner.js';
import { TRAY_CLOCK_OWNER_SCHEMA } from './tray-clock-owner.js';
import { TRAY_CLOCK_SOURCE_SCHEMA } from './tray-clock-source.js';

const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(url&&!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))throw new Error('Choice clock proof requires isolated loopback PostgreSQL');
const person='a'.repeat(64),workspace='11111111-1111-4111-8111-111111111111',room='22222222-2222-4222-8222-222222222222',choice='33333333-3333-4333-8333-333333333333';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
async function fixture(){
  const schema=`choice_clock_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url,max:1});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const config={connectionString:url,options:`-c search_path=${schema},public -c lock_timeout=150ms`,max:2};
  const first=new PostgresDatabase('',2,{pool:new Pool(config)}),second=new PostgresDatabase('',2,{pool:new Pool(config)});
  const locks=new Pool({connectionString:url,max:1}),connection=await locks.connect();
  try{
    await connection.query('SELECT pg_advisory_lock($1)',[BACKGROUND_LEADER_LOCK_KEY]);
    await first.query(`CREATE TABLE identities(id text PRIMARY KEY,kind text,name text,handle text,avatar text,face_id text);
      CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,parent_id uuid,archived_at timestamptz);
      CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,removed_at timestamptz);
      CREATE TABLE messages(id text PRIMARY KEY,room_id uuid,author_id text,text text,presentation text DEFAULT 'message',
        card_type text,card jsonb,deleted_at timestamptz,created_at timestamptz DEFAULT now());
      CREATE TABLE needs_you_marks(identity_id text,message_id text,workspace_id uuid,first_seen_at timestamptz,cleared_at timestamptz);
      CREATE TABLE room_choices(id uuid PRIMARY KEY,workspace_id uuid,room_id uuid,agent_id text,message_id text,mode text,prompt text,
        constraint_text text,options jsonb,electorate text[],status text,closes_at timestamptz,workflow_run_id text);
      CREATE TABLE room_choice_votes(choice_id uuid,voter_id text,option_id text,created_at timestamptz DEFAULT now());
      CREATE TABLE live_server_instances(instance_id text PRIMARY KEY,renewed_at timestamptz NOT NULL);
      INSERT INTO live_server_instances VALUES('owner',clock_timestamp());
      INSERT INTO identities(id,kind,name) VALUES('${person}','human','Synthetic');
      INSERT INTO rooms(id,workspace_id) VALUES('${room}','${workspace}');
      INSERT INTO memberships VALUES('${workspace}',NULL,'${person}',NULL),('${workspace}','${room}','${person}',NULL);`);
    await first.query(DURABLE_LIVE_SCHEMA);await first.query(BACKGROUND_OWNERSHIP_SCHEMA);
    await first.query(TRAY_CLOCK_SOURCE_SCHEMA);await first.query(TRAY_CLOCK_OWNER_SCHEMA);
    await first.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
      VALUES('card',$1,$2,'Synthetic poll','card','choice','{"status":"open"}')`,[room,person]);
    await first.query(`INSERT INTO room_choices(id,workspace_id,room_id,agent_id,message_id,mode,prompt,options,electorate,status,closes_at)
      VALUES($1,$2,$3,$4,'card','poll','Synthetic?',$5::jsonb,$6::text[],'open',clock_timestamp()-interval '1 second')`,
    [choice,workspace,room,person,JSON.stringify([{optionId:'A',letter:'A',label:'One',consequence:'One'},{optionId:'B',letter:'B',label:'Two',consequence:'Two'}]),[person,'b'.repeat(64)]]);
  }catch(error){connection.release(true);await Promise.all([first.close(),second.close(),locks.end()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();throw error;}
  return{first,second,connection,close:async()=>{connection.release(true);await Promise.all([first.close(),second.close(),locks.end()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}};
}

describe.skipIf(!url)('real PostgreSQL owned choice expiry races',()=>{
  it('refuses a legacy-held source before its authority request instead of deadlocking or applying a partial close',async()=>{
    const f=await fixture(),held=deferred(),release=deferred();const core=new BackgroundOwnership(f.first,'owner');
    const epoch=await core.claim(f.connection);let writer:Promise<unknown>|undefined;
    try{
      writer=f.second.transaction(async tx=>{
        await tx.query('SELECT id FROM room_choices WHERE id=$1 FOR UPDATE',[choice]);held.resolve();await release.promise;
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[ROUTER_AUTHORITY_LOCK]);
        await tx.query(`UPDATE room_choices SET closes_at=closes_at+interval '1 microsecond' WHERE id=$1`,[choice]);
      });
      await held.promise;await expect(new TrayChoiceClockOwner(core).drain(epoch)).rejects.toMatchObject({code:'55P03'});
      expect((await f.first.query('SELECT status FROM room_choices')).rows).toEqual([{status:'open'}]);
      expect((await f.first.query('SELECT revision::text FROM tray_clock_state')).rows).toEqual([{revision:'0'}]);
      release.resolve();await writer;
      expect((await new TrayChoiceClockOwner(core).drain(epoch)).consumed).toBe(true);
    }finally{release.resolve();await writer?.catch(()=>{});core.revoke(epoch);await f.close();}
  });

  it('rolls actual poll/card/source/clock back if the lease expires after the callback and before SQL COMMIT',async()=>{
    const f=await fixture(),returned=deferred(),commit=deferred();let delay=false;
    const observed:SqlDatabase={query:(sql,args)=>f.first.query(sql,args),transaction:work=>f.first.transaction(async tx=>{
      const result=await work(tx);if(delay){returned.resolve();await commit.promise;}return result;
    })};
    const core=new BackgroundOwnership(observed,'owner'),epoch=await core.claim(f.connection);let flight:Promise<unknown>|undefined;
    try{
      await f.first.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp()-interval '88 seconds'`);delay=true;
      flight=new TrayChoiceClockOwner(core).drain(epoch);const rejected=expect(flight).rejects.toMatchObject({code:'23514'});
      await returned.promise;expect((await f.second.query('SELECT status FROM room_choices')).rows).toEqual([{status:'open'}]);
      await f.second.query('SELECT pg_sleep(2.1)');commit.resolve();await rejected;
      expect((await f.second.query('SELECT status FROM room_choices')).rows).toEqual([{status:'open'}]);
      expect((await f.second.query(`SELECT card->>'status' status FROM messages WHERE id='card'`)).rows).toEqual([{status:'open'}]);
      expect((await f.second.query('SELECT state FROM tray_clock_deadlines')).rows).toEqual([{state:'pending'}]);
      expect((await f.second.query('SELECT revision::text FROM tray_clock_state')).rows).toEqual([{revision:'0'}]);
      expect((await f.second.query('SELECT * FROM tray_clock_owner_fences')).rows).toEqual([]);
    }finally{commit.resolve();await flight?.catch(()=>{});core.revoke(epoch);await f.close();}
  });
});
