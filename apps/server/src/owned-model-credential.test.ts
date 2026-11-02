import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlDatabase } from './database.js';
import { OwnedModelCredentials, OwnedModelUnknownGeneration } from './owned-model-credential.js';
import { OwnedModelAttempts } from './owned-model-attempt.js';
import { MODEL_AGENT, MODEL_CLAIM, MODEL_KEY, MODEL_ROOM, MODEL_SOURCE, ownedModelFixture } from './test-fixtures/owned-model.js';

describe('opaque immutable owned-model credential primitive', () => {
  let fixture: Awaited<ReturnType<typeof ownedModelFixture>>;
  beforeEach(async () => { fixture = await ownedModelFixture(); });
  afterEach(async () => { await fixture.db.close(); });

  it('reconstructs the same credential on claim replay with no credential/command renewal or DML', async () => {
    const { db, credentials, issued } = fixture;
    const before = (await db.query('SELECT xmin::text version,* FROM owned_model_credentials')).rows;
    const queries: string[] = [];
    const observe = (tx: SqlDatabase): SqlDatabase => ({ query: (sql, values) => { queries.push(sql); return tx.query(sql, values); },
      transaction: work => tx.transaction(inner => work(observe(inner))) });
    expect(await db.transaction(tx => credentials.issueInTransaction(observe(tx), MODEL_CLAIM))).toEqual(issued);
    expect((await db.query('SELECT xmin::text version,* FROM owned_model_credentials')).rows).toEqual(before);
    expect(queries.some(sql => /\b(?:INSERT|UPDATE|DELETE)\b|beeline_register_owned_effect/.test(sql))).toBe(false);
    expect(JSON.stringify(before)).not.toContain(issued.token);
    expect(JSON.stringify(before)).not.toContain(MODEL_KEY.toString('hex'));
    expect(before[0]?.token_hash).toBe(createHash('sha256').update(issued.token).digest('hex'));
  });

  it('separates the key-derivation and credential-message MAC domains from direct sealing-key MACs', async () => {
    const { db, issued, credentials } = fixture;
    const row = (await db.query('SELECT * FROM owned_model_credentials')).rows[0]!;
    const data = JSON.stringify([row.id, row.key_version, row.agent_id, row.owner_id, row.workspace_id, row.room_id, row.command_id,
      row.generation_id, row.request_id, row.connection_id, Number(row.connection_epoch), row.instance_id, row.model,
      row.agent_model, row.model_token_hash, Number(row.expires_ms)]);
    const key = createHmac('sha256', MODEL_KEY).update('beeline:owned-model:credential-key:v1\0').digest();
    const mac = createHmac('sha256', key).update('beeline:owned-model:credential:v1\0').update(data).digest('hex');
    expect(issued.token).toBe(`bfmc_v1.${row.id}.${mac}`);
    for (const wrong of [createHmac('sha256', MODEL_KEY).update(data).digest('hex'),
      createHmac('sha256', key).update('beeline:legacy-model:v1\0').update(data).digest('hex')])
      await expect(credentials.authenticate(db, `bfmc_v1.${row.id}.${wrong}`)).rejects.toThrow('authority');
    await expect(new OwnedModelCredentials({ currentVersion: 'test-v1', key: () => Buffer.alloc(32, 8) },
      () => 'synthetic/model', () => 900_000).authenticate(db, issued.token)).rejects.toThrow('authority');
  });

  it('rejects malformed legacy-prefix, substituted ID and signature credentials without fallback', async () => {
    const { db, credentials, issued } = fixture;
    for (const token of ['bfm_legacy', issued.token + '.extra', issued.token.replace('bfmc_v1.', 'bfmc_v2.'),
      issued.token.replace(/\.[a-f0-9]{64}$/, '.' + '0'.repeat(64)), issued.token.replace(/^bfmc_v1\.[^.]+/, 'bfmc_v1.' + 'f'.repeat(32))])
      await expect(credentials.authenticate(db, token)).rejects.toThrow('authority');
  });

  it('rejects normal SQL identity/expiry mutation and cannot authenticate an out-of-band tampered binding', async () => {
    const { db, credentials, issued } = fixture;
    await expect(db.query(`UPDATE owned_model_credentials SET expires_ms=expires_ms+1000`)).rejects.toThrow('immutable');
    await expect(db.query('DELETE FROM owned_model_credentials')).rejects.toThrow('retained');
    // Synthetic DB-owner corruption bypasses the ordinary immutable trigger;
    // the original bearer still cannot authenticate the changed signed row.
    await db.query('ALTER TABLE owned_model_credentials DISABLE TRIGGER beeline_owned_model_credential_immutable');
    await db.query(`UPDATE owned_model_credentials SET generation_id='another-generation'`);
    await expect(credentials.authenticate(db, issued.token)).rejects.toThrow('authority');
  });

  it.each(['lease', 'membership', 'workspace', 'archive', 'rotation', 'retired', 'model', 'source', 'command', 'hard-cap', 'stop'])(
    'refuses a previously authenticated actor after actual %s authority changes', async change => {
      const { db, credentials, actor, issued } = fixture;
      if (change === 'lease') await db.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp()-interval '91 seconds'`);
      if (change === 'membership') await db.query('UPDATE memberships SET removed_at=clock_timestamp() WHERE room_id=$1', [MODEL_ROOM]);
      if (change === 'workspace') await db.query('UPDATE memberships SET removed_at=clock_timestamp() WHERE room_id IS NULL AND identity_id=$1', [MODEL_AGENT]);
      if (change === 'archive') await db.query('UPDATE rooms SET archived_at=clock_timestamp() WHERE id=$1', [MODEL_ROOM]);
      if (change === 'rotation') await db.query(`UPDATE free_agents SET model_token_hash=$2 WHERE agent_id=$1`, [MODEL_AGENT, 'd'.repeat(64)]);
      if (change === 'retired') await db.query('UPDATE free_agents SET removed_at=clock_timestamp() WHERE agent_id=$1', [MODEL_AGENT]);
      if (change === 'model') await db.query(`UPDATE free_agents SET model='synthetic/other' WHERE agent_id=$1`, [MODEL_AGENT]);
      if (change === 'source') await db.query(`UPDATE agent_connections SET connection_id='replacement',epoch=2 WHERE agent_id=$1`, [MODEL_AGENT]);
      if (change === 'command') await db.query(`UPDATE agent_commands SET state='pending',generation_id=NULL,turn_owner_connection_id=NULL,turn_owner_epoch=NULL WHERE id=$1`, [MODEL_CLAIM.commandId]);
      if (change === 'hard-cap') await db.query(`UPDATE agent_commands SET claimed_at=clock_timestamp()-interval '16 minutes' WHERE id=$1`, [MODEL_CLAIM.commandId]);
      if (change === 'stop') await db.query(`UPDATE agent_commands SET action='stop' WHERE id=$1`, [MODEL_CLAIM.commandId]);
      await expect(credentials.assertCurrent(db, actor)).rejects.toThrow('authority');
      await expect(credentials.authenticate(db, issued.token)).rejects.toThrow('authority');
    },
  );

  it('does not issue a new credential for an old generation/source or manufacture a trusted actor from JSON', async () => {
    const { db, credentials, actor } = fixture;
    await expect(db.transaction(tx => credentials.issueInTransaction(tx, { ...MODEL_CLAIM,
      source: { ...MODEL_SOURCE, epoch: 2 } }))).rejects.toThrow('authority');
    expect(() => credentials.actor({ binding: actor.binding } as typeof actor)).toThrow('authority');
    expect((await db.query('SELECT count(*)::int count FROM owned_model_credentials')).rows[0]?.count).toBe(1);
  });

  it.each(['private_payload', 'review_context'] as const)('rolls a new %s command generation claim back while its prior model outcome remains UNKNOWN', async kind => {
    const { db, credentials, actor, issued } = fixture;
    await new OwnedModelAttempts(db, credentials).reserve(actor, '11111111-1111-4111-8111-111111111111', { step: 'synthetic request' }, async () => ({
      reservation: { day: '2026-11-02', reserved: 16, maxOutput: 8, reservedUsd: 0.01, credit: 0 },
      payload: { model: actor.binding.model, max_tokens: 8, messages: [] },
    }));
    // Exact current claim recovery remains reconstructive, with no new bearer,
    // generation, reservation or provider admission despite its UNKNOWN.
    expect(await db.transaction(tx => credentials.issueInTransaction(tx, MODEL_CLAIM))).toEqual(issued);
    await db.query(`UPDATE agent_commands SET ${kind}='{"synthetic":true}'::jsonb,state='pending',generation_id=NULL,
      turn_owner_connection_id=NULL,turn_owner_epoch=NULL WHERE id=$1`, [MODEL_CLAIM.commandId]);
    await expect(db.transaction(async tx => {
      await tx.query(`UPDATE agent_commands SET state='claimed',generation_id='next-generation',claimed_at=clock_timestamp(),
        turn_owner_connection_id=$2,turn_owner_epoch=$3 WHERE id=$1`, [MODEL_CLAIM.commandId, MODEL_SOURCE.connectionId, MODEL_SOURCE.epoch]);
      return credentials.issueInTransaction(tx, { ...MODEL_CLAIM, generationId: 'next-generation' });
    })).rejects.toBeInstanceOf(OwnedModelUnknownGeneration);
    expect((await db.query(`SELECT state,generation_id FROM agent_commands WHERE id=$1`, [MODEL_CLAIM.commandId])).rows)
      .toEqual([{ state: 'pending', generation_id: null }]);
    expect((await db.query(`SELECT 1 FROM agent_command_generation_owners WHERE generation_id='next-generation'`)).rowCount).toBe(0);
    expect((await db.query('SELECT * FROM owned_model_credentials')).rowCount).toBe(1);
    expect((await db.query('SELECT state FROM owned_model_attempts')).rows).toEqual([{ state: 'unknown' }]);
  });

  it('leaves an explicit different durable command available while the prior command remains UNKNOWN', async () => {
    const { db, credentials, actor } = fixture, attempts = new OwnedModelAttempts(db, credentials);
    const prepared = async () => ({ reservation: { day: '2026-11-02', reserved: 16, maxOutput: 8, reservedUsd: 0.01, credit: 0 },
      payload: { model: actor.binding.model, max_tokens: 8, messages: [] } });
    await attempts.reserve(actor, '11111111-1111-4111-8111-111111111111', { step: 'same synthetic semantic payload' }, prepared);
    await db.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,reason,root_command_id,root_source_message_id,
      agent_depth,state,generation_id,claimed_at,turn_owner_connection_id,turn_owner_epoch)
      SELECT 'different-command',room_id,agent_id,'different-request','input','human_tag','different-command','different-human-source',
        0,'claimed','different-generation',clock_timestamp(),turn_owner_connection_id,turn_owner_epoch FROM agent_commands WHERE id=$1`, [MODEL_CLAIM.commandId]);
    const granted = await db.transaction(tx => credentials.issueInTransaction(tx, { ...MODEL_CLAIM, commandId: 'different-command', generationId: 'different-generation' }));
    const different = await credentials.authenticate(db, granted.token);
    expect((await attempts.reserve(different, '22222222-2222-4222-8222-222222222222', { step: 'same synthetic semantic payload' }, prepared)).permit).toBeDefined();
    expect((await db.query('SELECT command_id,state FROM owned_model_attempts ORDER BY command_id')).rows).toEqual([
      { command_id: 'different-command', state: 'unknown' }, { command_id: MODEL_CLAIM.commandId, state: 'unknown' },
    ]);
  });
});
