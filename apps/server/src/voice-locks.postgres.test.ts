import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import { migrate,PostgresDatabase } from './database.js';
import { concurrentWriters } from './test-fixtures/concurrent-writers.js';
import { VoiceService } from './voice-service.js';
import { VoiceBudgetStore } from './voice-budget.js';
import { LiveHub } from './live.js';

vi.mock('./voice-room-runtime.js',()=>({VoiceRoomRuntime:{connect:vi.fn(async()=>({
  countHumans:vi.fn(async()=>{}),close:vi.fn(async()=>{}),reconcileParticipants:vi.fn(async()=>{}),refresh:vi.fn(async()=>{}),
}))}}));
vi.mock('livekit-server-sdk',async original=>{
  const actual=await original<typeof import('livekit-server-sdk')>();
  return {...actual,RoomServiceClient:class {async removeParticipant(){} async deleteRoom(){}}};
});
const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(url&&!['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname))throw new Error('Isolated loopback PostgreSQL required');
describe.skipIf(!url)('voice atomic call and usage claims',()=>{
  const name='voice_locks_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url,max:1});
  const target=new URL(url??'postgresql://localhost/postgres');target.pathname='/'+name;
  const config={connectionString:target.toString(),max:1,options:'-c statement_timeout=8000'};
  const first=new PostgresDatabase('',1,{pool:new Pool(config)}),second=new PostgresDatabase('',1,{pool:new Pool(config)});
  const workspace=randomUUID(),room=randomUUID(),human='a'.repeat(64),other='b'.repeat(64),agent='c'.repeat(64);
  const services:VoiceService[]=[];
  const service=(db:PostgresDatabase)=>new VoiceService(db,new LiveHub(),{url:'ws://localhost',apiKey:'proof',apiSecret:'proof',
    brain:{answer:vi.fn()},speech:{synthesize:vi.fn()},stt:vi.fn()});
  beforeAll(async()=>{
    await admin.query(`CREATE DATABASE ${name}`);await migrate(first);
    await first.query(`INSERT INTO workspaces(id,name) VALUES($1,'Voice claims');`,[workspace]);
    await first.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Voice')`,[room,workspace]);
    await first.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','One'),($2,'human','Two'),($3,'agent','Agent')`,[human,other,agent]);
    await first.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)',[agent,human]);
    await first.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      SELECT $1,scope,person,'owner' FROM unnest(ARRAY[NULL::uuid,$2::uuid]) scope
      CROSS JOIN unnest($3::text[]) person`,[workspace,room,[human,other,agent]]);
  },60_000);
  afterAll(async()=>{
    await Promise.all(services.map(s=>s.close()));await first.close();await second.close();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH(FORCE)`);await admin.end();
  });
  it('two first joins share one call and one card, and concurrent exhaustion ends it once',async()=>{
    let index=0;
    const joined=await concurrentWriters(first,second,db=>{
      const voice=service(db as PostgresDatabase);services.push(voice);
      return voice.join(room,index++===0?human:other);
    },'INSERT INTO identities(id,kind,name,handle,hidden_from_roster,avatar)');
    expect(joined[0]!.call.id).toBe(joined[1]!.call.id);
    expect((await first.query(`SELECT id FROM messages WHERE room_id=$1 AND card_type='voice-call'`,[room])).rowCount).toBe(1);
    expect((await first.query('SELECT identity_id FROM voice_participants WHERE call_id=$1 AND left_at IS NULL',[joined[0]!.call.id])).rowCount).toBe(2);
    const now=Date.now(),day=Math.floor(now/86400000)*86400000;
    await first.query(`INSERT INTO voice_workspace_usage(workspace_id,call_id,day_start,audio) VALUES($1,$2,$3,$4::int8multirange)`,
      [workspace,joined[0]!.call.id,day,`{[${day},${day+3600000})}`]);
    await concurrentWriters(first,second,db=>{const voice=service(db as PostgresDatabase);services.push(voice);return voice.endWorkspaceCalls(workspace);},'UPDATE voice_calls call SET');
    expect((await first.query('SELECT id FROM voice_calls WHERE room_id=$1 AND ended_at IS NULL',[room])).rowCount).toBe(0);
    expect((await first.query('SELECT identity_id FROM voice_participants WHERE call_id=$1 AND left_at IS NULL',[joined[0]!.call.id])).rowCount).toBe(0);
    expect((await first.query(`SELECT presentation,card->'participants' participants FROM messages WHERE room_id=$1 AND card_type='voice-call'`,[room])).rows)
      .toEqual([{presentation:'system',participants:[]}]);
  });
  it('concurrent overlapping microphone checkpoints union rather than overwrite or double-charge',async()=>{
    const call=randomUUID(),message=randomUUID(),now=Date.now();
    await first.query('INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,\'fixture\')',[message,room,human]);
    await first.query(`INSERT INTO voice_calls(id,room_id,message_id,runtime_owner,runtime_until)
      VALUES($1,$2,$3,'owner',clock_timestamp()+interval '1 minute')`,[call,room,message]);
    await first.query('DELETE FROM voice_workspace_usage WHERE workspace_id=$1',[workspace]);
    let index=0;
    await concurrentWriters(first,second,db=>db.transaction(tx=>new VoiceBudgetStore(tx,10000,()=>now)
      .record(call,'owner',workspace,index++===0?[[now-100,now-25]]:[[now-75,now]])), 'INSERT INTO voice_workspace_usage(');
    expect((await new VoiceBudgetStore(first,10000,()=>now).read(workspace)).remainingMs).toBe(9900);
  });
});
