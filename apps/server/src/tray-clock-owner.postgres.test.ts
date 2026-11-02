import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresDatabase, type SqlDatabase } from './database.js';
import { BackgroundOwnership, BACKGROUND_OWNERSHIP_SCHEMA, BACKGROUND_LEADER_LOCK_KEY, BackgroundOwnershipLost, type BackgroundEpoch } from './background-ownership.js';
import { DURABLE_LIVE_SCHEMA } from './durable-live.js';
import { TRAY_CLOCK_SOURCE_SCHEMA } from './tray-clock-source.js';
import { TrayClockOwner, TRAY_CLOCK_OWNER_SCHEMA } from './tray-clock-owner.js';

const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(url&&!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))throw new Error('Tray clock owner proof requires isolated loopback PostgreSQL');
const viewer='a'.repeat(64),author='b'.repeat(64),workspace='11111111-1111-4111-8111-111111111111',room='22222222-2222-4222-8222-222222222222';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
// Actual aggregate leases and COMMIT constraints retain the real PostgreSQL
// clock. Only the semantic source clock is controlled for deterministic dues.
const semanticSql=(sql:string)=>sql.includes('FROM tray_clock_deadlines')?sql.replaceAll('clock_timestamp()','tray_clock_test_now()'):sql;
const semanticDb=(db:SqlDatabase):SqlDatabase=>({query:(sql,args)=>db.query(semanticSql(sql),args),transaction:work=>db.transaction(tx=>work(semanticDb(tx)))});

