import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { endAgentTurn } from './agent-turn-end.js';
import { refuseExpiredFreeAgentTurn } from './free-agent-turn-budget.js';
import { OwnedModelAttempts } from './owned-model-attempt.js';
import { MODEL_AGENT, MODEL_CLAIM, MODEL_OWNER, MODEL_ROOM, MODEL_SOURCE, MODEL_WORKSPACE, ownedModelFixture } from './test-fixtures/owned-model.js';

let fixture: Awaited<ReturnType<typeof ownedModelFixture>>;
const OTHER_ROOM='33333333-3333-4333-8333-333333333333';
beforeEach(async()=>{fixture=await ownedModelFixture();});
afterEach(()=>fixture.db.close());
async function addSibling(scope: 'same'|'room'|'agent'|'generation'|'connection'|'epoch'|'control'='same') {
  if(scope==='room')await fixture.db.query("INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Elsewhere')",[OTHER_ROOM,MODEL_WORKSPACE]);
  await fixture.db.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,reason,
    root_command_id,root_source_message_id,agent_depth,state,generation_id,claimed_at,turn_owner_connection_id,turn_owner_epoch)
    VALUES('sibling',$1,$2,'sibling-request',$3,'human_tag','sibling','sibling-source',0,'claimed',$4,clock_timestamp(),$5,$6)`,
    [scope==='room'?OTHER_ROOM:MODEL_ROOM,scope==='agent'?MODEL_OWNER:MODEL_AGENT,scope==='control'?'stop':'input',
      scope==='generation'?'other-generation':MODEL_CLAIM.generationId,scope==='connection'?'other-connection':MODEL_SOURCE.connectionId,
      scope==='epoch'?2:MODEL_SOURCE.epoch]);
}
const end=(id:string)=>fixture.db.transaction(db=>endAgentTurn(db,{id,generation_id:MODEL_CLAIM.generationId},'complete'));
const prepare=()=>({reservation:{day:'2026-11-02',reserved:16,maxOutput:8,reservedUsd:0.01,credit:0},
  payload:{model:fixture.actor.binding.model,max_tokens:8,messages:[]}});

it('the same immutable credential dispatches a continuation after the first answer, then closes with the last answer',async()=>{
  await addSibling();
  await end(MODEL_CLAIM.commandId);
  const actor=await fixture.credentials.authenticate(fixture.db,fixture.issued.token);
  expect(actor.binding).toEqual(fixture.actor.binding);
  const attempts=new OwnedModelAttempts(fixture.db,fixture.credentials);
  const admitted=await attempts.reserve(actor,'11111111-1111-4111-8111-111111111111',{step:'answer the other request'},async()=>prepare());
  const start=vi.fn(async()=> 'provider response');
  const sent=await attempts.handoff(admitted.permit!,start);
  expect(sent.state).toBe('started');expect(await sent.completion).toBe('provider response');expect(start).toHaveBeenCalledOnce();
  await attempts.settleUsage(actor,'11111111-1111-4111-8111-111111111111',{tokens:2,usd:0},'succeeded',async()=>{});
  expect((await fixture.db.query('SELECT count(*)::int n FROM owned_model_credentials')).rows).toEqual([{n:1}]);
  await end('sibling');
  await expect(fixture.credentials.authenticate(fixture.db,fixture.issued.token)).rejects.toThrow('authority');
  expect((await fixture.db.query('SELECT id,state FROM agent_commands ORDER BY id')).rows)
    .toEqual([{id:'sibling',state:'complete'},{id:MODEL_CLAIM.commandId,state:'complete'}]);
});

it('the last answer fences an already reserved provider entry without inventing its outcome',async()=>{
  await addSibling();await end(MODEL_CLAIM.commandId);
  const attempts=new OwnedModelAttempts(fixture.db,fixture.credentials);
  const admitted=await attempts.reserve(fixture.actor,'11111111-1111-4111-8111-111111111111',{step:'reserved continuation'},async()=>prepare());
  await end('sibling');
  const start=vi.fn(async()=> 'must not run');
  await expect(attempts.handoff(admitted.permit!,start)).rejects.toThrow('authority');
  expect(start).not.toHaveBeenCalled();
  expect((await fixture.db.query('SELECT state FROM owned_model_attempts')).rows).toEqual([{state:'unknown'}]);
});

it.each(['room','agent','generation','connection','epoch','control'] as const)('a claimed command in another %s scope cannot extend the invocation',async scope=>{
  await addSibling(scope);await end(MODEL_CLAIM.commandId);
  await expect(fixture.credentials.authenticate(fixture.db,fixture.issued.token)).rejects.toThrow('authority');
});

it('the invocation cost limit ends only unanswered commands after its first result is complete',async()=>{
  await addSibling();
  await fixture.db.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status,generation_id)
    SELECT room_id,turn_request_id,agent_id,'working',generation_id FROM agent_commands`);
  await end(MODEL_CLAIM.commandId);
  await fixture.db.query("UPDATE agent_turns SET started_at=clock_timestamp()-interval '16 minutes' WHERE request_id='synthetic-request'");
  expect(await refuseExpiredFreeAgentTurn(fixture.db,MODEL_CLAIM.commandId,MODEL_CLAIM.generationId,15*60_000)).toBe(true);
  expect(await refuseExpiredFreeAgentTurn(fixture.db,MODEL_CLAIM.commandId,MODEL_CLAIM.generationId,15*60_000)).toBe(false);
  expect((await fixture.db.query('SELECT request_id,status FROM agent_turns ORDER BY request_id')).rows)
    .toEqual([{request_id:'sibling-request',status:'failed'},{request_id:'synthetic-request',status:'complete'}]);
});
