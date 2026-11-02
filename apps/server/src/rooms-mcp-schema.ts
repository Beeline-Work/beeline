/** OAuth credentials are independent of phone and helper credentials. */
export const ROOMS_MCP_SCHEMA = `
ALTER TABLE messages ADD COLUMN IF NOT EXISTS source_client jsonb;
CREATE TABLE IF NOT EXISTS rooms_mcp_clients (
  id text PRIMARY KEY, name text NOT NULL, redirects jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE rooms_mcp_clients ADD COLUMN IF NOT EXISTS logo text;
ALTER TABLE rooms_mcp_clients ADD COLUMN IF NOT EXISTS callback_url text;
ALTER TABLE rooms_mcp_clients ADD COLUMN IF NOT EXISTS secret_hash text;
ALTER TABLE rooms_mcp_clients ADD COLUMN IF NOT EXISTS auth_method text NOT NULL DEFAULT 'none';
-- A published client id for an app that cannot register itself; never expires unused.
ALTER TABLE rooms_mcp_clients ADD COLUMN IF NOT EXISTS preregistered boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS rooms_mcp_clients_created ON rooms_mcp_clients(created_at);
CREATE TABLE IF NOT EXISTS rooms_mcp_connections (
  client_id text NOT NULL REFERENCES rooms_mcp_clients(id) ON DELETE CASCADE,
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  scope text NOT NULL, connected_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz,
  revoked_at timestamptz, PRIMARY KEY(client_id,identity_id)
);
CREATE INDEX IF NOT EXISTS rooms_mcp_connections_identity ON rooms_mcp_connections(identity_id);
-- One MCP connection acts as one agent-like member owned by the approving person.
-- The member's own Room memberships alone decide what it can read and post in.
CREATE TABLE IF NOT EXISTS rooms_mcp_members (
  client_id text NOT NULL REFERENCES rooms_mcp_clients(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  member_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  model_label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, owner_id)
);
-- NULL preserves legacy all-Workspace consent; new approvals save the exact selection.
ALTER TABLE rooms_mcp_members ADD COLUMN IF NOT EXISTS workspace_ids uuid[];
CREATE INDEX IF NOT EXISTS rooms_mcp_members_member ON rooms_mcp_members(member_id);
-- Each member sets its own inbound webhook, so a shared published client id
-- never routes one person's Room text to another person's receiver.
-- NULL inherits the registration callback; an empty string explicitly disables delivery.
ALTER TABLE rooms_mcp_members ADD COLUMN IF NOT EXISTS callback_url text;
-- AES-GCM sealed bearer secret sent on each webhook POST; never returned.
ALTER TABLE rooms_mcp_members ADD COLUMN IF NOT EXISTS callback_secret text;
-- Until the member names itself, read results repeat the setup rules, because
-- many hosts never show the model the server instructions.
ALTER TABLE rooms_mcp_members ADD COLUMN IF NOT EXISTS profile_set boolean NOT NULL DEFAULT false;
ALTER TABLE rooms_mcp_members ADD COLUMN IF NOT EXISTS last_bridge_poll_at timestamptz;
-- Each tag or direct message addressed to an AI-client member, in order: the
-- list_mentions catch-up read and send_message's wake provenance.
CREATE TABLE IF NOT EXISTS rooms_mcp_mentions (
  seq bigserial PRIMARY KEY,
  member_id text NOT NULL,
  room_id uuid NOT NULL,
  message_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, message_id)
);
CREATE INDEX IF NOT EXISTS rooms_mcp_mentions_member_room ON rooms_mcp_mentions(member_id, room_id, seq);
-- A member's post whose agent wakes have not been routed yet. send_message
-- deletes it once routing commits; maintenance retries any that failed.
CREATE TABLE IF NOT EXISTS rooms_mcp_pending_routes (
  message_id text PRIMARY KEY,
  room_id uuid NOT NULL,
  member_id text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- A client-supplied idempotency key returns the first message it already posted.
CREATE TABLE IF NOT EXISTS rooms_mcp_idempotency (
  member_id text NOT NULL,
  idempotency_key text NOT NULL,
  message_id text NOT NULL,
  result jsonb,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS rooms_mcp_families (
  id text PRIMARY KEY, client_id text NOT NULL, identity_id text NOT NULL, scope text NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY(client_id,identity_id) REFERENCES rooms_mcp_connections(client_id,identity_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS rooms_mcp_families_connection ON rooms_mcp_families(client_id,identity_id);
CREATE TABLE IF NOT EXISTS rooms_mcp_refresh (
  hash text PRIMARY KEY, family_id text NOT NULL REFERENCES rooms_mcp_families(id) ON DELETE CASCADE,
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS rooms_mcp_refresh_family ON rooms_mcp_refresh(family_id);
CREATE TABLE IF NOT EXISTS rooms_mcp_flows (
  id text PRIMARY KEY, browser_hash text NOT NULL, client_id text NOT NULL REFERENCES rooms_mcp_clients(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL, state text NOT NULL, challenge text NOT NULL, scope text NOT NULL,
  identity_id text REFERENCES identities(id) ON DELETE CASCADE,
  provider text, expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS rooms_mcp_flows_identity ON rooms_mcp_flows(identity_id);
ALTER TABLE rooms_mcp_flows ADD COLUMN IF NOT EXISTS joiner_name text;
ALTER TABLE rooms_mcp_flows ADD COLUMN IF NOT EXISTS joiner_handle text;
ALTER TABLE rooms_mcp_flows ADD COLUMN IF NOT EXISTS claude_inbound_fallback boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS rooms_mcp_flows_client ON rooms_mcp_flows(client_id);
CREATE INDEX IF NOT EXISTS rooms_mcp_flows_expiry ON rooms_mcp_flows(expires_at);
CREATE TABLE IF NOT EXISTS rooms_mcp_codes (
  hash text PRIMARY KEY, client_id text NOT NULL REFERENCES rooms_mcp_clients(id) ON DELETE CASCADE,
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL, challenge text NOT NULL, scope text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS rooms_mcp_codes_identity ON rooms_mcp_codes(identity_id);
CREATE INDEX IF NOT EXISTS rooms_mcp_codes_client ON rooms_mcp_codes(client_id);
CREATE INDEX IF NOT EXISTS rooms_mcp_codes_expiry ON rooms_mcp_codes(expires_at);
-- A headless client (a coding session on a VPS) registers this server's own handoff
-- page as its redirect: the page keeps the code for the client to collect by state.
-- The code still needs the client's PKCE verifier, so the page never grants access.
CREATE TABLE IF NOT EXISTS rooms_mcp_handoffs (
  state_hash text PRIMARY KEY, code text, error text,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS rooms_mcp_handoffs_expiry ON rooms_mcp_handoffs(expires_at);
CREATE TABLE IF NOT EXISTS rooms_mcp_tokens (
  hash text PRIMARY KEY, client_id text NOT NULL REFERENCES rooms_mcp_clients(id) ON DELETE CASCADE,
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  scope text NOT NULL, expires_at timestamptz NOT NULL,
  revoked_at timestamptz, window_at timestamptz NOT NULL DEFAULT now(), calls integer NOT NULL DEFAULT 0
);
ALTER TABLE rooms_mcp_tokens ADD COLUMN IF NOT EXISTS family_id text REFERENCES rooms_mcp_families(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS rooms_mcp_tokens_family ON rooms_mcp_tokens(family_id);
CREATE INDEX IF NOT EXISTS rooms_mcp_tokens_identity ON rooms_mcp_tokens(identity_id);
CREATE INDEX IF NOT EXISTS rooms_mcp_tokens_client ON rooms_mcp_tokens(client_id);
CREATE INDEX IF NOT EXISTS rooms_mcp_tokens_expiry ON rooms_mcp_tokens(expires_at);
CREATE TABLE IF NOT EXISTS rooms_mcp_audit (
  id bigserial PRIMARY KEY, client_id text NOT NULL, identity_id text NOT NULL,
  operation text NOT NULL, outcome text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rooms_mcp_audit_created ON rooms_mcp_audit(created_at);
CREATE TABLE IF NOT EXISTS rooms_mcp_admission (
  key text PRIMARY KEY, window_at timestamptz NOT NULL DEFAULT now(), calls integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS rooms_mcp_admission_window ON rooms_mcp_admission(window_at);

-- Event subscriptions belong to the consenting connection, not its expiring access token.
CREATE TABLE IF NOT EXISTS rooms_mcp_event_subscriptions (
  id text PRIMARY KEY,
  client_id text NOT NULL, owner_id text NOT NULL,
  member_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  url text NOT NULL, secret text NOT NULL,
  previous_secret text, rotation_until timestamptz,
  verified_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  FOREIGN KEY(client_id,owner_id) REFERENCES rooms_mcp_members(client_id,owner_id) ON DELETE CASCADE,
  FOREIGN KEY(client_id,owner_id) REFERENCES rooms_mcp_connections(client_id,identity_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS rooms_mcp_event_subscriptions_expiry ON rooms_mcp_event_subscriptions(expires_at);
CREATE INDEX IF NOT EXISTS rooms_mcp_event_subscriptions_member ON rooms_mcp_event_subscriptions(member_id);
CREATE INDEX IF NOT EXISTS rooms_mcp_event_subscriptions_connection ON rooms_mcp_event_subscriptions(client_id,owner_id);
-- Existing rows are mention subscriptions. Wake is a separate subscribable event.
ALTER TABLE rooms_mcp_event_subscriptions ADD COLUMN IF NOT EXISTS event_name text NOT NULL DEFAULT 'mention';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='rooms_mcp_event_subscriptions_event_name') THEN
    ALTER TABLE rooms_mcp_event_subscriptions ADD CONSTRAINT rooms_mcp_event_subscriptions_event_name
      CHECK (event_name IN ('mention','wake'));
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS rooms_mcp_event_deliveries (
  subscription_id text NOT NULL REFERENCES rooms_mcp_event_subscriptions(id) ON DELETE CASCADE,
  message_id text NOT NULL, room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  event_id text NOT NULL, body text NOT NULL,
  attempts integer NOT NULL DEFAULT 0, claimed_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz,
  PRIMARY KEY(subscription_id,message_id)
);
CREATE INDEX IF NOT EXISTS rooms_mcp_event_deliveries_done ON rooms_mcp_event_deliveries(delivered_at) WHERE delivered_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS rooms_mcp_event_deliveries_room ON rooms_mcp_event_deliveries(room_id);
CREATE INDEX IF NOT EXISTS rooms_mcp_event_deliveries_pending ON rooms_mcp_event_deliveries(next_attempt_at)
  WHERE delivered_at IS NULL;
-- A private wake has no message. command_id is its idempotency key; exactly one of the two is set.
ALTER TABLE rooms_mcp_event_deliveries ADD COLUMN IF NOT EXISTS command_id text;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
    WHERE c.conrelid='rooms_mcp_event_deliveries'::regclass AND c.contype='p' AND a.attname='message_id'
  ) THEN
    ALTER TABLE rooms_mcp_event_deliveries DROP CONSTRAINT rooms_mcp_event_deliveries_pkey;
  END IF;
END $$;
ALTER TABLE rooms_mcp_event_deliveries ALTER COLUMN message_id DROP NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='rooms_mcp_event_deliveries'::regclass AND contype='p'
  ) THEN
    ALTER TABLE rooms_mcp_event_deliveries ADD CONSTRAINT rooms_mcp_event_deliveries_pkey PRIMARY KEY (event_id);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS rooms_mcp_event_deliveries_message
  ON rooms_mcp_event_deliveries(subscription_id,message_id) WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS rooms_mcp_event_deliveries_command
  ON rooms_mcp_event_deliveries(subscription_id,command_id) WHERE command_id IS NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='rooms_mcp_event_deliveries_subject') THEN
    ALTER TABLE rooms_mcp_event_deliveries ADD CONSTRAINT rooms_mcp_event_deliveries_subject
      CHECK ((message_id IS NOT NULL) <> (command_id IS NOT NULL));
  END IF;
END $$;
`;
