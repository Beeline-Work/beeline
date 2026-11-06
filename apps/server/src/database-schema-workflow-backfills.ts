import { VOICE_SCHEMA } from './voice-schema.js';
import { messageSearchDocumentSql } from './message-search-document-sql.js';
export const DATABASE_SCHEMA_WORKFLOW_BACKFILLS = `
CREATE TABLE IF NOT EXISTS workflow_backfills (
  name text PRIMARY KEY,
  completed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS identities (
  id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL CHECK (kind IN ('human', 'agent')),
  name text NOT NULL,
  handle text,
  avatar text,
  hidden_from_roster boolean NOT NULL DEFAULT false,
  push_level text NOT NULL DEFAULT 'attention' CHECK(push_level IN ('off','attention','full')),
  github_subject text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE identities ADD COLUMN IF NOT EXISTS hidden_from_roster boolean NOT NULL DEFAULT false;
ALTER TABLE identities ADD COLUMN IF NOT EXISTS face_id text NULL;
DROP TRIGGER IF EXISTS beeline_agent_schedule_due ON identities;
-- Null excludes every identity present at rollout. New humans inherit true;
-- completion changes it to false and follows the account across devices.
ALTER TABLE identities ADD COLUMN IF NOT EXISTS welcome_cards_due boolean;
ALTER TABLE identities ALTER COLUMN welcome_cards_due SET DEFAULT true;
ALTER TABLE identities ADD COLUMN IF NOT EXISTS speaking_speed double precision NOT NULL DEFAULT 1.15 CHECK (speaking_speed IN (1.15,1.3,1.5));
ALTER TABLE identities ADD COLUMN IF NOT EXISTS push_level text NOT NULL DEFAULT 'attention';
ALTER TABLE identities DROP CONSTRAINT IF EXISTS identities_push_level_check;
-- Record user counts (excluding hidden system identities) and convert once.
CREATE TABLE IF NOT EXISTS push_level_migration_counts (
  old_level text PRIMARY KEY,
  user_count bigint NOT NULL
);
DO $push_tiers$ BEGIN
  LOCK TABLE identities IN SHARE ROW EXCLUSIVE MODE;
  IF NOT EXISTS (SELECT 1 FROM workflow_backfills WHERE name='push-tiers-attention-full') THEN
    INSERT INTO push_level_migration_counts(old_level,user_count)
      SELECT tier, count(person.id) FROM (VALUES ('off'),('direct'),('mine'),('all')) tiers(tier)
      LEFT JOIN identities person ON person.push_level=tier AND person.kind='human'
        AND NOT person.hidden_from_roster
      GROUP BY tier;
    UPDATE identities SET push_level=CASE push_level
      WHEN 'direct' THEN 'attention' WHEN 'mine' THEN 'attention' WHEN 'all' THEN 'full'
      ELSE push_level END
      WHERE push_level IN ('direct','mine','all');
    INSERT INTO workflow_backfills(name) VALUES('push-tiers-attention-full');
  END IF;
END $push_tiers$;
ALTER TABLE identities ALTER COLUMN push_level SET DEFAULT 'attention';
DO $$ BEGIN
  ALTER TABLE identities ADD CONSTRAINT identities_push_level_check
    CHECK(push_level IN ('off','attention','full')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE identities VALIDATE CONSTRAINT identities_push_level_check;

CREATE TABLE IF NOT EXISTS identity_external_links (
  provider text NOT NULL,
  subject text NOT NULL,
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  issuer text NOT NULL,
  audience text NOT NULL,
  provider_login text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject)
);
ALTER TABLE identity_external_links ADD COLUMN IF NOT EXISTS provider_login text;
UPDATE identity_external_links AS link SET provider_login=identity.handle
FROM identities AS identity
WHERE link.provider='github' AND link.identity_id=identity.id
  AND link.provider_login IS NULL AND identity.handle IS NOT NULL;
CREATE INDEX IF NOT EXISTS identity_external_links_identity_idx ON identity_external_links(identity_id);
UPDATE identity_external_links SET audience='github'
WHERE provider='github' AND audience<>'github';

CREATE TABLE IF NOT EXISTS identity_successions (
  old_identity_id text PRIMARY KEY REFERENCES identities(id),
  new_identity_id text NOT NULL REFERENCES identities(id),
  provider text NOT NULL,
  subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS identity_successions_new_idx ON identity_successions(new_identity_id);

CREATE TABLE IF NOT EXISTS phone_sessions (
  refresh_hash text PRIMARY KEY CHECK (refresh_hash ~ '^[0-9a-f]{64}$'),
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  family_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  successor_tokens text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE phone_sessions ADD COLUMN IF NOT EXISTS successor_tokens text;
CREATE INDEX IF NOT EXISTS phone_sessions_identity_idx ON phone_sessions(identity_id, expires_at);

CREATE TABLE IF NOT EXISTS phone_access_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  family_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS phone_access_tokens_expiry_idx ON phone_access_tokens(expires_at);
-- The device session that called reportRunningUpdate. A later report on that
-- same sign-in family uses this installation only. Another family, including
-- a browser that never reports an update, has no row.
CREATE TABLE IF NOT EXISTS phone_update_devices (
  family_id uuid PRIMARY KEY,
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  reported_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS daemon_token_exchanges (
  exchange_hash text PRIMARY KEY CHECK (exchange_hash ~ '^[0-9a-f]{64}$'),
  agent_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS daemon_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  agent_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS daemon_tokens_agent_idx ON daemon_tokens(agent_id);

-- Forward recovery of an imported helper identity; token history permanently closes this seam.
CREATE TABLE IF NOT EXISTS legacy_daemon_migrations (
  agent_id text PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
  proof_id text NOT NULL,
  exchange_hash text NOT NULL,
  workspace_id uuid NOT NULL,
  owner_id text NOT NULL,
  migrated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  about text,
  avatar text,
  visibility text NOT NULL DEFAULT 'invite-only' CHECK (visibility IN ('public', 'invite-only')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS allow_fix_sweep boolean NOT NULL DEFAULT true;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS internal boolean NOT NULL DEFAULT false;
-- Confirmed fixtures and the operator team's Workspace (verified by its Room ID).
-- Classification is persisted; readers never infer it from names or membership.
UPDATE workspaces SET internal=true WHERE NOT internal AND id IN (
  'bee11e00-0000-4000-8000-000000000105',
  'c2e54c45-cf58-4cc1-a620-89b196096e7b',
  'b81a2815-924c-4bd9-bc04-d38bdee177bc',
  '18e555f7-e191-452b-9b0f-b825f58ee4ba'
);

-- Retired: empty in production on 2026-11-02 and written by nothing on main.
CREATE TABLE IF NOT EXISTS service_review_visits (
  agent_id text,
  run_id text,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  visited_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,visited_at)
);

ALTER TABLE service_review_visits ADD COLUMN IF NOT EXISTS agent_id text;
ALTER TABLE service_review_visits ADD COLUMN IF NOT EXISTS run_id text;
ALTER TABLE service_review_visits ADD COLUMN IF NOT EXISTS read_from timestamptz;
ALTER TABLE service_review_visits ADD COLUMN IF NOT EXISTS read_through timestamptz;
ALTER TABLE service_review_visits ADD COLUMN IF NOT EXISTS receipt jsonb;
ALTER TABLE service_review_visits ADD COLUMN IF NOT EXISTS completed_at timestamptz;

-- Retained for serving/rollback compatibility after completed class retirement.
-- The reviewed drop is staged in scripts/audit-decisions-drop-columns.sql.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS weight_tier_rules jsonb;

CREATE TABLE IF NOT EXISTS rooms (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES rooms(id) ON DELETE CASCADE,
  created_by text REFERENCES identities(id),
  name text NOT NULL,
  about text,
  avatar text,
  visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'invite-only')),
  archived_at timestamptz,
  direct_participants jsonb,
  repository_key text,
  repository_name text,
  repository_remote text,
  repository_target_branch text NOT NULL DEFAULT 'main',
  repository_updated_at timestamptz,
  repository_resolution text NOT NULL DEFAULT 'none' CHECK (repository_resolution IN ('repository', 'none', 'unverified')),
  github_installation_id bigint,
  reviewer_agent_id text REFERENCES identities(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE rooms ALTER COLUMN visibility SET DEFAULT 'public';
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS created_by text REFERENCES identities(id);
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS repository_updated_at timestamptz;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS repository_name text;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS repository_resolution text NOT NULL DEFAULT 'none';
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS reviewer_agent_id text REFERENCES identities(id);
CREATE INDEX IF NOT EXISTS rooms_workspace_idx ON rooms(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS rooms_parent_idx ON rooms(parent_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS memberships (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  room_id uuid REFERENCES rooms(id) ON DELETE CASCADE,
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  generation bigint NOT NULL DEFAULT 1,
  identity_profile jsonb,
  invited_by text REFERENCES identities(id) ON DELETE SET NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz
);
-- Retired ban rows remain for rollout storage compatibility. Deployment does
-- not apply them again to people who have since received a fresh invite.
DROP TRIGGER IF EXISTS membership_workspace_ban ON memberships;
DROP FUNCTION IF EXISTS enforce_workspace_ban();
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_role_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check CHECK(role IN ('owner','admin','member','spectator'));
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS identity_profile jsonb;
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS invited_by text;
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_invited_by_fkey;
ALTER TABLE memberships ADD CONSTRAINT memberships_invited_by_fkey
  FOREIGN KEY (invited_by) REFERENCES identities(id) ON DELETE SET NULL;
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS push_muted boolean NOT NULL DEFAULT false;
-- What this member reacts to in THIS Room. An event happens in a Room, so the
-- subscription lives on the Room membership row and not on the identity: an
-- agent in several Rooms would otherwise inherit one Room's job everywhere.
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS event_subscriptions jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS memberships_identity_idx ON memberships(identity_id, removed_at);
CREATE UNIQUE INDEX IF NOT EXISTS memberships_workspace_unique
  ON memberships(workspace_id, identity_id) WHERE room_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS memberships_room_unique
  ON memberships(room_id, identity_id) WHERE room_id IS NOT NULL;

-- Closing a chat is a per-person list preference. It never changes Room
-- membership, message history, or the Room's shared archived state.
CREATE TABLE IF NOT EXISTS chat_dismissals (
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, identity_id)
);
CREATE INDEX IF NOT EXISTS chat_dismissals_identity_idx
  ON chat_dismissals(identity_id, dismissed_at DESC);

CREATE TABLE IF NOT EXISTS room_push_views (
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  instance_id text,
  expires_at timestamptz,
  PRIMARY KEY (room_id,identity_id,session_id)
);
ALTER TABLE room_push_views ADD COLUMN IF NOT EXISTS instance_id text;
ALTER TABLE room_push_views ALTER COLUMN expires_at DROP NOT NULL;
CREATE INDEX IF NOT EXISTS room_push_views_identity_idx ON room_push_views(identity_id);

CREATE TABLE IF NOT EXISTS agents (
  agent_id text PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES identities(id),
  access_policy jsonb NOT NULL DEFAULT '{"type":"everyone"}'::jsonb,
  soul jsonb,
  selected_model text,
  selected_effort text,
  fast_mode boolean NOT NULL DEFAULT false,
  model_catalog jsonb NOT NULL DEFAULT '[]'::jsonb,
  model_unavailable text CHECK (model_unavailable IN ('model','effort','selection')),
  commands jsonb NOT NULL DEFAULT '[]'::jsonb,
  yolo_mode boolean NOT NULL DEFAULT true,
  yolo_set_by text,
  yolo_set_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS wake_batch_minutes integer NOT NULL DEFAULT 0 CHECK (wake_batch_minutes >= 0);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS usage_snapshot jsonb;
-- One plan reading per owner, provider and account, shared by every agent on
-- it (agent-usage.ts). account_key is a hash; it never names the account.
CREATE TABLE IF NOT EXISTS usage_accounts (
  id bigserial PRIMARY KEY,
  owner_id text NOT NULL,
  provider text NOT NULL,
  account_key text NOT NULL,
  usage jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, provider, account_key)
);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS usage_account_id bigint REFERENCES usage_accounts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS agents_usage_account ON agents(usage_account_id) WHERE usage_account_id IS NOT NULL;
-- Retired: never non-empty in production; nothing reads it since schedules moved to the server.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS yolo_mode boolean NOT NULL DEFAULT true;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS yolo_set_by text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS yolo_set_at timestamptz;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS model_unavailable text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS fast_mode boolean NOT NULL DEFAULT false;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS machine_id text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS machine_name text;
-- Broker facts are machine reports, not connector lifecycle records.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS squire_report jsonb;
-- Outstanding helper work and its progress; never the broker's status.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS squire_work jsonb NOT NULL DEFAULT '{}'::jsonb;
-- The harness is posted alongside the model catalog on every activation
-- (same cadence as selected_model). custom_tags is retained but unused:
-- agent tags were removed; the reviewed contract drop waits for old images.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS harness text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS custom_tags jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_model_unavailable_check;
ALTER TABLE agents ADD CONSTRAINT agents_model_unavailable_check
  CHECK (model_unavailable IN ('model','effort','selection'));
-- An agent nobody but its owner may address is indistinguishable from a dead one,
-- so a newly connected agent now answers everyone (agent-access.ts). Only the
-- DEFAULT moves: every existing row keeps the policy its owner is running with and
-- changes it from the members page.
ALTER TABLE agents ALTER COLUMN access_policy SET DEFAULT '{"type":"everyone"}'::jsonb;
-- Consent moved from a mid-conversation ask to one up-front owner choice, so yolo is
-- now the default for a NEW agent. Unlike the access_policy default change above,
-- existing rows were flipped once too: leaving them behind after the last default
-- change left agents refusing everyone for hours. The two hard
-- stops (a command naming a credential file; a script nobody has read) are outside
-- yolo's scope gate and are unaffected. An owner or workspace admin can still turn
-- an agent's yolo back off from the members page.
ALTER TABLE agents ALTER COLUMN yolo_mode SET DEFAULT true;

CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  author_id text NOT NULL REFERENCES identities(id),
  text text NOT NULL,
  presentation text NOT NULL DEFAULT 'message' CHECK (presentation IN ('message', 'system', 'activity', 'card')),
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  reactions jsonb NOT NULL DEFAULT '{}'::jsonb,
  reply_to_message_id text REFERENCES messages(id),
  root_message_id text,
  request_id text,
  turn_id text,
  activity jsonb,
  durable_fact text CHECK (durable_fact IS NULL OR durable_fact IN ('failure', 'merge', 'action')),
  card_type text,
  card jsonb,
  legacy_event jsonb,
  agent_hop_count integer NOT NULL DEFAULT 0,
  system_event jsonb,
  deleted_at timestamptz,
  deleted_by text REFERENCES identities(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- A live computer card keeps only the Beeline bearer link in the Room. The
${VOICE_SCHEMA}
-- upstream Squire URL remains server-side and dies with its browser session.
CREATE TABLE IF NOT EXISTS computer_sessions (
  id text PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  message_id text NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES identities(id),
  source_session_id text NOT NULL,
  upstream_url text NOT NULL,
  relay_instance_id text,
  view_secret bytea,
  handoff_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'live' CHECK (status IN ('live', 'ended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE INDEX IF NOT EXISTS computer_sessions_room_idx ON computer_sessions(room_id);
CREATE INDEX IF NOT EXISTS computer_sessions_agent_idx ON computer_sessions(agent_id);
ALTER TABLE computer_sessions ADD COLUMN IF NOT EXISTS view_secret bytea;
-- A Squire share link has an absolute expiry. Rows without one never expire.
ALTER TABLE computer_sessions ADD COLUMN IF NOT EXISTS expires_at timestamptz;
CREATE INDEX IF NOT EXISTS computer_sessions_live_expiry_idx ON computer_sessions(expires_at)
  WHERE status='live' AND expires_at IS NOT NULL;
-- A bounded, metadata-only activity trail lets a waiting agent receive live
-- control updates and replay events after its WebSocket reconnects.
CREATE TABLE IF NOT EXISTS computer_session_events (
  id bigserial PRIMARY KEY,
  session_id text NOT NULL REFERENCES computer_sessions(id) ON DELETE CASCADE,
  name text NOT NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS computer_session_events_session_idx ON computer_session_events(session_id, id);
-- Private message bookmarks deliberately keep their pointer after a source is
-- deleted or becomes inaccessible. Reads never cache or reveal source text;
-- they return an unavailable row that the viewer can remove.
CREATE TABLE IF NOT EXISTS message_bookmarks (
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  room_id uuid NOT NULL,
  message_id text NOT NULL,
  source_room_name text NOT NULL,
  source_room_kind text NOT NULL CHECK (source_room_kind IN ('room','corner')),
  message_created_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(identity_id,message_id)
);
CREATE INDEX IF NOT EXISTS message_bookmarks_workspace_viewer_page_idx
  ON message_bookmarks(workspace_id,identity_id,created_at DESC,message_id);
-- The Needs-you tray's only stored facts, per person: when they first saw a
-- cell (its 24-hour clock, shared by every device) and when they cleared it
-- by tapping or dismissing. Which messages are cells is read live
-- (needs-you.ts), never stored.
CREATE TABLE IF NOT EXISTS needs_you_marks (
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz,
  PRIMARY KEY(identity_id,message_id)
);
-- message_id/workspace_id cascade from messages/workspaces with no index
-- (the primary key leads with identity_id), so deleting a message or a
-- workspace made Postgres sequentially scan this table to find rows to
-- cascade-delete.
CREATE INDEX IF NOT EXISTS needs_you_marks_message_idx ON needs_you_marks(message_id);
CREATE INDEX IF NOT EXISTS needs_you_marks_workspace_idx ON needs_you_marks(workspace_id);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS agent_hop_count integer NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS system_event jsonb;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_by text REFERENCES identities(id);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reactions jsonb NOT NULL DEFAULT '{}'::jsonb;
-- Per-message write counter. A live delta carries it so a socket never sends
-- an older projection of a row after a newer one. A constant default adds the
-- column without rewriting the table.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;
CREATE OR REPLACE FUNCTION messages_bump_version() RETURNS trigger
LANGUAGE plpgsql AS $messages_version$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END
$messages_version$;
DROP TRIGGER IF EXISTS messages_bump_version ON messages;
CREATE TRIGGER messages_bump_version BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_bump_version();
-- A GENERATED ... STORED column rewrites every row of the busiest table under
-- ACCESS EXCLUSIVE, so the release migration would stall the live fleet before
-- the machine roll. An ordinary nullable column is metadata-only; the trigger
-- maintains it from the moment the schema lands and
-- backfillMessageSearchDocuments fills the history in bounded batches.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS search_document tsvector;
-- Keep exact tokens alongside English word forms without rewriting existing
-- rows or doubling the size of an individual bounded vector.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS search_stem_document tsvector;
CREATE OR REPLACE FUNCTION messages_search_document_refresh() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_document := ${messageSearchDocumentSql('NEW.')};
  NEW.search_stem_document := ${messageSearchDocumentSql('NEW.', 'english')};
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS messages_search_document_trg ON messages;
CREATE TRIGGER messages_search_document_trg
  BEFORE INSERT OR UPDATE OF text,presentation ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_search_document_refresh();
-- Who a message tags is read from its text against the Room's CURRENT membership
-- (message-mentions.ts), never from a list frozen at write time. The old column
-- was that frozen list, and it drifted: a handle renamed, a member removed, or a
-- person joining after the fact left stored ids that no longer matched the words
-- anybody could see. Deriving on read is the only way the two can never disagree.
-- Where an event line came from. The cause is the message that triggered the
-- turn that emitted it; the root is the first line of that whole cascade, and
-- the depth is how far this line sits from it. Columns rather than more json
-- because the loop guard COUNTS over the root and the partial index is what
-- makes that count cheap; nothing outside a cascade carries them.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS event_cause_id text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS event_root_cause_id text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS event_depth integer;
-- How many turns this line woke, which is what the cascade budget spends. It is
-- a COUNT and never a list: wake targets were the one thing the retired column
-- below held that no text could be read back for, because a system line
-- addresses agents by subscription rather than by anything in its sentence.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS event_woken integer;
-- The model that produced an agent's durable reply, stamped at generation time
-- on the server (from the author's agents.selected_model, the daemon-posted
-- live selection) so a byline renders the model of THAT turn, not today's
-- roster setting retro-labeling old messages.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS agent_model text;
CREATE INDEX IF NOT EXISTS messages_event_root_idx ON messages(event_root_cause_id)
  WHERE event_root_cause_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_room_page_idx ON messages(room_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS messages_request_idx ON messages(room_id, request_id) WHERE request_id IS NOT NULL;

-- Retired: empty in production on 2026-11-02 and written by nothing on main.

CREATE TABLE IF NOT EXISTS agent_turns (
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  agent_id text NOT NULL REFERENCES identities(id),
  status text NOT NULL CHECK (status IN ('working', 'complete', 'failed', 'cancelled')),
  generation_id text,
  started_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  failure_reason text,
  PRIMARY KEY (room_id, request_id, agent_id)
);
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS failure_reason text;
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS completion_kind text;
-- How much work the turn did, as the harness's own stream counted it. A turn is
-- the unit mid-close cohorts compare, so the count has to live where both the
-- served and the unserved cohort can be read from — a serve ledger only ever
-- holds the turns memory reached, which is exactly the biased half.
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS tool_calls integer;
ALTER TABLE agent_turns DROP CONSTRAINT IF EXISTS agent_turns_tool_calls_check;
ALTER TABLE agent_turns ADD CONSTRAINT agent_turns_tool_calls_check
  CHECK (tool_calls IS NULL OR tool_calls >= 0);
-- Optional harness token totals. Null means the daemon did not report a figure.
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS input_tokens integer;
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS output_tokens integer;
ALTER TABLE agent_turns DROP CONSTRAINT IF EXISTS agent_turns_input_tokens_check;
ALTER TABLE agent_turns ADD CONSTRAINT agent_turns_input_tokens_check
  CHECK (input_tokens IS NULL OR input_tokens >= 0);
ALTER TABLE agent_turns DROP CONSTRAINT IF EXISTS agent_turns_output_tokens_check;
ALTER TABLE agent_turns ADD CONSTRAINT agent_turns_output_tokens_check
  CHECK (output_tokens IS NULL OR output_tokens >= 0);
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS started_at timestamptz;
UPDATE agent_turns SET started_at=created_at WHERE started_at IS NULL;
ALTER TABLE agent_turns ALTER COLUMN started_at SET DEFAULT now();
-- 'cancelled' joined the vocabulary when the requester gained a stop control.
-- A table created before that carries the older three-word CHECK, and a CHECK
-- is not IF NOT EXISTS-able by definition: drop the constraint by its
-- generated name and re-add the full vocabulary. Both statements together are
-- idempotent, so an already-current database re-adds exactly what it had.
ALTER TABLE agent_turns DROP CONSTRAINT IF EXISTS agent_turns_status_check;
ALTER TABLE agent_turns ADD CONSTRAINT agent_turns_status_check
  CHECK (status IN ('working', 'complete', 'failed', 'cancelled'));
-- Replay diagnostics expire independently of durable turn/message history.
CREATE TABLE IF NOT EXISTS agent_turn_traces (
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  agent_id text NOT NULL REFERENCES identities(id),
  trigger_message_id text,
  reply_message_ids jsonb NOT NULL DEFAULT '[]',
  outcome text NOT NULL,
  trace jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(room_id,request_id,agent_id)
);
CREATE INDEX IF NOT EXISTS agent_turn_traces_created ON agent_turn_traces(created_at);

CREATE INDEX IF NOT EXISTS agent_turns_agent_activity ON agent_turns(agent_id,created_at DESC);
CREATE INDEX IF NOT EXISTS agent_turns_room_created ON agent_turns(room_id,created_at DESC);

-- Institutional memory: server-owned evidence and live items. A daemon id
-- records who processed a job; it is never an ownership or visibility axis.
CREATE TABLE IF NOT EXISTS institutional_memory_jobs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('turn_review','merge_review','curator')),
  mode text NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow','live')),
  source_room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  source_message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  source_request_id text,
  requester_identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  source_audience_kind text NOT NULL CHECK (
    source_audience_kind IN ('workspace_candidate','human_private')
  ),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 300),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','claimed','retry','completed','dead')),
  lease_owner_agent_id text REFERENCES identities(id) ON DELETE SET NULL,
  lease_owner_machine_id text,
  lease_token text,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 5),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  proposal jsonb,
  proposal_hash text CHECK (proposal_hash IS NULL OR proposal_hash ~ '^[0-9a-f]{64}$'),
  extractor_version text CHECK (
    extractor_version IS NULL OR length(extractor_version) BETWEEN 1 AND 120
  ),
  model text CHECK (model IS NULL OR length(model) BETWEEN 1 AND 160),
  input_bytes integer NOT NULL DEFAULT 0 CHECK (input_bytes >= 0),
  output_bytes integer NOT NULL DEFAULT 0 CHECK (output_bytes >= 0),
  input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  estimated_cost_usd_micros bigint CHECK (
    estimated_cost_usd_micros IS NULL OR estimated_cost_usd_micros >= 0
  ),
  error text CHECK (error IS NULL OR length(error) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  source_deleted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE institutional_memory_jobs ADD COLUMN IF NOT EXISTS source_deleted_at timestamptz;
ALTER TABLE institutional_memory_jobs ADD COLUMN IF NOT EXISTS context jsonb;
CREATE INDEX IF NOT EXISTS institutional_memory_jobs_claim_idx
  ON institutional_memory_jobs(status,next_attempt_at,created_at,id)
  WHERE status IN ('pending','retry','claimed');
CREATE INDEX IF NOT EXISTS institutional_memory_jobs_workspace_created_idx
  ON institutional_memory_jobs(workspace_id,created_at,id);
-- source_message_id/source_room_id cascade from messages/rooms with no index,
-- so deleting a room or workspace made Postgres sequentially scan this table
-- to find rows to cascade-delete.
CREATE INDEX IF NOT EXISTS institutional_memory_jobs_source_message_idx
  ON institutional_memory_jobs(source_message_id);
CREATE INDEX IF NOT EXISTS institutional_memory_jobs_source_room_idx
  ON institutional_memory_jobs(source_room_id);

-- Meaning-based recall (search_memory, the per-turn snapshot, workspace
-- skills) needs pgvector; Neon supports the extension directly.
CREATE EXTENSION IF NOT EXISTS vector;

`;
