import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqlDatabase } from './database.js';
import { OwnedModelAttempts, OwnedModelIdentityConflict, OwnedModelUnknownPayload, canonicalOwnedModelPayload,
  type OwnedModelDispatchPermit, type OwnedModelReservation } from './owned-model-attempt.js';
import { OwnedModelCredentials, OwnedModelUnknownGeneration } from './owned-model-credential.js';
import { MODEL, MODEL_CLAIM, MODEL_KEY, MODEL_ROOM, MODEL_SOURCE, ownedModelFixture } from './test-fixtures/owned-model.js';

const ONE = '11111111-1111-4111-8111-111111111111', TWO = '22222222-2222-4222-8222-222222222222';
const ALLOWANCE: OwnedModelReservation = { day: '2026-11-02', reserved: 16, maxOutput: 8, reservedUsd: 0.01, credit: 0 };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

describe('owned model durable UNKNOWN and exact one-use handoff primitive', () => {
  let fixture: Awaited<ReturnType<typeof ownedModelFixture>>, attempts: OwnedModelAttempts;
  beforeEach(async () => { fixture = await ownedModelFixture(); attempts = new OwnedModelAttempts(fixture.db, fixture.credentials); });
  afterEach(async () => { vi.useRealTimers(); await fixture.db.close(); });
  const semantic = { model: MODEL, messages: [{ role: 'user', content: 'synthetic private model message' }] };
  function hook(payload = { ...semantic, max_tokens: 8 }) {
    let count = 0;
    return vi.fn(async (tx: SqlDatabase) => {
      await tx.query('INSERT INTO owned_model_test_accounting VALUES($1,16)', [`reservation-${++count}`]);
      return { reservation: ALLOWANCE, payload };
    });
  }
  const reservations = async () => (await fixture.db.query(`SELECT count(*)::int count FROM owned_model_test_accounting WHERE id LIKE 'reservation-%'`)).rows[0]?.count;

  it('commits UNKNOWN and its reservation before handing off exact immutable bytes without awaiting the provider under locks', async () => {
    const payload = { ...semantic, max_tokens: 8 }, reserve = hook(payload);
    const admitted = await attempts.reserve(fixture.actor, ONE, semantic, reserve);
    expect(admitted.permit).toBeDefined(); expect(admitted.receipt.state).toBe('unknown');
    expect((await fixture.db.query('SELECT state FROM owned_model_attempts')).rows).toEqual([{ state: 'unknown' }]);
    payload.messages = [{ role: 'user', content: 'changed after durable reservation' }];
    const provider = deferred<string>();
    const start = vi.fn((body: string) => {
      expect(JSON.parse(body)).toEqual({ ...semantic, max_tokens: 8 });
      return provider.promise;
    });
    const result = await attempts.handoff(admitted.permit!, start);
    expect(result.state).toBe('started'); expect(start).toHaveBeenCalledOnce();
    provider.resolve('synthetic provider result');
    expect(await result.completion).toBe('synthetic provider result');
    await expect(attempts.handoff(admitted.permit!, start)).rejects.toBeInstanceOf(OwnedModelUnknownPayload);
    const stored = JSON.stringify((await fixture.db.query('SELECT * FROM owned_model_attempts')).rows);
    expect(stored).not.toContain('synthetic private model message'); expect(stored).not.toContain('synthetic provider result');
    expect(stored).not.toContain(fixture.issued.token);
  });

  it('replays the same request after process-owner replacement with zero new reservation or dispatch permit', async () => {
    const reserve = hook(), first = await attempts.reserve(fixture.actor, ONE, semantic, reserve);
    const credentials = new OwnedModelCredentials({ currentVersion: 'test-v1', key: () => MODEL_KEY }, () => MODEL, () => 900_000);
    const actor = await credentials.authenticate(fixture.db, fixture.issued.token);
    const restarted = new OwnedModelAttempts(fixture.db, credentials);
    const replay = await restarted.reserve(actor, ONE, { messages: semantic.messages, model: MODEL }, reserve);
    expect(replay).toEqual({ receipt: first.receipt }); expect(reserve).toHaveBeenCalledOnce();
    expect(await reservations()).toBe(1);
    await expect(restarted.handoff(first.permit!, async () => 'wrong owner')).rejects.toBeInstanceOf(OwnedModelUnknownPayload);
  });

  it('refuses changed request identity and an identical semantic UNKNOWN under a new UUID before reserving again', async () => {
    const reserve = hook(); await attempts.reserve(fixture.actor, ONE, semantic, reserve);
    await expect(attempts.reserve(fixture.actor, ONE, { ...semantic, requested: 10 }, reserve)).rejects.toBeInstanceOf(OwnedModelIdentityConflict);
    await expect(attempts.reserve(fixture.actor, TWO, semantic, reserve)).rejects.toBeInstanceOf(OwnedModelUnknownPayload);
    expect(reserve).toHaveBeenCalledOnce(); expect(await reservations()).toBe(1);
  });

  it('rolls the entire second reservation back when different semantic requests clamp to the same UNKNOWN final payload', async () => {
    const reserve = hook(); await attempts.reserve(fixture.actor, ONE, { ...semantic, requested: 20 }, reserve);
    await expect(attempts.reserve(fixture.actor, TWO, { ...semantic, requested: 40 }, reserve)).rejects.toBeInstanceOf(OwnedModelUnknownPayload);
    expect(reserve).toHaveBeenCalledTimes(2); expect(await reservations()).toBe(1);
    expect((await fixture.db.query('SELECT model_request_id FROM owned_model_attempts')).rows).toEqual([{ model_request_id: ONE }]);
  });

  it('rolls reservation and attempt back together when the actual outer admission transaction fails', async () => {
    const observed: SqlDatabase = { query: (sql, values) => fixture.db.query(sql, values), transaction: work => fixture.db.transaction(async tx => {
      await work(tx); throw new Error('synthetic admission rollback');
    }) };
    const reserve = hook();
    await expect(new OwnedModelAttempts(observed, fixture.credentials).reserve(fixture.actor, ONE, semantic, reserve)).rejects.toThrow('admission rollback');
    expect(await reservations()).toBe(0); expect((await fixture.db.query('SELECT * FROM owned_model_attempts')).rows).toEqual([]);
  });

  it('consumes the permit on a synchronous possibly-started failure and never retries or refunds UNKNOWN on elapsed time', async () => {
    const reserve = hook(), admitted = await attempts.reserve(fixture.actor, ONE, semantic, reserve);
    const start = vi.fn(() => { throw new Error('synthetic accepted before throw'); });
    expect(await attempts.handoff(admitted.permit!, start)).toEqual({ state: 'unknown' });
    await expect(attempts.handoff(admitted.permit!, start)).rejects.toBeInstanceOf(OwnedModelUnknownPayload);
    const settle = vi.fn();
    await expect(attempts.refuseBeforeHandoff(admitted.permit!, 'cancelled', settle)).rejects.toBeInstanceOf(OwnedModelUnknownPayload);
    vi.useFakeTimers(); await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(start).toHaveBeenCalledOnce(); expect(reserve).toHaveBeenCalledOnce(); expect(settle).not.toHaveBeenCalled();
    vi.useRealTimers();
    expect((await fixture.db.query('SELECT state,evidence FROM owned_model_attempts')).rows).toEqual([{ state: 'unknown', evidence: null }]);
  });

  it('retains UNKNOWN across final transaction rollback after the synchronous provider handoff', async () => {
    let fail = false;
    const observed: SqlDatabase = { query: (sql, values) => fixture.db.query(sql, values), transaction: work => fixture.db.transaction(async tx => {
      const value = await work(tx); if (fail) throw new Error('synthetic final COMMIT failure'); return value;
    }) };
    const owner = new OwnedModelAttempts(observed, fixture.credentials), admitted = await owner.reserve(fixture.actor, ONE, semantic, hook());
    fail = true;
    const start = vi.fn(async () => 'synthetic accepted');
    const result = await owner.handoff(admitted.permit!, start);
    expect(result.state).toBe('unknown'); expect(await result.completion).toBe('synthetic accepted');
    expect((await fixture.db.query('SELECT state FROM owned_model_attempts')).rows).toEqual([{ state: 'unknown' }]);
    await expect(owner.handoff(admitted.permit!, start)).rejects.toBeInstanceOf(OwnedModelUnknownPayload);
    expect(start).toHaveBeenCalledOnce(); expect(await reservations()).toBe(1);
  });

  it('refuses a queued request after current membership removal, consumes its permit, and releases only proven nonentry once', async () => {
    const admitted = await attempts.reserve(fixture.actor, ONE, semantic, hook());
    await fixture.db.query('UPDATE memberships SET removed_at=clock_timestamp() WHERE room_id=$1', [MODEL_ROOM]);
    const start = vi.fn(async () => 'must not enter');
    await expect(attempts.handoff(admitted.permit!, start)).rejects.toThrow('authority');
    await expect(attempts.handoff(admitted.permit!, start)).rejects.toBeInstanceOf(OwnedModelUnknownPayload);
    const settle = vi.fn(async (tx: SqlDatabase) => { await tx.query(`INSERT INTO owned_model_test_accounting VALUES('refund',-16)`); });
    const result = await attempts.refuseBeforeHandoff(admitted.permit!, 'authority', settle);
    expect(result.state).toBe('refused'); expect(await attempts.refuseBeforeHandoff(admitted.permit!, 'authority', settle)).toEqual(result);
    expect(start).not.toHaveBeenCalled(); expect(settle).toHaveBeenCalledOnce();
    await expect(attempts.refuseBeforeHandoff({} as OwnedModelDispatchPermit, 'authority', settle)).rejects.toBeInstanceOf(OwnedModelUnknownPayload);
  });

  it('settles known usage once while preserving UNKNOWN, then accepts a late same-evidence completion without charging twice', async () => {
    await attempts.reserve(fixture.actor, ONE, semantic, hook());
    const settle = vi.fn(async (tx: SqlDatabase) => { await tx.query(`INSERT INTO owned_model_test_accounting VALUES('usage',5)`); });
    const usage = { tokens: 5, usd: 0.001 };
    expect((await attempts.settleUsage(fixture.actor, ONE, usage, 'unknown', settle)).state).toBe('unknown');
    expect((await attempts.settleUsage(fixture.actor, ONE, usage, 'unknown', settle)).state).toBe('unknown');
    expect((await attempts.settleUsage(fixture.actor, ONE, usage, 'succeeded', settle)).state).toBe('succeeded');
    expect(settle).toHaveBeenCalledOnce();
    await expect(attempts.settleUsage(fixture.actor, ONE, { tokens: 6, usd: 0.002 }, 'succeeded', settle)).rejects.toBeInstanceOf(OwnedModelIdentityConflict);
    expect(settle).toHaveBeenCalledOnce();
  });

  it('does not treat an ambiguous 500 as known refusal and refunds a definite provider refusal only once', async () => {
    await attempts.reserve(fixture.actor, ONE, semantic, hook()); const settle = vi.fn(async () => {});
    await expect(attempts.refuseFromProvider(fixture.actor, ONE, 500, settle)).rejects.toBeInstanceOf(OwnedModelIdentityConflict);
    expect(settle).not.toHaveBeenCalled();
    const refused = await attempts.refuseFromProvider(fixture.actor, ONE, 402, settle);
    expect(refused.state).toBe('refused'); expect(await attempts.refuseFromProvider(fixture.actor, ONE, 402, settle)).toEqual(refused);
    expect(settle).toHaveBeenCalledOnce();
  });

  it('retains immutable SQL request/digest identities instead of minting permits from row assertions', async () => {
    await attempts.reserve(fixture.actor, ONE, semantic, hook());
    const before = (await fixture.db.query('SELECT * FROM owned_model_attempts')).rows;
    await expect(fixture.db.query(`UPDATE owned_model_attempts SET payload_digest=$1`, ['d'.repeat(64)]))
      .rejects.toMatchObject({ code: '23514', message: 'owned model attempt identity or settled evidence changed' });
    await expect(fixture.db.query('DELETE FROM owned_model_attempts')).rejects.toThrow('retained');
    expect((await fixture.db.query('SELECT * FROM owned_model_attempts')).rows).toEqual(before);
    await expect(attempts.handoff({} as OwnedModelDispatchPermit, async () => 'forged')).rejects.toBeInstanceOf(OwnedModelUnknownPayload);
  });

  it('fences a pre-created newer-generation permit and new reservation when prior-generation UNKNOWN evidence arrives, while exact receipt recovery stays read-only', async () => {
    const { db, credentials, actor } = fixture;
    await db.query(`UPDATE agent_commands SET state='pending',generation_id=NULL,turn_owner_connection_id=NULL,turn_owner_epoch=NULL WHERE id=$1`, [MODEL_CLAIM.commandId]);
    const grant = await db.transaction(async tx => {
      await tx.query(`UPDATE agent_commands SET state='claimed',generation_id='next-generation',claimed_at=clock_timestamp(),
        turn_owner_connection_id=$2,turn_owner_epoch=$3 WHERE id=$1`, [MODEL_CLAIM.commandId, MODEL_SOURCE.connectionId, MODEL_SOURCE.epoch]);
      return credentials.issueInTransaction(tx, { ...MODEL_CLAIM, generationId: 'next-generation' });
    });
    const nextActor = await credentials.authenticate(db, grant.token), next = new OwnedModelAttempts(db, credentials), reserve = hook();
    const admitted = await next.reserve(nextActor, ONE, semantic, reserve);
    // Simulate a durable old-generation marker recovered from an older
    // admission. It is evidence only; the row can never manufacture a permit.
    await db.query(`INSERT INTO owned_model_attempts(credential_id,model_request_id,command_id,generation_id,agent_id,owner_id,
      request_digest,payload_digest,reservation,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'unknown')`,
    [actor.binding.id, TWO, actor.binding.commandId, actor.binding.generationId, actor.binding.agentId, actor.binding.ownerId,
      'd'.repeat(64), 'e'.repeat(64), JSON.stringify(ALLOWANCE)]);
    expect(await next.reserve(nextActor, ONE, semantic, reserve)).toEqual({ receipt: admitted.receipt });
    expect(await db.transaction(tx => credentials.issueInTransaction(tx, { ...MODEL_CLAIM, generationId: 'next-generation' }))).toEqual(grant);
    const noNewQuota = vi.fn(hook());
    await expect(next.reserve(nextActor, TWO, { ...semantic, another: true }, noNewQuota)).rejects.toBeInstanceOf(OwnedModelUnknownGeneration);
    const start = vi.fn(async () => 'must not enter');
    await expect(next.handoff(admitted.permit!, start)).rejects.toBeInstanceOf(OwnedModelUnknownGeneration);
    await expect(next.handoff(admitted.permit!, start)).rejects.toBeInstanceOf(OwnedModelUnknownPayload);
    expect(start).not.toHaveBeenCalled(); expect(noNewQuota).not.toHaveBeenCalled(); expect(reserve).toHaveBeenCalledOnce();
  });

  it('uses canonical bounded JSON, rejects accessors and cycles without invoking getters, and preserves the endpoint byte bound', () => {
    expect(canonicalOwnedModelPayload({ b: 2, a: ['é🙂'] })).toEqual(canonicalOwnedModelPayload({ a: ['é🙂'], b: 2 }));
    const getter = vi.fn(() => 'secret'); const accessor = Object.defineProperty({}, 'field', { enumerable: true, get: getter });
    expect(() => canonicalOwnedModelPayload(accessor)).toThrow('invalid'); expect(getter).not.toHaveBeenCalled();
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => canonicalOwnedModelPayload(cyclic)).toThrow('JSON');
    expect(() => canonicalOwnedModelPayload({ text: 'x'.repeat(8 * 1024 * 1024) })).toThrow('capacity');
  });
});
