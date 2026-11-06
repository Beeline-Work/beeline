import { CORNER_MACHINE_SCHEMA, CORNER_GITHUB_CACHE_MIRROR_SQL } from './corner-lifecycle.js';
export const DATABASE_SCHEMA_CORNER_FACTS = `  PRIMARY KEY (agent_id, room_id)
);
CREATE INDEX IF NOT EXISTS agent_mandates_room_idx ON agent_mandates(room_id);

-- A corner stores only what nothing else can derive: whether people locked
-- it, its reviewer override, and a display cache of GitHub facts
-- (lifecycle). Everything else is read from its commands, cards and Room.
CREATE TABLE IF NOT EXISTS corner_facts (
  corner_id uuid PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  lifecycle jsonb NOT NULL DEFAULT '{"lifecycle":"unknown","checks":"unknown"}'::jsonb
);
ALTER TABLE corner_facts ADD COLUMN IF NOT EXISTS locked boolean NOT NULL DEFAULT false;
ALTER TABLE corner_facts ADD COLUMN IF NOT EXISTS reviewer_agent_id text REFERENCES identities(id);
-- Reproduction rollout-0707: the preceding serving/rollback image reads this
-- field in corner lists, command delivery and webhook dispatch. Repair the
-- premature drop as well as preserving existing installations.
ALTER TABLE corner_facts ADD COLUMN IF NOT EXISTS owner_agent_id text REFERENCES identities(id);
CREATE INDEX IF NOT EXISTS corner_facts_reviewer_agent_idx ON corner_facts(reviewer_agent_id);
-- Smallest corner state (owner order 2026-11-02; [drops data], each item
-- approved by the owner). Derived storage and its retired tables are dropped
-- once, after the release that stopped every replica touching them.
DROP TRIGGER IF EXISTS corner_owed_facts_update ON corner_facts;
DROP TRIGGER IF EXISTS corner_owed_input_facts ON corner_facts;
-- Older releases' triggers that watched dropped columns; later schemas drop them too.
DROP TRIGGER IF EXISTS corner_follows_facts_insert ON corner_facts;
DROP TRIGGER IF EXISTS corner_follows_facts_update ON corner_facts;
DROP TRIGGER IF EXISTS corner_attention_head ON corner_facts;
DROP TRIGGER IF EXISTS corner_attention_open ON corner_facts;
DROP TRIGGER IF EXISTS corner_state_facts ON corner_facts;
DROP TABLE IF EXISTS corner_validation_stages, corner_attention_flags, corner_pr_closures,
  corner_branch_deletions, corner_report_blockers, corner_attention_spans, automatic_report_wakes;
DROP INDEX IF EXISTS corner_facts_opened_from_idx;
DROP INDEX IF EXISTS corner_facts_owner_agent_idx;
DROP INDEX IF EXISTS corner_facts_commissioned_by_idx;
DROP INDEX IF EXISTS corner_facts_workflow_land_idx;
ALTER TABLE corner_facts DROP CONSTRAINT IF EXISTS corner_facts_kind_check;
ALTER TABLE corner_facts DROP CONSTRAINT IF EXISTS corner_facts_lane_check;
ALTER TABLE corner_facts
  DROP COLUMN IF EXISTS plan, DROP COLUMN IF EXISTS review_handback_head, DROP COLUMN IF EXISTS review_handback_count,
  DROP COLUMN IF EXISTS command_check_state, DROP COLUMN IF EXISTS worker_agent_id,
  DROP COLUMN IF EXISTS merge_attempt_head, DROP COLUMN IF EXISTS workflow_state, DROP COLUMN IF EXISTS workflow_outcome,
  DROP COLUMN IF EXISTS feature_branch, DROP COLUMN IF EXISTS close_requested, DROP COLUMN IF EXISTS kind,
  DROP COLUMN IF EXISTS commissioned_by, DROP COLUMN IF EXISTS opened_from_corner_id, DROP COLUMN IF EXISTS request_id,
  DROP COLUMN IF EXISTS open_idempotency_key, DROP COLUMN IF EXISTS title_generated, DROP COLUMN IF EXISTS objective,
  DROP COLUMN IF EXISTS updated_at, DROP COLUMN IF EXISTS feedback_triage, DROP COLUMN IF EXISTS lane;
ALTER TABLE rooms DROP COLUMN IF EXISTS reviewer_class, DROP COLUMN IF EXISTS reviewer_fallback_ids;

-- GitHub's display cache for a corner (PR, checks, mergeability), written only
-- from GitHub and helper remote-state reports. Disposable: it is never corner
-- state, and it moves out of corner_facts.lifecycle (expand, switch, contract).
CREATE TABLE IF NOT EXISTS corner_github_cache (
  corner_id uuid PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  lifecycle jsonb NOT NULL DEFAULT '{"lifecycle":"working","checks":"unknown"}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION corner_github_cache_touch() RETURNS trigger LANGUAGE plpgsql AS $touch$
BEGIN NEW.updated_at=now(); RETURN NEW; END $touch$;
DROP TRIGGER IF EXISTS corner_github_cache_touch ON corner_github_cache;
CREATE TRIGGER corner_github_cache_touch BEFORE UPDATE OF lifecycle ON corner_github_cache
  FOR EACH ROW EXECUTE FUNCTION corner_github_cache_touch();
${CORNER_GITHUB_CACHE_MIRROR_SQL}
${CORNER_MACHINE_SCHEMA}

CREATE TABLE IF NOT EXISTS corner_watches (
  watcher_room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  corner_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  kinds jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (watcher_room_id,agent_id,corner_id)
);
CREATE INDEX IF NOT EXISTS corner_watches_corner_idx ON corner_watches(corner_id);

-- Assignment revisions are immutable; the current revision is the greatest
-- committed row. Opening and revising insert the row in the command transaction.
CREATE TABLE IF NOT EXISTS corner_brief_revisions (
  corner_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 65536),
  change text,
  author_id text NOT NULL REFERENCES identities(id),
  source_room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  source_message_id text,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (corner_id, revision)
);
CREATE INDEX IF NOT EXISTS corner_brief_revisions_source_idx ON corner_brief_revisions(source_room_id);
ALTER TABLE corner_brief_revisions ADD COLUMN IF NOT EXISTS source_message_id text;
ALTER TABLE corner_brief_revisions ADD COLUMN IF NOT EXISTS objective text;
-- Structured authority was added after the original opaque content field.
-- Rows from before it keep null authority fields and read back as their
-- build_spec alone.
ALTER TABLE corner_brief_revisions ADD COLUMN IF NOT EXISTS intent_verbatim jsonb;
ALTER TABLE corner_brief_revisions ADD COLUMN IF NOT EXISTS build_spec text;
ALTER TABLE corner_brief_revisions ADD COLUMN IF NOT EXISTS criteria jsonb;
ALTER TABLE corner_brief_revisions ADD COLUMN IF NOT EXISTS non_goals jsonb;
ALTER TABLE corner_brief_revisions ADD COLUMN IF NOT EXISTS brief_references jsonb;
ALTER TABLE corner_brief_revisions ADD COLUMN IF NOT EXISTS approval_basis jsonb;
ALTER TABLE corner_brief_revisions ADD COLUMN IF NOT EXISTS revision_hash text;
UPDATE corner_brief_revisions SET build_spec=content
  WHERE build_spec IS NULL AND content IS NOT NULL;
-- The trimmed brief is one Markdown spec plus one approving message. New
-- revisions write spec and approval_basis and leave content and the typed
-- columns above NULL; older rows keep them and are folded into a spec on read.
ALTER TABLE corner_brief_revisions ADD COLUMN IF NOT EXISTS spec text;
ALTER TABLE corner_brief_revisions ALTER COLUMN content DROP NOT NULL;
-- Retired storage only (SENTRY-22). Older images still join these tables on
-- ordinary corner reads during rolling deployment and rollback. Preserve rows;
-- CREATE IF NOT EXISTS also repairs databases where #3221 already dropped them.
-- No current tools/routes/UI use these tables. Remove only in a separate contract
-- migration after all live AND rollback images no longer reference them.
CREATE TABLE IF NOT EXISTS corner_apps (
  corner_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  slug text NOT NULL,
  author_agent_id text NOT NULL REFERENCES identities(id),
  definition jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (corner_id, slug)
);
CREATE INDEX IF NOT EXISTS corner_apps_author_idx ON corner_apps(author_agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS corner_apps_command_idx
  ON corner_apps(corner_id,(definition->>'command'));

CREATE TABLE IF NOT EXISTS corner_app_installations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  installed_by text NOT NULL REFERENCES identities(id),
  developer_agent_id text REFERENCES identities(id),
  manifest jsonb NOT NULL,
  connected_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS corner_app_installations_workspace_idx
  ON corner_app_installations(workspace_id,connected_at DESC);
CREATE TABLE IF NOT EXISTS corner_app_bindings (
  corner_id uuid PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL REFERENCES corner_app_installations(id) ON DELETE RESTRICT,
  instance_id uuid NOT NULL UNIQUE,
  bound_by text NOT NULL REFERENCES identities(id),
  bound_at timestamptz NOT NULL DEFAULT now()
);

-- Check verdicts come from GitHub's statusCheckRollup. Retire the old webhook-derived cache.
DROP TABLE IF EXISTS corner_check_facts;

CREATE TABLE IF NOT EXISTS corner_merge_approvals (
  corner_id uuid PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  approved_by text NOT NULL REFERENCES identities(id),
  pull_request_number integer,
  head_sha text,
  approved_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE corner_merge_approvals ADD COLUMN IF NOT EXISTS pull_request_number integer;
ALTER TABLE corner_merge_approvals ADD COLUMN IF NOT EXISTS head_sha text;
ALTER TABLE corner_merge_approvals DROP COLUMN IF EXISTS patch_id;
ALTER TABLE corner_merge_approvals DROP COLUMN IF EXISTS force, DROP COLUMN IF EXISTS brief_revision;

CREATE TABLE IF NOT EXISTS invites (
  token_hash text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by text NOT NULL REFERENCES identities(id),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS invites_workspace_idx ON invites(workspace_id);
-- A public token is recoverable for managers, reusable, and has no expiry.
ALTER TABLE invites ALTER COLUMN expires_at DROP NOT NULL;
ALTER TABLE invites ADD COLUMN IF NOT EXISTS public_token text;
ALTER TABLE invites ADD COLUMN IF NOT EXISTS onboarding_room_id uuid REFERENCES rooms(id) ON DELETE CASCADE;
ALTER TABLE invites ADD COLUMN IF NOT EXISTS onboarding_created_at timestamptz;
ALTER TABLE invites ADD COLUMN IF NOT EXISTS onboarding_friend_id text REFERENCES identities(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS invites_onboarding_friend ON invites(onboarding_friend_id) WHERE onboarding_friend_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS invites_onboarding_room ON invites(onboarding_room_id) WHERE onboarding_room_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS invites_public_workspace_idx ON invites(workspace_id)
  WHERE public_token IS NOT NULL;
-- Publish the existing support Workspace's first link with the website release.
-- Existing/rotated links win on all later migrations; never recreate an old token.
INSERT INTO invites(token_hash,workspace_id,created_by,expires_at,public_token)
SELECT '71365e5a8aac2ea96a29263d9c08e60157f01439ff5eaa68aecbc9807992962b',w.id,m.identity_id,NULL,
  'inv_8765f41a655c33815ea86cecf199ab60983b9326bb02b869f6436af1286dd0f2'
FROM workspaces w JOIN memberships m ON m.workspace_id=w.id AND m.room_id IS NULL
  AND m.removed_at IS NULL AND m.role IN ('owner','admin')
WHERE w.id='8556a9be-d929-41e7-a0ef-d70af452a494' AND w.visibility='public'
  AND NOT EXISTS(SELECT 1 FROM invites i WHERE i.workspace_id=w.id AND i.public_token IS NOT NULL)
ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END,m.identity_id LIMIT 1
ON CONFLICT DO NOTHING;
-- Existing invites stay null. There is no backfill; operator_metric_epochs
-- records when creation counts start.
ALTER TABLE invites ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE invites ALTER COLUMN created_at SET DEFAULT now();

CREATE TABLE IF NOT EXISTS agent_pairing_codes (
  code_hash text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by text NOT NULL REFERENCES identities(id),
  expires_at timestamptz NOT NULL,
  claimed_by text REFERENCES identities(id),
  claimed_at timestamptz
);
CREATE INDEX IF NOT EXISTS agent_pairing_codes_workspace_idx ON agent_pairing_codes(workspace_id);
ALTER TABLE agent_pairing_codes ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE agent_pairing_codes ALTER COLUMN created_at SET DEFAULT now();

-- Workspace-owned bytes, independent of expiring Room attachments.
CREATE TABLE IF NOT EXISTS avatars (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 131072)
);

-- One current generated portrait per agent; independent of attachment expiry.
CREATE TABLE IF NOT EXISTS agent_avatars (
  id uuid PRIMARY KEY,
  agent_id text NOT NULL UNIQUE REFERENCES agents(agent_id) ON DELETE CASCADE,
  bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 131072),
  request_id text NOT NULL,
  drawing jsonb NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now()
);

-- Object-storage rows (object-storage.ts): person file shares and agent
-- artifacts. Bytes live in S3-compatible storage. The key is kind/owner/sha256;
-- owner+sha256 dedupes. The retired bytea media store is dropped below.
CREATE TABLE IF NOT EXISTS objects (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES identities(id),
  kind text NOT NULL CHECK (kind IN ('media','artifact')),
  key text NOT NULL UNIQUE,
  mime text NOT NULL,
  title text,
  size bigint NOT NULL CHECK (size > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (owner_id, sha256)
);
CREATE INDEX IF NOT EXISTS objects_expires_idx ON objects(expires_at);
CREATE INDEX IF NOT EXISTS objects_pending_idx ON objects(created_at) WHERE state='pending';

-- One row per swept object id, so the media read answers 410 Gone instead of 404.
CREATE TABLE IF NOT EXISTS object_expirations (
  id uuid PRIMARY KEY,
  retention_hours integer NOT NULL DEFAULT 24,
  expired_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE object_expirations
  ADD COLUMN IF NOT EXISTS retention_hours integer NOT NULL DEFAULT 24;

-- The bytea media store is retired: person files share the objects/Tigris path.
DROP TABLE IF EXISTS legacy_media_urls;
DROP TABLE IF EXISTS media;
DROP TABLE IF EXISTS media_expirations;

CREATE TABLE IF NOT EXISTS github_installations (
  installation_id bigint PRIMARY KEY,
  owner_id text NOT NULL REFERENCES identities(id),
  account_id text,
  account_login text NOT NULL,
  account_type text NOT NULL,
  account_avatar_url text,
  repository_selection text NOT NULL DEFAULT 'selected',
  encrypted_token text,
  status text NOT NULL DEFAULT 'active',
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE github_installations ADD COLUMN IF NOT EXISTS api_retry_at timestamptz;
ALTER TABLE github_installations ADD COLUMN IF NOT EXISTS account_id text;
ALTER TABLE github_installations ADD COLUMN IF NOT EXISTS account_avatar_url text;
ALTER TABLE github_installations ADD COLUMN IF NOT EXISTS repository_selection text NOT NULL DEFAULT 'selected';

CREATE TABLE IF NOT EXISTS github_repositories (
  repository_id bigint PRIMARY KEY,
  installation_id bigint NOT NULL REFERENCES github_installations(installation_id) ON DELETE CASCADE,
  full_name text NOT NULL UNIQUE,
  default_branch text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- NULL until the next installation refresh records GitHub's flag; read as private.
ALTER TABLE github_repositories ADD COLUMN IF NOT EXISTS private boolean;
-- NULL until the next installation refresh records GitHub's flag; a Beeline
-- reviewer set on a Room whose repository allows auto-merge never gets a
-- turn, since GitHub merges on the same green-checks signal that wakes it.
ALTER TABLE github_repositories ADD COLUMN IF NOT EXISTS allow_auto_merge boolean;

DROP TABLE IF EXISTS github_head_checks;

-- First confirmed link per person and Workspace, without repository or message content.
-- Keeping Workspace scope prevents a fixture success masking a later real success.
CREATE TABLE IF NOT EXISTS repository_link_successes (
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  first_linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (identity_id, workspace_id)
);
CREATE INDEX IF NOT EXISTS repository_link_successes_workspace_idx ON repository_link_successes(workspace_id);
CREATE TABLE IF NOT EXISTS operator_metric_epochs (
  metric text PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO operator_metric_epochs(metric) VALUES('repository_link') ON CONFLICT DO NOTHING;
INSERT INTO operator_metric_epochs(metric) VALUES('invite') ON CONFLICT DO NOTHING;
INSERT INTO operator_metric_epochs(metric) VALUES('agent_pairing') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS github_user_tokens (
  subject text PRIMARY KEY,
  encrypted_token text NOT NULL,
  stale_at timestamptz,
  encrypted_refresh_token text,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE github_user_tokens ADD COLUMN IF NOT EXISTS encrypted_refresh_token text;
ALTER TABLE github_user_tokens ADD COLUMN IF NOT EXISTS expires_at timestamptz;

CREATE TABLE IF NOT EXISTS github_auth_flows (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('identity', 'installation')),
  provider_identity jsonb,
  encrypted_token text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE github_auth_flows ADD COLUMN IF NOT EXISTS provider_identity jsonb;
ALTER TABLE github_auth_flows ADD COLUMN IF NOT EXISTS encrypted_token text;
CREATE INDEX IF NOT EXISTS github_auth_flows_expiry_idx ON github_auth_flows(expires_at);

CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
  delivery_id text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);
-- The old payload shape: NULL on every row in production on 2026-11-02.
ALTER TABLE github_webhook_deliveries DROP COLUMN IF EXISTS event_type;
ALTER TABLE github_webhook_deliveries DROP COLUMN IF EXISTS payload;
ALTER TABLE github_webhook_deliveries DROP COLUMN IF EXISTS processed_at;

CREATE TABLE IF NOT EXISTS push_devices (
  token text PRIMARY KEY,
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('android', 'ios')),
  environment text NOT NULL CHECK (environment IN ('physical', 'emulator')),
  registered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE push_devices DROP CONSTRAINT IF EXISTS push_devices_platform_check;
ALTER TABLE push_devices ADD CONSTRAINT push_devices_platform_check CHECK (platform IN ('android', 'ios', 'web'));
ALTER TABLE push_devices ADD COLUMN IF NOT EXISTS web_keys jsonb;
ALTER TABLE push_devices ADD COLUMN IF NOT EXISTS registered_at timestamptz;
UPDATE push_devices SET registered_at=updated_at WHERE registered_at IS NULL;
ALTER TABLE push_devices ALTER COLUMN registered_at SET DEFAULT now();
ALTER TABLE push_devices ALTER COLUMN registered_at SET NOT NULL;
CREATE INDEX IF NOT EXISTS push_devices_identity_idx ON push_devices(identity_id);

DROP TABLE IF EXISTS push_read_clears;
-- No longer read or written; it stays for rolling-update compatibility.
ALTER TABLE room_read_marks ADD COLUMN IF NOT EXISTS read_at timestamptz;
CREATE INDEX IF NOT EXISTS room_read_marks_identity_read_idx
  ON room_read_marks(identity_id,read_at);

CREATE TABLE IF NOT EXISTS push_delivery_floors (
  id text PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now()
);

-- Release-owned, one-shot data steps (welcome-retirement.ts): one row per
-- step, written last inside that step's own transaction, so a retry sees the
-- marker and completes quietly.
CREATE TABLE IF NOT EXISTS beeline_release_steps (
  name text PRIMARY KEY,
  completed_at timestamptz NOT NULL DEFAULT now(),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Latest helper bundle confirmed delivered by the release pipeline. Every
-- server instance reads this for connected daemon sockets and reconnects.
CREATE TABLE IF NOT EXISTS helper_release_notifications (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version text NOT NULL,
  sha text NOT NULL,
  announced_at timestamptz NOT NULL DEFAULT now()
);

-- Owner-initiated workspace deletion is a real DELETE FROM workspaces, whose
-- ON DELETE CASCADE already empties rooms/memberships/messages/invites/etc
-- (every one of those tables carries workspace_id or a room_id that chains to
-- it). These two tables record the fact independent of the workspace row, so
-- the audit trail and the other members' notice both survive the cascade.
CREATE TABLE IF NOT EXISTS workspace_deletions (
  workspace_id uuid PRIMARY KEY,
  workspace_name text NOT NULL,
  deleted_by text NOT NULL REFERENCES identities(id),
  deleted_at timestamptz NOT NULL DEFAULT now()
);

-- One row per member (other than the deleter) at deletion time, consumed by
-- readWorkspaces on that member's next sync.
CREATE TABLE IF NOT EXISTS workspace_deletion_notices (
  id bigserial PRIMARY KEY,
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- The name is read from workspace_deletions.
ALTER TABLE workspace_deletion_notices DROP COLUMN IF EXISTS workspace_name;
CREATE INDEX IF NOT EXISTS workspace_deletion_notices_identity_idx
  ON workspace_deletion_notices(identity_id, created_at);

CREATE TABLE IF NOT EXISTS workspace_join_notifications (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  room_id uuid REFERENCES rooms(id) ON DELETE SET NULL,
  joining_identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workspace_join_notifications_workspace_idx
  ON workspace_join_notifications(workspace_id);
CREATE INDEX IF NOT EXISTS workspace_join_notifications_room_idx
  ON workspace_join_notifications(room_id) WHERE room_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS workspace_join_notification_devices (
  notification_id text NOT NULL REFERENCES workspace_join_notifications(id) ON DELETE CASCADE,
  device_token text NOT NULL REFERENCES push_devices(token) ON DELETE CASCADE,
  PRIMARY KEY (notification_id, device_token)
);

CREATE TABLE IF NOT EXISTS push_delivery_claims (
  message_id text NOT NULL,
  device_token text NOT NULL REFERENCES push_devices(token) ON DELETE CASCADE,
  status text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error text,
  PRIMARY KEY (message_id, device_token)
);
ALTER TABLE push_delivery_claims ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 1;
DROP TRIGGER IF EXISTS retry_push_outbox ON push_delivery_claims;
-- When a read-clear push named this delivered message (sendReadClears). Read
-- messages a push left out stay NULL and go in a later push.
ALTER TABLE push_delivery_claims ADD COLUMN IF NOT EXISTS read_cleared_at timestamptz;
-- Content-free observations written only when a real client operation ends.
-- The dashboard reads a bounded recent window; no timer produces samples.
CREATE TABLE IF NOT EXISTS x_ad_signups (
  identity_id text PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
  twclid text, campaign_id text, ad_id text, ad_group_id text,
  captured_at timestamptz NOT NULL, created_at timestamptz NOT NULL,
  conversion_id text NOT NULL UNIQUE, event_id text,
  sent_at timestamptz, attempts integer NOT NULL DEFAULT 0,
  delivery_failed boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS x_ad_signups_date ON x_ad_signups(created_at);
CREATE INDEX IF NOT EXISTS x_ad_signups_pending ON x_ad_signups(created_at) WHERE sent_at IS NULL AND attempts=0;
CREATE TABLE IF NOT EXISTS x_ad_daily (
  day date NOT NULL, level text NOT NULL CHECK(level IN ('campaign','ad_group','ad')),
  entity_id text NOT NULL, name text NOT NULL, campaign_id text, ad_group_id text,
  currency text NOT NULL, spend_micros bigint NOT NULL CHECK(spend_micros>=0),
  impressions bigint NOT NULL CHECK(impressions>=0), link_clicks bigint NOT NULL CHECK(link_clicks>=0),
  PRIMARY KEY(day,level,entity_id)
);
ALTER TABLE x_ad_daily ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'api' CHECK(source IN ('api','screen'));
CREATE TABLE IF NOT EXISTS x_ad_sync (
  id text PRIMARY KEY, completed_at timestamptz, failed_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS x_site_visit_daily (
  day date PRIMARY KEY,
  site_visits bigint NOT NULL CHECK(site_visits>=0),
  by_ad jsonb NOT NULL DEFAULT '[]'::jsonb
);

ALTER TABLE x_site_visit_daily ADD COLUMN IF NOT EXISTS all_site_visits bigint CHECK(all_site_visits>=0);
CREATE TABLE IF NOT EXISTS site_download_tap_daily (
  day date NOT NULL,
  platform text NOT NULL CHECK(platform IN ('ios','android','macos','windows','linux')),
  source text NOT NULL CHECK(source IN ('x','organic')),
  taps bigint NOT NULL CHECK(taps>=0 AND taps<=100000),
  PRIMARY KEY(day,platform,source)
);

CREATE TABLE IF NOT EXISTS signin_funnel_installs (
  install_id uuid PRIMARY KEY,
  internal boolean NOT NULL DEFAULT false,
  seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS signin_funnel_events (
  install_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  event text NOT NULL CHECK (event IN ('app_opened','signin_screen_shown','provider_tapped','callback_result','signed_in','signup','workspace_created','first_message_sent','screen_shown','repo_job_chosen','youtube_job_chosen','other_job_chosen','banter_shown','welcome_shown','welcome_skipped','option_picked','user_answered','task_question','task_first_answer','task_review_requested','task_final_answer','game_posted','game_viewer_opened','game_viewer_closed','invite_created','invite_shared','invite_opened','invite_friend_signed_up','invite_friend_messaged','returned_day_1','returned_day_7','next_day_checkin_sent')),
  platform text NOT NULL CHECK (platform IN ('ios','android','web','macos','windows','linux')),
  version text NOT NULL,
  provider text NOT NULL DEFAULT '' CHECK (provider IN ('','github','google')),
  outcome text NOT NULL DEFAULT '' CHECK (outcome IN ('','success','cancelled','error')),
  error_code text,
  source text NOT NULL CHECK (source IN ('client','server')),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- Allowlisted route pattern for screen_shown only; never a route value.
  screen text NOT NULL DEFAULT '',
  PRIMARY KEY(install_id,attempt_id,event,provider,screen)
);
ALTER TABLE signin_funnel_installs ADD COLUMN IF NOT EXISTS account_hash text;
CREATE INDEX IF NOT EXISTS signin_funnel_installs_account ON signin_funnel_installs(account_hash) WHERE account_hash IS NOT NULL;
ALTER TABLE signin_funnel_events ADD COLUMN IF NOT EXISTS onboarding_option text CHECK(onboarding_option IN ('A','B','C','D'));
ALTER TABLE signin_funnel_events ADD COLUMN IF NOT EXISTS duration_ms bigint;
ALTER TABLE signin_funnel_events ADD COLUMN IF NOT EXISTS artifact_id uuid;
CREATE INDEX IF NOT EXISTS signin_funnel_events_date ON signin_funnel_events(occurred_at);
ALTER TABLE signin_funnel_events ADD COLUMN IF NOT EXISTS screen text NOT NULL DEFAULT '';
-- Device time of the latest visit for a screen_shown row; NULL otherwise.
ALTER TABLE signin_funnel_events ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
-- Screen events stored on a screen_shown row (first visit plus revisits); 1 otherwise.
ALTER TABLE signin_funnel_events ADD COLUMN IF NOT EXISTS visits integer NOT NULL DEFAULT 1;
DO $$ BEGIN
  IF (SELECT array_length(conkey,1) FROM pg_constraint
      WHERE conrelid='signin_funnel_events'::regclass AND contype='p') <> 5 THEN
    ALTER TABLE signin_funnel_events DROP CONSTRAINT signin_funnel_events_pkey;
    ALTER TABLE signin_funnel_events ADD CONSTRAINT signin_funnel_events_pkey
      PRIMARY KEY(install_id,attempt_id,event,provider,screen);
  END IF;
END $$;
ALTER TABLE signin_funnel_events DROP CONSTRAINT IF EXISTS signin_funnel_events_event_check;
ALTER TABLE signin_funnel_events ADD CONSTRAINT signin_funnel_events_event_check
  CHECK (event IN ('app_opened','signin_screen_shown','provider_tapped','callback_result','signed_in','signup','workspace_created','first_message_sent','screen_shown','repo_job_chosen','youtube_job_chosen','other_job_chosen','banter_shown','welcome_shown','welcome_skipped','option_picked','user_answered','task_question','task_first_answer','task_review_requested','task_final_answer','game_posted','game_viewer_opened','game_viewer_closed','invite_created','invite_shared','invite_opened','invite_friend_signed_up','invite_friend_messaged','returned_day_1','returned_day_7','next_day_checkin_sent'));
CREATE TABLE IF NOT EXISTS signin_funnel_auth_flows (
  flow_hash text PRIMARY KEY,
  context jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
-- Only hashes used for correlation, never continuation secrets. Deleted after expiry.
CREATE TABLE IF NOT EXISTS signin_attempt_correlations (
  attempt_id uuid PRIMARY KEY,
  flow_hash text UNIQUE NOT NULL,
  recovery_hash text,
  ticket_hash text,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS signin_attempt_correlations_recovery ON signin_attempt_correlations(recovery_hash);
CREATE INDEX IF NOT EXISTS signin_attempt_correlations_ticket ON signin_attempt_correlations(ticket_hash);
CREATE INDEX IF NOT EXISTS signin_attempt_correlations_expiry ON signin_attempt_correlations(expires_at);
-- Append-only observations, except for the 90-day retention deletion.
CREATE TABLE IF NOT EXISTS signin_attempt_events (
  attempt_id uuid NOT NULL,
  stage text NOT NULL CHECK(stage IN ('started','provider_returned','ticket_issued','ticket_exchanged','cancelled','expired','failed')),
  install_id uuid,
  funnel_attempt_id uuid,
  provider text NOT NULL CHECK(provider IN ('google','github')),
  platform text,
  version text,
  internal boolean NOT NULL,
  error_code text,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY(attempt_id,stage)
);
-- Installation onboarding can return from GitHub twice in one attempt.
ALTER TABLE signin_attempt_events DROP CONSTRAINT IF EXISTS signin_attempt_events_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS signin_attempt_events_once
  ON signin_attempt_events(attempt_id,stage) WHERE stage <> 'provider_returned';
CREATE INDEX IF NOT EXISTS signin_attempt_events_attempt ON signin_attempt_events(attempt_id);
CREATE INDEX IF NOT EXISTS signin_attempt_events_date ON signin_attempt_events(occurred_at);
CREATE INDEX IF NOT EXISTS signin_attempt_events_install ON signin_attempt_events(install_id,funnel_attempt_id);
CREATE TABLE IF NOT EXISTS signin_funnel_daily (
  day date NOT NULL,
  platform text NOT NULL,
  event text NOT NULL,
  provider text NOT NULL,
  outcome text NOT NULL,
  installs bigint NOT NULL,
  PRIMARY KEY(day,platform,event,provider,outcome)
);
CREATE TABLE IF NOT EXISTS store_download_days (
  platform text NOT NULL CHECK (platform IN ('ios','android')),
  day date NOT NULL,
  installs bigint CHECK (installs >= 0 AND installs <= 9007199254740991),
  source text NOT NULL,
  fetched_at timestamptz,
  attempted_at timestamptz NOT NULL,
  final boolean NOT NULL DEFAULT false,
  PRIMARY KEY(platform,day)
);
CREATE TABLE IF NOT EXISTS operator_function_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  function_name text NOT NULL CHECK (function_name IN
    ('page_load','message_delivery','corner_open','attachment_upload')),
  duration_ms integer NOT NULL CHECK (duration_ms >= 0 AND duration_ms <= 600000),
  network_rtt_residual_ms integer CHECK (network_rtt_residual_ms >= 0 AND network_rtt_residual_ms <= 15000),
  failed boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS operator_function_events_recent
  ON operator_function_events(created_at DESC);
ALTER TABLE operator_function_events ADD COLUMN IF NOT EXISTS network_rtt_residual_ms integer
  CHECK (network_rtt_residual_ms >= 0 AND network_rtt_residual_ms <= 15000);
ALTER TABLE operator_function_events ADD COLUMN IF NOT EXISTS js_response_delay_ms integer
  CHECK (js_response_delay_ms >= 0 AND js_response_delay_ms <= 600000);
ALTER TABLE push_delivery_claims DROP CONSTRAINT IF EXISTS push_delivery_claims_status_check;
ALTER TABLE push_delivery_claims ADD CONSTRAINT push_delivery_claims_status_check
  CHECK (status IN ('claimed', 'delivered', 'failed', 'suppressed', 'retryable', 'uncertain'));

-- Release announcements and their queued device-registration replays are retired.
DROP TABLE IF EXISTS push_release_catchups;

CREATE TABLE IF NOT EXISTS device_update_receipts (
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  receipt jsonb NOT NULL,
  reported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (identity_id, device_id)
);

-- Attachments queued by an agent's beeline-agent post_artifact tool, drained onto
-- the agent's next final Room reply (see DaemonService.postRoomMessage).
CREATE TABLE IF NOT EXISTS agent_pending_attachments (
  id bigserial PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  url text NOT NULL,
  name text NOT NULL,
  mime_type text NOT NULL,
  size integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE agent_pending_attachments ALTER COLUMN size TYPE integer USING size::integer;
`;
