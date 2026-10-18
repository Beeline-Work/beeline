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
ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS transport_ready_epoch integer NOT NULL DEFAULT -1;
ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS transport_epoch integer NOT NULL DEFAULT 0;
ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS retired_transport_epochs integer[] NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS voice_account_owners (
  identity_id text PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
  epoch integer NOT NULL DEFAULT 0,
  call_id uuid REFERENCES voice_calls(id) ON DELETE SET NULL,
  device_id text NOT NULL DEFAULT '',
  session_id text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS voice_account_owners_call_idx ON voice_account_owners(call_id);
CREATE TABLE IF NOT EXISTS voice_replaced_devices (
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  call_id uuid NOT NULL,
  PRIMARY KEY(identity_id,device_id,call_id)
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
ALTER TABLE voice_participants ADD COLUMN IF NOT EXISTS parked_at timestamptz;
ALTER TABLE voice_participants ADD COLUMN IF NOT EXISTS session_id text NOT NULL DEFAULT '';
ALTER TABLE voice_participants ADD COLUMN IF NOT EXISTS ownership_epoch integer NOT NULL DEFAULT 0;
ALTER TABLE voice_participants ADD COLUMN IF NOT EXISTS device_id text NOT NULL DEFAULT '';
ALTER TABLE voice_participants ADD COLUMN IF NOT EXISTS rtc_identity text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS voice_participants_identity_idx ON voice_participants(identity_id);
-- Adopt pre-ownership calls once. An unknown legacy device must reconnect to
-- bind its durable authenticated family before receiving a new token.
INSERT INTO voice_account_owners(identity_id,epoch,call_id,device_id,session_id)
SELECT DISTINCT ON (p.identity_id) p.identity_id,greatest(p.ownership_epoch,1),p.call_id,'legacy',p.session_id
FROM voice_participants p JOIN voice_calls c ON c.id=p.call_id
WHERE p.left_at IS NULL AND c.ended_at IS NULL
ORDER BY p.identity_id,p.joined_at DESC,p.call_id
ON CONFLICT(identity_id) DO NOTHING;
UPDATE voice_participants p SET ownership_epoch=o.epoch FROM voice_account_owners o
WHERE p.identity_id=o.identity_id AND p.call_id=o.call_id AND p.rtc_identity='' AND p.ownership_epoch=0;
WITH departed AS (
  UPDATE voice_participants p SET left_at=now()
  FROM voice_account_owners o
  WHERE p.identity_id=o.identity_id AND p.left_at IS NULL AND p.call_id<>o.call_id
  RETURNING p.call_id
)
UPDATE voice_calls c SET retired_transport_epochs=array_append(retired_transport_epochs,transport_epoch),
  transport_epoch=transport_epoch+1,runtime_owner=NULL,runtime_until=NULL
WHERE c.id IN (SELECT call_id FROM departed) AND c.ended_at IS NULL;
DROP TABLE IF EXISTS voice_daily_usage;
CREATE TABLE IF NOT EXISTS voice_workspace_usage (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Retain charged time even when the call or its Room is deleted.
  call_id uuid NOT NULL,
  day_start bigint NOT NULL,
  audio int8multirange NOT NULL DEFAULT '{}',
  PRIMARY KEY(workspace_id,day_start,call_id)
);

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
