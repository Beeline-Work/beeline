import type { HelperTurnOwnershipSource } from '@beeline/api-contract/helper-turn-ownership';
import type { SqlDatabase } from './database.js';
import type { PostTurnReceiptInput } from '@beeline/api-contract/daemon';

/** Causal owner lifetime evidence, not a provider outcome or product state.
 * Install with TURN_OWNERSHIP_SCHEMA before using its effective predicates. */
export const OWNED_MODEL_OWNER_END_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_command_owner_ends (
 command_id text NOT NULL, generation_id text NOT NULL,
 model_request_id text, ended_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 transaction_id bigint NOT NULL DEFAULT txid_current(),
 PRIMARY KEY(command_id,generation_id),
 FOREIGN KEY(command_id,generation_id) REFERENCES agent_command_generation_owners(command_id,generation_id) ON DELETE CASCADE
);
ALTER TABLE agent_command_owner_ends ALTER COLUMN model_request_id DROP NOT NULL;
CREATE OR REPLACE FUNCTION beeline_command_generation_open(command text,generation text) RETURNS boolean
 LANGUAGE sql STABLE AS $$ SELECT NOT EXISTS(SELECT 1 FROM agent_command_owner_ends ended
   WHERE ended.command_id=command AND ended.generation_id=generation) $$;
CREATE OR REPLACE FUNCTION beeline_command_claim_open(command text) RETURNS boolean
 LANGUAGE sql STABLE AS $$ SELECT NOT EXISTS(SELECT 1 FROM agent_command_owner_ends ended WHERE ended.command_id=command) $$;
CREATE OR REPLACE FUNCTION beeline_fence_ended_command_claim() RETURNS trigger AS $$
BEGIN
 IF to_jsonb(NEW)->>'action' IN ('input','resume') AND NEW.state='claimed' AND
   (TG_OP='INSERT' OR ROW(NEW.state,NEW.generation_id,NEW.turn_owner_connection_id,NEW.turn_owner_epoch,to_jsonb(NEW)->>'action')
     IS DISTINCT FROM ROW(OLD.state,OLD.generation_id,OLD.turn_owner_connection_id,OLD.turn_owner_epoch,to_jsonb(OLD)->>'action'))
   AND NOT beeline_command_claim_open(NEW.id) THEN
   RAISE EXCEPTION 'command model owner has ended' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS beeline_fence_ended_command_claim ON agent_commands;
CREATE TRIGGER beeline_fence_ended_command_claim BEFORE INSERT OR UPDATE
 ON agent_commands FOR EACH ROW EXECUTE FUNCTION beeline_fence_ended_command_claim();
CREATE OR REPLACE FUNCTION beeline_preserve_owner_end() RETURNS trigger AS $$
BEGIN
 IF TG_OP='UPDATE' OR EXISTS(SELECT 1 FROM agent_commands WHERE id=OLD.command_id) THEN
   RAISE EXCEPTION 'command owner end is immutable' USING ERRCODE='23514';
 END IF;
 RETURN OLD;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS beeline_preserve_owner_end ON agent_command_owner_ends;
CREATE TRIGGER beeline_preserve_owner_end BEFORE UPDATE OR DELETE ON agent_command_owner_ends
 FOR EACH ROW EXECUTE FUNCTION beeline_preserve_owner_end();
`;
type Identity = { roomId: string; agentId: string; requestId: string; generationId?: string | null };
type Cause = { kind: 'terminal-receipt'; source: HelperTurnOwnershipSource; modelRequestId: string | null } | { kind: 'source-ended' };
export class OwnedModelOwnerEndRefusal extends Error {
  constructor() { super('Owned model owner end could not be authorized'); }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
async function modelInstalled(database: SqlDatabase): Promise<boolean> {
  return (await database.query<{ installed: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace space ON space.oid=relation.relnamespace
    WHERE space.nspname=current_schema() AND relation.relname='owned_model_attempts' AND relation.relkind='r') installed`)).rows[0]?.installed === true;
}

/** Compose inside the existing actual-authority transaction. No provider I/O,
 * new receipt state, release/refund, requeue or notification is invented here.
 * DELETE sources own committed fanout; rollback emits no application event. */
