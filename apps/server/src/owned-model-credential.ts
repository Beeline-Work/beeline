import type { OwnedModelCredential } from '@beeline/api-contract/helper-model';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { CommandRefusalError } from './command-refusal.js';
import type { SqlDatabase } from './database.js';
import { commandOwnerLiveSql, registerOwnedEffectFence } from './turn-ownership.js';

/** Uninstalled, additive primitive. The actual claim/router/provider adapters
 * must opt in together; this module creates no transport or rollout switch. */
export const OWNED_MODEL_CREDENTIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS owned_model_credentials (
 id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{32}$'),
 key_version text NOT NULL,
 token_hash text NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 agent_id text NOT NULL, owner_id text NOT NULL, workspace_id uuid NOT NULL, room_id uuid NOT NULL,
 command_id text NOT NULL, generation_id text NOT NULL, request_id text NOT NULL,
 connection_id text NOT NULL, connection_epoch bigint NOT NULL CHECK(connection_epoch>0), instance_id text NOT NULL,
 model text NOT NULL, agent_model text, model_token_hash text NOT NULL,
 expires_ms bigint NOT NULL CHECK(expires_ms>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), revoked_at timestamptz,
 UNIQUE(command_id,generation_id)
);
CREATE OR REPLACE FUNCTION beeline_owned_model_credential_immutable() RETURNS trigger AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'owned model credential identity is retained' USING ERRCODE='23514'; END IF;
 IF to_jsonb(NEW)-'revoked_at' IS DISTINCT FROM to_jsonb(OLD)-'revoked_at'
   OR OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
   RAISE EXCEPTION 'owned model credential binding is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS beeline_owned_model_credential_immutable ON owned_model_credentials;
CREATE TRIGGER beeline_owned_model_credential_immutable BEFORE UPDATE OR DELETE ON owned_model_credentials
 FOR EACH ROW EXECUTE FUNCTION beeline_owned_model_credential_immutable();
