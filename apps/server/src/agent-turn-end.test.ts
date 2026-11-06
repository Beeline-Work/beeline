import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { SqlDatabase } from './database.js';
import { AGENT_TURN_END_SCHEMA, endAgentTurn } from './agent-turn-end.js';

const pg = new PGlite();
const db = { query: async (sql: string, values: unknown[] = []) => {
  const result = await pg.query(sql, values);
  return { rows:result.rows, rowCount:result.rows.length || result.affectedRows || 0 };
} } as SqlDatabase;
beforeAll(async () => {
  await pg.exec(`CREATE TABLE agent_commands(id text PRIMARY KEY,room_id text,agent_id text,turn_request_id text,
    state text,generation_id text,reason text,completed_at timestamptz,lease_expires_at timestamptz,cancellation_reason text,result_message_id text);
    CREATE TABLE agent_turns(room_id text,agent_id text,request_id text,status text,generation_id text,
      failure_reason text,created_at timestamptz DEFAULT now());
    CREATE TABLE agent_command_generation_owners(command_id text,generation_id text);
    CREATE TABLE live_outputs(room_id text,agent_id text,turn_id text,kind text);
    ${AGENT_TURN_END_SCHEMA}`);
});
afterAll(() => pg.close());
beforeEach(async () => {
  await pg.exec(`TRUNCATE agent_commands,agent_turns,live_outputs,agent_command_generation_owners;
    INSERT INTO agent_command_generation_owners VALUES('command','first');
    INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,state,generation_id)
      VALUES('command','room','agent','request','claimed','first');
    INSERT INTO agent_turns(room_id,agent_id,request_id,status,generation_id)
      VALUES('room','agent','request','working','first');
    INSERT INTO live_outputs VALUES('room','agent','request','draft'),('room','agent','request','thought');`);
});
const command = { id:'command', generation_id:'first' };
const state = async () => (await pg.query(`SELECT command.state,command.result_message_id,turn.status,turn.failure_reason
  FROM agent_commands command JOIN agent_turns turn ON turn.request_id=command.turn_request_id`)).rows;

it.each(['complete','failed','cancelled'] as const)('ends command and turn together for %s and ignores late results', async outcome => {
  expect(await endAgentTurn(db,command,outcome,'reason',outcome === 'complete' ? 'answer' : undefined)).toBe(true);
  expect(await state()).toEqual([{state:outcome === 'cancelled' ? 'cancelled' : 'complete',
    result_message_id:outcome === 'complete' ? 'answer' : null,status:outcome,failure_reason:'reason'}]);
  expect((await pg.query('SELECT * FROM live_outputs')).rows).toEqual([]);
  expect(await endAgentTurn(db,command,'complete',null,'late answer')).toBe(false);
  expect((await state())[0]?.status).toBe(outcome);
});
it('refuses an old generation without changing a successor or clearing its output', async () => {
  await pg.exec("UPDATE agent_commands SET generation_id='successor'; UPDATE agent_turns SET generation_id='successor';");
  expect(await endAgentTurn(db,command,'failed','old receipt')).toBe(false);
  expect((await state())[0]?.status).toBe('working');
  expect((await pg.query('SELECT * FROM live_outputs')).rows).toHaveLength(2);
});
it('ends pending commands through the same owner on explicit cancellation', async () => {
  await pg.exec("UPDATE agent_commands SET state='pending',generation_id=NULL; UPDATE agent_turns SET generation_id='pending:command';");
  expect(await endAgentTurn(db,{id:command.id,generation_id:null},'cancelled','corner_close')).toBe(true);
  expect((await state())[0]?.status).toBe('cancelled');
});
it('rolls back the result, command, turn and output changes with its caller transaction', async () => {
  await expect(pg.transaction(async tx => {
    await tx.query("SELECT * FROM beeline_end_agent_turn('command','first','complete',NULL,'answer')");
    throw new Error('reply insert refused');
  })).rejects.toThrow('reply insert refused');
  expect((await state())[0]?.status).toBe('working');
  expect((await pg.query('SELECT * FROM live_outputs')).rows).toHaveLength(2);
});
it.each([null,'first'])('never completes an unrelated turn with expected generation %s', async generation => {
  if(generation===null)await pg.exec("UPDATE agent_commands SET state='pending',generation_id=NULL;");
  await pg.exec("INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,state,generation_id) VALUES('next','room','agent','request','claimed','next'); UPDATE agent_turns SET generation_id='next';");
  expect(await endAgentTurn(db,{id:command.id,generation_id:generation},'cancelled')).toBe(true);
  expect((await state())[0]?.status).toBe('working');
  expect((await pg.query('SELECT * FROM live_outputs')).rows).toHaveLength(2);
});

it('explicit cancellation settles the abandoned generation after connection hand-back', async () => {
  await pg.exec("UPDATE agent_commands SET state='pending',generation_id=NULL;");
  expect(await endAgentTurn(db,{id:command.id,generation_id:null},'cancelled','superseded_report')).toBe(true);
  expect((await state())[0]?.status).toBe('cancelled');
  expect((await pg.query('SELECT * FROM live_outputs')).rows).toEqual([]);
});
it('a pending-generation cancellation cannot end a new claim', async () => {
  expect(await endAgentTurn(db,{id:command.id,generation_id:null},'cancelled')).toBe(false);
  expect((await state())[0]?.status).toBe('working');
});
