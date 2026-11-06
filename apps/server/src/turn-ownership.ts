import type { HelperTurnOwnershipSource } from '@beeline/api-contract/helper-turn-ownership';
import type { SqlDatabase } from './database.js';
import { OWNED_MODEL_OWNER_END_SCHEMA } from './owned-model-parking.js';
import { ROUTER_AUTHORITY_LOCK } from './router-authority-lock.js';

/** Independent rollout gate. Legacy rows and helpers retain their receipt adapter. */
export { networkRouterEnabled as turnOwnershipEnabled } from './network-router-rollout.js';
const ownedTurnAdapters = new Set([
  'claimAgentCommand', 'acknowledgeAgentCommand', 'getAgentCommands',
  'postRoomMessage', 'postCornerMessage', 'postAgentTurnReceipt', 'markAgentTurnSilent',
  'postAgentActivity', 'postRoomEvent', 'postAgentDraft', 'postAgentThought', 'retractAgentLiveOutput',
  'postBackgroundToolCompletion', 'getRoomConversation', 'getRoomMessage', 'getRoomAuthority',
  // Prompt preparation uses these existing command-authorized database adapters.
  'getInstitutionalContext', 'getInstitutionalMemoryTurnStats', 'listRoomCorners',
]);
/** Completed ownership adapters select their dedicated behavior. Every other
 * operation retains its existing handler, permissions and provider leaf; lack
 * of a new adapter is never a reason to refuse an otherwise allowed operation. */
export const usesOwnedTurnAdapter = (name: string): boolean => ownedTurnAdapters.has(name);

