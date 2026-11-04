import {BACKGROUND_OWNERSHIP_SCHEMA} from './background-ownership.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlDatabase } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { DURABLE_LIVE_SCHEMA } from './durable-live.js';
import { TRAY_CLOCK_SOURCE_SCHEMA, consumeTrayClockInTransaction, readTrayClockBasis, readTrayClockCause, readTrayClockDue, readTrayClockNext, readTrayClockWake,
  readTrayClockBasisCause,type TrayClockClaim } from './tray-clock-source.js';

const viewer='a'.repeat(64),other='b'.repeat(64),author='c'.repeat(64);
const workspace='11111111-1111-4111-8111-111111111111',elsewhere='22222222-2222-4222-8222-222222222222';
const room='33333333-3333-4333-8333-333333333333',otherRoom='44444444-4444-4444-8444-444444444444';
// Only the DB clock is replaced. Source predicates, triggers, claims, elapsed
// transitions and journal functions are the actual uninstalled implementation.
const schema=`CREATE TABLE clock_fixture(now_at timestamptz NOT NULL);
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
 CREATE TABLE room_choices(id uuid PRIMARY KEY,workspace_id uuid,room_id uuid,status text,closes_at timestamptz);`;
const observedClock=(db:SqlDatabase):SqlDatabase=>({
  query:(sql,args)=>db.query(sql.replaceAll('clock_timestamp()','tray_clock_test_now()'),args),
  transaction:work=>db.transaction(tx=>work(observedClock(tx))),
});

