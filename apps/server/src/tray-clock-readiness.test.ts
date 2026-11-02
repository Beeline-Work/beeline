import {BACKGROUND_OWNERSHIP_SCHEMA} from './background-ownership.js';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {migratedDatabase,type PgliteDatabase} from './test-support.js';
import type {SqlDatabase} from './database.js';
import {TRAY_CLOCK_SOURCE_SCHEMA} from './tray-clock-source.js';
import {TrayClockReadiness,readTrayClockReadiness,readTrayClockBasisCause} from './tray-clock-readiness.js';
import {postRoomChoice} from './room-choice.js';
const VIEWER='a'.repeat(64),AUTHOR='b'.repeat(64),WS='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
const ROOM='33333333-3333-4333-8333-333333333333',SECOND='44444444-4444-4444-8444-444444444444';
type Observe=(sql:string,db:SqlDatabase)=>Promise<void>;
const observed=(db:SqlDatabase,after:Observe):SqlDatabase=>({query:async(sql,args)=>{const value=await db.query(sql,args);await after(sql,db);return value;},
  transaction:work=>db.transaction(tx=>work(observed(tx,after)))});

describe('unselected bounded committed Tray capture readiness',()=>{
  let db:PgliteDatabase,owner:TrayClockReadiness,choiceId:string;
  beforeEach(async()=>{
    db=await migratedDatabase();await db.query(BACKGROUND_OWNERSHIP_SCHEMA);
    // Genuine pre-feature records: no clock lifecycle hook observes insertion.
    await db.query(`DO $$ DECLARE item record;BEGIN FOR item IN SELECT t.tgname,c.relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname=current_schema() AND NOT t.tgisinternal AND t.tgname LIKE 'beeline_tray_clock_%'
      LOOP EXECUTE format('DROP TRIGGER %I ON %I',item.tgname,item.relname);END LOOP;END $$;`);
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Reader','reader'),($2,'human','Author','writer')`,[VIEWER,AUTHOR]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Old'),($2,'New')`,[WS,OTHER]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'Room'),($2,$4,'Other')`,[ROOM,SECOND,WS,OTHER]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$4,'owner'),($1,$3,$4,'owner'),($2,NULL,$4,'owner')`,[WS,OTHER,ROOM,VIEWER]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES('q',$1,$2,'@reader please?',clock_timestamp()-interval '1 day'),
      ('past',$1,$2,'@reader please?',clock_timestamp()-interval '10 days'),('plain',$1,$2,'Ordinary text',clock_timestamp())`,[ROOM,AUTHOR]);
    await db.query(`INSERT INTO needs_you_marks(identity_id,message_id,workspace_id,first_seen_at) VALUES($1,'q',$2,clock_timestamp()-interval '1 hour')`,[VIEWER,WS]);
    for(const[id,type,card]of [['sign-in','agent-sign-in',{ownerId:VIEWER,status:'pending',expiresAt:Date.now()+7200000}],
      ['squire','squire-approval',{approvalId:'synthetic',sourceRoomId:ROOM,status:'pending',expiresAt:Date.now()+7200000}]] as const)
      await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card) VALUES($1,$2,$3,'Synthetic','card',$4,$5::jsonb)`,[id,ROOM,AUTHOR,type,JSON.stringify(card)]);
    const choice=await db.transaction(tx=>postRoomChoice(tx,{roomId:ROOM,agentId:VIEWER,mode:'question',prompt:'Synthetic?',options:[{label:'One',consequence:'One'},{label:'Two',consequence:'Two'}],ttlSeconds:300}));choiceId=choice.choiceId;
    await db.query(TRAY_CLOCK_SOURCE_SCHEMA);owner=new TrayClockReadiness(db);
  });
  afterEach(async()=>{await db.close();});
  const seed=async()=>{await owner.initialize();for(let n=0;n<20;n++){const batch=await owner.seed();expect(batch.processed).toBeLessThanOrEqual(100);if(!batch.continuation)return;}throw new Error('Unbounded seed');};
  const finish=async(instance=owner)=>{for(let n=0;n<50;n++){const batch=await instance.step();if(!batch)return;expect(batch.processed).toBeLessThanOrEqual(100);if(!batch.continuation)return;}throw new Error('Unbounded lifecycle completion');};
  const heads=async()=>(await db.query(`SELECT id,epoch,sequence::text FROM live_streams ORDER BY id`)).rows;
  const state=async(ws=WS)=>(await db.query(`SELECT generation,revision::text,ready FROM tray_clock_state WHERE workspace_id=$1`,[ws])).rows[0];

  it('verifies actual functions/parsed trigger guards once, and repeated initialization changes no source cut',async()=>{
    await owner.initialize();const before=await heads();await owner.initialize();expect(await heads()).toEqual(before);
    expect((await db.query(`SELECT 1 FROM pg_trigger WHERE tgname='beeline_tray_clock_readiness_probe'`)).rowCount).toBe(0);
    await seed();expect((await state()).ready).toBe(false);expect((await state(OTHER)).ready).toBe(false);
  });
  it('backfills all existing source kinds, including already aged records, before publishing a coherent generation/cut',async()=>{
    expect((await db.query(`SELECT * FROM tray_clock_sources`)).rowCount).toBe(0);await seed();await finish();
    const rows=(await db.query(`SELECT kind,state FROM tray_clock_deadlines ORDER BY kind,state`)).rows;
    expect(rows).toEqual([{kind:'agent-sign-in',state:'pending'},{kind:'choice-close',state:'pending'},
      {kind:'question-age',state:'elapsed'},{kind:'question-age',state:'pending'},{kind:'question-seen',state:'pending'},{kind:'squire-approval',state:'pending'}]);
    expect((await db.query(`SELECT * FROM tray_clock_sources WHERE source_id='plain'`)).rows).toEqual([]);
    const ready=await readTrayClockReadiness(db,WS);expect(ready?.ready).toBe(true);expect(ready?.source_epoch).toEqual(expect.any(String));
    const cause=(await db.query<{event:Record<string,unknown>}>(`SELECT event FROM live_journal WHERE stream_id=$1 AND sequence=$2`,[`workspace:${WS}`,ready!.workspace_through])).rows[0]!.event;
    expect(readTrayClockBasisCause(cause)).toEqual({sourceTable:'tray-clock-readiness',version:1,trayWorkspaceId:WS,generation:ready!.generation,revision:ready!.revision,ready:true});
    const before=await heads();expect(await owner.step()).toBe(null);expect(await heads()).toEqual(before);
  });
  it('bounded high-watermark pages make finite progress while later inserts use actual capture',async()=>{
    await db.query(`ALTER TABLE messages DISABLE TRIGGER beeline_tray_clock_message_insert`);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) SELECT 'old-'||lpad(n::text,3,'0'),$1,$2,'@reader please?' FROM generate_series(1,205)n`,[ROOM,AUTHOR]);
    await db.query(`ALTER TABLE messages ENABLE TRIGGER beeline_tray_clock_message_insert`);await seed();await owner.step();
    const first=await owner.step();expect(first).toMatchObject({processed:100,ready:false,continuation:true});
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('zz-after-bound',$1,$2,'@reader please?'),('000-behind-cursor',$1,$2,'@reader please?')`,[ROOM,AUTHOR]);
    await finish();expect((await readTrayClockReadiness(db,WS))?.ready).toBe(true);
    expect((await db.query(`SELECT source_id FROM tray_clock_deadlines WHERE source_id IN('zz-after-bound','000-behind-cursor') ORDER BY source_id`)).rows)
      .toEqual([{source_id:'000-behind-cursor'},{source_id:'zz-after-bound'}]);
  });
  it('pure readiness access never initializes or repairs missing evidence',async()=>{
    const before=await heads();expect(await readTrayClockReadiness(db,WS)).toBeUndefined();expect(await heads()).toEqual(before);
    expect((await db.query(`SELECT * FROM tray_clock_readiness_floor`)).rows).toEqual([]);
  });
  it('a genuinely new empty Workspace has pending work and cannot become ready without the owned exhaustive phases',async()=>{
    await seed();await finish();const fresh='55555555-5555-4555-8555-555555555555';
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'New empty Workspace')`,[fresh]);
    expect((await readTrayClockReadiness(db,fresh))?.ready).toBe(false);
    expect((await db.query(`SELECT phase FROM tray_clock_readiness WHERE workspace_id=$1`,[fresh])).rows).toEqual([{phase:'sources'}]);
    await finish();expect((await readTrayClockReadiness(db,fresh))?.ready).toBe(true);
  });
  it('a Room move atomically invalidates both old/new generations without foreground message fanout, then actual reconciliation repairs scopes',async()=>{
    await seed();await finish();const old=await state(),target=await state(OTHER),before=(await db.query(`SELECT count(*)::int n FROM live_journal WHERE stream_id='jobs:tray-clock'`)).rows;
    await db.transaction(async tx=>{
      await tx.query(`UPDATE rooms SET workspace_id=$1 WHERE id=$2`,[OTHER,ROOM]);
      expect((await readTrayClockReadiness(tx,WS))?.ready).toBe(false);expect((await readTrayClockReadiness(tx,OTHER))?.ready).toBe(false);
    });
    expect((await state()).generation).not.toBe(old.generation);expect((await state(OTHER)).generation).not.toBe(target.generation);
    expect((await db.query(`SELECT count(*)::int n FROM live_journal WHERE stream_id='jobs:tray-clock'`)).rows).toEqual(before);
    expect((await db.query(`SELECT workspace_id::text FROM tray_clock_deadlines WHERE source_id='q' AND kind='question-age'`)).rows).toEqual([{workspace_id:WS}]);
    // Actual domain keys must move coherently too; the migration never rewrites
    // them or bypasses the existing choice/seen ownership policy.
    await db.query(`UPDATE room_choices SET workspace_id=$1 WHERE id=$2`,[OTHER,choiceId]);
    await db.query(`UPDATE needs_you_marks SET workspace_id=$1 WHERE message_id='q'`,[OTHER]);
    await finish();expect((await readTrayClockReadiness(db,WS))?.ready).toBe(true);expect((await readTrayClockReadiness(db,OTHER))?.ready).toBe(true);
    expect((await db.query(`SELECT DISTINCT workspace_id::text FROM tray_clock_deadlines WHERE state<>'cancelled'`)).rows).toEqual([{workspace_id:OTHER}]);
  });
  it('resetting a migration generation persists real work; an empty invalidation cannot manufacture readiness',async()=>{
    await seed();await owner.step();await owner.step();const prior=await state();
    await db.query(`SELECT beeline_tray_clock_require_readiness(ARRAY[$1::uuid])`,[WS]);
    expect((await state()).generation).not.toBe(prior.generation);expect((await state()).ready).toBe(false);
    expect((await db.query(`SELECT phase,cursor_one,bounded FROM tray_clock_readiness WHERE workspace_id=$1`,[WS])).rows)
      .toEqual([{phase:'sources',cursor_one:null,bounded:false}]);await finish();expect((await readTrayClockReadiness(db,WS))?.ready).toBe(true);
  });
  it('missing/disabled or semantically changed capture guards cannot establish a floor',async()=>{
    await db.query(`ALTER TABLE messages DISABLE TRIGGER beeline_tray_clock_message_change`);
    await expect(owner.initialize()).rejects.toThrow('trigger differs');expect((await db.query(`SELECT * FROM tray_clock_readiness_floor`)).rows).toEqual([]);
    await db.query(TRAY_CLOCK_SOURCE_SCHEMA);
    await db.query(`DROP TRIGGER beeline_tray_clock_message_change ON messages;
      CREATE TRIGGER beeline_tray_clock_message_change AFTER UPDATE ON messages FOR EACH ROW WHEN(false) EXECUTE FUNCTION beeline_tray_clock_capture()`);
    await expect(owner.initialize()).rejects.toThrow('trigger differs');
  });
  it('changed functions or installed capture after initialization fail closed rather than preserving a stale ready bit',async()=>{
    await seed();await finish();
    await db.query(`CREATE OR REPLACE FUNCTION beeline_tray_clock_room_move() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW;END$$`);
    expect((await readTrayClockReadiness(db,WS))?.ready).toBe(false);await expect(owner.seed()).rejects.toThrow('floor unavailable');
    await expect(owner.step()).rejects.toThrow('floor unavailable');
  });
  it('one failed lifecycle batch rolls reconciliation, source cuts and cursor back together',async()=>{
    await seed();await owner.step();const before=await heads(),cursor=(await db.query(`SELECT * FROM tray_clock_readiness WHERE workspace_id=$1`,[WS])).rows;
    let fail=true;const broken=new TrayClockReadiness(observed(db,async sql=>{if(fail&&sql.startsWith('SELECT beeline_tray_clock_reconcile')){fail=false;throw new Error('synthetic migration failure');}}));
    await expect(broken.step()).rejects.toThrow('synthetic migration failure');expect(await heads()).toEqual(before);
    expect((await db.query(`SELECT * FROM tray_clock_readiness WHERE workspace_id=$1`,[WS])).rows).toEqual(cursor);expect((await state()).ready).toBe(false);
    await finish();expect((await readTrayClockReadiness(db,WS))?.ready).toBe(true);
  });
  it('a no-op reconcile with inconsistent captured evidence cannot be mistaken for an exhaustive success',async()=>{
    await seed();await owner.step();await owner.step();
    await db.query(`DELETE FROM tray_clock_deadlines WHERE source_id='q' AND kind='question-age'`);
    await db.query(`UPDATE tray_clock_readiness SET phase='messages',cursor_one=NULL,bounded=false WHERE workspace_id=$1`,[WS]);
    await expect(owner.step()).rejects.toThrow('reconciliation incomplete');expect((await readTrayClockReadiness(db,WS))?.ready).toBe(false);
  });
  it('a source mutation behind a captured cursor stays coherent through actual lifecycle hooks',async()=>{
    await seed();await owner.step();await owner.step();
    await db.query(`UPDATE messages SET id='000-renamed' WHERE id='past'`);
    await finish();expect((await readTrayClockReadiness(db,WS))?.ready).toBe(true);
    expect((await db.query(`SELECT source_id,state FROM tray_clock_deadlines WHERE source_id IN('past','000-renamed') AND kind='question-age' ORDER BY source_id`)).rows)
      .toEqual([{source_id:'000-renamed',state:'elapsed'},{source_id:'past',state:'cancelled'}]);
  });
  it('unsupported source key bounds leave pending work unavailable rather than trimming a clock source',async()=>{
    await db.query(`ALTER TABLE messages DISABLE TRIGGER beeline_tray_clock_message_insert`);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@reader please?')`,['z'.repeat(129),ROOM,AUTHOR]);
    await db.query(`ALTER TABLE messages ENABLE TRIGGER beeline_tray_clock_message_insert`);await seed();await owner.step();
    await expect(owner.step()).rejects.toThrow('Unrepresentable');expect((await state()).ready).toBe(false);
  });
  it('charges empty Room entries/completions against100 instead of scanning all empty Rooms in one lifecycle pass',async()=>{
    await db.query(`INSERT INTO rooms(id,workspace_id,name)
      SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$1,'Empty' FROM generate_series(1,205)n`,[OTHER]);
    await seed();
    for(let n=0;n<20;n++){
      const phase=(await db.query<{phase:string}>(`SELECT phase FROM tray_clock_readiness WHERE workspace_id=$1`,[OTHER])).rows[0]!.phase;
      if(phase==='messages')break;await owner.step();
    }
    const result=await owner.step();expect(result).toMatchObject({workspaceId:OTHER,processed:100,ready:false,continuation:true});
    const progress=(await db.query(`SELECT phase,room_cursor::text,current_room FROM tray_clock_readiness WHERE workspace_id=$1`,[OTHER])).rows;
    expect(progress).toEqual([{phase:'messages',room_cursor:'00000000-0000-4000-8000-000000000050',current_room:null}]);
    await finish();expect((await readTrayClockReadiness(db,OTHER))?.ready).toBe(true);
  });
  it('keeps the Room high watermark finite while actual capture covers Rooms inserted behind and beyond it',async()=>{
    await db.query(`ALTER TABLE messages DISABLE TRIGGER beeline_tray_clock_message_insert`);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) SELECT 'old-'||lpad(n::text,3,'0'),$1,$2,'@reader please?' FROM generate_series(1,205)n`,[ROOM,AUTHOR]);
    await db.query(`ALTER TABLE messages ENABLE TRIGGER beeline_tray_clock_message_insert`);await seed();await owner.step();await owner.step();
    const bound=(await db.query<{room_bound:string}>(`SELECT room_bound::text FROM tray_clock_readiness WHERE workspace_id=$1`,[WS])).rows[0]!.room_bound;
    const behind='00000000-0000-4000-8000-000000000001',beyond='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'Behind'),($2,$3,'Beyond')`,[behind,beyond,WS]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('behind-room',$1,$3,'@reader please?'),('beyond-room',$2,$3,'@reader please?')`,[behind,beyond,AUTHOR]);
    expect((await db.query(`SELECT room_bound::text FROM tray_clock_readiness WHERE workspace_id=$1`,[WS])).rows).toEqual([{room_bound:bound}]);
    await finish();expect((await readTrayClockReadiness(db,WS))?.ready).toBe(true);
    expect((await db.query(`SELECT source_id FROM tray_clock_deadlines WHERE source_id IN('behind-room','beyond-room') ORDER BY source_id`)).rows)
      .toEqual([{source_id:'behind-room'},{source_id:'beyond-room'}]);
  });
  it('bounds per-message reader traversal while capture handles new marks on both sides of the reader cursor',async()=>{
    await db.query(`INSERT INTO identities(id,kind,name,handle) SELECT lpad(to_hex(n+1000),64,'0'),'human','Synthetic','reader-'||n FROM generate_series(1,205)n`);
    await db.query(`ALTER TABLE needs_you_marks DISABLE TRIGGER beeline_tray_clock_seen_insert`);
    await db.query(`INSERT INTO needs_you_marks(identity_id,message_id,workspace_id)
      SELECT lpad(to_hex(n+1000),64,'0'),'q',$1 FROM generate_series(1,205)n`,[WS]);
    await db.query(`ALTER TABLE needs_you_marks ENABLE TRIGGER beeline_tray_clock_seen_insert`);await seed();
    for(let n=0;n<10;n++){
      const phase=(await db.query<{phase:string}>(`SELECT phase FROM tray_clock_readiness WHERE workspace_id=$1`,[WS])).rows[0]!.phase;
      if(phase==='seen')break;await owner.step();
    }
    expect(await owner.step()).toMatchObject({processed:100,ready:false,continuation:true});
    expect((await db.query(`SELECT current_message FROM tray_clock_readiness WHERE workspace_id=$1`,[WS])).rows).toEqual([{current_message:'q'}]);
    const behind='0'.repeat(63)+'1',beyond='f'.repeat(64);
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Behind','behind'),($2,'human','Beyond','beyond')`,[behind,beyond]);
    await db.query(`INSERT INTO needs_you_marks(identity_id,message_id,workspace_id) VALUES($1,'q',$3),($2,'q',$3)`,[behind,beyond,WS]);
    await finish();expect((await readTrayClockReadiness(db,WS))?.ready).toBe(true);
    expect((await db.query(`SELECT count(*)::int n FROM tray_clock_deadlines WHERE source_kind='seen' AND source_id='q'`)).rows).toEqual([{n:208}]);
  });
  it('refuses a wrong-key traversal index and later index drift cannot preserve ready evidence',async()=>{
    await db.query(`DROP INDEX tray_clock_readiness_messages_idx;CREATE INDEX tray_clock_readiness_messages_idx ON messages(id,room_id)`);
    await expect(owner.initialize()).rejects.toThrow('traversal index unavailable');expect((await db.query(`SELECT * FROM tray_clock_readiness_floor`)).rows).toEqual([]);
    await db.query(`DROP INDEX tray_clock_readiness_messages_idx`);await db.query(TRAY_CLOCK_SOURCE_SCHEMA);await seed();await finish();
    expect((await readTrayClockReadiness(db,WS))?.ready).toBe(true);await db.query(`DROP INDEX tray_clock_readiness_messages_idx`);
    expect((await readTrayClockReadiness(db,WS))?.ready).toBe(false);await expect(owner.step()).rejects.toThrow('floor unavailable');
  });
  it('invalidates mutable empty Room IDs and rolls all evidence back when a referenced ID mutation is refused',async()=>{
    await seed();await finish();const original=await state(OTHER),fresh='55555555-5555-4555-8555-555555555555';
    await db.query(`UPDATE rooms SET id=$1 WHERE id=$2`,[fresh,SECOND]);
    expect((await state(OTHER)).generation).not.toBe(original.generation);expect((await readTrayClockReadiness(db,OTHER))?.ready).toBe(false);
    await finish();expect((await readTrayClockReadiness(db,OTHER))?.ready).toBe(true);
    const before=await heads(),prior=await state();
    await expect(db.query(`UPDATE rooms SET id=$1 WHERE id=$2`,['66666666-6666-4666-8666-666666666666',ROOM])).rejects.toMatchObject({code:'23503'});
    expect(await heads()).toEqual(before);expect(await state()).toEqual(prior);
  });
  it('decodes only the exact closed six-member readiness/basis cause',()=>{
    const value={sourceTable:'tray-clock-basis',version:1,trayWorkspaceId:WS,generation:'a'.repeat(32),revision:'0',ready:false};
    expect(readTrayClockBasisCause(value)).toEqual(value);expect(readTrayClockBasisCause({...value,sourceTable:'tray-clock-readiness'})).toBeDefined();
    for(const invalid of [{...value,extra:true},{...value,revision:'-1'},{...value,ready:1},{...value,version:2}])expect(readTrayClockBasisCause(invalid)).toBeUndefined();
  });
});
