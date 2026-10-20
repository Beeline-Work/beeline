/** Preserve historical storage for database-copy compatibility. Never deletes data. */
export const LEGACY_STORAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS beeline_materializer_reservations (
  consumer text PRIMARY KEY,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS beeline_room_read_marks (
  community_id uuid NOT NULL,
  room_id uuid NOT NULL,
  viewer_pubkey bytea NOT NULL,
  message_created_at timestamptz NOT NULL,
  message_id bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, room_id, viewer_pubkey)
);

CREATE OR REPLACE FUNCTION beeline_mark_room_read(
  target_community uuid,
  target_room uuid,
  target_viewer bytea,
  target_created_at timestamptz,
  target_message_id bytea
) RETURNS boolean LANGUAGE sql VOLATILE STRICT AS $$
  INSERT INTO beeline_room_read_marks (
    community_id, room_id, viewer_pubkey, message_created_at, message_id, updated_at
  ) VALUES (
    target_community, target_room, target_viewer, target_created_at, target_message_id, now()
  )
  ON CONFLICT (community_id, room_id, viewer_pubkey) DO UPDATE SET
    message_created_at = EXCLUDED.message_created_at,
    message_id = EXCLUDED.message_id,
    updated_at = EXCLUDED.updated_at
  WHERE EXCLUDED.message_created_at > beeline_room_read_marks.message_created_at
    OR (EXCLUDED.message_created_at = beeline_room_read_marks.message_created_at
      AND EXCLUDED.message_id < beeline_room_read_marks.message_id)
  RETURNING true;
$$;

CREATE TABLE IF NOT EXISTS beeline_agent_pairing_claims (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  community_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  minter_pubkey bytea NOT NULL,
  agent_pubkey bytea NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS beeline_agent_pairing_claim_memberships (
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  community_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  agent_pubkey bytea NOT NULL,
  joined_at timestamptz,
  PRIMARY KEY (token_hash, community_id, channel_id, agent_pubkey)
);

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
