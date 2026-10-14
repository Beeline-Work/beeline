export const VOICE_SCHEMA = `
ALTER TABLE agents ADD COLUMN IF NOT EXISTS chosen_voices jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS voice_provider text NOT NULL DEFAULT 'aura-2'
  CHECK (voice_provider IN ('aura-2','kokoro-deepinfra','fish-s2.1-pro'));
ALTER TABLE workspaces ALTER COLUMN voice_provider SET DEFAULT 'aura-2';
UPDATE workspaces SET voice_provider='aura-2' WHERE voice_provider<>'aura-2';
CREATE TABLE IF NOT EXISTS voice_calls (
  id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  message_id text NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  runtime_owner text,
  runtime_until timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS voice_calls_room_live_idx ON voice_calls(room_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS voice_calls_message_idx ON voice_calls(message_id);
CREATE TABLE IF NOT EXISTS voice_participants (
  call_id uuid NOT NULL REFERENCES voice_calls(id) ON DELETE CASCADE,
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  PRIMARY KEY(call_id,identity_id)
);
CREATE INDEX IF NOT EXISTS voice_participants_identity_idx ON voice_participants(identity_id);
CREATE TABLE IF NOT EXISTS voice_orders (
  source_message_id text PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  call_id uuid NOT NULL REFERENCES voice_calls(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  spoken_message_id text REFERENCES messages(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS voice_orders_call_idx ON voice_orders(call_id);
CREATE INDEX IF NOT EXISTS voice_orders_agent_idx ON voice_orders(agent_id);
CREATE INDEX IF NOT EXISTS voice_orders_spoken_message_idx ON voice_orders(spoken_message_id);
`;
