import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { CommandRefusalError } from './command-refusal.js';
import type { SqlDatabase } from './database.js';
import { OwnedModelCredentials, OwnedModelRefusal, type AuthenticatedOwnedModel, type OwnedModelBinding } from './owned-model-credential.js';
import { ROUTER_AUTHORITY_LOCK } from './router-projection-schema.js';
import { assertCurrentTurnOwner } from './turn-ownership.js';

/** Same body bound as the existing model HTTP endpoint, never a larger escape. */
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
export const OWNED_MODEL_ATTEMPT_SCHEMA = `
CREATE TABLE IF NOT EXISTS owned_model_attempts (
 credential_id text NOT NULL REFERENCES owned_model_credentials(id), model_request_id text NOT NULL,
 command_id text NOT NULL, generation_id text NOT NULL, agent_id text NOT NULL, owner_id text NOT NULL,
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
 reservation jsonb NOT NULL, state text NOT NULL CHECK(state IN ('unknown','succeeded','refused')),
 evidence jsonb, evidence_hash text, settled_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(credential_id,model_request_id),
 CHECK((evidence IS NULL)=(evidence_hash IS NULL) AND (evidence IS NULL)=(settled_at IS NULL)),
 CHECK(COALESCE(state='unknown' OR evidence IS NOT NULL AND (state='succeeded' AND evidence->>'kind'='usage'
   OR state='refused' AND evidence->>'kind' IN ('not-dispatched','provider-refused')),false))
);
CREATE UNIQUE INDEX IF NOT EXISTS owned_model_unknown_request ON owned_model_attempts(command_id,generation_id,request_digest) WHERE state='unknown';
CREATE UNIQUE INDEX IF NOT EXISTS owned_model_unknown_payload ON owned_model_attempts(command_id,generation_id,payload_digest) WHERE state='unknown';
CREATE OR REPLACE FUNCTION beeline_owned_model_attempt_immutable() RETURNS trigger AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'owned model attempt identity is retained' USING ERRCODE='23514'; END IF;
 IF to_jsonb(NEW)-ARRAY['state','evidence','evidence_hash','settled_at'] IS DISTINCT FROM to_jsonb(OLD)-ARRAY['state','evidence','evidence_hash','settled_at']
   OR OLD.state<>'unknown' AND NEW.state IS DISTINCT FROM OLD.state
   OR OLD.evidence IS NOT NULL AND ROW(NEW.evidence,NEW.evidence_hash,NEW.settled_at) IS DISTINCT FROM ROW(OLD.evidence,OLD.evidence_hash,OLD.settled_at) THEN
   RAISE EXCEPTION 'owned model attempt identity or settled evidence changed' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS beeline_owned_model_attempt_immutable ON owned_model_attempts;
CREATE TRIGGER beeline_owned_model_attempt_immutable BEFORE UPDATE OR DELETE ON owned_model_attempts
 FOR EACH ROW EXECUTE FUNCTION beeline_owned_model_attempt_immutable();
`;

/** Canonical server-pinned semantic input/final payload. Only digests reach
 * PostgreSQL; text, tool arguments and model output never enter the ledger. */