export const TURN_OWNERSHIP_SCHEMA = `
-- Execution ownership survives transport loss; a new helper runtime replaces it.
ALTER TABLE agent_connections ADD COLUMN IF NOT EXISTS turn_connection_id text;
ALTER TABLE agent_connections ADD COLUMN IF NOT EXISTS turn_connection_epoch bigint;
ALTER TABLE agent_connections ADD COLUMN IF NOT EXISTS turn_transport_id text;
-- A pre-continuation server updates only the physical connection. Clear the
-- optional runtime binding when that writer takes over during rollout/rollback.
CREATE OR REPLACE FUNCTION beeline_replace_turn_transport() RETURNS trigger AS $$
BEGIN
  IF NEW.turn_transport_id IS DISTINCT FROM NEW.connection_id THEN
    NEW.turn_connection_id=NULL;
    NEW.turn_connection_epoch=NULL;
    NEW.turn_transport_id=NULL;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS beeline_replace_turn_transport ON agent_connections;
CREATE TRIGGER beeline_replace_turn_transport BEFORE UPDATE OF connection_id ON agent_connections
  FOR EACH ROW EXECUTE FUNCTION beeline_replace_turn_transport();
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS turn_owner_connection_id text;
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS turn_owner_epoch bigint;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='agent_commands_turn_owner_pair'
    AND conrelid='agent_commands'::regclass) THEN
    ALTER TABLE agent_commands ADD CONSTRAINT agent_commands_turn_owner_pair CHECK
      ((turn_owner_connection_id IS NULL)=(turn_owner_epoch IS NULL));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS agent_commands_turn_owner_claimed
  ON agent_commands(agent_id,turn_owner_connection_id,turn_owner_epoch)
  WHERE state='claimed' AND turn_owner_connection_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS agent_command_generation_owners(
  command_id text NOT NULL REFERENCES agent_commands(id) ON DELETE CASCADE,
  generation_id text NOT NULL,
  connection_id text,
  connection_epoch bigint,
  PRIMARY KEY(command_id,generation_id),
  CHECK((connection_id IS NULL)=(connection_epoch IS NULL))
);
-- One migration cut preserves known legacy generations as NULL-owner markers.
INSERT INTO agent_command_generation_owners(command_id,generation_id,connection_id,connection_epoch)
 SELECT id,generation_id,turn_owner_connection_id,turn_owner_epoch FROM agent_commands
 WHERE generation_id IS NOT NULL ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION beeline_preserve_generation_binding() RETURNS trigger AS $$
BEGIN
  IF TG_OP='UPDATE' OR EXISTS(SELECT 1 FROM agent_commands WHERE id=OLD.command_id) THEN
    RAISE EXCEPTION 'command generation binding is immutable' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS beeline_preserve_generation_binding ON agent_command_generation_owners;
CREATE TRIGGER beeline_preserve_generation_binding BEFORE UPDATE OR DELETE ON agent_command_generation_owners
  FOR EACH ROW EXECUTE FUNCTION beeline_preserve_generation_binding();
CREATE OR REPLACE FUNCTION beeline_bind_command_generation() RETURNS trigger AS $$
BEGIN
  IF NEW.generation_id IS NULL THEN RETURN NULL; END IF;
  INSERT INTO agent_command_generation_owners(command_id,generation_id,connection_id,connection_epoch)
    VALUES(NEW.id,NEW.generation_id,NEW.turn_owner_connection_id,NEW.turn_owner_epoch)
    ON CONFLICT DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM agent_command_generation_owners binding
    WHERE binding.command_id=NEW.id AND binding.generation_id=NEW.generation_id
      AND binding.connection_id IS NOT DISTINCT FROM NEW.turn_owner_connection_id
      AND binding.connection_epoch IS NOT DISTINCT FROM NEW.turn_owner_epoch) THEN
    RAISE EXCEPTION 'command generation owner changed' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS beeline_bind_command_generation ON agent_commands;
CREATE TRIGGER beeline_bind_command_generation
  AFTER INSERT OR UPDATE OF generation_id,turn_owner_connection_id,turn_owner_epoch ON agent_commands
  FOR EACH ROW EXECUTE FUNCTION beeline_bind_command_generation();
${OWNED_MODEL_OWNER_END_SCHEMA}
-- Actual owned effects register one ephemeral row per transaction/source.
-- The deferred trigger runs at COMMIT, then removes its own evidence. No
-- heartbeat, reader, journal, sweeper or retained per-effect history uses it.
CREATE TABLE IF NOT EXISTS turn_owned_effect_fences(
  transaction_id bigint NOT NULL,agent_id text NOT NULL,connection_id text NOT NULL,connection_epoch bigint NOT NULL,
  command_id text NOT NULL,generation_id text NOT NULL,
  PRIMARY KEY(transaction_id,agent_id,connection_id,connection_epoch)
);
CREATE OR REPLACE FUNCTION beeline_register_owned_effect(
  effect_command text,effect_agent text,effect_generation text,effect_connection text,effect_epoch bigint
) RETURNS boolean AS $$
DECLARE previous turn_owned_effect_fences%ROWTYPE;
BEGIN
  IF effect_connection IS NULL THEN RETURN true; END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'owned effect requires read committed' USING ERRCODE='23514';
  END IF;
  SELECT * INTO previous FROM turn_owned_effect_fences WHERE transaction_id=txid_current()
    AND agent_id=effect_agent AND connection_id=effect_connection AND connection_epoch=effect_epoch;
  IF FOUND THEN
    IF previous.command_id IS DISTINCT FROM effect_command OR previous.generation_id IS DISTINCT FROM effect_generation THEN
      RAISE EXCEPTION 'owned transaction crosses execution generations' USING ERRCODE='23514';
    END IF;
    RETURN true;
  END IF;
  INSERT INTO turn_owned_effect_fences(transaction_id,agent_id,connection_id,connection_epoch,command_id,generation_id)
    VALUES(txid_current(),effect_agent,effect_connection,effect_epoch,effect_command,effect_generation);
  RETURN true;
END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION beeline_commit_owned_effect() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM agent_connections connection JOIN live_server_instances server
      ON server.instance_id=connection.instance_id
    JOIN agent_commands command ON command.id=NEW.command_id AND command.agent_id=NEW.agent_id
    JOIN agent_command_generation_owners binding ON binding.command_id=command.id AND binding.generation_id=NEW.generation_id
      AND binding.connection_id=NEW.connection_id AND binding.connection_epoch=NEW.connection_epoch
    WHERE connection.agent_id=NEW.agent_id AND COALESCE(connection.turn_connection_id,connection.connection_id)=NEW.connection_id
      AND COALESCE(connection.turn_connection_epoch,connection.epoch)=NEW.connection_epoch AND connection.released_at IS NULL
      AND server.renewed_at>clock_timestamp()-interval '90 seconds'
      AND (beeline_command_generation_open(command.id,NEW.generation_id) OR EXISTS(
        SELECT 1 FROM agent_command_owner_ends ended WHERE ended.command_id=command.id
          AND ended.generation_id=NEW.generation_id AND ended.transaction_id=NEW.transaction_id))
      AND ((command.generation_id=NEW.generation_id AND command.turn_owner_connection_id=NEW.connection_id
        AND command.turn_owner_epoch=NEW.connection_epoch) OR (
          command.state='pending' AND command.generation_id IS NULL AND command.turn_owner_connection_id IS NULL
          AND EXISTS(SELECT 1 FROM agent_turns turn WHERE turn.room_id=command.room_id AND turn.agent_id=command.agent_id
            AND turn.request_id=command.turn_request_id AND turn.generation_id=NEW.generation_id
            AND turn.status IN ('failed','complete','cancelled'))))) THEN
    RAISE EXCEPTION 'owned effect authority expired before commit' USING ERRCODE='23514';
  END IF;
  DELETE FROM turn_owned_effect_fences WHERE transaction_id=NEW.transaction_id AND agent_id=NEW.agent_id
    AND connection_id=NEW.connection_id AND connection_epoch=NEW.connection_epoch;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS beeline_commit_owned_effect ON turn_owned_effect_fences;
CREATE CONSTRAINT TRIGGER beeline_commit_owned_effect AFTER INSERT ON turn_owned_effect_fences
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION beeline_commit_owned_effect();
CREATE OR REPLACE FUNCTION beeline_command_owner_live(
  owned_agent text,owned_connection text,owned_epoch bigint,legacy_until timestamptz,observed_at timestamptz
) RETURNS boolean AS $$
  SELECT CASE WHEN owned_connection IS NULL THEN legacy_until>observed_at
  ELSE EXISTS(
    SELECT 1 FROM agent_connections connection LEFT JOIN live_server_instances server
      ON server.instance_id=connection.instance_id
    WHERE connection.agent_id=owned_agent AND COALESCE(connection.turn_connection_id,connection.connection_id)=owned_connection
      AND COALESCE(connection.turn_connection_epoch,connection.epoch)=owned_epoch
      AND (connection.turn_connection_id IS NOT NULL OR (connection.released_at IS NULL
        AND server.renewed_at>clock_timestamp()-interval '90 seconds'))
  ) END;
$$ LANGUAGE sql VOLATILE;
`;

