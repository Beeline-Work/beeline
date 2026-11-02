/**
 * Historical storage kept for database-copy compatibility. The other
 * pre-monolith tables were empty in production on 2026-11-02 and written by
 * nothing, so they are dropped.
 */
export const LEGACY_STORAGE_SCHEMA = `
DROP FUNCTION IF EXISTS beeline_mark_room_read(uuid, uuid, bytea, timestamptz, bytea);
DROP TABLE IF EXISTS beeline_materializer_reservations;
DROP TABLE IF EXISTS beeline_room_read_marks;
DROP TABLE IF EXISTS beeline_agent_pairing_claim_memberships;
DROP TABLE IF EXISTS beeline_agent_pairing_claims;
DROP TABLE IF EXISTS beeline_nip05_names;
DROP TABLE IF EXISTS beeline_github_handle_reservations;
DROP TABLE IF EXISTS google_oauth_accounts;
DROP TABLE IF EXISTS google_oauth_attempts;

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
