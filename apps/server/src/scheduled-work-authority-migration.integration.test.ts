import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import type {SqlDatabase} from './database.js';
import {migratedDatabase,type PgliteDatabase} from './test-support.js';
import {SCHEDULED_WORK_AUTHORITY_SCHEMA} from './scheduled-work-authority.js';
import {PhoneService} from './phone-service.js';
import {LiveHub} from './live.js';
import {routerSocketProtocol} from './router-socket.js';
const EXISTING='a'.repeat(64),AGENT='b'.repeat(64),CURRENT='c'.repeat(64),HIDDEN='d'.repeat(64);

describe('existing-reader Scheduled Work authority stream installation',()=>{
  let db:PgliteDatabase;
  beforeEach(async()=>{
    db=await migratedDatabase();
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Already live reader')`,[CURRENT]);
    // Model genuine pre-feature records: no Scheduled Work identity trigger
    // has observed their insertion. Keep every other production trigger live.
    await db.query(`DROP TRIGGER beeline_scheduled_work_authority ON identities`);
    await db.query(`INSERT INTO identities(id,kind,name,hidden_from_roster) VALUES
      ($1,'human','Existing reader',false),($2,'agent','Existing helper',false),($3,'human','Existing hidden reader',true)`,[EXISTING,AGENT,HIDDEN]);
  });
  afterEach(async()=>{await db.close();});
  const heads=async()=>(await db.query(`SELECT id,epoch,sequence::text,byte_total::text FROM live_streams ORDER BY id`)).rows;
  const journal=async()=>(await db.query(`SELECT stream_id,sequence::text,event FROM live_journal ORDER BY stream_id,live_journal.sequence`)).rows;
  it('initializes existing human heads at zero once, preserving live epochs/history and emitting no fabricated cause',async()=>{
    expect((await db.query(`SELECT 1 FROM live_streams WHERE id=ANY($1::text[])`,[[`authority:${EXISTING}`,`authority:${HIDDEN}`]])).rowCount).toBe(0);
    const before=await heads(),events=await journal();
    await db.query(SCHEDULED_WORK_AUTHORITY_SCHEMA);
    const initialized=await heads();
    expect(initialized.filter(row=>row.id===`authority:${EXISTING}`||row.id===`authority:${HIDDEN}`)).toEqual([
      {id:`authority:${EXISTING}`,epoch:expect.any(String),sequence:'0',byte_total:'0'},
      {id:`authority:${HIDDEN}`,epoch:expect.any(String),sequence:'0',byte_total:'0'},
    ]);
    expect(initialized.filter(row=>before.some(old=>old.id===row.id))).toEqual(before);
    expect(initialized.some(row=>row.id===`authority:${AGENT}`)).toBe(false);
    expect(await journal()).toEqual(events);
    await db.query(SCHEDULED_WORK_AUTHORITY_SCHEMA);
    expect(await heads()).toEqual(initialized);expect(await journal()).toEqual(events);
  });
  it('negotiates real compact coverage for the migrated reader with zero write statements or source advancement',async()=>{
    await db.query(SCHEDULED_WORK_AUTHORITY_SCHEMA);const before=await heads(),events=await journal(),statements:string[]=[];
    const observe=(database:SqlDatabase):SqlDatabase=>({transaction:work=>database.transaction(tx=>work(observe(tx))),query:(sql,args)=>{
      statements.push(sql);
      if(!/^\s*(SELECT|WITH|SET)\b/i.test(sql)||/\b(beeline_journal|pg_notify|nextval)\s*\(/i.test(sql))throw new Error('Negotiation attempted a write');
      return database.query(sql,args);
    }});
    const observed=observe(db),frames:Record<string,any>[]=[],protocol=routerSocketProtocol(observed,EXISTING,raw=>{frames.push(JSON.parse(raw));},
      {families:['room-scheduled-work'],listenerReady:()=>true,commandDedupV1:true,scheduledWorkCoverageV1:true},
      {live:new LiveHub(),phone:new PhoneService(observed,'https://synthetic.test'),rooms:()=>{throw new Error('No client inventory');}});
    try{
      await protocol.handle({type:'router-negotiate',protocol:1,families:['room-scheduled-work'],authorityFencesV1:true,scheduledWorkCoverageV1:true});
      expect(frames).toEqual([expect.objectContaining({type:'router-capabilities',families:['room-scheduled-work'],
        scheduledWorkCoverageV1:{version:1,authorityStart:{stream:`authority:${EXISTING}`,epoch:expect.any(String),segment:expect.any(String),through:0,protocol:1}}})]);
      expect(statements.length).toBeGreaterThan(0);expect(await heads()).toEqual(before);expect(await journal()).toEqual(events);
    }finally{protocol.close();}
  });
});