export async function parkOwnedModelGeneration(database: SqlDatabase, input: Identity, cause: Cause): Promise<boolean> {
  if (!input.generationId) { if (cause.kind === 'terminal-receipt') throw new OwnedModelOwnerEndRefusal(); return false; }
  if (cause.kind === 'terminal-receipt' && (cause.modelRequestId!==null&&!uuid.test(cause.modelRequestId) || !cause.source.connectionId ||
      !Number.isSafeInteger(cause.source.epoch) || cause.source.epoch <= 0)) throw new OwnedModelOwnerEndRefusal();
  const command = (await database.query<{ id: string; turn_owner_connection_id: string | null; turn_owner_epoch: string | number | null }>(
    `SELECT id,turn_owner_connection_id,turn_owner_epoch FROM agent_commands
     WHERE room_id=$1 AND agent_id=$2 AND turn_request_id=$3 AND generation_id=$4
       AND state='claimed' AND action IN ('input','resume') FOR UPDATE`,
    [input.roomId, input.agentId, input.requestId, input.generationId])).rows[0];
  if (!command?.turn_owner_connection_id) { if (cause.kind === 'terminal-receipt') throw new OwnedModelOwnerEndRefusal(); return false; }
  if (cause.kind === 'terminal-receipt') {
    if (command.turn_owner_connection_id !== cause.source.connectionId || Number(command.turn_owner_epoch) !== cause.source.epoch ||
        !(await database.query(`SELECT 1 FROM agent_connections connection JOIN live_server_instances server
          ON server.instance_id=connection.instance_id WHERE connection.agent_id=$1 AND COALESCE(connection.turn_connection_id,connection.connection_id)=$2
          AND COALESCE(connection.turn_connection_epoch,connection.epoch)=$3 AND connection.released_at IS NULL
          AND server.renewed_at>clock_timestamp()-interval '90 seconds'`,
        [input.agentId, cause.source.connectionId, cause.source.epoch])).rowCount) throw new OwnedModelOwnerEndRefusal();
  } else {
    const ended = await database.query(`SELECT 1 WHERE NOT beeline_command_owner_live($1,$2,$3,NULL,clock_timestamp())`,
      [input.agentId, command.turn_owner_connection_id, command.turn_owner_epoch]);
    if (!ended.rowCount) return false;
  }
  const previous = await database.query(`SELECT 1 FROM agent_command_owner_ends WHERE command_id=$1 AND generation_id=$2`,
    [command.id, input.generationId]);
  if (previous.rowCount) return true;
  let modelRequestId: string | null;
  if(cause.kind==='terminal-receipt'&&cause.modelRequestId===null){
    // Journal loss supplies no provider outcome or invented request identity.
    // Only an actually issued credential for this exact current owner can end.
    const credential=await database.query(`SELECT 1 FROM owned_model_credentials
      WHERE command_id=$1 AND generation_id=$2 AND agent_id=$3 AND room_id=$4 AND request_id=$5
        AND connection_id=$6 AND connection_epoch=$7 LIMIT 1`,
      [command.id,input.generationId,input.agentId,input.roomId,input.requestId,command.turn_owner_connection_id,command.turn_owner_epoch]);
    if(!credential.rowCount)throw new OwnedModelOwnerEndRefusal();
    modelRequestId=null;
  }else{
    const attempt = (await database.query<{ model_request_id: string }>(
    `SELECT attempt.model_request_id FROM owned_model_attempts attempt
     JOIN owned_model_credentials credential ON credential.id=attempt.credential_id
     WHERE attempt.command_id=$1 AND attempt.generation_id=$2 AND attempt.agent_id=$3
       AND credential.command_id=attempt.command_id AND credential.generation_id=attempt.generation_id
       AND credential.agent_id=$3 AND credential.room_id=$4 AND credential.request_id=$5
       AND credential.connection_id=$6 AND credential.connection_epoch=$7
       AND ${cause.kind === 'terminal-receipt' ? 'attempt.model_request_id=$8' : "attempt.state='unknown'"}
     ORDER BY attempt.model_request_id LIMIT 1 FOR SHARE OF attempt`,
    [command.id, input.generationId, input.agentId, input.roomId, input.requestId,
      command.turn_owner_connection_id, command.turn_owner_epoch,
      ...(cause.kind === 'terminal-receipt' ? [cause.modelRequestId] : [])])).rows[0];
    if (!attempt) { if (cause.kind === 'terminal-receipt') throw new OwnedModelOwnerEndRefusal(); return false; }
    modelRequestId=attempt.model_request_id;
  }
  if (cause.kind === 'terminal-receipt') await database.query('SELECT beeline_register_owned_effect($1,$2,$3,$4,$5)',
    [command.id, input.agentId, input.generationId, command.turn_owner_connection_id, command.turn_owner_epoch]);
  await database.query(`INSERT INTO agent_command_owner_ends(command_id,generation_id,model_request_id)
    VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [command.id, input.generationId, modelRequestId]);
  await database.query(`DELETE FROM agent_turns WHERE room_id=$1 AND agent_id=$2 AND request_id=$3
    AND generation_id=$4 AND status='working'`, [input.roomId, input.agentId, input.requestId, input.generationId]);
  await database.query(`DELETE FROM live_outputs WHERE room_id=$1 AND agent_id=$2 AND turn_id=$3
    AND kind IN ('draft','thought') AND body->'overlayV1'->>'turnGeneration'=$4`, [input.roomId, input.agentId, input.requestId, input.generationId]);
  return true;
}

/** Before silence/reassignment, even if this callback belongs to an old owner.
 * No credential/attempt table query is needed for an ordinary legacy row. */
export async function guardOwnedModelSilence(database: SqlDatabase, input: Identity): Promise<boolean> {
  if (!input.generationId) return false;
  if ((await database.query(`SELECT 1 FROM agent_command_owner_ends ended JOIN agent_commands command ON command.id=ended.command_id
    WHERE command.room_id=$1 AND command.agent_id=$2 AND command.turn_request_id=$3 AND ended.generation_id=$4`,
  [input.roomId, input.agentId, input.requestId, input.generationId])).rowCount) return true;
  // Source-ended parking checks that a real owned model credential exists
  // before touching the optional model ledger in legacy-only installations.
  const owned = await database.query(`SELECT 1 FROM agent_commands WHERE room_id=$1 AND agent_id=$2
    AND turn_request_id=$3 AND generation_id=$4 AND turn_owner_connection_id IS NOT NULL AND state='claimed'`,
  [input.roomId, input.agentId, input.requestId, input.generationId]);
  if (!owned.rowCount) return false;
  if (!await modelInstalled(database)) return false;
  if (await parkOwnedModelGeneration(database, input, { kind: 'source-ended' })) return true;
  // UNKNOWN is also the normal in-flight reservation state. While its owner
  // is still running, suppress an unrelated silence consequence but retain
  // all working state and create NO owner-end evidence.
  return Boolean((await database.query(`SELECT 1 FROM agent_commands command
    JOIN owned_model_attempts attempt ON attempt.command_id=command.id AND attempt.generation_id=command.generation_id
      AND attempt.agent_id=command.agent_id AND attempt.state='unknown'
    JOIN owned_model_credentials credential ON credential.id=attempt.credential_id
      AND credential.command_id=command.id AND credential.generation_id=command.generation_id
      AND credential.agent_id=command.agent_id AND credential.connection_id=command.turn_owner_connection_id
      AND credential.connection_epoch=command.turn_owner_epoch
    WHERE command.room_id=$1 AND command.agent_id=$2 AND command.turn_request_id=$3
      AND command.generation_id=$4 AND command.state='claimed' LIMIT 1`,
  [input.roomId, input.agentId, input.requestId, input.generationId])).rowCount);
}

/** Existing current-owner terminal receipt ingress, before all terminal effects.
 * An explicit modelOwnerEnd also covers committed success whose final response
 * was lost. Without that causal field, only actual UNKNOWN is parked. */
export async function parkOwnedModelTerminal(
  database: SqlDatabase, input: PostTurnReceiptInput, agentId: string, source?: HelperTurnOwnershipSource,
): Promise<boolean> {
  const explicit = input.modelOwnerEnd !== undefined;
  if (explicit && (input.status !== 'failed' || input.heartbeat !== undefined || !source || !input.modelOwnerEnd ||
      typeof input.modelOwnerEnd !== 'object' || Array.isArray(input.modelOwnerEnd) ||
      !(('requestId' in input.modelOwnerEnd && Object.keys(input.modelOwnerEnd).join()==='requestId' &&
        typeof input.modelOwnerEnd.requestId==='string' && uuid.test(input.modelOwnerEnd.requestId)) ||
        ('journalUnavailable' in input.modelOwnerEnd && Object.keys(input.modelOwnerEnd).join()==='journalUnavailable' && input.modelOwnerEnd.journalUnavailable===true)))) throw new OwnedModelOwnerEndRefusal();
  if (!source || !['failed', 'complete'].includes(input.status) || input.heartbeat) return false;
  if (!await modelInstalled(database)) {
    if (explicit) throw new OwnedModelOwnerEndRefusal(); return false;
  }
  if(input.modelOwnerEnd&&'journalUnavailable' in input.modelOwnerEnd)
    return parkOwnedModelGeneration(database,{...input,agentId},{kind:'terminal-receipt',source,modelRequestId:null});
  let modelRequestId = input.modelOwnerEnd?.requestId;
  if (!modelRequestId) {
    modelRequestId = (await database.query<{ model_request_id: string }>(`SELECT attempt.model_request_id
      FROM agent_commands command JOIN owned_model_attempts attempt ON attempt.command_id=command.id
        AND attempt.generation_id=command.generation_id AND attempt.agent_id=command.agent_id
      WHERE command.room_id=$1 AND command.agent_id=$2 AND command.turn_request_id=$3 AND command.generation_id=$4
        AND command.turn_owner_connection_id=$5 AND command.turn_owner_epoch=$6 AND attempt.state='unknown'
      ORDER BY attempt.model_request_id LIMIT 1`,
    [input.roomId, agentId, input.requestId, input.generationId, source.connectionId, source.epoch])).rows[0]?.model_request_id;
  }
  if (!modelRequestId) return false;
  return parkOwnedModelGeneration(database, { ...input, agentId }, { kind: 'terminal-receipt', source, modelRequestId });
}