export function canonicalOwnedModelPayload(value: unknown): { body: string; digest: string } {
  const chunks: string[] = [], ancestors = new Set<object>();
  let bytes = 0, nodes = 0;
  const write = (text: string) => {
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_PAYLOAD_BYTES) throw new CommandRefusalError('Owned model payload exceeds capacity', 400);
    chunks.push(text);
  };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 262144 || depth > 64) throw new CommandRefusalError('Owned model payload exceeds complexity', 400);
    if (item === null || typeof item === 'boolean' || typeof item === 'string' || typeof item === 'number' && Number.isFinite(item)) {
      write(JSON.stringify(item)); return;
    }
    if (!item || typeof item !== 'object' || ancestors.has(item) || Object.getOwnPropertySymbols(item).length ||
        !Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
      throw new CommandRefusalError('Owned model payload must be JSON', 400);
    ancestors.add(item);
    if (Array.isArray(item)) {
      write('[');
      for (let index = 0; index < item.length; index++) {
        const field = Object.getOwnPropertyDescriptor(item, String(index));
        if (!field || !('value' in field)) throw new CommandRefusalError('Owned model array is invalid', 400);
        if (index) write(','); visit(field.value, depth + 1);
      }
      write(']');
    } else {
      write('{'); let first = true;
      for (const key of Object.getOwnPropertyNames(item).sort()) {
        const field = Object.getOwnPropertyDescriptor(item, key)!;
        if (!('value' in field) || !field.enumerable) throw new CommandRefusalError('Owned model object is invalid', 400);
        if (field.value === undefined) continue;
        if (!first) write(','); first = false;
        write(JSON.stringify(key)); write(':'); visit(field.value, depth + 1);
      }
      write('}');
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  const body = chunks.join('');
  return { body, digest: createHash('sha256').update('beeline:owned-model:payload:v1\0').update(body).digest('hex') };
}

export type OwnedModelReservation = Readonly<{ day: string; reserved: number; maxOutput: number; reservedUsd: number; credit: number }>;
type RefusalReason = 'authority' | 'queue' | 'cancelled' | 'deadline';
export type OwnedModelEvidence = Readonly<{ kind: 'usage'; tokens: number; usd: number }> |
  Readonly<{ kind: 'not-dispatched'; reason: RefusalReason }> | Readonly<{ kind: 'provider-refused'; status: number }>;
export type OwnedModelAttemptReceipt = Readonly<{ requestId: string; state: 'unknown' | 'succeeded' | 'refused'; evidence?: OwnedModelEvidence }>;
declare const permitBrand: unique symbol;
export type OwnedModelDispatchPermit = Readonly<{ readonly [permitBrand]: true }>;
type Permit = { actor: AuthenticatedOwnedModel; requestId: string; digest: string; body: string; consumed: boolean; entered: boolean };
interface Row {
  credential_id: string; model_request_id: string; command_id: string; generation_id: string; agent_id: string; owner_id: string;
  request_digest: string; payload_digest: string; reservation: OwnedModelReservation;
  state: 'unknown' | 'succeeded' | 'refused'; evidence: OwnedModelEvidence | null; evidence_hash: string | null;
}
export class OwnedModelIdentityConflict extends CommandRefusalError {
  constructor() { super('Owned model request identity conflict', 409); }
}
export class OwnedModelUnknownPayload extends CommandRefusalError {
  readonly state = 'unknown';
  constructor() { super('Owned model request is already UNKNOWN; do not resubmit', 409); }
}
const requestId = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const receipt = (row: Row): OwnedModelAttemptReceipt => Object.freeze({ requestId: row.model_request_id, state: row.state,
  ...(row.evidence ? { evidence: row.evidence } : {}) });
function reservation(value: OwnedModelReservation): void {
  if (!value || Object.keys(value).sort().join() !== 'credit,day,maxOutput,reserved,reservedUsd' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value.day) || !Number.isFinite(value.reservedUsd) || value.reservedUsd < 0 ||
      ![value.reserved, value.maxOutput, value.credit].every(n => Number.isSafeInteger(n) && n >= 0) || !value.maxOutput)
    throw new CommandRefusalError('Owned model reservation is invalid', 400);
}
function evidence(value: OwnedModelEvidence): string {
  if (!value || !['usage', 'not-dispatched', 'provider-refused'].includes(value.kind)) throw new OwnedModelIdentityConflict();
  const keys = value.kind === 'usage' ? 'kind,tokens,usd' : value.kind === 'not-dispatched' ? 'kind,reason' : 'kind,status';
  if (Object.keys(value).sort().join() !== keys || value.kind === 'usage' &&
      (!Number.isSafeInteger(value.tokens) || value.tokens < 0 || !Number.isFinite(value.usd) || value.usd < 0) ||
      value.kind === 'not-dispatched' && !['authority', 'queue', 'cancelled', 'deadline'].includes(value.reason) ||
      value.kind === 'provider-refused' && ![400, 401, 402, 403, 404, 413, 422, 429].includes(value.status)) throw new OwnedModelIdentityConflict();
  return createHash('sha256').update('beeline:owned-model:evidence:v1\0').update(canonicalOwnedModelPayload(value).body).digest('hex');
}
async function accountingLocks(database: SqlDatabase, ownerId: string): Promise<void> {
  await database.query(`SELECT pg_advisory_xact_lock(hashtext('free-agent-global-budget'))`);
  await database.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`free-agent-usage:${ownerId}`]);
}
type Settlement = (database: SqlDatabase, reservation: OwnedModelReservation, evidence: OwnedModelEvidence) => Promise<void>;

