import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgliteDatabase } from "../../../tests/helpers/server.js";
import type { SqlDatabase } from './database.js';
import {installBackgroundOwnerTestProof,backgroundOwnerTestLock} from "../../../tests/helpers/server.js";
import { BackgroundOwnership, BACKGROUND_OWNERSHIP_SCHEMA, BackgroundOwnershipLost, type BackgroundEpoch } from './background-ownership.js';
import { DURABLE_LIVE_SCHEMA } from './durable-live.js';
import { TRAY_CLOCK_SOURCE_SCHEMA } from './tray-clock-source.js';
import { TrayClockOwner, TRAY_CLOCK_OWNER_SCHEMA } from './tray-clock-owner.js';

const viewer='a'.repeat(64),author='b'.repeat(64),workspace='11111111-1111-4111-8111-111111111111',room='22222222-2222-4222-8222-222222222222';
const sourceSchema=`CREATE TABLE clock_fixture(now_at timestamptz NOT NULL);INSERT INTO clock_fixture VALUES('2000-01-08');
 CREATE FUNCTION tray_clock_test_now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT now_at FROM clock_fixture $$;
 CREATE TABLE identities(id text PRIMARY KEY,kind text,handle text);
 CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,parent_id uuid,archived_at timestamptz);
 CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,removed_at timestamptz);
 CREATE TABLE messages(id text PRIMARY KEY,room_id uuid,author_id text,text text,presentation text DEFAULT 'message',card_type text,
   card jsonb,deleted_at timestamptz,created_at timestamptz DEFAULT tray_clock_test_now());
 CREATE TABLE needs_you_marks(identity_id text REFERENCES identities(id) ON DELETE CASCADE,message_id text REFERENCES messages(id) ON DELETE CASCADE,
   workspace_id uuid,first_seen_at timestamptz,cleared_at timestamptz,PRIMARY KEY(identity_id,message_id));
 CREATE TABLE room_choices(id uuid PRIMARY KEY,workspace_id uuid,room_id uuid,status text,closes_at timestamptz);
 CREATE TABLE live_server_instances(instance_id text PRIMARY KEY,renewed_at timestamptz NOT NULL);`;
type Observe=(sql:string,tx:SqlDatabase)=>Promise<void>;
const observed=(db:SqlDatabase,after?:Observe):SqlDatabase=>({
  query:async(sql,args)=>{
    // Only semantic deadline time is controlled. Aggregate ownership evidence
    // and its actual deferred COMMIT check use the real database clock.
    const wire=sql.includes('FROM tray_clock_deadlines')?sql.replaceAll('clock_timestamp()','tray_clock_test_now()'):sql;
    const result=await db.query(wire,args);await after?.(sql,db);return result;
  },transaction:work=>db.transaction(tx=>work(observed(tx,after))),
});

