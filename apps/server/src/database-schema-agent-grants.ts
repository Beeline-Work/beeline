import { SERVICE_REVIEW_READ_SCHEMA } from './service-review.js';
export const DATABASE_SCHEMA_AGENT_GRANTS = `CREATE INDEX IF NOT EXISTS agent_pending_attachments_room_idx ON agent_pending_attachments(room_id);

-- Agent Grants (slice 2): the grant store. One row per ask; a 'once' grant is
-- spent by setting expires_at at its first run; revoke flips status.
CREATE TABLE IF NOT EXISTS agent_grants (
  id uuid PRIMARY KEY,
  agent_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('path','host','secret','device','budget','command','mcp','repository','shared_asset')),
  target text NOT NULL,
  reason text NOT NULL,
  requested_by text NOT NULL REFERENCES identities(id),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending','approved','once','denied','revoked')),
  decided_by text REFERENCES identities(id),
  decided_at timestamptz,
  expires_at timestamptz,
  auto boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- C94: an interpreter command grant is bound to the script the card showed.
ALTER TABLE agent_grants ADD COLUMN IF NOT EXISTS script jsonb;
ALTER TABLE agent_grants ADD COLUMN IF NOT EXISTS superseded_at timestamptz;
ALTER TABLE agent_grants ADD COLUMN IF NOT EXISTS purpose text;
ALTER TABLE agent_grants ADD COLUMN IF NOT EXISTS touches text;
ALTER TABLE agent_grants ADD COLUMN IF NOT EXISTS capabilities text;
-- Replacing an unchanged check locks this hot table on every release.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='agent_grants'::regclass
      AND conname='agent_grants_kind_check' AND pg_get_constraintdef(oid) LIKE '%shared_asset%') THEN
    ALTER TABLE agent_grants DROP CONSTRAINT IF EXISTS agent_grants_kind_check;
    ALTER TABLE agent_grants ADD CONSTRAINT agent_grants_kind_check
      CHECK (kind IN ('path','host','secret','device','budget','command','mcp','repository','shared_asset')) NOT VALID;
  END IF;
END $$;
ALTER TABLE agent_grants VALIDATE CONSTRAINT agent_grants_kind_check;
CREATE INDEX IF NOT EXISTS agent_grants_agent_idx ON agent_grants(agent_id, workspace_id, status);
CREATE INDEX IF NOT EXISTS agent_grants_room_idx ON agent_grants(room_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_grants_pending_idx ON agent_grants(workspace_id)
  WHERE status='pending';
CREATE UNIQUE INDEX IF NOT EXISTS agent_grants_shared_asset_one_live_idx
  ON agent_grants(agent_id,target)
  WHERE kind='shared_asset' AND status IN ('pending','approved');

-- Immutable evidence for the requester-aware policy upgrade. This deliberately
-- has no foreign keys: deleting a Workspace or agent must not erase what the
-- release revoked. previous_status is NULL when the already-run production
-- migration destroyed information that cannot be reconstructed safely.
CREATE TABLE IF NOT EXISTS agent_grant_policy_revocations (
  grant_id uuid PRIMARY KEY,
  agent_id text NOT NULL,
  workspace_id uuid NOT NULL,
  room_id uuid NOT NULL,
  owner_id text NOT NULL,
  command_id text,
  kind text NOT NULL,
  target text NOT NULL,
  requested_by text NOT NULL,
  previous_status text CHECK (previous_status IS NULL OR previous_status IN ('pending','approved','once')),
  reason text NOT NULL CHECK (reason IN (
    'budget-retired','missing-requester-provenance','third-party-auto-resource',
    'non-owner-resource-decision'
  )),
  recovered boolean NOT NULL DEFAULT false,
  turn_disposition text CHECK (turn_disposition IS NULL OR turn_disposition IN (
    'resumed','cancelled','not-active','unrecoverable'
  )),
  revoked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_grant_policy_revocations_owner_idx
  ON agent_grant_policy_revocations(owner_id, revoked_at DESC);

-- Preference cards: one lettered question or Room poll per row. Electorate is
-- frozen at insert so a join/leave cannot move the denominator. Votes live in
-- room_choice_votes; the card JSON on messages is the phone projection.
CREATE TABLE IF NOT EXISTS room_choices (
  id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('question','poll')),
  prompt text NOT NULL,
  constraint_text text,
  options jsonb NOT NULL,
  electorate text[] NOT NULL,
  closes_at timestamptz,
  status text NOT NULL CHECK (status IN ('open','answered','skipped','closed','retracted')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE room_choices ADD COLUMN IF NOT EXISTS workflow_run_id text;
-- Existing gate cards already carry the run id on their message.
UPDATE room_choices choice SET workflow_run_id=message.card->>'runId'
  FROM messages message WHERE message.id=choice.message_id AND choice.status='open'
    AND choice.workflow_run_id IS NULL AND message.card->>'runId' IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS room_choices_open_ordinary_agent_room
  ON room_choices(agent_id, room_id) WHERE status='open' AND workflow_run_id IS NULL;
DROP INDEX IF EXISTS room_choices_open_agent_room;
CREATE INDEX IF NOT EXISTS room_choices_due_idx
  ON room_choices(closes_at) WHERE status='open' AND closes_at IS NOT NULL;
-- room_id/workspace_id/message_id all cascade from rooms/workspaces/messages
-- with no index, so deleting any of those made Postgres sequentially scan
-- this table to find rows to cascade-delete.
CREATE INDEX IF NOT EXISTS room_choices_room_idx ON room_choices(room_id);
CREATE INDEX IF NOT EXISTS room_choices_workspace_idx ON room_choices(workspace_id);
CREATE INDEX IF NOT EXISTS room_choices_message_idx ON room_choices(message_id);
CREATE TABLE IF NOT EXISTS room_choice_votes (
  choice_id uuid NOT NULL REFERENCES room_choices(id) ON DELETE CASCADE,
  voter_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  option_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (choice_id, voter_id)
);
-- A workflow gate answer's optional note, delivered to the woken agent.
ALTER TABLE room_choice_votes ADD COLUMN IF NOT EXISTS note text;

-- Retired: empty in production on 2026-11-02 and written by nothing on main.

-- Workbench: per-human connector provisioning. One row per (Workspace,
-- owner, connector type, machine): a connection belongs to whoever
-- provisioned it, so sovereignty is this row's owner_identity_id,
-- re-checked on every read. One machine = one connector.
CREATE TABLE IF NOT EXISTS workspace_connectors (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  connector_type text NOT NULL,
  helper_agent_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  machine_id text,
  status text NOT NULL DEFAULT 'installing'
    CHECK (status IN ('installing','connected','error','disconnected')),
  status_steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  status_error text,
  -- Edge-triggered work tokens for the helper ('sync','revoke-grants:<ref>').
  pending_ops jsonb NOT NULL DEFAULT '[]'::jsonb,
  pairing_generation integer NOT NULL DEFAULT 1,
  connected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- The helper's incremental install report: the sign-in surface it printed
-- (the app opens exactly that URL), the installed trusty-squire version, and
-- the account it is signed in as, once the human completes it.
ALTER TABLE workspace_connectors ADD COLUMN IF NOT EXISTS machine_id text;
ALTER TABLE workspace_connectors ADD COLUMN IF NOT EXISTS sign_in jsonb;
ALTER TABLE workspace_connectors ADD COLUMN IF NOT EXISTS squire_version text;
ALTER TABLE workspace_connectors ADD COLUMN IF NOT EXISTS signed_in_as text;
ALTER TABLE workspace_connectors ADD COLUMN IF NOT EXISTS pairing_generation integer NOT NULL DEFAULT 1;
-- Retire helper-installed Composio connectors from the older integration.
-- The new managed OAuth route is server-owned in workspace_apps; these helper
-- rows could otherwise be sent as unknown install assignments. Their old
-- synthetic connections cascade with the connector.
DELETE FROM workspace_connectors WHERE connector_type='composio';
ALTER TABLE workspace_connectors ADD COLUMN IF NOT EXISTS registry_server_name text;
ALTER TABLE workspace_connectors ADD COLUMN IF NOT EXISTS registry_version text;
ALTER TABLE workspace_connectors ADD COLUMN IF NOT EXISTS registry_manifest jsonb;
ALTER TABLE workspace_connectors ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE workspace_connectors ADD COLUMN IF NOT EXISTS website_url text;
ALTER TABLE workspace_connectors ADD COLUMN IF NOT EXISTS install_agent_id text REFERENCES identities(id) ON DELETE SET NULL;
ALTER TABLE workspace_connectors ADD COLUMN IF NOT EXISTS install_room_id uuid REFERENCES rooms(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS workspace_connectors_install_room_idx
  ON workspace_connectors(install_room_id) WHERE install_room_id IS NOT NULL;
-- agent_commands is installed immediately after this base schema and its
-- ids are text, so this provenance pointer deliberately follows the existing
-- grant command pointer instead of introducing an early cross-schema FK.
ALTER TABLE workspace_connectors ADD COLUMN IF NOT EXISTS install_command_id text;
ALTER TABLE workspace_connectors ADD COLUMN IF NOT EXISTS registry_handoff_attempt text;
ALTER TABLE workspace_connectors ADD COLUMN IF NOT EXISTS registry_squire_relayed_attempt text;
-- Set only by a Squire login-wall reconnect (DaemonService.squireLoginWall):
-- the exact provider Squire's next connect run must force through
-- --force-relogin=provider, pushing its shared-browser session through the
-- ceremony instead of the ordinary already-connected skip. Cleared on every
-- ordinary re-pair (armConnectorPairing) and on a completed install
-- (installConnector), so it never outlives one run.
ALTER TABLE workspace_connectors ADD COLUMN IF NOT EXISTS force_relogin_provider text;

-- Hosted Link wallet grants belong to a human. Neither agents nor helpers see OAuth tokens.
CREATE TABLE IF NOT EXISTS link_oauth_accounts (
  owner_identity_id text PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
  state text UNIQUE,
  code_verifier text,
  attempt_expires_at timestamptz,
  sealed_grant text,
  granted_scopes text[] NOT NULL DEFAULT '{}',
  ineligible boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS link_spend_requests (
  id text PRIMARY KEY,
  owner_identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  merchant text NOT NULL,
  amount bigint NOT NULL,
  description text NOT NULL,
  test boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS link_spend_requests_room_idx ON link_spend_requests(room_id);
CREATE TABLE IF NOT EXISTS registry_mcp_oauth_attempts (
  state text PRIMARY KEY,
  connector_id uuid NOT NULL REFERENCES workspace_connectors(id) ON DELETE CASCADE,
  code text,
  expires_at timestamptz NOT NULL
);

-- Per-machine unique: one connector per (workspace, owner, type, machine).
-- NULL machine_id (legacy agents before this migration) are each their own
-- machine; PostgreSQL treats NULL as distinct in unique indexes.
-- Both DROPs name indexes nothing here creates, so each is a one-time
-- conversion and every later migrate() leaves the live index in place. A
-- drop-and-recreate under the SAME name would reopen a window on every
-- release in which an ON CONFLICT upsert can infer no arbiter index.
DROP INDEX IF EXISTS workspace_connectors_owner_unique;
DROP INDEX IF EXISTS workspace_connectors_machine_unique;
CREATE UNIQUE INDEX IF NOT EXISTS workspace_connectors_fixed_machine_unique
  ON workspace_connectors(workspace_id, owner_identity_id, connector_type, machine_id)
  WHERE connector_type <> 'registry-mcp';
CREATE UNIQUE INDEX IF NOT EXISTS workspace_connectors_registry_machine_unique
  ON workspace_connectors(workspace_id, owner_identity_id, machine_id, registry_server_name)
  WHERE connector_type = 'registry-mcp';
CREATE INDEX IF NOT EXISTS workspace_connectors_helper_idx
  ON workspace_connectors(helper_agent_id);

-- One vault entry a helper sync reported. Secrets never leave the
-- provider: only metadata and the opaque reference are stored.
-- connection_metadata carries { fieldNames, vaultCreatedAt }.
CREATE TABLE IF NOT EXISTS workspace_connections (
  id uuid PRIMARY KEY,
  connector_id uuid NOT NULL REFERENCES workspace_connectors(id) ON DELETE CASCADE,
  owner_identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  reference text NOT NULL,
  service text NOT NULL DEFAULT '',
  label text,
  hosts jsonb NOT NULL DEFAULT '[]'::jsonb,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','error')),
  connection_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  grants jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connector_id, reference)
);
CREATE INDEX IF NOT EXISTS workspace_connections_owner_idx
  ON workspace_connections(owner_identity_id, connector_id);
ALTER TABLE workspace_connections ALTER COLUMN connector_id DROP NOT NULL;
ALTER TABLE workspace_connections ADD COLUMN IF NOT EXISTS machine_id text;
ALTER TABLE workspace_connections ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS workspace_connections_workspace_idx ON workspace_connections(workspace_id);

-- R5: an agent's offer to add one connector, made from a Room at the moment
-- of need. The addressee is the person whose message woke the offering turn
-- (whose keys the tool will hold); they or a Workspace manager accept it.
-- Accepting starts the connector on the offering agent's machine through the
-- same row pairConnector writes. Adapted kinds (Squire, YouTube) also require
-- the acceptor to own that helper; a foreign Workbench row cannot inherit
-- that machine's vault. The helper's connected report settles the Room card
-- and resumes the paused turn.
CREATE TABLE IF NOT EXISTS connector_offers (
  id uuid PRIMARY KEY,
  agent_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  addressee_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  connector_type text NOT NULL,
  reason text NOT NULL,
  machine_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','connecting','accepted','denied','failed')),
  message_id text REFERENCES messages(id) ON DELETE SET NULL,
  command_id text,
  accepted_by text REFERENCES identities(id),
  accepted_at timestamptz,
  connector_id uuid REFERENCES workspace_connectors(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS connector_offers_room_idx
  ON connector_offers(room_id, connector_type, status, created_at DESC);
-- 'add' (the only kind before this column existed) asks "shall this
-- Workspace gain tool X?", decided by a tap. 'reconnect' (squire-login-wall
-- handoff) is written straight to 'connecting' with no decision to make: an
-- already-connected connector's own live session went stale mid-task, and
-- provider names which one (e.g. 'google'). 'switch' asks to replace the
-- account an already-connected Trusty Squire is bound to; accepting re-arms
-- that connector with force_relogin_provider=provider.
ALTER TABLE connector_offers ADD COLUMN IF NOT EXISTS intent text NOT NULL DEFAULT 'add';
ALTER TABLE connector_offers DROP CONSTRAINT IF EXISTS connector_offers_intent_check;
ALTER TABLE connector_offers ADD CONSTRAINT connector_offers_intent_check
  CHECK (intent IN ('add','reconnect','switch'));
ALTER TABLE connector_offers ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE connector_offers DROP CONSTRAINT IF EXISTS connector_offers_status_check;
ALTER TABLE connector_offers ADD CONSTRAINT connector_offers_status_check
  CHECK (status IN ('pending','connecting','accepted','denied','failed'));
DROP INDEX IF EXISTS connector_offers_open_idx;
CREATE UNIQUE INDEX connector_offers_open_idx
  ON connector_offers(room_id, connector_type) WHERE status IN ('pending','connecting');
-- workspace_id/message_id cascade (resp. SET NULL) from workspaces/messages
-- with no index, so deleting a workspace or a message made Postgres
-- sequentially scan this table to find matching rows.
CREATE INDEX IF NOT EXISTS connector_offers_workspace_idx ON connector_offers(workspace_id);
CREATE INDEX IF NOT EXISTS connector_offers_message_idx
  ON connector_offers(message_id) WHERE message_id IS NOT NULL;

-- Existing failed cards must lead to the current card instead of a dead Retry.
UPDATE messages message SET card=jsonb_set(message.card,'{replacementMessageId}',to_jsonb(current_offer.message_id))
FROM connector_offers failed JOIN connector_offers current_offer
  ON current_offer.room_id=failed.room_id AND current_offer.connector_type=failed.connector_type
    AND current_offer.status IN ('pending','connecting') AND current_offer.created_at>failed.created_at
WHERE failed.status='failed' AND current_offer.message_id IS NOT NULL AND message.room_id=failed.room_id
  AND message.card_type='connector-offer' AND message.card->>'offerId'=failed.id::text
  AND message.card->>'replacementMessageId' IS DISTINCT FROM current_offer.message_id;

-- What an agent did with a connection, as reported by the helper. The ledger
-- behind the connection detail screen; also the source for batched receipt
-- DMs (one card per agent turn, keyed by turn_key).
CREATE TABLE IF NOT EXISTS connection_receipts (
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES workspace_connections(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  agent_id text REFERENCES identities(id) ON DELETE SET NULL,
  operation text NOT NULL,
  status_code integer,
  bytes bigint NOT NULL DEFAULT 0,
  grant_info text,
  turn_key text,
  message_id text,
  event_class text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS connection_receipts_connection_idx
  ON connection_receipts(connection_id, created_at DESC);
CREATE INDEX IF NOT EXISTS connection_receipts_turn_idx
  ON connection_receipts(connection_id, turn_key) WHERE turn_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS connection_receipts_workspace_idx ON connection_receipts(workspace_id);
ALTER TABLE connection_receipts ADD COLUMN IF NOT EXISTS event_class text;

-- Apps: the one front door (\`app-connections.ts\`). ONE row per app per
-- person, served by an existing Workbench connection, managed OAuth, or
-- Trusty Squire. Route decisions and authorized uses have separate ledgers.
CREATE TABLE IF NOT EXISTS workspace_apps (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  app_key text NOT NULL,
  display_name text NOT NULL,
  domain text,
  transport text NOT NULL
    CHECK (transport IN ('registry-mcp','composio','squire-api','squire-browser')),
  route text NOT NULL
    CHECK (route IN ('workbench','registry-mcp','composio','squire-api','squire-browser')),
  connector_id uuid REFERENCES workspace_connectors(id) ON DELETE SET NULL,
  composio_account_id text,
  composio_link_expires_at timestamptz,
  sign_in_error text,
  machine_id text,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','disconnected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- The Workbench is the person's across Workspaces: one app, one row, one
  -- permission decision. workspace_id is where its route was last chosen.
  UNIQUE (owner_identity_id, app_key)
);
ALTER TABLE workspace_apps ADD COLUMN IF NOT EXISTS composio_account_id text;
ALTER TABLE workspace_apps ADD COLUMN IF NOT EXISTS composio_link_expires_at timestamptz;
ALTER TABLE workspace_apps ADD COLUMN IF NOT EXISTS sign_in_error text;
ALTER TABLE workspace_apps ADD COLUMN IF NOT EXISTS authorised_at timestamptz;
ALTER TABLE workspace_apps DROP CONSTRAINT IF EXISTS workspace_apps_transport_check;
ALTER TABLE workspace_apps ADD CONSTRAINT workspace_apps_transport_check
  CHECK (transport IN ('registry-mcp','composio','squire-api','squire-browser'));
ALTER TABLE workspace_apps DROP CONSTRAINT IF EXISTS workspace_apps_route_check;
ALTER TABLE workspace_apps ADD CONSTRAINT workspace_apps_route_check
  CHECK (route IN ('workbench','registry-mcp','composio','squire-api','squire-browser'));
CREATE INDEX IF NOT EXISTS workspace_apps_connector_idx ON workspace_apps(connector_id);
CREATE INDEX IF NOT EXISTS workspace_apps_workspace_idx ON workspace_apps(workspace_id);
-- Retire the reported pending Link fallback; real vaulted connections are preserved.
UPDATE workspace_apps app SET state='disconnected',updated_at=now()
WHERE app.id='c3dc5902-2009-45b3-96cb-a69ccf7a322a'::uuid
  AND app.app_key='stripelinklinkcom' AND app.transport='squire-api' AND app.state='active'
  AND NOT EXISTS (SELECT 1 FROM workspace_connections connection
    WHERE connection.owner_identity_id=app.owner_identity_id
      AND connection.service='stripelinklinkcom' AND connection.state='active');
ALTER TABLE agent_grants ADD COLUMN IF NOT EXISTS app_id uuid REFERENCES workspace_apps(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS agent_grants_app_idx ON agent_grants(app_id,agent_id,status);
CREATE TABLE IF NOT EXISTS workspace_app_routes (
  id uuid PRIMARY KEY,
  app_id uuid NOT NULL REFERENCES workspace_apps(id) ON DELETE CASCADE,
  route text NOT NULL,
  transport text NOT NULL,
  reason text NOT NULL,
  requested_by text REFERENCES identities(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workspace_app_routes_app_idx
  ON workspace_app_routes(app_id, created_at DESC);
CREATE TABLE IF NOT EXISTS workspace_app_usage (
  id uuid PRIMARY KEY,
  app_id uuid NOT NULL REFERENCES workspace_apps(id) ON DELETE CASCADE,
  agent_id text REFERENCES identities(id) ON DELETE SET NULL,
  room_id uuid REFERENCES rooms(id) ON DELETE SET NULL,
  requester_id text,
  transport text NOT NULL,
  operation text NOT NULL,
  grant_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workspace_app_usage_app_idx
  ON workspace_app_usage(app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS workspace_app_usage_room_idx
  ON workspace_app_usage(room_id) WHERE room_id IS NOT NULL;

-- Wallet connector: the binding row (this account owns that wallet), never a
-- secret. The one app-wide Coinbase credential lives in server secrets, and
-- cdp_user_id holds the deterministic CDP account name (server-wallet model, not
-- an end-user id). The name is stable per identity so recreate is idempotent.
CREATE TABLE IF NOT EXISTS wallet_bindings (
  identity_id text PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  cdp_user_id text NOT NULL,
  eoa_address text NOT NULL,
  solana_address text,
  -- NULL expiry means either never granted or standing; the separate flag
  -- distinguishes them. Legacy time-limited grants keep their timestamps.
  delegation_expires_at timestamptz,
  delegation_standing boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wallet_bindings_workspace_idx ON wallet_bindings(workspace_id);

-- One wallet transaction, in AND out, as the @wallet ledger wrote it. The
-- balance_after_usd is what the line left behind; agent_id names the agent
-- that spent on outbound lines. tx identity is unique per wallet so an
-- inbound reconciliation never double-writes a deposit.
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id uuid PRIMARY KEY,
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  tx_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('in','out')),
  asset text NOT NULL,
  amount text NOT NULL,
  counterparty text NOT NULL,
  chain text NOT NULL,
  balance_after_usd text NOT NULL,
  agent_id text REFERENCES identities(id) ON DELETE SET NULL,
  tx_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (identity_id, tx_id)
);
CREATE INDEX IF NOT EXISTS wallet_transactions_wallet_idx
  ON wallet_transactions(identity_id, created_at DESC);
-- The last balance seen per (chain, asset). CDP v2 has no address history,
-- so an increase over this snapshot is recorded as an inbound transfer.
CREATE TABLE IF NOT EXISTS wallet_balance_snapshots (
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  chain text NOT NULL,
  asset text NOT NULL,
  amount text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (identity_id, chain, asset)
);

CREATE TABLE IF NOT EXISTS operation_outcomes_hourly (
  hour timestamptz NOT NULL,
  op text NOT NULL,
  status int NOT NULL,
  code text NOT NULL,
  release text NOT NULL,
  count bigint NOT NULL,
  PRIMARY KEY (hour,op,status,code,release)
);

-- The Beeline feedback loop (apps/server/src/feedback.ts). An agent's
-- report_feedback call and a person's @system tag or Report issue action land
-- here. The saved feedback-triage workflow reads this table through a
-- read-only grant, and notify_feedback_fixed resolves items once a fix merges.
-- Message ids only, plus the text of a person's own @system report. The
-- issue_* columns are retired GitHub-filing state, kept for rolling-update
-- compatibility.
CREATE TABLE IF NOT EXISTS feedback_items (
  id text PRIMARY KEY,
  source_kind text NOT NULL CHECK (source_kind IN ('agent','human')),
  reporter_identity_id text NOT NULL,
  reporter_owner_id text,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  room_id uuid REFERENCES rooms(id) ON DELETE CASCADE,
  trigger_message_id text,
  message_ids text[] NOT NULL DEFAULT '{}',
  request_id text,
  category text NOT NULL CHECK (category IN
    ('simpler_path','contradiction','tooling_gap','context_gap','bug','human_report')),
  summary text NOT NULL,
  summary_key text NOT NULL,
  detail text,
  tool_name text,
  error_excerpt text,
  prompt_section_ids text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'new' CHECK (status IN
    ('new','filed','attached','dismissed','resolved','closed')),
  issue_repository text,
  issue_number integer,
  triage_reason text,
  resolved_notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  triaged_at timestamptz
);
ALTER TABLE feedback_items ADD COLUMN IF NOT EXISTS occurrence_count integer NOT NULL DEFAULT 1
  CHECK (occurrence_count > 0);
ALTER TABLE feedback_items ADD COLUMN IF NOT EXISTS occurrences jsonb NOT NULL DEFAULT '[]';
ALTER TABLE feedback_items ADD COLUMN IF NOT EXISTS last_occurrence_at timestamptz;
-- Versions in use when the report was filed. Null means the server did not
-- know that fact; existing rows stay null. Triage compares them to the
-- delivered release when it reads, so these columns are not a latest flag.
ALTER TABLE feedback_items ADD COLUMN IF NOT EXISTS helper_version text;
ALTER TABLE feedback_items ADD COLUMN IF NOT EXISTS app_version text;
ALTER TABLE feedback_items ADD COLUMN IF NOT EXISTS app_platform text;
ALTER TABLE feedback_items ADD COLUMN IF NOT EXISTS harness text;
ALTER TABLE feedback_items ADD COLUMN IF NOT EXISTS harness_version text;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='beeline_feedback_reader') THEN
    GRANT SELECT ON helper_release_notifications TO beeline_feedback_reader;
  END IF;
END $$;
-- One human report per message, whether it came from a tag or the action.
CREATE UNIQUE INDEX IF NOT EXISTS feedback_items_human_message_idx
  ON feedback_items(trigger_message_id) WHERE source_kind='human';
CREATE INDEX IF NOT EXISTS feedback_items_status_idx ON feedback_items(status, created_at);
CREATE INDEX IF NOT EXISTS feedback_items_reporter_idx
  ON feedback_items(reporter_identity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_items_issue_idx
  ON feedback_items(issue_repository, issue_number) WHERE issue_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS feedback_items_workspace_idx ON feedback_items(workspace_id);
CREATE INDEX IF NOT EXISTS feedback_items_room_idx ON feedback_items(room_id) WHERE room_id IS NOT NULL;
-- Retired: empty in production on 2026-11-02 and written by nothing on main.

-- First-party Google Workspace consent is retired. Existing sealed grants
-- cannot be moved to a different OAuth client, so disconnect the old rows and
-- require a fresh managed sign-in through Connect an app. Remove pending offer
-- cards with their obsolete action and revoke grants. Keep the legacy token
-- tables through this release so an older server image remains compatible
-- during a rolling update; a later-release migration can drop them.
UPDATE agent_grants SET status='revoked',decided_at=now()
  WHERE kind='mcp' AND target LIKE 'google-%'
    AND status IN ('pending','approved','once');
UPDATE agent_grants g SET status='revoked',decided_at=now()
  FROM workspace_apps app JOIN workspace_connectors connector ON connector.id=app.connector_id
  WHERE g.app_id=app.id AND connector.connector_type IN
    ('google-gmail','google-calendar','google-drive','google-youtube')
    AND g.status IN ('pending','approved','once');
DELETE FROM messages WHERE card_type='connector-offer'
  AND card->>'connectorType' IN ('google-gmail','google-calendar','google-drive','google-youtube');
DELETE FROM connector_offers
  WHERE connector_type IN ('google-gmail','google-calendar','google-drive','google-youtube');
UPDATE workspace_apps SET state='disconnected',updated_at=now()
  WHERE connector_id IN (SELECT id FROM workspace_connectors
    WHERE connector_type IN ('google-gmail','google-calendar','google-drive','google-youtube'));
DELETE FROM workspace_connectors
  WHERE connector_type IN ('google-gmail','google-calendar','google-drive','google-youtube');
-- Preserve vault metadata and receipts before removing legacy Squire rows.
DO $$ BEGIN
IF EXISTS (SELECT 1 FROM workspace_connectors WHERE connector_type='trusty-squire') THEN
UPDATE workspace_connections c SET machine_id=COALESCE(k.machine_id,k.helper_agent_id),
  workspace_id=k.workspace_id
FROM workspace_connectors k WHERE c.connector_id=k.id AND k.connector_type='trusty-squire';
WITH ranked AS (
  SELECT id,first_value(id) OVER (
    PARTITION BY owner_identity_id,machine_id,reference ORDER BY updated_at DESC,id
  ) keeper FROM workspace_connections WHERE machine_id IS NOT NULL
)
UPDATE connection_receipts receipt SET connection_id=ranked.keeper
FROM ranked WHERE receipt.connection_id=ranked.id AND ranked.id<>ranked.keeper;
WITH merged AS (
  SELECT owner_identity_id,machine_id,reference,jsonb_agg(DISTINCT grant_row) grants
  FROM workspace_connections c CROSS JOIN LATERAL jsonb_array_elements(c.grants) grant_row
  WHERE machine_id IS NOT NULL GROUP BY owner_identity_id,machine_id,reference
)
UPDATE workspace_connections c SET grants=merged.grants FROM merged
WHERE c.owner_identity_id=merged.owner_identity_id AND c.machine_id=merged.machine_id
  AND c.reference=merged.reference;
DELETE FROM workspace_connections c USING workspace_connections newer
WHERE c.machine_id IS NOT NULL AND c.owner_identity_id=newer.owner_identity_id
  AND c.machine_id=newer.machine_id AND c.reference=newer.reference
  AND (c.updated_at,c.id)<(newer.updated_at,newer.id);
UPDATE workspace_connections SET connector_id=NULL WHERE machine_id IS NOT NULL;
-- Preserve every known successful route, including unused legacy connections.
UPDATE workspace_apps a SET authorised_at=a.created_at WHERE a.authorised_at IS NULL AND (
  (a.transport='composio' AND a.composio_account_id IS NOT NULL
    AND a.composio_link_expires_at IS NULL AND a.sign_in_error IS NULL)
  OR EXISTS(SELECT 1 FROM workspace_connectors c WHERE c.id=a.connector_id AND c.connected_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM workspace_app_usage u WHERE u.app_id=a.id)
  OR EXISTS(SELECT 1 FROM messages m WHERE m.card_type='app-sign-in'
    AND m.card->>'appId'=a.id::text AND m.card->>'status'='connected')
);

UPDATE workspace_apps app SET machine_id=COALESCE(k.machine_id,k.helper_agent_id)
FROM workspace_connectors k WHERE app.connector_id=k.id AND k.connector_type='trusty-squire';
UPDATE messages m SET card=jsonb_set(card,'{connectorId}',to_jsonb('squire:' || COALESCE(k.machine_id,k.helper_agent_id)))
FROM connector_offers offer JOIN workspace_connectors k ON k.id=offer.connector_id
WHERE m.card_type='connector-offer' AND m.card->>'offerId'=offer.id::text AND k.connector_type='trusty-squire';
END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS workspace_connections_machine_reference_unique
  ON workspace_connections(owner_identity_id,machine_id,reference) WHERE machine_id IS NOT NULL;
DELETE FROM workspace_connectors WHERE connector_type='trusty-squire';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workspace_connectors_no_squire') THEN
    ALTER TABLE workspace_connectors ADD CONSTRAINT workspace_connectors_no_squire
      CHECK (connector_type<>'trusty-squire') NOT VALID;
  END IF;
END $$;
ALTER TABLE workspace_connectors VALIDATE CONSTRAINT workspace_connectors_no_squire;

${SERVICE_REVIEW_READ_SCHEMA}
`;