export class OwnedModelAttempts {
  private readonly permits = new WeakMap<object, Permit>();
  constructor(private readonly database: SqlDatabase, private readonly credentials: OwnedModelCredentials) {}

  /** Hook composes the existing allowance reservation in THIS transaction.
   * It returns its exact final server-pinned body after maxOutput clamping.
   * No provider call, retry, token or body persistence belongs in the hook. */
  async reserve(actor: AuthenticatedOwnedModel, id: string, semanticInput: unknown,
    reserve: (database: SqlDatabase, binding: OwnedModelBinding) => Promise<{ reservation: OwnedModelReservation; payload: Record<string, unknown> }>,
  ): Promise<{ receipt: OwnedModelAttemptReceipt; permit?: OwnedModelDispatchPermit }> {
    if (!requestId(id)) throw new OwnedModelIdentityConflict();
    const owned = this.credentials.actor(actor), canonical = canonicalOwnedModelPayload(semanticInput);
    const semantic = createHash('sha256').update('beeline:owned-model:request:v1\0').update(canonical.body).digest('hex');
    const admitted = await this.database.transaction(async database => {
      await accountingLocks(database, owned.ownerId);
      await this.credentials.assertCurrent(database, actor);
      const old = (await database.query<Row>('SELECT * FROM owned_model_attempts WHERE credential_id=$1 AND model_request_id=$2 FOR UPDATE', [owned.id, id])).rows[0];
      if (old) {
        if (old.request_digest !== semantic) throw new OwnedModelIdentityConflict();
        return { row: old };
      }
      if ((await database.query(`SELECT 1 FROM owned_model_attempts WHERE command_id=$1 AND generation_id=$2 AND request_digest=$3 AND state='unknown'`,
        [owned.commandId, owned.generationId, semantic])).rowCount) throw new OwnedModelUnknownPayload();
      const prepared = await reserve(database, owned);
      reservation(prepared.reservation);
      const payload = canonicalOwnedModelPayload(prepared.payload);
      if (prepared.payload.model !== owned.model || prepared.payload.max_tokens !== prepared.reservation.maxOutput) throw new OwnedModelIdentityConflict();
      if ((await database.query(`SELECT 1 FROM owned_model_attempts WHERE command_id=$1 AND generation_id=$2 AND payload_digest=$3 AND state='unknown'`,
        [owned.commandId, owned.generationId, payload.digest])).rowCount) throw new OwnedModelUnknownPayload();
      const row = (await database.query<Row>(`INSERT INTO owned_model_attempts(credential_id,model_request_id,command_id,generation_id,agent_id,owner_id,
        request_digest,payload_digest,reservation,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'unknown') RETURNING *`,
      [owned.id, id, owned.commandId, owned.generationId, owned.agentId, owned.ownerId, semantic, payload.digest, JSON.stringify(prepared.reservation)])).rows[0]!;
      return { row, body: payload.body };
    });
    if (admitted.body === undefined) return { receipt: receipt(admitted.row) };
    const permit = Object.freeze({}) as OwnedModelDispatchPermit;
    this.permits.set(permit, { actor, requestId: id, digest: admitted.row.payload_digest, body: admitted.body, consumed: false, entered: false });
    return { receipt: receipt(admitted.row), permit };
  }

