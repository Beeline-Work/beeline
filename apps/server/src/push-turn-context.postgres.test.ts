import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {migrate,PostgresDatabase,type SqlDatabase} from './database.js';
import {PushDeliveryLoop} from './background.js';
import {PUSH_OUTBOX_SCHEMA} from './push-outbox.js';
import {concurrentWriters} from './test-fixtures/concurrent-writers.js';

const url=process.env.BEELINE_PUSH_TEST_POSTGRES_URL;
if(url&&!['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname))throw new Error('Isolated loopback PostgreSQL required');
describe.skipIf(!url)('native push turn context',()=>{
  const name='push_turn_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url,max:1});
  const target=new URL(url??'postgresql://localhost/postgres');target.pathname='/'+name;
  const config={connectionString:target.toString(),max:1,options:'-c statement_timeout=8000'};
  const first=new PostgresDatabase('',1,{pool:new Pool(config)}),second=new PostgresDatabase('',1,{pool:new Pool(config)});
  const workspace=randomUUID(),room=randomUUID(),person='a'.repeat(64),agent='b'.repeat(64),request=randomUUID();
  const send=vi.fn().mockResolvedValue(undefined);
  const post=(db:SqlDatabase,id:string,turn:string)=>db.query(`INSERT INTO messages(id,room_id,author_id,text,request_id)
    VALUES($1,$2,$3,'@owner answer',$4)`,[id,room,agent,turn]);
  beforeAll(async()=>{
    await admin.query(`CREATE DATABASE ${name}`);await migrate(first);
    await first.query(`INSERT INTO identities(id,kind,name,handle,push_level)
      VALUES($1,'human','Owner','owner','full'),($2,'agent','Helper','helper','full')`,[person,agent]);
    await first.query(`INSERT INTO workspaces(id,name) VALUES($1,'Push proof')`,[workspace]);
    await first.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`,[room,workspace]);
    await first.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')`,[workspace,room,person,agent]);
    await first.query(`INSERT INTO push_devices(token,identity_id,platform,environment,registered_at)
      VALUES('proof-device',$1,'android','physical',now()-interval '1 day')`,[person]);
    await first.query(`INSERT INTO push_delivery_floors(id,started_at) VALUES('message-delivery',now()-interval '1 day')`);
  },60_000);
  afterAll(async()=>{await first.close();await second.close();await admin.query(`DROP DATABASE IF EXISTS ${name} WITH(FORCE)`);await admin.end();});
  it('merges concurrent writers into one context and sends once for that turn, then once for a new turn',async()=>{
    let writer=0;
    await concurrentWriters(first,second,db=>db.transaction(tx=>post(tx,'part-'+writer++,request)),'INSERT INTO messages');
    await post(first,'part-2',request);
    expect((await first.query<{turn_ids:string[]}>(`SELECT turn_ids FROM push_turn_context WHERE room_id=$1`,[room])).rows
      .map(row=>row.turn_ids.sort())).toEqual([['part-0','part-1','part-2']]);
    expect((await Promise.all([new PushDeliveryLoop(first,{send}).runOnce(),new PushDeliveryLoop(second,{send}).runOnce()]))
      .reduce((sum,count)=>sum+count,0)).toBe(1);
    expect(send.mock.calls.map(([,message])=>message.messageId)).toEqual(['part-2']);
    await post(first,'part-3',request);
    await post(first,'next-turn',randomUUID());
    expect(await new PushDeliveryLoop(first,{send}).runOnce()).toBe(1);
    expect(send.mock.calls.map(([,message])=>message.messageId)).toEqual(['part-2','next-turn']);
    expect((await first.query('SELECT * FROM push_turn_context')).rowCount).toBe(2);
  });
  it('upgrades queued per-message projections idempotently and retains existing turn claims',async()=>{
    await first.query('DELETE FROM push_turn_context');
    await first.query(PUSH_OUTBOX_SCHEMA);await first.query(PUSH_OUTBOX_SCHEMA);
    expect((await first.query<{turn_ids:string[]}>('SELECT turn_ids FROM push_turn_context WHERE request_id=$1',[request])).rows
      .map(row=>row.turn_ids.sort())).toEqual([['part-0','part-1','part-2','part-3']]);
    expect(await new PushDeliveryLoop(first,{send}).runOnce()).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
