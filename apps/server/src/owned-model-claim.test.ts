import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentCommand } from './agent-command.js';
import { DaemonService, type OwnedModelClaimCapability } from './daemon-service.js';
import { LiveHub } from './live.js';
import { OwnedModelAttempts } from './owned-model-attempt.js';
import { OwnedModelUnknownGeneration } from './owned-model-credential.js';
import { MODEL_AGENT, MODEL_CLAIM, MODEL_OWNER, MODEL_ROOM, MODEL_SOURCE, MODEL_WORKSPACE, ownedModelFixture } from './test-fixtures/owned-model.js';

describe('actual owned-model claim transaction and secret boundary', () => {
  let f: Awaited<ReturnType<typeof ownedModelFixture>>, live: LiveHub, daemon: DaemonService, commandId: string;
  const generationId = 'claimed-model-generation';
  beforeEach(async () => {
    f = await ownedModelFixture(); live = new LiveHub(); daemon = new DaemonService(f.db, live);
    daemon.setOwnedModel({ credentials: f.credentials, ready: () => true });
    await f.db.query(`UPDATE agent_commands SET state='complete',completed_at=now() WHERE id=$1`, [MODEL_CLAIM.commandId]);
    await f.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner')`, [MODEL_WORKSPACE, MODEL_OWNER, MODEL_ROOM]);
    await f.db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('actual-model-request',$1,$2,'Synthetic actual claim')`, [MODEL_ROOM, MODEL_OWNER]);
    commandId = (await createAgentCommand(f.db, { roomId: MODEL_ROOM, agentId: MODEL_AGENT, sourceMessageId: 'actual-model-request', reason: 'human_mention' }))!.id;
  });
  afterEach(async () => { vi.unstubAllEnvs(); await f.db.close(); });
  const input = () => ({ roomId: MODEL_ROOM, commandId, generationId });
  const capability = async () => (await daemon.negotiateOwnedModel(MODEL_AGENT, MODEL_SOURCE, true)).capability!;

  it('atomically issues the current claimed generation credential and keeps it out of activation, journal and live events', async () => {
    vi.stubEnv('BEELINE_NETWORK_ROUTER_V1', '1');
    const events: unknown[] = []; const publish = vi.spyOn(live, 'publish').mockImplementation(event => { events.push(event); });
    const selected = await capability(), result = await daemon.execute('claimAgentCommand', input(), MODEL_AGENT, MODEL_SOURCE, selected);
    expect(result.modelCredential).toMatchObject({ v: 1 }); expect(Number.isSafeInteger(result.modelCredential?.expiresAt)).toBe(true);
    const bearer = result.modelCredential!.token, actor = await f.credentials.authenticate(f.db, bearer);
    expect(actor.binding).toMatchObject({ commandId, generationId, agentId: MODEL_AGENT, connectionId: MODEL_SOURCE.connectionId, connectionEpoch: MODEL_SOURCE.epoch });
    expect((await f.db.query('SELECT command_id FROM owned_model_credentials WHERE command_id=$1', [commandId])).rows).toEqual([{ command_id: commandId }]);
    const before = (await f.db.query('SELECT xmin::text version,* FROM owned_model_credentials WHERE command_id=$1', [commandId])).rows;
    expect((await daemon.execute('claimAgentCommand', input(), MODEL_AGENT, MODEL_SOURCE, selected)).modelCredential).toEqual(result.modelCredential);
    expect((await f.db.query('SELECT xmin::text version,* FROM owned_model_credentials WHERE command_id=$1', [commandId])).rows).toEqual(before);
    const activation = await daemon.readCommandActivation({ agentId: MODEL_AGENT, workspaceId: MODEL_WORKSPACE, roomId: MODEL_ROOM, commandId, generationId, source: MODEL_SOURCE }, MODEL_AGENT);
    const durable = (await f.db.query(`SELECT to_jsonb(command) value FROM agent_commands command WHERE id=$1
      UNION ALL SELECT event FROM live_journal UNION ALL SELECT to_jsonb(turn) FROM agent_turns turn`, [commandId])).rows;
    for (const value of [activation, durable, events, { ...result, modelCredential: undefined }]) expect(JSON.stringify(value)).not.toContain(bearer);
    publish.mockRestore();
  });

  it('refuses ownerless helper claims even with client-supplied model metadata', async () => {
    await expect(daemon.execute('claimAgentCommand', { ...input(), ownedModelV1: true,
      modelCredential: { token: 'forged' } } as never, MODEL_AGENT)).rejects.toThrow('helper claim requires its machine connection owner');
    expect((await f.db.query('SELECT * FROM owned_model_credentials WHERE command_id=$1', [commandId])).rowCount).toBe(0);
    expect((await f.db.query('SELECT turn_owner_connection_id FROM agent_commands WHERE id=$1', [commandId])).rows).toEqual([{ turn_owner_connection_id: null }]);
  });

  it('refuses source-only or forged capability claims and rolls the real claim/working-turn creation back without events', async () => {
    const events = vi.spyOn(live, 'publish');
    for (const selected of [undefined, {} as OwnedModelClaimCapability])
      await expect(daemon.execute('claimAgentCommand', input(), MODEL_AGENT, MODEL_SOURCE, selected)).rejects.toThrow('authority');
    expect((await f.db.query('SELECT state,generation_id FROM agent_commands WHERE id=$1', [commandId])).rows).toEqual([{ state: 'pending', generation_id: null }]);
    expect((await f.db.query('SELECT * FROM agent_command_generation_owners WHERE command_id=$1', [commandId])).rowCount).toBe(0);
    expect((await f.db.query(`SELECT * FROM agent_turns WHERE room_id=$1 AND request_id='actual-model-request'`, [MODEL_ROOM])).rows.every(row => row.generation_id !== generationId)).toBe(true);
    expect(events).not.toHaveBeenCalled(); events.mockRestore();
  });

  it('keeps machine ownership after signer loss and refuses another service owner’s model capability', async () => {
    const selected = await capability(); daemon.setOwnedModel(undefined);
    expect(await daemon.execute('claimAgentCommand', input(), MODEL_AGENT, MODEL_SOURCE, selected)).not.toHaveProperty('modelCredential');
    const other = new DaemonService(f.db, live); other.setOwnedModel({ credentials: f.credentials, ready: () => true });
    await expect(other.execute('claimAgentCommand', input(), MODEL_AGENT, MODEL_SOURCE, selected)).rejects.toThrow('authority');
    expect((await f.db.query('SELECT state FROM agent_commands WHERE id=$1', [commandId])).rows).toEqual([{ state: 'claimed' }]);
  });

  it('preserves an actual source-owned Stop and its bearer-free acknowledgement after model capability loss', async () => {
    await daemon.execute('claimAgentCommand', input(), MODEL_AGENT, MODEL_SOURCE, await capability());
    const stop = (await createAgentCommand(f.db, { roomId: MODEL_ROOM, agentId: MODEL_AGENT, sourceMessageId: 'actual-model-request',
      reason: 'human_stop', action: 'stop', turnRequestId: 'actual-model-request' }))!;
    daemon.setOwnedModel(undefined);
    const stopInput = { roomId: MODEL_ROOM, commandId: stop.id, generationId: 'stop-generation' };
    expect(await daemon.execute('claimAgentCommand', stopInput, MODEL_AGENT, MODEL_SOURCE)).not.toHaveProperty('modelCredential');
    expect(await daemon.execute('acknowledgeAgentCommand', stopInput, MODEL_AGENT, MODEL_SOURCE)).not.toHaveProperty('modelCredential');
    expect((await f.db.query('SELECT state FROM agent_commands WHERE id=$1', [stop.id])).rows).toEqual([{ state: 'complete' }]);
  });

  it.each(['private_payload', 'review_context'] as const)('rolls actual %s re-claim effects back instead of issuing a new generation across UNKNOWN', async kind => {
    const selected = await capability(), first = await daemon.execute('claimAgentCommand', input(), MODEL_AGENT, MODEL_SOURCE, selected);
    const actor = await f.credentials.authenticate(f.db, first.modelCredential!.token);
    await new OwnedModelAttempts(f.db, f.credentials).reserve(actor, '11111111-1111-4111-8111-111111111111', { step: 'synthetic private/review model request' }, async () => ({
      reservation: { day: '2026-11-02', reserved: 16, maxOutput: 8, reservedUsd: 0.01, credit: 0 }, payload: { model: actor.binding.model, max_tokens: 8, messages: [] },
    }));
    await f.db.query(`UPDATE agent_commands SET ${kind}=$2::jsonb,state='pending',generation_id=NULL,
      turn_owner_connection_id=NULL,turn_owner_epoch=NULL WHERE id=$1`, [commandId, JSON.stringify(kind === 'private_payload'
      ? { kind: 'order', authorId: MODEL_OWNER, fromRoomId: MODEL_ROOM, text: 'Synthetic private order' }
      : { purpose: 'verdict', headSha: 'synthetic-head', briefRevision: 0 })]);
    await f.db.query(`UPDATE agent_turns SET status='failed' WHERE room_id=$1 AND request_id='actual-model-request' AND agent_id=$2`, [MODEL_ROOM, MODEL_AGENT]);
    const before = (await f.db.query(`SELECT xmin::text version,status,generation_id FROM agent_turns WHERE room_id=$1 AND agent_id=$2`, [MODEL_ROOM, MODEL_AGENT])).rows;
    const events = vi.spyOn(live, 'publish');
    await expect(daemon.execute('claimAgentCommand', { ...input(), generationId: 'unsafe-next-generation' }, MODEL_AGENT, MODEL_SOURCE, selected)).rejects.toBeInstanceOf(OwnedModelUnknownGeneration);
    expect((await f.db.query('SELECT state,generation_id FROM agent_commands WHERE id=$1', [commandId])).rows).toEqual([{ state: 'pending', generation_id: null }]);
    expect((await f.db.query(`SELECT xmin::text version,status,generation_id FROM agent_turns WHERE room_id=$1 AND agent_id=$2`, [MODEL_ROOM, MODEL_AGENT])).rows).toEqual(before);
    expect((await f.db.query('SELECT * FROM owned_model_credentials WHERE command_id=$1', [commandId])).rowCount).toBe(1);
    expect(events).not.toHaveBeenCalled(); events.mockRestore();
  });
});