function prefix(alias?: string): string {
  if (alias !== undefined && !/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error('Invalid command SQL alias');
  return alias ? `${alias}.` : '';
}

/** One definition for claims, recovery, effective busy state and tool authority. */
export function commandOwnerLiveSql(alias?: string, observedAt = 'now()'): string {
  const p = prefix(alias);
  // Keep the legacy branch local to the row; no connection lookup or SQL
  // function call is needed for a row that has never selected this protocol.
  return `(CASE WHEN ${p}turn_owner_connection_id IS NULL THEN ${p}lease_expires_at>${observedAt}
    ELSE beeline_command_generation_open(${p}id,${p}generation_id) AND
      beeline_command_owner_live(${p}agent_id,${p}turn_owner_connection_id,${p}turn_owner_epoch,${p}lease_expires_at,${observedAt}) END)`;
}
export function commandOwnerExpiredSql(alias?: string, observedAt = 'now()'): string {
  const p = prefix(alias);
  return `((${p}turn_owner_connection_id IS NULL OR beeline_command_generation_open(${p}id,${p}generation_id)) AND NOT (${commandOwnerLiveSql(alias, observedAt)}))`;
}
/** Legacy grace periods are retained. A lost registered owner needs no fake turn freshness. */
export function commandOwnerExpiredBeforeSql(alias: string | undefined, before: string): string {
  const p = prefix(alias);
  return `(CASE WHEN ${p}turn_owner_connection_id IS NULL THEN ${p}lease_expires_at<${before}
    ELSE ${commandOwnerExpiredSql(alias)} END)`;
}

/** Visible working state follows real execution ownership for the new cohort.
 * Immutable bindings prevent an old owned turn borrowing legacy freshness
 * after its command was requeued or moved to a newer generation. */
export function workingTurnFreshSql(alias: string): string {
  const p = prefix(alias);
  const scope = `working_command.room_id=${p}room_id AND working_command.agent_id=${p}agent_id
    AND working_command.turn_request_id=${p}request_id`;
  return `(CASE WHEN EXISTS(SELECT 1 FROM agent_commands working_command
    JOIN agent_command_generation_owners working_binding ON working_binding.command_id=working_command.id
      AND working_binding.generation_id=${p}generation_id AND working_binding.connection_id IS NOT NULL
    WHERE ${scope}) THEN EXISTS(SELECT 1 FROM agent_commands working_command
      WHERE ${scope} AND working_command.generation_id=${p}generation_id
        AND working_command.state='claimed' AND ${commandOwnerLiveSql('working_command')})
    ELSE ${p}created_at>now()-interval '90 seconds' END)`;
}

/** Materialize the indexed source lock before command-row locks. Registration
 * uses that same source row, so replacement cannot pass an admitted write. */
export function commandOwnerFenceCteSql(scope: string): string {
  return `turn_owner_fence AS MATERIALIZED (
    SELECT owned_command.id command_id FROM agent_commands owned_command
    JOIN agent_connections connection ON connection.agent_id=owned_command.agent_id
      AND COALESCE(connection.turn_connection_id,connection.connection_id)=owned_command.turn_owner_connection_id
      AND COALESCE(connection.turn_connection_epoch,connection.epoch)=owned_command.turn_owner_epoch AND connection.released_at IS NULL
    JOIN live_server_instances server ON server.instance_id=connection.instance_id
      AND server.renewed_at>clock_timestamp()-interval '90 seconds'
    WHERE ${scope} AND beeline_command_generation_open(owned_command.id,owned_command.generation_id) FOR SHARE OF connection
  )`;
}
export function commandOwnerFenceMatchesSql(alias = 'command'): string {
  const p = prefix(alias);
  return `(${p}turn_owner_connection_id IS NULL OR EXISTS(
    SELECT 1 FROM turn_owner_fence WHERE turn_owner_fence.command_id=${p}id))`;
}

/** The caller transaction retains this source fence through its actual claim/write. */
export async function assertCurrentTurnOwner(
  database: SqlDatabase, agentId: string, source: HelperTurnOwnershipSource,
): Promise<void> {
  if (!source.connectionId || !Number.isSafeInteger(source.epoch) || source.epoch <= 0)
    throw new Error('Turn ownership source invalid');
  const current = await database.query(`SELECT connection.agent_id FROM agent_connections connection
    JOIN live_server_instances server ON server.instance_id=connection.instance_id
    WHERE connection.agent_id=$1 AND COALESCE(connection.turn_connection_id,connection.connection_id)=$2 AND COALESCE(connection.turn_connection_epoch,connection.epoch)=$3
      AND connection.released_at IS NULL AND server.renewed_at>clock_timestamp()-interval '90 seconds'
    FOR SHARE OF connection`, [agentId, source.connectionId, source.epoch]);
  if (!current.rowCount) throw new Error('Turn ownership source changed');
}

export async function isCommandOwnerLive(database: SqlDatabase, commandId: string, observedAt: number): Promise<boolean> {
  const row = await database.query<{ active: boolean }>(`SELECT ${commandOwnerLiveSql('command', '$2::timestamptz')} active
    FROM agent_commands command WHERE command.id=$1`, [commandId, new Date(observedAt * 1000)]);
  return row.rows[0]?.active === true;
}

/** Only an actual effect admission calls this; repeated authorization in the
 * same transaction/source reuses its one deferred commit constraint. */
export async function registerOwnedEffectFence(database: SqlDatabase, command: {
  id: string; agent_id: string; generation_id: string | null;
  turn_owner_connection_id?: string | null; turn_owner_epoch?: string | number | null;
}): Promise<void> {
  if (!command.turn_owner_connection_id) return;
  await database.query('SELECT beeline_register_owned_effect($1,$2,$3,$4,$5)', [
    command.id, command.agent_id, command.generation_id, command.turn_owner_connection_id, command.turn_owner_epoch,
  ]);
}

/** Archived corners retain only their exact queued cleanup controls. The
 * current parent and Workspace membership still share the authority fence. */
export async function lockOwnedTurnRoomAccess(
  database: SqlDatabase, roomId: string, agentId: string, controlId?: string,
): Promise<boolean> {
  await database.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [ROUTER_AUTHORITY_LOCK]);
  const access = await database.query(`SELECT 1 FROM rooms room JOIN room_access member
    ON member.room_id=CASE WHEN room.archived_at IS NULL THEN room.id ELSE room.parent_id END
    JOIN memberships workspace_member ON workspace_member.workspace_id=room.workspace_id
      AND workspace_member.room_id IS NULL AND workspace_member.identity_id=member.identity_id
      AND workspace_member.removed_at IS NULL
    WHERE room.id=$1 AND member.identity_id=$2 AND member.removed_at IS NULL
      AND (room.archived_at IS NULL OR EXISTS(SELECT 1 FROM agent_commands control
        WHERE control.id=$3 AND control.room_id=room.id AND control.agent_id=$2
          AND control.action IN ('stop','restart')))`, [roomId, agentId, controlId ?? null]);
  return Boolean(access.rowCount);
}