async function fixture(){
  const schema=`tray_clock_owner_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA ${schema}`);
  const config={connectionString:url,options:`-c search_path=${schema},public -c lock_timeout=100ms`,max:2};
  const first=new PostgresDatabase('',2,{pool:new Pool(config)}),second=new PostgresDatabase('',2,{pool:new Pool(config)});
  const locks=new Pool({connectionString:url,max:2,statement_timeout:0,options:'-c lock_timeout=0'}),held=new Set<PoolClient>();
  const scopes:Array<{owner:BackgroundOwnership;epoch:BackgroundEpoch}>=[];
  try{
    await first.query(`CREATE TABLE clock_fixture(now_at timestamptz NOT NULL);INSERT INTO clock_fixture VALUES('2000-01-08');
      CREATE FUNCTION tray_clock_test_now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT now_at FROM clock_fixture $$;
      CREATE TABLE identities(id text PRIMARY KEY,kind text,handle text);
      CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,parent_id uuid,archived_at timestamptz);
      CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,removed_at timestamptz);
      CREATE TABLE messages(id text PRIMARY KEY,room_id uuid,author_id text,text text,presentation text DEFAULT 'message',card_type text,
        card jsonb,deleted_at timestamptz,created_at timestamptz DEFAULT tray_clock_test_now());
      CREATE TABLE needs_you_marks(identity_id text REFERENCES identities(id) ON DELETE CASCADE,message_id text REFERENCES messages(id) ON DELETE CASCADE,
        workspace_id uuid,first_seen_at timestamptz,cleared_at timestamptz,PRIMARY KEY(identity_id,message_id));
      CREATE TABLE room_choices(id uuid PRIMARY KEY,workspace_id uuid,room_id uuid,status text,closes_at timestamptz);
      CREATE TABLE live_server_instances(instance_id text PRIMARY KEY,renewed_at timestamptz NOT NULL);
      INSERT INTO live_server_instances VALUES('first',clock_timestamp()),('second',clock_timestamp());`);
    await first.query(DURABLE_LIVE_SCHEMA);await first.query(BACKGROUND_OWNERSHIP_SCHEMA);
    await first.query(TRAY_CLOCK_SOURCE_SCHEMA.replaceAll('clock_timestamp()','tray_clock_test_now()'));await first.query(TRAY_CLOCK_OWNER_SCHEMA);
    await first.query(`INSERT INTO identities VALUES($1,'human','reader'),($2,'agent','writer')`,[viewer,author]);
    await first.query(`INSERT INTO rooms(id,workspace_id) VALUES($1,$2)`,[room,workspace]);
    await first.query(`INSERT INTO memberships VALUES($1,NULL,$3,NULL),($1,$2,$3,NULL)`,[workspace,room,viewer]);
    await first.query(`INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES('question',$1,$2,'@reader please?','2000-01-07')`,[room,author]);
    await first.query(`UPDATE clock_fixture SET now_at='2000-01-14'`);
  }catch(error){await Promise.all([first.close(),second.close(),locks.end()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();throw error;}
  return{first,second,scopes,
    acquire:async()=>{const client=await locks.connect();held.add(client);await client.query('SELECT pg_advisory_lock($1)',[BACKGROUND_LEADER_LOCK_KEY]);return client;},
    drop:(client:PoolClient)=>{if(held.delete(client))client.release(true);},
    close:async()=>{for(const{owner,epoch}of scopes)owner.revoke(epoch);for(const client of held)client.release(true);held.clear();
      await Promise.all([first.close(),second.close(),locks.end()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();},
  };
}

describe.skipIf(!url)('real aggregate-owner fenced Tray expiry at PostgreSQL COMMIT',()=>{
  it.each(['question','agent-sign-in','squire-approval'] as const)('rolls back %s when the bound backend dies after final SELECT; the new owner then consumes once',async(kind)=>{
    const f=await fixture(),entered=deferred(),release=deferred();let pause=false;
    const observed:SqlDatabase={query:(sql,args)=>f.first.query(semanticSql(sql),args),transaction:work=>f.first.transaction(async tx=>{
      const result=await work(semanticDb(tx));if(pause){entered.resolve();await release.promise;}return result;
    })};
    let flight:Promise<unknown>|undefined;
    try{
      if(kind!=='question'){
        await f.first.query(`DELETE FROM messages WHERE id='question'`);
        const card={status:'pending',expiresAt:Date.UTC(2000,0,15),
          ...(kind==='agent-sign-in'?{ownerId:viewer}:{approvalId:'approval',sourceRoomId:room})};
        await f.first.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
          VALUES('question',$1,$2,'Synthetic','card',$3,$4::jsonb)`,[room,author,kind,JSON.stringify(card)]);
        await f.first.query(`UPDATE clock_fixture SET now_at='2000-01-16'`);
      }
      const lockA=await f.acquire(),coreA=new BackgroundOwnership(observed,'first'),epochA=await coreA.claim(lockA);f.scopes.push({owner:coreA,epoch:epochA});
      const sourceBefore=(await f.second.query(`SELECT id,kind,incarnation,revision::text,state FROM tray_clock_deadlines
        WHERE source_id='question' ORDER BY id`)).rows;
      expect(sourceBefore.filter(row=>row.state==='pending')).toEqual([expect.objectContaining({
        kind:kind==='question'?'question-age':kind,incarnation:expect.any(String),revision:expect.any(String),state:'pending',
      })]);
      pause=true;flight=new TrayClockOwner(coreA).drain(epochA);await entered.promise;
      // The work callback and its final SELECT have returned. SQL COMMIT has
      // not happened and a second pool cannot see any partial state/cut.
      expect((await f.second.query(`SELECT revision::text FROM tray_clock_state`)).rows).toEqual([{revision:'0'}]);
      expect((await f.second.query(`SELECT event FROM live_journal WHERE event->>'sourceTable'='tray-clock'`)).rows).toEqual([]);
      f.drop(lockA);const lockB=await f.acquire(),coreB=new BackgroundOwnership(semanticDb(f.second),'second');
      await expect(coreB.claim(lockB)).rejects.toMatchObject({code:'55P03'});
      await expect(f.second.transaction(async tx=>{await tx.query(`UPDATE messages SET created_at=created_at+interval '1 day' WHERE id='question'`);})).rejects.toMatchObject({code:'55P03'});
      // Acquiring B proves A's actual advisory-lock backend is gone. Keep A's
      // aggregate lease fresh: backend identity, not lease expiry/takeover,
      // must reject A's deferred COMMIT after its last JS check returned.
      expect((await f.second.query(`SELECT renewed_at>clock_timestamp()-interval '90 seconds' fresh
        FROM live_server_instances WHERE instance_id='first'`)).rows).toEqual([{fresh:true}]);
      const rejected=expect(flight).rejects.toMatchObject({code:'23514'});release.resolve();await rejected;pause=false;
      expect((await f.second.query(`SELECT revision::text FROM tray_clock_state`)).rows).toEqual([{revision:'0'}]);
      expect((await f.second.query(`SELECT id,kind,incarnation,revision::text,state FROM tray_clock_deadlines
        WHERE source_id='question' ORDER BY id`)).rows).toEqual(sourceBefore);
      expect((await f.second.query(`SELECT event FROM live_journal WHERE event->>'sourceTable'='tray-clock'`)).rows).toEqual([]);
      const epochB=await coreB.claim(lockB);f.scopes.push({owner:coreB,epoch:epochB});expect(BigInt(epochB.generation)).toBeGreaterThan(BigInt(epochA.generation));
      // Deliberately withheld old connection-loss signal cannot grant work.
      await expect(new TrayClockOwner(coreA).drain(epochA)).rejects.toBeInstanceOf(BackgroundOwnershipLost);
      expect(await new TrayClockOwner(coreB).drain(epochB)).toEqual({attempted:1,consumed:1,next:null,continuation:false});
      expect(await new TrayClockOwner(coreB).drain(epochB)).toEqual({attempted:0,consumed:0,next:null,continuation:false});
      expect((await f.second.query(`SELECT revision::text FROM tray_clock_state`)).rows).toEqual([{revision:'1'}]);
      expect((await f.second.query(`SELECT event FROM live_journal WHERE event->>'sourceTable'='tray-clock'`)).rows).toHaveLength(1);
      expect((await f.second.query(`SELECT * FROM tray_clock_owner_fences`)).rows).toEqual([]);
    }finally{release.resolve();await flight?.catch(()=>{});await f.close();}
  });

  it('rolls back actual COMMIT after the real lease expires even though work and final owner SELECT already returned',async()=>{
    const f=await fixture(),returned=deferred(),commit=deferred();let delayCommit=false,bodyReturned=false;
    const observed:SqlDatabase={query:(sql,args)=>f.first.query(semanticSql(sql),args),transaction:work=>f.first.transaction(async tx=>{
      const result=await work(semanticDb(tx));if(delayCommit){bodyReturned=true;returned.resolve();await commit.promise;}return result;
    })};
    let flight:Promise<unknown>|undefined;
    try{
      const lock=await f.acquire(),core=new BackgroundOwnership(observed,'first'),epoch=await core.claim(lock);f.scopes.push({owner:core,epoch});
      await f.first.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp()-interval '88 seconds' WHERE instance_id='first'`);
      delayCommit=true;flight=new TrayClockOwner(core).drain(epoch);
      const rejected=expect(flight).rejects.toMatchObject({code:'23514',message:'Tray expiry owner expired before commit'});
      await returned.promise;expect(bodyReturned).toBe(true);
      // One finite physical-time delay in an isolated test, not a production
      // retry/poll. The expired row stays unchanged through the COMMIT check.
      await f.second.query(`SELECT pg_sleep(2.1)`);commit.resolve();await rejected;
      expect((await f.second.query(`SELECT state FROM tray_clock_deadlines`)).rows).toEqual([{state:'pending'}]);
      expect((await f.second.query(`SELECT revision::text FROM tray_clock_state`)).rows).toEqual([{revision:'0'}]);
      expect((await f.second.query(`SELECT event FROM live_journal WHERE event->>'sourceTable'='tray-clock'`)).rows).toEqual([]);
      expect((await f.second.query(`SELECT * FROM tray_clock_owner_fences`)).rows).toEqual([]);
      await expect(new TrayClockOwner(core).drain(epoch)).rejects.toBeInstanceOf(BackgroundOwnershipLost);
    }finally{commit.resolve();await flight?.catch(()=>{});await f.close();}
  });

  it('rejects a captured source ABA from another pool and only a fresh exact revision can advance the clock',async()=>{
    const f=await fixture(),captured=deferred(),release=deferred();let pause=false;
    const wrap=(db:SqlDatabase):SqlDatabase=>({query:async(sql,args)=>{
      const result=await db.query(semanticSql(sql),args);
      if(pause&&sql.includes('FROM tray_clock_deadlines')&&sql.includes('LIMIT 100')){pause=false;captured.resolve();await release.promise;}
      return result;
    },transaction:work=>db.transaction(tx=>work(wrap(tx)))});
    let flight:Promise<unknown>|undefined;
    try{
      const lock=await f.acquire(),core=new BackgroundOwnership(wrap(f.first),'first'),epoch=await core.claim(lock);f.scopes.push({owner:core,epoch});
      pause=true;flight=new TrayClockOwner(core).drain(epoch);await captured.promise;
      await f.second.transaction(async tx=>{
        await tx.query(`UPDATE clock_fixture SET now_at='2000-01-08'`);
        await tx.query(`UPDATE messages SET created_at=created_at+interval '1 day' WHERE id='question'`);
        await tx.query(`UPDATE messages SET created_at=created_at-interval '1 day' WHERE id='question'`);
        await tx.query(`UPDATE clock_fixture SET now_at='2000-01-14'`);
      });
      release.resolve();expect(await flight).toMatchObject({attempted:1,consumed:0,continuation:true,next:{revision:'3'}});
      expect((await f.second.query(`SELECT event FROM live_journal WHERE event->>'sourceTable'='tray-clock'`)).rows).toEqual([]);
      expect((await new TrayClockOwner(core).drain(epoch)).consumed).toBe(1);
      expect((await new TrayClockOwner(core).drain(epoch)).consumed).toBe(0);
      expect((await f.second.query(`SELECT event FROM live_journal WHERE event->>'sourceTable'='tray-clock'`)).rows).toHaveLength(1);
    }finally{release.resolve();await flight?.catch(()=>{});await f.close();}
  });
});