`;

export interface OwnedModelBinding {
  readonly id: string;
  readonly keyVersion: string;
  readonly agentId: string;
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly commandId: string;
  readonly generationId: string;
  readonly requestId: string;
  readonly connectionId: string;
  readonly connectionEpoch: number;
  readonly instanceId: string;
  readonly model: string;
  readonly agentModel: string | null;
  readonly modelTokenHash: string;
  readonly expiresMs: number;
}
interface CredentialRow {
  id: string; key_version: string; token_hash: string; agent_id: string; owner_id: string; workspace_id: string; room_id: string;
  command_id: string; generation_id: string; request_id: string; connection_id: string; connection_epoch: string | number;
  instance_id: string; model: string; agent_model: string | null; model_token_hash: string; expires_ms: string | number;
  revoked_at: Date | null;
}
interface CurrentRow {
  agent_id: string; owner_id: string; workspace_id: string; room_id: string; parent_id: string | null;
  command_id: string; generation_id: string; request_id: string; connection_id: string; connection_epoch: string | number;
  instance_id: string; model: string; agent_model: string | null; model_token_hash: string;
  expires_ms: string | number; now_ms: string | number; lease_ms: string | number;
}
declare const authenticated: unique symbol;
export type AuthenticatedOwnedModel = Readonly<{ readonly [authenticated]: true; readonly binding: OwnedModelBinding }>;
type Actor = { binding: OwnedModelBinding; tokenHash: string };
export type OwnedModelKeyring = Readonly<{
  currentVersion: string;
  /** Injected server key material only. Never an environment/file read here. */
  key(version: string): Uint8Array | undefined;
}>;
export class OwnedModelRefusal extends CommandRefusalError {
  constructor() { super('Owned model authority is unavailable', 403); }
}
export class OwnedModelUnknownGeneration extends CommandRefusalError {
  readonly state = 'unknown';
  constructor() { super('This command has a prior model outcome UNKNOWN; do not start another generation.', 409); }
}
const scalar = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fixedEqual(a: Buffer, b: Buffer): boolean { return a.length === b.length && timingSafeEqual(a, b); }
function binding(row: CredentialRow): OwnedModelBinding {
  const value = Object.freeze({ id: row.id, keyVersion: row.key_version, agentId: row.agent_id, ownerId: row.owner_id,
    workspaceId: row.workspace_id, roomId: row.room_id, commandId: row.command_id, generationId: row.generation_id,
    requestId: row.request_id, connectionId: row.connection_id, connectionEpoch: Number(row.connection_epoch),
    instanceId: row.instance_id, model: row.model, agentModel: row.agent_model, modelTokenHash: row.model_token_hash,
    expiresMs: Number(row.expires_ms) });
  if (!/^[a-f0-9]{32}$/.test(value.id) || !/^[A-Za-z0-9._-]{1,32}$/.test(value.keyVersion) ||
      !Number.isSafeInteger(value.connectionEpoch) || value.connectionEpoch < 1 || !Number.isSafeInteger(value.expiresMs) || value.expiresMs < 1 ||
      !/^[a-f0-9]{64}$/.test(value.modelTokenHash) || Object.entries(value).some(([key, item]) =>
        key !== 'expiresMs' && key !== 'connectionEpoch' && key !== 'agentModel' && !scalar(item)) ||
      value.agentModel !== null && !scalar(value.agentModel)) throw new OwnedModelRefusal();
  return value;
}
function signatureData(value: OwnedModelBinding): string {
  return JSON.stringify([value.id, value.keyVersion, value.agentId, value.ownerId, value.workspaceId, value.roomId,
    value.commandId, value.generationId, value.requestId, value.connectionId, value.connectionEpoch, value.instanceId,
    value.model, value.agentModel, value.modelTokenHash, value.expiresMs]);
}

/** Explicit aggregate/source/command/free-agent checks. Callers choose read
 * versus final-lock mode; provider entry must use the latter after its queue.
 * Current membership is resolved from stored parent rows, never HTTP metadata. */
const CURRENT = `SELECT command.agent_id,starter.owner_id,room.workspace_id,room.id room_id,room.parent_id,
 command.id command_id,command.generation_id,command.turn_request_id request_id,
 connection.connection_id,connection.epoch connection_epoch,connection.instance_id,
 COALESCE(starter.model,$4::text) model,starter.model agent_model,starter.model_token_hash,
 floor(extract(epoch FROM (command.claimed_at+($5::double precision*interval '1 millisecond')))*1000)::bigint expires_ms,
 floor(extract(epoch FROM clock_timestamp())*1000)::bigint now_ms,
 floor(extract(epoch FROM (server.renewed_at+interval '90 seconds'))*1000)::bigint lease_ms
 FROM agent_commands command JOIN rooms room ON room.id=command.room_id
 JOIN rooms parent ON parent.id=COALESCE(room.parent_id,room.id)
 JOIN agents agent ON agent.agent_id=command.agent_id
 JOIN free_agents starter ON starter.agent_id=command.agent_id AND starter.owner_id=agent.owner_id
 JOIN agent_connections connection ON connection.agent_id=command.agent_id
 JOIN live_server_instances server ON server.instance_id=connection.instance_id
 JOIN agent_command_generation_owners immutable ON immutable.command_id=command.id AND immutable.generation_id=command.generation_id
   AND immutable.connection_id=command.turn_owner_connection_id AND immutable.connection_epoch=command.turn_owner_epoch
 WHERE command.id=$1 AND command.agent_id=$2 AND command.generation_id=$3 AND command.state='claimed' AND command.action IN ('input','resume')
   AND command.turn_owner_connection_id=connection.connection_id AND command.turn_owner_epoch=connection.epoch
   AND connection.released_at IS NULL AND starter.removed_at IS NULL AND starter.state='running'
   AND starter.model_token_hash IS NOT NULL AND command.claimed_at IS NOT NULL
   AND room.archived_at IS NULL AND parent.archived_at IS NULL
   AND EXISTS(SELECT 1 FROM memberships workspace WHERE workspace.workspace_id=room.workspace_id AND workspace.room_id IS NULL
     AND workspace.identity_id=command.agent_id AND workspace.removed_at IS NULL)
   AND EXISTS(SELECT 1 FROM memberships member WHERE member.room_id=COALESCE(room.parent_id,room.id)
     AND member.identity_id=command.agent_id AND member.removed_at IS NULL)
   AND ${commandOwnerLiveSql('command', 'clock_timestamp()')}`;

export class OwnedModelCredentials {
  private readonly actors = new WeakMap<object, Actor>();
  constructor(private readonly keys: OwnedModelKeyring, private readonly currentDefaultModel: () => string,
    private readonly maxTurnMs: () => number) {}

  private limits(): [string, number] {
    const model = this.currentDefaultModel(), maxTurnMs = this.maxTurnMs();
    if (!scalar(model) || !Number.isSafeInteger(maxTurnMs) || maxTurnMs < 1) throw new OwnedModelRefusal();
    return [model, maxTurnMs];
  }
  private token(value: OwnedModelBinding): string {
    const key = this.keys.key(value.keyVersion);
    if (!key || key.byteLength < 32) throw new OwnedModelRefusal();
    // Neither sealing's key derivation nor the legacy model-token domain is
    // reused as a credential MAC key or message prefix.
    const derived = createHmac('sha256', key).update('beeline:owned-model:credential-key:v1\0').digest();
    const mac = createHmac('sha256', derived).update('beeline:owned-model:credential:v1\0').update(signatureData(value)).digest('hex');
    return `bfmc_v1.${value.id}.${mac}`;
  }

  /** Compose inside the successful owned claim transaction, after its existing
   * lifecycle/authority/source/command fences. No new transaction or renewal.
   * Only opaque ID, token hash and immutable DB-derived metadata are stored. */
  async issueInTransaction(database: SqlDatabase, input: {
    agentId: string; commandId: string; generationId: string; source: { connectionId: string; epoch: number };
  }): Promise<OwnedModelCredential> {
    if (![input.agentId, input.commandId, input.generationId, input.source?.connectionId].every(value => scalar(value)) ||
        !Number.isSafeInteger(input.source.epoch) || input.source.epoch < 1) throw new OwnedModelRefusal();
    // The actual claim already owns this row. The explicit read fence also
    // makes direct composition safe against an old in-flight reservation.
    // NOWAIT refuses existing inverse lock owners without a retry timer.
    await database.query('SELECT id FROM agent_commands WHERE id=$1 AND agent_id=$2 FOR SHARE NOWAIT', [input.commandId, input.agentId]);
    const [model, maxTurnMs] = this.limits();
    const current = (await database.query<CurrentRow>(CURRENT, [input.commandId, input.agentId, input.generationId, model, maxTurnMs])).rows[0];
    if (!current || current.connection_id !== input.source.connectionId || Number(current.connection_epoch) !== input.source.epoch ||
        Number(current.expires_ms) <= Number(current.now_ms)) throw new OwnedModelRefusal();
    let row = (await database.query<CredentialRow>('SELECT * FROM owned_model_credentials WHERE command_id=$1 AND generation_id=$2',
      [input.commandId, input.generationId])).rows[0];
    if (!row) {
      if ((await database.query(`SELECT 1 FROM owned_model_attempts WHERE command_id=$1 AND generation_id<>$2 AND state='unknown' LIMIT 1`,
        [input.commandId, input.generationId])).rowCount) throw new OwnedModelUnknownGeneration();
      await registerOwnedEffectFence(database, { id: current.command_id, agent_id: current.agent_id, generation_id: current.generation_id,
        turn_owner_connection_id: current.connection_id, turn_owner_epoch: current.connection_epoch });
      const candidate: CredentialRow = { id: randomBytes(16).toString('hex'), key_version: this.keys.currentVersion,
        token_hash: '', agent_id: current.agent_id, owner_id: current.owner_id, workspace_id: current.workspace_id, room_id: current.room_id,
        command_id: current.command_id, generation_id: current.generation_id, request_id: current.request_id,
        connection_id: current.connection_id, connection_epoch: current.connection_epoch, instance_id: current.instance_id,
        model: current.model, agent_model: current.agent_model, model_token_hash: current.model_token_hash, expires_ms: current.expires_ms, revoked_at: null };
      const value = binding(candidate); candidate.token_hash = hash(this.token(value));
      row = (await database.query<CredentialRow>(`INSERT INTO owned_model_credentials(id,key_version,token_hash,agent_id,owner_id,workspace_id,room_id,
        command_id,generation_id,request_id,connection_id,connection_epoch,instance_id,model,agent_model,model_token_hash,expires_ms)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        ON CONFLICT(command_id,generation_id) DO NOTHING RETURNING *`, [candidate.id, candidate.key_version, candidate.token_hash,
        candidate.agent_id, candidate.owner_id, candidate.workspace_id, candidate.room_id, candidate.command_id, candidate.generation_id,
        candidate.request_id, candidate.connection_id, candidate.connection_epoch, candidate.instance_id, candidate.model, candidate.agent_model,
        candidate.model_token_hash, candidate.expires_ms])).rows[0];
      row ??= (await database.query<CredentialRow>('SELECT * FROM owned_model_credentials WHERE command_id=$1 AND generation_id=$2',
        [input.commandId, input.generationId])).rows[0];
    }
    if (!row || row.revoked_at) throw new OwnedModelRefusal();
    const value = binding(row), token = this.token(value);
    if (value.connectionId !== current.connection_id || value.connectionEpoch !== Number(current.connection_epoch) ||
        value.ownerId !== current.owner_id || value.workspaceId !== current.workspace_id || value.roomId !== current.room_id ||
        value.requestId !== current.request_id || value.instanceId !== current.instance_id || value.model !== current.model ||
        value.agentModel !== current.agent_model || value.modelTokenHash !== current.model_token_hash ||
        value.expiresMs <= Number(current.now_ms) || !fixedEqual(Buffer.from(hash(token), 'hex'), Buffer.from(row.token_hash, 'hex')))
      throw new OwnedModelRefusal();
    return Object.freeze({ v: 1, token, expiresAt: value.expiresMs / 1000 });
  }

  async authenticate(database: SqlDatabase, token: string): Promise<AuthenticatedOwnedModel> {
    const match = /^bfmc_v1\.([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(token);
    if (!match) throw new OwnedModelRefusal();
    const row = (await database.query<CredentialRow>('SELECT * FROM owned_model_credentials WHERE id=$1', [match[1]])).rows[0];
    if (!row || row.revoked_at) throw new OwnedModelRefusal();
    const value = binding(row), expected = this.token(value);
    if (!fixedEqual(Buffer.from(token), Buffer.from(expected)) || !fixedEqual(Buffer.from(hash(token), 'hex'), Buffer.from(row.token_hash, 'hex')))
      throw new OwnedModelRefusal();
    const actor = Object.freeze({ binding: value }) as AuthenticatedOwnedModel;
    this.actors.set(actor, { binding: value, tokenHash: row.token_hash });
    await this.assertCurrent(database, actor);
    return actor;
  }

  actor(value: AuthenticatedOwnedModel): OwnedModelBinding {
    const actor = this.actors.get(value);
    if (!actor) throw new OwnedModelRefusal();
    return actor.binding;
  }

  /** Read-only final predicate after the caller acquired its ordered locks.
   * Returns a conservative DB-clock lifetime for immediate synchronous entry. */
  async assertCurrent(database: SqlDatabase, actor: AuthenticatedOwnedModel): Promise<{ nowMs: number; untilMs: number }> {
    const owned = this.actors.get(actor);
    if (!owned) throw new OwnedModelRefusal();
    const value = owned.binding, [model, maxTurnMs] = this.limits();
    const stored = (await database.query<CredentialRow>('SELECT * FROM owned_model_credentials WHERE id=$1', [value.id])).rows[0];
    if (!stored || stored.revoked_at || stored.token_hash !== owned.tokenHash || signatureData(binding(stored)) !== signatureData(value))
      throw new OwnedModelRefusal();
    const current = (await database.query<CurrentRow>(CURRENT, [value.commandId, value.agentId, value.generationId, model, maxTurnMs])).rows[0];
    if (!current || current.owner_id !== value.ownerId || current.workspace_id !== value.workspaceId || current.room_id !== value.roomId ||
        current.request_id !== value.requestId || current.connection_id !== value.connectionId || Number(current.connection_epoch) !== value.connectionEpoch ||
        current.instance_id !== value.instanceId || current.model !== value.model || current.agent_model !== value.agentModel ||
        current.model_token_hash !== value.modelTokenHash) throw new OwnedModelRefusal();
    const nowMs = Number(current.now_ms), untilMs = Math.min(value.expiresMs, Number(current.expires_ms), Number(current.lease_ms));
    if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(untilMs) || untilMs <= nowMs) throw new OwnedModelRefusal();
    return { nowMs, untilMs };
  }
}
