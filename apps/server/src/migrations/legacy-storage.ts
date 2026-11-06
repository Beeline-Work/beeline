/**
 * Historical storage remains through serving and rollback overlap. A later
 * contract release owns removal of the retired pre-monolith tables.
 */
export const LEGACY_STORAGE_SCHEMA = `
DROP FUNCTION IF EXISTS beeline_mark_room_read(uuid, uuid, bytea, timestamptz, bytea);

CREATE TABLE IF NOT EXISTS beeline_agent_connect_grants (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  community_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  minter_pubkey bytea NOT NULL,
  agent_pubkey bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;
