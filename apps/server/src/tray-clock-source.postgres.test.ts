import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresDatabase, type SqlDatabase } from './database.js';
import { DURABLE_LIVE_SCHEMA } from './durable-live.js';
import { TRAY_CLOCK_SOURCE_SCHEMA, consumeTrayClockInTransaction, readTrayClockBasis, readTrayClockDue } from './tray-clock-source.js';

const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(url&&!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))throw new Error('Tray clock proof requires isolated loopback PostgreSQL');
const viewer='a'.repeat(64),author='b'.repeat(64);
const workspace='11111111-1111-4111-8111-111111111111',room='22222222-2222-4222-8222-222222222222';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
const clockDb=(db:SqlDatabase):SqlDatabase=>({query:(sql,args)=>db.query(sql.replaceAll('clock_timestamp()','tray_clock_test_now()'),args),
  transaction:work=>db.transaction(tx=>work(clockDb(tx)))});

async function rig(run:(reader:SqlDatabase,writer:SqlDatabase)=>Promise<void>){
  const schema=`tray_clock_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url,max:1});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const config={connectionString:url,options:`-c search_path=${schema},public`,max:2};
  const reader=new PostgresDatabase('',2,{pool:new Pool(config)}),writer=new PostgresDatabase('',2,{pool:new Pool(config)});
  try{
    await reader.query(`CREATE TABLE clock_fixture(now_at timestamptz NOT NULL);
      INSERT INTO clock_fixture VALUES('2000-01-08T00:00:00Z');
      CREATE FUNCTION tray_clock_test_now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT now_at FROM clock_fixture $$;
      CREATE TABLE identities(id text PRIMARY KEY,kind text,handle text);
      CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,parent_id uuid,archived_at timestamptz);
      CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,removed_at timestamptz);
      CREATE TABLE messages(id text PRIMARY KEY,room_id uuid,author_id text,text text,presentation text DEFAULT 'message',
        card_type text,card jsonb,deleted_at timestamptz,created_at timestamptz DEFAULT tray_clock_test_now());
      CREATE TABLE needs_you_marks(identity_id text REFERENCES identities(id) ON DELETE CASCADE,
        message_id text REFERENCES messages(id) ON DELETE CASCADE,workspace_id uuid,first_seen_at timestamptz,cleared_at timestamptz,
        PRIMARY KEY(identity_id,message_id));
      CREATE TABLE room_choices(id uuid PRIMARY KEY,workspace_id uuid,room_id uuid,status text,closes_at timestamptz);`);
    await reader.query(DURABLE_LIVE_SCHEMA);
    // Controlled DB time makes boundary/race proofs deterministic. This does
    // not claim production owner/timer scheduling proof or install any schema.
    await reader.query(TRAY_CLOCK_SOURCE_SCHEMA.replaceAll('clock_timestamp()','tray_clock_test_now()'));
    await reader.query(`INSERT INTO identities VALUES($1,'human','reader'),($2,'agent','writer')`,[viewer,author]);
    await reader.query(`INSERT INTO rooms(id,workspace_id) VALUES($1,$2)`,[room,workspace]);
    await reader.query(`INSERT INTO memberships VALUES($1,NULL,$3,NULL),($1,$2,$3,NULL)`,[workspace,room,viewer]);
    await reader.query(`INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES('question',$1,$2,'@reader please?','2000-01-07')`,[room,author]);
    await reader.query(`UPDATE clock_fixture SET now_at='2000-01-14'`);
    await run(clockDb(reader),clockDb(writer));
  }finally{await Promise.all([reader.close(),writer.close()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}

describe.skipIf(!url)('real two-pool PostgreSQL Tray clock claim transactions',()=>{
  it('consumes the same durable version once across two pools and retains journal/basis after caller recovery',async()=>{
    await rig(async(reader,writer)=>{
      const [claim]=await readTrayClockDue(reader);
      const results=await Promise.all([reader.transaction(tx=>consumeTrayClockInTransaction(tx,claim!)),writer.transaction(tx=>consumeTrayClockInTransaction(tx,claim!))]);
      expect(results.sort()).toEqual([false,true]);
      expect((await readTrayClockBasis(writer,workspace))?.revision).toBe('1');
      expect((await writer.query(`SELECT event FROM live_journal WHERE event->>'sourceTable'='tray-clock'`)).rows).toHaveLength(1);
      expect(await readTrayClockDue(writer)).toEqual([]);
    });
  });

  it('holds the actual source fence through the transaction and rejects a stale ABA claim after reschedule',async()=>{
    await rig(async(reader,writer)=>{
      // Select before due and reschedule while still before due, preserving
      // a future pending record; the fixture clock advances independently.
      await reader.query(`UPDATE clock_fixture SET now_at='2000-01-08'`);
      const first=(await reader.query<{id:string;incarnation:string;revision:string;kind:'question-age';dueAt:string}>(
        `SELECT id,incarnation,revision::text,kind,due_at::text "dueAt" FROM tray_clock_deadlines`)).rows[0]!;
      await writer.query(`UPDATE messages SET created_at=created_at+interval '1 day' WHERE id='question'`);
      await writer.query(`UPDATE messages SET created_at=created_at-interval '1 day' WHERE id='question'`);
      await reader.query(`UPDATE clock_fixture SET now_at='2000-01-14'`);
      expect(await reader.transaction(tx=>consumeTrayClockInTransaction(tx,first))).toBe(false);
      const [current]=await readTrayClockDue(reader),entered=deferred(),release=deferred();
      const consumption=reader.transaction(async tx=>{expect(await consumeTrayClockInTransaction(tx,current!)).toBe(true);entered.resolve();await release.promise;});
      try{
        await entered.promise;
        await expect(writer.transaction(async tx=>{
          await tx.query(`SET LOCAL lock_timeout='100ms'`);await tx.query(`UPDATE messages SET created_at=created_at+interval '1 day' WHERE id='question'`);
        })).rejects.toMatchObject({code:'55P03'});
        release.resolve();await consumption;
      }finally{release.resolve();await consumption;}
      expect((await readTrayClockBasis(writer,workspace))?.revision).toBe('1');
    });
  });

  it('refuses an in-flight deletion/recreation without waiting and catches the newly committed overdue obligation',async()=>{
    await rig(async(reader,writer)=>{
      const [old]=await readTrayClockDue(reader),mutated=deferred(),commit=deferred();
      // Recreation happens before its actual due time so the new incarnation
      // is pending, then a multi-day owner absence leaves it durably overdue.
      await writer.query(`UPDATE clock_fixture SET now_at='2000-01-08'`);
      const mutation=writer.transaction(async tx=>{
        await tx.query(`DELETE FROM messages WHERE id='question'`);
        await tx.query(`INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES('question',$1,$2,'@reader please?','2000-01-07')`,[room,author]);
        mutated.resolve();await commit.promise;
      });
      await mutated.promise;
      try{
        await expect(reader.transaction(tx=>consumeTrayClockInTransaction(tx,old!))).rejects.toMatchObject({code:'55P03'});
        commit.resolve();await mutation;
        expect(await reader.transaction(tx=>consumeTrayClockInTransaction(tx,old!))).toBe(false);
      }finally{commit.resolve();await mutation;}
      await writer.query(`UPDATE clock_fixture SET now_at='2000-02-01'`);
      const [remaining]=await readTrayClockDue(writer);expect(remaining?.incarnation).not.toBe(old!.incarnation);
      expect(await writer.transaction(tx=>consumeTrayClockInTransaction(tx,remaining!))).toBe(true);
      expect((await writer.query(`SELECT event FROM live_journal WHERE event->>'sourceTable'='tray-clock'`)).rows).toHaveLength(1);
    });
  });
});