describe('uninstalled durable Tray clock source',()=>{
  let db:PgliteDatabase,clock:SqlDatabase;
  const advance=(at:string)=>db.query(`UPDATE clock_fixture SET now_at=$1`,[at]);
  const question=(id='question',created='2000-01-07T00:00:00Z',text='@reader please?')=>db.query(
    `INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,$4,$5)`,[id,room,author,text,created]);
  const claim=async(kind='question-age',id='question')=>(await db.query<TrayClockClaim>(`SELECT id,incarnation,revision::text,kind,due_at::text "dueAt"
    FROM tray_clock_deadlines WHERE source_id=$1 AND kind=$2`,[id,kind])).rows[0]!;
  const causes=async()=>(await db.query<{event:Record<string,unknown>}>(`SELECT event FROM live_journal
    WHERE event->>'sourceTable'='tray-clock' ORDER BY stream_id,sequence`)).rows.map(row=>row.event);
  const consume=(input:TrayClockClaim)=>clock.transaction(tx=>consumeTrayClockInTransaction(tx,input));
  beforeEach(async()=>{
    db=new PgliteDatabase();await db.query(schema);await db.query(DURABLE_LIVE_SCHEMA);
    await db.query(`CREATE TABLE live_server_instances(instance_id text PRIMARY KEY,renewed_at timestamptz NOT NULL)`);
    await db.query(BACKGROUND_OWNERSHIP_SCHEMA);
    await db.query(TRAY_CLOCK_SOURCE_SCHEMA.replaceAll('clock_timestamp()','tray_clock_test_now()'));clock=observedClock(db);
    await db.query(`INSERT INTO identities VALUES($1,'human','reader'),($2,'human','other'),($3,'agent','writer')`,[viewer,other,author]);
    await db.query(`INSERT INTO rooms(id,workspace_id) VALUES($1,$2),($3,$4)`,[room,workspace,otherRoom,elsewhere]);
    await db.query(`INSERT INTO memberships VALUES($1,NULL,$3,NULL),($1,$2,$3,NULL),($4,NULL,$5,NULL),($4,$6,$5,NULL)`,
      [workspace,room,viewer,elsewhere,other,otherRoom]);
  });
  afterEach(async()=>{await db.close();});

  it('allocates no clock rows or source locks for an ordinary bulk insert/delete',async()=>{
    await db.transaction(async tx=>{
      const held=async()=>Number((await tx.query<{count:string}>(`SELECT count(*)::text count FROM pg_locks
        WHERE locktype='advisory' AND pid=pg_backend_pid()`)).rows[0]!.count);
      const before=await held();
      await tx.query(`INSERT INTO messages(id,room_id,author_id,text)
        SELECT 'ordinary-'||item,$1,$2,'ordinary statement' FROM generate_series(1,128)item`,[room,author]);
      expect(await held()).toBe(before);
      expect((await tx.query(`SELECT * FROM tray_clock_sources`)).rows).toEqual([]);
      expect((await tx.query(`SELECT * FROM tray_clock_deadlines`)).rows).toEqual([]);
      await tx.query(`DELETE FROM messages WHERE id LIKE 'ordinary-%'`);
      expect(await held()).toBe(before);
    });
  });

  it('does not change committed eligibility/basis with wall time, then journals one exact elapsed transition',async()=>{
    await question();const pending=await claim(),basis=await readTrayClockBasis(db,workspace);
    expect(basis).toMatchObject({revision:'0',ready:false});expect(await readTrayClockDue(clock)).toEqual([]);
    await advance('2000-01-14T00:00:00Z');
    expect(await readTrayClockBasis(db,workspace)).toEqual(basis);
    expect((await db.query(`SELECT state FROM tray_clock_deadlines`)).rows).toEqual([{state:'pending'}]);
    expect(await consume(pending)).toBe(true);expect(await consume(pending)).toBe(false);
    expect((await readTrayClockBasis(db,workspace))?.revision).toBe('1');
    expect(await causes()).toEqual([expect.objectContaining({sourceTable:'tray-clock',kind:'question-age',trayReaderId:viewer,trayWorkspaceId:workspace})]);
    expect(readTrayClockCause((await causes())[0]!)).toBeTruthy();expect(await readTrayClockDue(clock)).toEqual([]);
    expect(await readTrayClockBasis(db,elsewhere)).toBeUndefined();
  });

  it('captures the 24-hour seen edge separately and duplicate seen preserves its exact version',async()=>{
    await question();await db.query(`INSERT INTO needs_you_marks VALUES($1,'question',$2,'2000-01-08T00:00:00.000123Z',NULL)`,[viewer,workspace]);
    const seen=await claim('question-seen');expect(seen.dueAt).toContain('00:00:00.000123');
    await db.query(`UPDATE needs_you_marks SET first_seen_at=first_seen_at WHERE identity_id=$1`,[viewer]);
    expect(await claim('question-seen')).toEqual(seen);
    await advance('2000-01-09T00:00:00.000122Z');expect(await consume(seen)).toBe(false);
    await advance('2000-01-09T00:00:00.000123Z');expect(await consume(seen)).toBe(true);
    expect((await claim()).revision).toBe('1');expect((await causes()).map(event=>event.kind)).toEqual(['question-seen']);
    await advance('2000-01-14');expect(await consume(await claim())).toBe(true);
    // The later age boundary has no remaining canonical cell for this reader.
    expect((await causes()).map(event=>event.kind)).toEqual(['question-seen']);
  });

  it('rejects a captured claim after reschedule A→B→A, retaining the source incarnation',async()=>{
    await question();const first=await claim();
    await db.query(`UPDATE messages SET created_at=created_at+interval '1 day' WHERE id='question'`);
    await db.query(`UPDATE messages SET created_at=created_at-interval '1 day' WHERE id='question'`);
    const latest=await claim();expect(latest.incarnation).toBe(first.incarnation);expect(latest.revision).toBe('3');
    await advance('2000-01-14T00:00:00Z');expect(await consume(first)).toBe(false);expect(await consume(latest)).toBe(true);
  });

  it('changes incarnation on deletion/recreation and does not resurrect an old same-key claim',async()=>{
    await question();await db.query(`INSERT INTO needs_you_marks VALUES($1,'question',$2,'2000-01-08',NULL)`,[viewer,workspace]);
    const first=await claim(),seen=await claim('question-seen');await db.query(`DELETE FROM messages WHERE id='question'`);await question();
    expect((await db.query(`SELECT 1 FROM needs_you_marks`)).rows).toEqual([]);expect(await consume(seen)).toBe(false);
    const latest=await claim();expect(latest.incarnation).not.toBe(first.incarnation);
    await advance('2000-01-14T00:00:00Z');expect(await consume(first)).toBe(false);expect(await consume(latest)).toBe(true);
  });

  it('retires old message and private mark keys before a move, and keeps new source keys separate',async()=>{
    await question();const old=await claim();
    await db.query(`UPDATE messages SET id='moved' WHERE id='question'`);
    await question('target');await db.query(`INSERT INTO needs_you_marks VALUES($1,'moved',$2,'2000-01-08',NULL)`,[viewer,workspace]);
    const oldSeen=await claim('question-seen','moved');
    await db.query(`UPDATE needs_you_marks SET message_id='target' WHERE message_id='moved'`);
    expect((await db.query(`SELECT state FROM tray_clock_deadlines WHERE source_id='question'`)).rows.every(row=>row.state==='cancelled')).toBe(true);
    await advance('2000-01-15');expect(await consume(old)).toBe(false);expect(await consume(oldSeen)).toBe(false);
    expect(await consume(await claim('question-seen','target'))).toBe(true);
  });

  it('cancels cleared seen obligations and recreates a new revision on actual reactivation',async()=>{
    await question();await db.query(`INSERT INTO needs_you_marks VALUES($1,'question',$2,'2000-01-08',NULL)`,[viewer,workspace]);
    const first=await claim('question-seen');await db.query(`UPDATE needs_you_marks SET cleared_at='2000-01-08'`);
    await db.query(`UPDATE needs_you_marks SET cleared_at=NULL`);const latest=await claim('question-seen');
    expect(latest.revision).toBe('3');await advance('2000-01-09');
    expect(await consume(first)).toBe(false);expect(await consume(latest)).toBe(true);
  });

  it('classifies already-past insert/backdate inline and never manufactures a future retry deadline',async()=>{
    await question('old','1999-01-01');expect((await db.query(`SELECT state FROM tray_clock_deadlines`)).rows).toEqual([{state:'elapsed'}]);
    expect(await readTrayClockDue(clock)).toEqual([]);expect(await causes()).toEqual([]);
    await question();await db.query(`UPDATE messages SET created_at='1999-01-01' WHERE id='question'`);
    expect((await db.query(`SELECT state FROM tray_clock_deadlines WHERE source_id='question'`)).rows).toEqual([{state:'elapsed'}]);
  });

  it('uses actual card predicates, no invented app-sign-in expiry, and rejects malformed JSON expiry',async()=>{
    for(const [id,type,body]of[
      ['agent','agent-sign-in',{ownerId:viewer,status:'pending',expiresAt:947462400000}],
      ['squire','squire-approval',{approvalId:'approval',sourceRoomId:room,expiresAt:947462400000}],
      ['app','app-sign-in',{ownerId:viewer,status:'pending',expiresAt:947462400000}],
      ['invalid','agent-sign-in',{ownerId:viewer,status:'pending',expiresAt:'tomorrow'}],
      ['no-expiry','agent-sign-in',{ownerId:viewer,status:'pending'}],
    ]as const)await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card) VALUES($1,$2,$3,'Synthetic','card',$4,$5::jsonb)`,[id,room,author,type,JSON.stringify(body)]);
    expect((await db.query(`SELECT source_id FROM tray_clock_deadlines ORDER BY source_id`)).rows).toEqual([{source_id:'agent'},{source_id:'squire'}]);
    await advance('2000-01-10');for(const due of await readTrayClockDue(clock))expect(await consume(due)).toBe(true);
    expect((await causes()).map(event=>event.kind).sort()).toEqual(['agent-sign-in','squire-approval']);
  });

  it('suppresses current unauthorized and reverse-decided audiences without failing to consume',async()=>{
    await question();await db.query(`UPDATE memberships SET removed_at='2000-01-08' WHERE identity_id=$1`,[viewer]);
    await advance('2000-01-14');expect(await consume(await claim())).toBe(true);expect(await causes()).toEqual([]);
    await db.query(`UPDATE memberships SET removed_at=NULL WHERE identity_id=$1`,[viewer]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card) VALUES('approval',$1,$2,'Synthetic','card','squire-approval',$3::jsonb)`,
      [room,author,JSON.stringify({approvalId:'a',sourceRoomId:otherRoom,expiresAt:948067200000})]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card) VALUES('decision',$1,$2,'Synthetic','card','squire-approval-decision','{"approvalId":"a"}')`,[otherRoom,author]);
    await advance('2000-01-17');expect(await consume(await claim('squire-approval','approval'))).toBe(true);expect(await causes()).toEqual([]);
  });

  it('does not write clock state/source tuples for ordinary content and duplicate mark mutations',async()=>{
    await question();await db.query(`INSERT INTO needs_you_marks VALUES($1,'question',$2,'2000-01-08',NULL)`,[viewer,workspace]);
    const before=(await db.query(`SELECT xmin::text,ctid::text,* FROM tray_clock_sources ORDER BY source_kind`)).rows;
    const deadlines=(await db.query(`SELECT xmin::text,ctid::text,* FROM tray_clock_deadlines ORDER BY kind`)).rows;
    const wakeHead=(await db.query(`SELECT sequence::text FROM live_streams WHERE id='jobs:tray-clock'`)).rows;
    await db.query(`UPDATE messages SET text='@reader approve another detail?' WHERE id='question'`);
    await db.query(`UPDATE needs_you_marks SET first_seen_at=first_seen_at`);
    expect((await db.query(`SELECT xmin::text,ctid::text,* FROM tray_clock_sources ORDER BY source_kind`)).rows).toEqual(before);
    expect((await db.query(`SELECT xmin::text,ctid::text,* FROM tray_clock_deadlines ORDER BY kind`)).rows).toEqual(deadlines);
    expect((await db.query(`SELECT sequence::text FROM live_streams WHERE id='jobs:tray-clock'`)).rows).toEqual(wakeHead);
    expect(await causes()).toEqual([]);expect((await readTrayClockBasis(db,workspace))?.revision).toBe('0');
  });

  it('bounds due discovery at 100, retains backlog, and cannot consume choice domain obligations',async()=>{
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
      SELECT 'q-'||n,$1,$2,'@reader please?','2000-01-07' FROM generate_series(1,101)n`,[room,author]);
    const choice='55555555-5555-4555-8555-555555555555';
    await db.query(`INSERT INTO room_choices VALUES($1,$2,$3,'open','2000-01-09')`,[choice,workspace,room]);
    await advance('2000-01-14');const batch=await readTrayClockDue(clock);expect(batch).toHaveLength(100);
    for(const entry of batch)expect(await consume(entry)).toBe(true);
    expect(await readTrayClockDue(clock)).toHaveLength(1);
    const [dueChoice]=await readTrayClockDue(clock,true);expect(await consume(dueChoice!)).toBe(false);
    expect((await db.query(`SELECT status FROM room_choices`)).rows).toEqual([{status:'open'}]);
  });

  it('rolls clock state, consumed watermark and source cause back together on failed commit',async()=>{
    await question();const initial=await claim();
    const sourceHead=(await db.query(`SELECT sequence::text FROM live_streams WHERE id='jobs:tray-clock'`)).rows;
    await expect(db.transaction(async tx=>{
      await tx.query(`UPDATE messages SET created_at=created_at+interval '1 day' WHERE id='question'`);
      throw new Error('synthetic source rollback');
    })).rejects.toThrow('synthetic source rollback');
    expect(await claim()).toEqual(initial);
    expect((await db.query(`SELECT sequence::text FROM live_streams WHERE id='jobs:tray-clock'`)).rows).toEqual(sourceHead);
    await advance('2000-01-14');const due=await claim(),basis=await readTrayClockBasis(db,workspace);
    await expect(clock.transaction(async tx=>{expect(await consumeTrayClockInTransaction(tx,due)).toBe(true);throw new Error('synthetic commit failure');})).rejects.toThrow('synthetic commit failure');
    expect(await readTrayClockBasis(db,workspace)).toEqual(basis);expect(await causes()).toEqual([]);
    expect(await consume(due)).toBe(true);
  });

  it('strictly parses only closed bounded reader causes',()=>{
    const cause={sourceTable:'tray-clock',trayReaderId:viewer,trayWorkspaceId:workspace,kind:'question-age',deadlineId:'1'.repeat(32),incarnation:'2'.repeat(32),revision:'1'};
    expect(readTrayClockCause(cause)).toEqual(cause);
    for(const invalid of[{...cause,kind:'app-sign-in'},{...cause,kind:'choice-close'},{...cause,revision:'01'},{...cause,inventory:[]},{...cause,trayReaderId:'x'.repeat(129)}])expect(readTrayClockCause(invalid)).toBeUndefined();
    const wake={sourceTable:'tray-clock-source',sourceKind:'message',sourceId:'question',readerId:'',incarnation:'a'.repeat(32),revision:'1'};
    expect(readTrayClockWake(wake)).toEqual(wake);expect(readTrayClockWake({...wake,job:'arbitrary'})).toBeUndefined();
    expect(readTrayClockWake({...wake,sourceKind:'seen'})).toBeUndefined();
  });

  it('exposes the exact next version and ignores no-Workspace messages without writing source inventory',async()=>{
    expect(await readTrayClockNext(clock)).toBeUndefined();await question();
    const next=await readTrayClockNext(clock);expect(next).toMatchObject({kind:'question-age',revision:'1',remainingMs:6*24*60*60*1000});
    await db.query(`INSERT INTO rooms(id) VALUES('66666666-6666-4666-8666-666666666666')`);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('unscoped','66666666-6666-4666-8666-666666666666',$1,'@reader please?')`,[author]);
    expect((await db.query(`SELECT 1 FROM tray_clock_sources WHERE source_id='unscoped'`)).rows).toEqual([]);
    const wake=(await db.query<{event:Record<string,unknown>}>(`SELECT event FROM live_journal WHERE stream_id='jobs:tray-clock'`)).rows;
    expect(wake).toHaveLength(1);expect(readTrayClockWake(wake[0]!.event)).toBeTruthy();
  });
  it('fresh committed clock identity advances its canonical Workspace even before readiness',async()=>{
    await question();const basis=await readTrayClockBasis(db,workspace);
    const rows=(await db.query<{event:Record<string,unknown>}>(`SELECT event FROM live_journal WHERE stream_id=$1`,[`workspace:${workspace}`])).rows;
    expect(rows).toHaveLength(1);expect(readTrayClockBasisCause(rows[0]!.event)).toEqual({sourceTable:'tray-clock-basis',version:1,
      trayWorkspaceId:workspace,generation:basis!.generation,revision:'0',ready:false});
  });
  it('a zero-reader expiry still advances the exact Workspace cut and emits its real changed basis',async()=>{
    await question();await db.query(`DELETE FROM memberships WHERE identity_id=$1`,[viewer]);
    const before=(await db.query<{sequence:string}>(`SELECT sequence::text FROM live_streams WHERE id=$1`,[`workspace:${workspace}`])).rows[0]!.sequence;
    await advance('2000-01-14');expect(await consume(await claim())).toBe(true);expect(await causes()).toEqual([]);
    const rows=(await db.query<{event:Record<string,unknown>}>(`SELECT event FROM live_journal WHERE stream_id=$1 AND sequence>$2`,[`workspace:${workspace}`,before])).rows;
    expect(rows).toHaveLength(1);expect(readTrayClockBasisCause(rows[0]!.event)).toMatchObject({sourceTable:'tray-clock-basis',trayWorkspaceId:workspace,revision:'1'});
  });
  it('Room moves invalidate only two exact Workspace generations with bounded foreground work and no fake source completion',async()=>{
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at) SELECT 'q-'||n,$1,$2,'@reader please?','2000-01-07' FROM generate_series(1,101)n`,[room,author]);
    const before=(await db.query(`SELECT sequence::text FROM live_streams WHERE id='jobs:tray-clock'`)).rows;
    const clock=await readTrayClockBasis(db,workspace);
    await db.query(`UPDATE rooms SET workspace_id=$1 WHERE id=$2`,[elsewhere,room]);
    expect((await db.query(`SELECT sequence::text FROM live_streams WHERE id='jobs:tray-clock'`)).rows).toEqual(before);
    expect((await db.query(`SELECT DISTINCT workspace_id::text FROM tray_clock_deadlines`)).rows).toEqual([{workspace_id:workspace}]);
    expect((await readTrayClockBasis(db,workspace))?.generation).not.toBe(clock!.generation);
    const pending=(await db.query(`SELECT workspace_id::text,phase FROM tray_clock_readiness ORDER BY workspace_id`)).rows;
    expect(pending).toEqual([{workspace_id:workspace,phase:'sources'},{workspace_id:elsewhere,phase:'sources'}]);
    const readiness=(await db.query<{event:Record<string,unknown>}>(`SELECT event FROM live_journal WHERE event->>'sourceTable'='tray-clock-readiness' ORDER BY stream_id`)).rows;
    expect(readiness).toHaveLength(2);expect(readiness.every(row=>readTrayClockBasisCause(row.event)?.ready===false)).toBe(true);
    const cuts=(await db.query(`SELECT id,sequence::text FROM live_streams ORDER BY id`)).rows;
    await db.query(`UPDATE rooms SET workspace_id=workspace_id WHERE id=$1`,[room]);expect((await db.query(`SELECT id,sequence::text FROM live_streams ORDER BY id`)).rows).toEqual(cuts);
  });
});
