import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';
import type { SqlDatabase } from './database.js';
import { BackgroundWork } from './background-work.js';
import { ChoiceExpiryLoop } from './choice-expiry.js';
import { CHOICE_EXPIRY_SCHEMA } from './choice-expiry-schema.js';
import { COMMAND_COMPLETION_CHANNEL, notifyCommandCompletion, subscribeCommandCompletion } from './command-completion.js';
import { closeExpiredChoices, postRoomChoice } from './room-choice.js';
import type { PostgresDatabase } from './database.js';
import { groupBPostgresDatabase } from './test-fixtures/test-support-router-group-b-postgres.js';
import { AgentScheduleLoop } from './agent-schedules.js';

const human='a'.repeat(64), room='11111111-1111-4111-8111-111111111111', workspace='22222222-2222-4222-8222-222222222222';
const postgresUrl=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
describe.each(['pglite',...(postgresUrl?['postgres']:[])])('P12 actual choice expiry obligations (%s)', backend => {
  let db: PgliteDatabase|PostgresDatabase, stop: () => Promise<void>, closeDatabase:()=>Promise<void>;
  beforeAll(async () => {
    if(backend==='postgres'){
      const fixture=await groupBPostgresDatabase(postgresUrl!);db=fixture.database;closeDatabase=fixture.close;
      stop=await fixture.listenToCompletions();
    }else{
      const local=await migratedDatabase();db=local;closeDatabase=()=>local.close();
      stop=await local.client.listen(COMMAND_COMPLETION_CHANNEL,notifyCommandCompletion);
    }
    await db.query(CHOICE_EXPIRY_SCHEMA);
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Synthetic owner')`,[human]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Synthetic workspace')`,[workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Synthetic Room')`,[room,workspace]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner'),($1,NULL,$3,'owner')`,[workspace,room,human]);
  },60000);
  afterAll(async()=>{await stop?.();await closeDatabase?.();});
  const create=()=>db.transaction(tx=>postRoomChoice(tx,{roomId:room,agentId:human,mode:'question',prompt:'Synthetic choice?',options:[{label:'One',consequence:'Use one'},{label:'Two',consequence:'Use two'}],ttlSeconds:300}));

  it('has zero SQL during an empty idle day and unrelated Room traffic',async()=>{
    let now=0; const query=vi.fn(db.query.bind(db));
    const observed:SqlDatabase={query,transaction:work=>db.transaction(work)};
    const loop=new ChoiceExpiryLoop(observed), work=new BackgroundWork(()=>now,()=>{});
    work.addDeadline('choices',()=>loop.runOnce());
    const scheduleQueries=vi.fn(db.query.bind(db));
    const schedule=new AgentScheduleLoop({query:scheduleQueries,transaction:work=>db.transaction(work)});
    work.addDeadline('schedules',async()=>{await schedule.runOnce();return await schedule.nextDelayMs()??undefined;});
    expect(await work.run(true)).toBe(Infinity);expect(query).toHaveBeenCalledTimes(2);
    expect(scheduleQueries).toHaveBeenCalled();const scheduleCount=scheduleQueries.mock.calls.length;
    now=86_400_000;work.wake('messages');expect(await work.run(false)).toBe(Infinity);expect(query).toHaveBeenCalledTimes(2);
    expect(scheduleQueries).toHaveBeenCalledTimes(scheduleCount);
    const source=vi.fn(()=>work.wake('choices','committed-choice'));
    const release=subscribeCommandCompletion({principal:'choice',operation:'expiry',commandId:'pending'},source);
    try{
      const choice=await create();await vi.waitFor(()=>expect(source).toHaveBeenCalledOnce());
      expect(await work.run(false)).toBeGreaterThan(0);
      expect(query).toHaveBeenCalledTimes(4);expect(scheduleQueries).toHaveBeenCalledTimes(scheduleCount);
      await db.query(`UPDATE room_choices SET status='skipped' WHERE id=$1`,[choice.choiceId]);
      await vi.waitFor(()=>expect(source).toHaveBeenCalledTimes(2));await work.run(false);
      const initialized=query.mock.calls.length;
      await work.run(true);expect(query).toHaveBeenCalledTimes(initialized+2);
      expect(scheduleQueries.mock.calls.length).toBeGreaterThan(scheduleCount);
    }finally{release();}
  });
  it('notifies only committed deadline/state changes and settles an actual due choice exactly once',async()=>{
    const wake=vi.fn(),release=subscribeCommandCompletion({principal:'choice',operation:'expiry',commandId:'pending'},wake);
    try {
      const choice=await create();await vi.waitFor(()=>expect(wake).toHaveBeenCalledOnce());wake.mockClear();
      await db.query(`UPDATE room_choices SET prompt='Changed content' WHERE id=$1`,[choice.choiceId]);expect(wake).not.toHaveBeenCalled();
      await expect(db.transaction(async tx=>{await tx.query(`UPDATE room_choices SET closes_at=clock_timestamp() WHERE id=$1`,[choice.choiceId]);throw new Error('rollback');})).rejects.toThrow('rollback');
      expect(wake).not.toHaveBeenCalled();
      const delay=await new ChoiceExpiryLoop(db).runOnce();expect(delay).toBeGreaterThan(0);expect(delay).toBeLessThanOrEqual(300_000);
      await db.query(`UPDATE room_choices SET closes_at=clock_timestamp()-interval '1 second' WHERE id=$1`,[choice.choiceId]);await vi.waitFor(()=>expect(wake).toHaveBeenCalledOnce());
      expect(await closeExpiredChoices(db)).toBe(1);expect(await closeExpiredChoices(db)).toBe(0);
      expect((await db.query(`SELECT status FROM room_choices WHERE id=$1`,[choice.choiceId])).rows[0]!.status).toBe('skipped');
      expect((await db.query(`SELECT count(*)::int count FROM messages WHERE card_type='choice-skipped'`)).rows[0]!.count).toBe(1);
    } finally {release();}
  });
  it('fences even a changed deadline that remains due, then admits the new version once',async()=>{
    const choice=await create();await db.query(`UPDATE room_choices SET closes_at=clock_timestamp()-interval '2 seconds' WHERE id=$1`,[choice.choiceId]);
    let changed=false;const observed:SqlDatabase={transaction:work=>db.transaction(work),query:async(sql,values)=>{
      const result=await db.query(sql,values);
      if(!changed&&sql.includes('expiry_version FROM room_choices')){changed=true;await db.query(`UPDATE room_choices SET closes_at=closes_at+interval '1 microsecond' WHERE id=$1`,[choice.choiceId]);}
      return result;
    }};
    expect(await closeExpiredChoices(observed)).toBe(0);
    expect((await db.query(`SELECT status FROM room_choices WHERE id=$1`,[choice.choiceId])).rows[0]!.status).toBe('open');
    expect(await closeExpiredChoices(db)).toBe(1);
  });
  it('a failed batch parks until an actual source wake, with no due query or retry deadline',async()=>{
    let now=0;const query=vi.fn().mockRejectedValueOnce(new Error('outage')).mockResolvedValue({rows:[],rowCount:0});
    const loop=new ChoiceExpiryLoop({query,transaction:vi.fn()}),work=new BackgroundWork(()=>now,()=>{});
    work.addDeadline('choices',async()=>{try{return await loop.runOnce();}catch{return;}});
    expect(await work.run(true)).toBe(Infinity);expect(query).toHaveBeenCalledOnce();
    now=86_400_000;expect(await work.run(false)).toBe(Infinity);expect(query).toHaveBeenCalledOnce();
    work.wake('choices','committed-choice');expect(await work.run(false)).toBe(Infinity);expect(query).toHaveBeenCalledTimes(3);
  });
});
