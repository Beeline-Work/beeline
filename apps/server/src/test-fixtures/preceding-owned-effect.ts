// The preceding schema-46 installer owns this callback during rolling rollback.
export const PRECEDING_OWNED_EFFECT_SCHEMA = `
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
`;
