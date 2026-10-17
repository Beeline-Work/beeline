export const VOICE_SCHEMA = `
ALTER TABLE agents ADD COLUMN IF NOT EXISTS chosen_voices jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE workspaces DROP COLUMN IF EXISTS voice_provider;
UPDATE agents SET chosen_voices = CASE
  WHEN chosen_voices ? 'aura-2' THEN jsonb_build_object('aura-2', chosen_voices->'aura-2')
  ELSE '{}'::jsonb END
WHERE chosen_voices - 'aura-2' <> '{}'::jsonb;
CREATE TABLE IF NOT EXISTS voice_calls (
  id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  message_id text NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  runtime_owner text,
  runtime_until timestamptz
);
ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS end_reason text;
CREATE UNIQUE INDEX IF NOT EXISTS voice_calls_room_live_idx ON voice_calls(room_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS voice_calls_message_idx ON voice_calls(message_id);
CREATE TABLE IF NOT EXISTS voice_participants (
  call_id uuid NOT NULL REFERENCES voice_calls(id) ON DELETE CASCADE,
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  PRIMARY KEY(call_id,identity_id)
);
ALTER TABLE voice_participants ADD COLUMN IF NOT EXISTS parked_at timestamptz;
ALTER TABLE voice_participants ADD COLUMN IF NOT EXISTS session_id text NOT NULL DEFAULT '';
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
-- Spoken turns the call runtime recorded. Unless a voice_orders row hands one
-- to the agent, no helper was woken, so its silence is not an outage.
CREATE TABLE IF NOT EXISTS voice_messages (
  message_id text PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  call_id uuid NOT NULL REFERENCES voice_calls(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS voice_messages_call_idx ON voice_messages(call_id);
`;