describe('unselected background-owned display expiry adapter',()=>{
  let db:PgliteDatabase;const owners:Array<{core:BackgroundOwnership;epoch:BackgroundEpoch}>=[];
  const makeOwner=async(after?:Observe)=>{
    const core=new BackgroundOwnership(observed(db,after),'instance'),epoch=await core.claim(await backgroundOwnerTestLock(db));
    owners.push({core,epoch});return{core,epoch,adapter:new TrayClockOwner(core)};
  };
  const question=(id='question')=>db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,'@reader please?','2000-01-07')`,[id,room,author]);
  const advance=(at='2000-01-14')=>db.query(`UPDATE clock_fixture SET now_at=$1`,[at]);
  const causes=async()=>(await db.query(`SELECT event FROM live_journal WHERE event->>'sourceTable'='tray-clock'`)).rows;
  beforeEach(async()=>{
    db=new PgliteDatabase();await db.query(sourceSchema);await db.query(DURABLE_LIVE_SCHEMA);await db.query(BACKGROUND_OWNERSHIP_SCHEMA);
    await db.query(TRAY_CLOCK_SOURCE_SCHEMA.replaceAll('clock_timestamp()','tray_clock_test_now()'));await db.query(TRAY_CLOCK_OWNER_SCHEMA);
    await installBackgroundOwnerTestProof(db);
    await db.query(`INSERT INTO live_server_instances VALUES('instance',clock_timestamp());
      INSERT INTO identities VALUES('${viewer}','human','reader'),('${author}','agent','writer');
      INSERT INTO rooms(id,workspace_id) VALUES('${room}','${workspace}');
      INSERT INTO memberships VALUES('${workspace}',NULL,'${viewer}',NULL),('${workspace}','${room}','${viewer}',NULL)`);
  });
  afterEach(async()=>{for(const{core,epoch}of owners.splice(0))core.revoke(epoch);await db.close();});

  it('consumes at most 100 captured question versions and returns continuation only for an actual remaining due row',async()=>{
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
      SELECT 'question-'||n,$1,$2,'@reader please?','2000-01-07' FROM generate_series(1,101)n`,[room,author]);
    await advance();const{adapter,epoch}=await makeOwner();
    const first=await adapter.drain(epoch);expect(first).toMatchObject({attempted:100,consumed:100,continuation:true,next:{kind:'question-age',remainingMs:0}});
    const last=await adapter.drain(epoch);expect(last).toEqual({attempted:1,consumed:1,continuation:false,next:null});
    expect(await causes()).toHaveLength(101);expect((await db.query(`SELECT * FROM tray_clock_owner_fences`)).rows).toEqual([]);
  });

  it('consumes due sign-in display expiry while excluding choices from discovery and next deadline',async()=>{
    await question();await db.query(`INSERT INTO room_choices VALUES('33333333-3333-4333-8333-333333333333',$1,$2,'open','2000-01-09')`,[workspace,room]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card) VALUES('sign-in',$1,$2,'Synthetic','card','agent-sign-in',$3::jsonb)`,
      [room,author,JSON.stringify({ownerId:viewer,status:'pending',expiresAt:947462400000})]);
    await advance('2000-01-10');const{adapter,epoch}=await makeOwner();
    const pending=await adapter.drain(epoch);expect(pending).toMatchObject({attempted:1,consumed:1,continuation:false,next:{kind:'question-age',dueAt:'2000-01-14T00:00:00.000000Z',remainingMs:4*86400000}});
    await advance();expect(await adapter.drain(epoch)).toEqual({attempted:1,consumed:1,continuation:false,next:null});
    expect((await db.query(`SELECT kind,state FROM tray_clock_deadlines WHERE kind NOT IN ('question-age','question-seen') ORDER BY kind`)).rows)
      .toEqual([{kind:'agent-sign-in',state:'elapsed'},{kind:'choice-close',state:'pending'}]);
    expect((await db.query(`SELECT card->>'status' status FROM messages WHERE id='sign-in'`)).rows).toEqual([{status:'pending'}]);
    expect((await db.query(`SELECT status FROM room_choices`)).rows).toEqual([{status:'open'}]);
  });

  it('publishes sign-in only to its current owner and Squire only to eligible members without external decisions',async()=>{
    const other='c'.repeat(64);
    await db.query(`INSERT INTO identities VALUES($1,'human','other')`,[other]);
    await db.query(`INSERT INTO memberships VALUES($1,NULL,$3,NULL),($1,$2,$3,NULL)`,[workspace,room,other]);
    for(const [id,type,card] of [
      ['sign-in','agent-sign-in',{ownerId:viewer,status:'pending',expiresAt:947462400000}],
      ['squire','squire-approval',{approvalId:'approval',sourceRoomId:room,status:'pending',expiresAt:947462400000}],
    ] as const)await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
      VALUES($1,$2,$3,'Synthetic','card',$4,$5::jsonb)`,[id,room,author,type,JSON.stringify(card)]);
    await advance('2000-01-10');const{adapter,epoch}=await makeOwner();
    expect(await adapter.drain(epoch)).toEqual({attempted:2,consumed:2,continuation:false,next:null});
    const readers=(await db.query<{kind:string;reader:string}>(`SELECT event->>'kind' kind,event->>'trayReaderId' reader
      FROM live_journal WHERE event->>'sourceTable'='tray-clock' ORDER BY kind,reader`)).rows;
    expect(readers).toEqual([{kind:'agent-sign-in',reader:viewer},{kind:'squire-approval',reader:viewer},{kind:'squire-approval',reader:other}]);
    expect((await adapter.drain(epoch)).consumed).toBe(0);
    expect((await db.query(`SELECT card->>'status' status FROM messages ORDER BY id`)).rows).toEqual([{status:'pending'},{status:'pending'}]);
  });

  it('does not publish a decided Squire card or a sign-in owner who lost membership before expiry',async()=>{
    const other='c'.repeat(64);
    await db.query(`INSERT INTO identities VALUES($1,'human','other')`,[other]);
    await db.query(`INSERT INTO memberships VALUES($1,NULL,$3,NULL),($1,$2,$3,NULL)`,[workspace,room,other]);
    for(const [id,type,card] of [
      ['sign-in','agent-sign-in',{ownerId:viewer,status:'pending',expiresAt:947462400000}],
      ['squire','squire-approval',{approvalId:'approval',sourceRoomId:room,status:'pending',expiresAt:947462400000}],
      ['decision','squire-approval-decision',{approvalId:'approval'}],
    ] as const)await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
      VALUES($1,$2,$3,'Synthetic','card',$4,$5::jsonb)`,[id,room,author,type,JSON.stringify(card)]);
    await db.query(`UPDATE memberships SET removed_at=tray_clock_test_now() WHERE identity_id=$1`,[viewer]);
    await advance('2000-01-10');const{adapter,epoch}=await makeOwner();
    expect(await adapter.drain(epoch)).toEqual({attempted:2,consumed:2,continuation:false,next:null});
    expect(await causes()).toEqual([]);
  });

  it('handles question-seen through the same exact owner transaction, without consuming it twice',async()=>{
    await question();await db.query(`INSERT INTO needs_you_marks VALUES($1,'question',$2,'2000-01-08',NULL)`,[viewer,workspace]);
    await advance('2000-01-09');const{adapter,epoch}=await makeOwner();
    const first=await adapter.drain(epoch);expect(first).toMatchObject({attempted:1,consumed:1,continuation:false,next:{kind:'question-age'}});
    expect((await adapter.drain(epoch)).consumed).toBe(0);expect(await causes()).toHaveLength(1);
  });

  it('does not query deadlines or register an effect for cloned, revoked or replaced opaque epochs',async()=>{
    await question();await advance();let reads=0;
    const first=await makeOwner(async sql=>{if(sql.includes('tray_clock_deadlines')||sql.includes('beeline_register_tray_clock_owner'))reads++;});
    await expect(first.adapter.drain({...first.epoch})).rejects.toBeInstanceOf(BackgroundOwnershipLost);expect(reads).toBe(0);
    await makeOwner();await expect(first.adapter.drain(first.epoch)).rejects.toBeInstanceOf(BackgroundOwnershipLost);
    expect(reads).toBe(0);expect(await causes()).toEqual([]);
  });

  it('rejects authoritative expired aggregate evidence before any deadline read/effect',async()=>{
    await question();await advance();let reads=0;
    const{adapter,epoch}=await makeOwner(async sql=>{if(sql.includes('tray_clock_deadlines'))reads++;});
    await db.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp()-interval '91 seconds'`);
    await expect(adapter.drain(epoch)).rejects.toBeInstanceOf(BackgroundOwnershipLost);expect(reads).toBe(0);expect(await causes()).toEqual([]);
  });

  it('revalidates the captured source revision and rejects a source ABA before admitting that version',async()=>{
    await question();await advance();let change=true;
    const{adapter,epoch}=await makeOwner(async(sql,tx)=>{
      if(change&&sql.includes('FROM tray_clock_deadlines')&&sql.includes('LIMIT 100')){
        change=false;await tx.query(`UPDATE clock_fixture SET now_at='2000-01-08'`);
        await tx.query(`UPDATE messages SET created_at=created_at+interval '1 day' WHERE id='question'`);
        await tx.query(`UPDATE messages SET created_at=created_at-interval '1 day' WHERE id='question'`);
        await tx.query(`UPDATE clock_fixture SET now_at='2000-01-14'`);
      }
    });
    expect(await adapter.drain(epoch)).toMatchObject({attempted:1,consumed:0,continuation:true,next:{revision:'3'}});
    expect(await causes()).toEqual([]);expect((await adapter.drain(epoch)).consumed).toBe(1);expect(await causes()).toHaveLength(1);
  });

  it('rolls consumed version, clock and journal back on one SQL failure and manufactures no retry/continuation',async()=>{
    await question();await advance();let attempts=0;
    const{adapter,epoch}=await makeOwner(async sql=>{if(sql.includes('SELECT beeline_tray_clock_consume')){attempts++;throw new Error('synthetic storage failure');}});
    await expect(adapter.drain(epoch)).rejects.toThrow('synthetic storage failure');expect(attempts).toBe(1);
    expect((await db.query(`SELECT state FROM tray_clock_deadlines`)).rows).toEqual([{state:'pending'}]);
    expect((await db.query(`SELECT revision::text FROM tray_clock_state`)).rows).toEqual([{revision:'0'}]);expect(await causes()).toEqual([]);
    expect((await db.query(`SELECT * FROM tray_clock_owner_fences`)).rows).toEqual([]);
  });

  it('registers no retained fence/history on an empty real wake and returns no invented future time',async()=>{
    const{adapter,epoch}=await makeOwner();expect(await adapter.drain(epoch)).toEqual({attempted:0,consumed:0,next:null,continuation:false});
    expect((await db.query(`SELECT * FROM tray_clock_owner_fences`)).rows).toEqual([]);expect(await causes()).toEqual([]);
  });
});
