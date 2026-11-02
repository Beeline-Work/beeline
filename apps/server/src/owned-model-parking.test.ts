import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OwnedModelAttempts } from './owned-model-attempt.js';
import { parkOwnedModelGeneration, parkOwnedModelTerminal, guardOwnedModelSilence } from './owned-model-parking.js';
import { commandOwnerLiveSql, commandOwnerExpiredSql, registerOwnedEffectFence } from './turn-ownership.js';
import { createAgentCommand, claimAgentCommand } from './agent-command.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { noteFirstSilence } from './turn-silence-notice.js';
import { MODEL, MODEL_AGENT, MODEL_CLAIM, MODEL_OWNER, MODEL_ROOM, MODEL_SOURCE, MODEL_WORKSPACE, ownedModelFixture } from './test-fixtures/owned-model.js';

const ONE = '11111111-1111-4111-8111-111111111111', TWO = '22222222-2222-4222-8222-222222222222';
const input = { roomId: MODEL_ROOM, agentId: MODEL_AGENT, requestId: 'synthetic-request', generationId: MODEL_CLAIM.generationId };
describe('causal owned-model generation parking', () => {
  let f: Awaited<ReturnType<typeof ownedModelFixture>>, attempts: OwnedModelAttempts;
  beforeEach(async () => {
    f = await ownedModelFixture(); attempts = new OwnedModelAttempts(f.db, f.credentials);
    await f.db.query(`INSERT INTO agent_turns(room_id,agent_id,request_id,status,generation_id)
      VALUES($1,$2,$3,'working',$4)`, [MODEL_ROOM, MODEL_AGENT, input.requestId, input.generationId]);
    await attempts.reserve(f.actor, ONE, { model: MODEL, messages: [{ role: 'user', content: 'synthetic' }] }, async () => ({
      reservation: { day: '2026-11-02', reserved: 16, maxOutput: 8, reservedUsd: 0.01, credit: 0 }, payload: { model: MODEL, messages: [], max_tokens: 8 },
    }));
  });
  afterEach(async () => { await f.db.close(); });
  const terminal = { ...input, status: 'failed' as const, modelOwnerEnd: { requestId: ONE } };
  const row = async () => (await f.db.query(`SELECT state,generation_id FROM agent_commands WHERE id=$1`, [MODEL_CLAIM.commandId])).rows[0];

  it.each(['unknown','succeeded'] as const)('journal loss ends authority without altering a %s attempt or inventing its identity',async outcome=>{
    if(outcome==='succeeded')await attempts.settleUsage(f.actor,ONE,{tokens:2,usd:0},'succeeded',async()=>{});
    const receipt={...input,status:'failed' as const,modelOwnerEnd:{journalUnavailable:true as const}};
    await expect(f.db.transaction(tx=>parkOwnedModelTerminal(tx,receipt,MODEL_AGENT,{...MODEL_SOURCE,epoch:2}))).rejects.toThrow();
    expect(await f.db.transaction(tx=>parkOwnedModelTerminal(tx,receipt,MODEL_AGENT,MODEL_SOURCE))).toBe(true);
    expect((await f.db.query('SELECT model_request_id FROM agent_command_owner_ends')).rows).toEqual([{model_request_id:null}]);
    expect((await f.db.query('SELECT state FROM owned_model_attempts')).rows).toEqual([{state:outcome}]);
    expect((await f.db.query(`SELECT ${commandOwnerLiveSql()} live FROM agent_commands`)).rows[0]?.live).toBe(false);
  });

  it('preserves command/generation/UNKNOWN and clears only live execution presentation', async () => {
    expect(await f.db.transaction(tx => parkOwnedModelTerminal(tx, terminal, MODEL_AGENT, MODEL_SOURCE))).toBe(true);
    expect(await row()).toEqual({ state: 'claimed', generation_id: input.generationId });
    expect((await f.db.query(`SELECT state FROM owned_model_attempts`)).rows).toEqual([{ state: 'unknown' }]);
    expect((await f.db.query('SELECT * FROM agent_turns')).rowCount).toBe(0);
    expect((await f.db.query(`SELECT ${commandOwnerLiveSql()} live,${commandOwnerExpiredSql()} expired FROM agent_commands`)).rows[0])
      .toEqual({ live: false, expired: false });
    expect((await f.db.query('SELECT * FROM messages')).rowCount).toBe(0);
    expect(await f.db.transaction(tx => parkOwnedModelTerminal(tx, terminal, MODEL_AGENT, MODEL_SOURCE))).toBe(true);
    expect((await f.db.query('SELECT * FROM agent_command_owner_ends')).rowCount).toBe(1);
  });

  it('actual terminal UNKNOWN overrides generic failed/complete handling without trusting reason text', async () => {
    expect(await f.db.transaction(tx => parkOwnedModelTerminal(tx, { ...input, status: 'complete' }, MODEL_AGENT, MODEL_SOURCE))).toBe(true);
    expect((await f.db.query('SELECT state FROM owned_model_attempts')).rows[0]?.state).toBe('unknown');
    expect(await row()).toEqual({ state: 'claimed', generation_id: input.generationId });
  });

  it('preserves committed success when the final response was lost, while normal success does not park', async () => {
    await attempts.settleUsage(f.actor, ONE, { tokens: 2, usd: 0 }, 'succeeded', async () => {});
    expect(await f.db.transaction(tx => parkOwnedModelTerminal(tx, { ...input, status: 'complete' }, MODEL_AGENT, MODEL_SOURCE))).toBe(false);
    expect(await f.db.transaction(tx => parkOwnedModelTerminal(tx, terminal, MODEL_AGENT, MODEL_SOURCE))).toBe(true);
    expect((await f.db.query('SELECT state,evidence FROM owned_model_attempts')).rows[0]).toEqual({ state: 'succeeded', evidence: { kind: 'usage', tokens: 2, usd: 0 } });
    expect(await row()).toEqual({ state: 'claimed', generation_id: input.generationId });
  });

  it('active UNKNOWN is still running; only actual source loss parks it', async () => {
    expect(await f.db.transaction(tx => guardOwnedModelSilence(tx, input))).toBe(true);
    expect((await f.db.query('SELECT * FROM agent_command_owner_ends')).rowCount).toBe(0);
    expect((await f.db.query('SELECT status FROM agent_turns')).rows[0]?.status).toBe('working');
    expect((await f.db.query(`SELECT ${commandOwnerLiveSql()} live FROM agent_commands`)).rows[0]?.live).toBe(true);
    await f.db.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp()-interval '91 seconds'`);
    expect(await f.db.transaction(tx => guardOwnedModelSilence(tx, input))).toBe(true);
    expect((await f.db.query('SELECT state FROM owned_model_attempts')).rows[0]?.state).toBe('unknown');
  });

  it('actual unrelated silence while UNKNOWN is in flight creates no failure, reassignment or owner end', async () => {
    const live = new LiveHub(), events: unknown[] = []; live.publish = event => { events.push(event); };
    const result = await noteFirstSilence(f.db, live, { ...input, reason: 'synthetic unrelated silence', reasonKind: 'hiccup', stalled: true });
    expect(result.hiccupRestart).toBe(false); expect(result.updateRequeued).toBe(false); expect(events).toEqual([]);
    expect((await f.db.query('SELECT * FROM agent_command_owner_ends')).rowCount).toBe(0);
    expect((await f.db.query('SELECT status FROM agent_turns')).rows[0]?.status).toBe('working');
    expect((await f.db.query(`SELECT ${commandOwnerLiveSql()} live FROM agent_commands`)).rows[0]?.live).toBe(true);
    expect((await f.db.query('SELECT * FROM messages')).rowCount).toBe(0);
    expect(await row()).toEqual({ state: 'claimed', generation_id: input.generationId });
  });

  it('source loss after known success does not invent an unresolved owner end', async () => {
    await attempts.settleUsage(f.actor, ONE, { tokens: 2, usd: 0 }, 'succeeded', async () => {});
    await f.db.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp()-interval '91 seconds'`);
    expect(await f.db.transaction(tx => guardOwnedModelSilence(tx, input))).toBe(false);
    expect((await f.db.query('SELECT * FROM agent_command_owner_ends')).rowCount).toBe(0);
  });

  it('wrong request, generation, source and invalid terminal shape refuse without falling through', async () => {
    for (const [receipt, source] of [
      [{ ...terminal, modelOwnerEnd: { requestId: TWO } }, MODEL_SOURCE],
      [{ ...terminal, generationId: 'foreign-generation' }, MODEL_SOURCE],
      [terminal, { ...MODEL_SOURCE, epoch: 2 }],
      [{ ...terminal, status: 'working' as const }, MODEL_SOURCE],
    ] as const) await expect(f.db.transaction(tx => parkOwnedModelTerminal(tx, receipt, MODEL_AGENT, source))).rejects.toThrow('could not be authorized');
    await expect(f.db.transaction(tx => parkOwnedModelTerminal(tx, terminal, MODEL_AGENT))).rejects.toThrow('could not be authorized');
    expect((await f.db.query('SELECT * FROM agent_command_owner_ends')).rowCount).toBe(0);
    expect((await f.db.query('SELECT status FROM agent_turns')).rows[0]?.status).toBe('working');
  });

  it('rollback restores activity and leaves zero durable owner ends or failed events', async () => {
    await expect(f.db.transaction(async tx => {
      expect(await parkOwnedModelTerminal(tx, terminal, MODEL_AGENT, MODEL_SOURCE)).toBe(true);
      throw new Error('synthetic rollback');
    })).rejects.toThrow('synthetic rollback');
    expect((await f.db.query('SELECT * FROM agent_command_owner_ends')).rowCount).toBe(0);
    expect((await f.db.query('SELECT status FROM agent_turns')).rows[0]?.status).toBe('working');
    expect((await f.db.query('SELECT * FROM messages')).rowCount).toBe(0);
  });

  it('immutable marker survives raw legacy requeue and denies a future original-command claim', async () => {
    await f.db.transaction(tx => parkOwnedModelTerminal(tx, terminal, MODEL_AGENT, MODEL_SOURCE));
    await expect(f.db.query('DELETE FROM agent_command_owner_ends')).rejects.toThrow('immutable');
    await expect(f.db.query(`UPDATE agent_command_owner_ends SET model_request_id=$1`, [TWO])).rejects.toThrow('immutable');
    await f.db.query(`UPDATE agent_commands SET state='pending',generation_id=NULL,turn_owner_connection_id=NULL,turn_owner_epoch=NULL`);
    await expect(f.db.query(`UPDATE agent_commands SET state='claimed',generation_id='replacement'`)).rejects.toThrow('owner has ended');
    expect((await f.db.query('SELECT * FROM agent_command_owner_ends')).rowCount).toBe(1);
  });

  it('real parent command deletion retains existing cascade semantics', async () => {
    await f.db.transaction(tx => parkOwnedModelTerminal(tx, terminal, MODEL_AGENT, MODEL_SOURCE));
    await f.db.query('DELETE FROM agent_commands WHERE id=$1', [MODEL_CLAIM.commandId]);
    expect((await f.db.query('SELECT * FROM agent_command_owner_ends')).rowCount).toBe(0);
    expect((await f.db.query('SELECT * FROM owned_model_attempts')).rowCount).toBe(1);
  });

  it('a different human command has independent claim eligibility', async () => {
    await f.db.transaction(tx => parkOwnedModelGeneration(tx, input, { kind: 'terminal-receipt', source: MODEL_SOURCE, modelRequestId: ONE }));
    expect((await f.db.query(`SELECT beeline_command_claim_open($1) old,beeline_command_claim_open('new-explicit-human-command') fresh`,
      [MODEL_CLAIM.commandId])).rows[0]).toEqual({ old: false, fresh: true });
    await f.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner')`, [MODEL_WORKSPACE, MODEL_OWNER, MODEL_ROOM]);
    await f.db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('new-explicit-human-request',$1,$2,'A different explicit action')`, [MODEL_ROOM, MODEL_OWNER]);
    const next = await createAgentCommand(f.db, { roomId: MODEL_ROOM, agentId: MODEL_AGENT, sourceMessageId: 'new-explicit-human-request', reason: 'human_mention' });
    expect(next).toBeDefined();
    const claimed = await f.db.transaction(tx => claimAgentCommand(tx, MODEL_ROOM, MODEL_AGENT, next!.id, 'new-human-generation', MODEL_SOURCE));
    expect(claimed.state).toBe('claimed'); expect(claimed.id).not.toBe(MODEL_CLAIM.commandId);
    expect(await row()).toEqual({ state: 'claimed', generation_id: input.generationId });
  });

  it('actual terminal service ingress parks without publishing generic failed events or traces', async () => {
    const live = new LiveHub(), events: unknown[] = []; live.publish = event => { events.push(event); };
    const daemon = new DaemonService(f.db, live);
    await daemon.execute('postAgentTurnReceipt', terminal, MODEL_AGENT, MODEL_SOURCE);
    expect(events).toEqual([]);
    expect((await f.db.query('SELECT * FROM agent_turns')).rowCount).toBe(0);
    expect((await f.db.query('SELECT * FROM messages')).rowCount).toBe(0);
    expect((await f.db.query('SELECT state FROM owned_model_attempts')).rows[0]?.state).toBe('unknown');
  });

  it('only the parking transaction gets its own commit exception; later effects and expired sources roll back', async () => {
    const command = { id: MODEL_CLAIM.commandId, agent_id: MODEL_AGENT, generation_id: input.generationId,
      turn_owner_connection_id: MODEL_SOURCE.connectionId, turn_owner_epoch: MODEL_SOURCE.epoch };
    await f.db.transaction(async tx => {
      await registerOwnedEffectFence(tx, command); await parkOwnedModelTerminal(tx, terminal, MODEL_AGENT, MODEL_SOURCE);
    });
    await expect(f.db.transaction(async tx => {
      await registerOwnedEffectFence(tx, command);
      await tx.query(`INSERT INTO owned_model_test_accounting VALUES('late-effect',1)`);
    })).rejects.toThrow();
    expect((await f.db.query(`SELECT * FROM owned_model_test_accounting WHERE id='late-effect'`)).rowCount).toBe(0);
  });

  it('parking does not excuse actual source expiry at the same deferred commit', async () => {
    await expect(f.db.transaction(async tx => {
      await registerOwnedEffectFence(tx, { id: MODEL_CLAIM.commandId, agent_id: MODEL_AGENT, generation_id: input.generationId,
        turn_owner_connection_id: MODEL_SOURCE.connectionId, turn_owner_epoch: MODEL_SOURCE.epoch });
      await parkOwnedModelTerminal(tx, terminal, MODEL_AGENT, MODEL_SOURCE);
      await tx.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp()-interval '91 seconds'`);
    })).rejects.toThrow();
    expect((await f.db.query('SELECT * FROM agent_command_owner_ends')).rowCount).toBe(0);
    expect((await f.db.query('SELECT status FROM agent_turns')).rows[0]?.status).toBe('working');
  });
});