  /** The already committed UNKNOWN/reservation cannot be rolled back by this
   * final fence. start MUST synchronously hand these exact bytes to the existing
   * transport and return its native Promise, without a pre-dispatch await.
   * No provider response/body/backpressure is awaited under these locks. */
  async handoff<T>(permit: OwnedModelDispatchPermit, start: (body: string) => Promise<T>): Promise<
    { state: 'started'; completion: Promise<T> } | { state: 'unknown'; completion?: Promise<T> }
  > {
    const pending = this.permits.get(permit);
    if (!pending || pending.consumed) throw new OwnedModelUnknownPayload();
    pending.consumed = true; // consumed even if BEGIN, authority, callback or COMMIT fails
    const owned = this.credentials.actor(pending.actor);
    let completion: Promise<T> | undefined;
    try {
      await this.database.transaction(async database => {
        await database.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [ROUTER_AUTHORITY_LOCK]);
        await assertCurrentTurnOwner(database, owned.agentId, { connectionId: owned.connectionId, epoch: owned.connectionEpoch });
        await database.query('SELECT id FROM agent_commands WHERE id=$1 FOR SHARE NOWAIT', [owned.commandId]);
        await database.query('SELECT agent_id FROM free_agents WHERE agent_id=$1 FOR SHARE NOWAIT', [owned.agentId]);
        await database.query('SELECT agent_id FROM agents WHERE agent_id=$1 FOR SHARE NOWAIT', [owned.agentId]);
        await database.query('SELECT id FROM owned_model_credentials WHERE id=$1 FOR SHARE NOWAIT', [owned.id]);
        const row = (await database.query<Row>('SELECT * FROM owned_model_attempts WHERE credential_id=$1 AND model_request_id=$2 FOR SHARE NOWAIT',
          [owned.id, pending.requestId])).rows[0];
        if (!row || row.state !== 'unknown' || row.evidence || row.payload_digest !== pending.digest) throw new OwnedModelRefusal();
        const began = performance.now(), current = await this.credentials.assertCurrent(database, pending.actor);
        // Subtract the entire DB round trip rather than assuming host/DB clocks
        // agree or allowing a lease to expire between the query and handoff.
        if (performance.now() - began >= current.untilMs - current.nowMs) throw new OwnedModelRefusal();
        pending.entered = true;
        completion = start(pending.body);
        if (!(completion instanceof Promise)) throw new Error('Owned model handoff must return its transport promise');
        void completion.catch(() => {}); // delayed COMMIT must not create an unhandled rejection
      });
    } catch (error) {
      if (pending.entered) return { state: 'unknown', ...(completion ? { completion } : {}) };
      throw error;
    }
    return { state: 'started', completion: completion! };
  }

  /** A live process-local permit proves known nonentry. A restart, possibly
   * started callback or lost permit cannot turn UNKNOWN into a refund. */
  refuseBeforeHandoff(permit: OwnedModelDispatchPermit, reason: RefusalReason, settle: Settlement): Promise<OwnedModelAttemptReceipt> {
    const pending = this.permits.get(permit);
    if (!pending || pending.entered) return Promise.reject(new OwnedModelUnknownPayload());
    pending.consumed = true;
    return this.complete(pending.actor, pending.requestId, { kind: 'not-dispatched', reason }, 'refused', settle);
  }
  settleUsage(actor: AuthenticatedOwnedModel, id: string, usage: { tokens: number; usd: number }, outcome: 'unknown' | 'succeeded',
    settle: Settlement): Promise<OwnedModelAttemptReceipt> {
    return this.complete(actor, id, { kind: 'usage', tokens: usage.tokens, usd: usage.usd }, outcome, settle);
  }
  refuseFromProvider(actor: AuthenticatedOwnedModel, id: string, status: number, settle: Settlement): Promise<OwnedModelAttemptReceipt> {
    return this.complete(actor, id, { kind: 'provider-refused', status }, 'refused', settle);
  }
  private async complete(actor: AuthenticatedOwnedModel, id: string, value: OwnedModelEvidence,
    outcome: Row['state'], settle: Settlement): Promise<OwnedModelAttemptReceipt> {
    const owned = this.credentials.actor(actor), digest = evidence(value);
    if (!requestId(id)) throw new OwnedModelIdentityConflict();
    return this.database.transaction(async database => {
      await accountingLocks(database, owned.ownerId);
      const old = (await database.query<Row>('SELECT * FROM owned_model_attempts WHERE credential_id=$1 AND model_request_id=$2 FOR UPDATE', [owned.id, id])).rows[0];
      if (!old || old.command_id !== owned.commandId || old.generation_id !== owned.generationId || old.owner_id !== owned.ownerId ||
          old.evidence_hash && old.evidence_hash !== digest || old.state !== 'unknown' && old.state !== outcome) throw new OwnedModelIdentityConflict();
      if (!old.evidence_hash) await settle(database, old.reservation, value);
      else if (old.state === outcome) return receipt(old);
      const row = (await database.query<Row>(`UPDATE owned_model_attempts SET state=$3,evidence=$4::jsonb,evidence_hash=$5,
        settled_at=COALESCE(settled_at,clock_timestamp()) WHERE credential_id=$1 AND model_request_id=$2 RETURNING *`,
      [owned.id, id, outcome, JSON.stringify(value), digest])).rows[0]!;
      return receipt(row);
    });
  }
}
