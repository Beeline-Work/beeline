import { scheduleWorkflowSlugSql } from './workflow-admin.js';
export const DATABASE_SCHEMA_INSTITUTIONAL_MEMORY_ITEMS = `CREATE TABLE IF NOT EXISTS institutional_memory_items (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('workspace_fact','human_profile_fact')),
  subject_identity_id text REFERENCES identities(id) ON DELETE CASCADE,
  canonical_key text NOT NULL CHECK (length(canonical_key) BETWEEN 1 AND 160),
  body text NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','stale','archived')),
  source_room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  source_message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  source_corner_id uuid REFERENCES rooms(id) ON DELETE CASCADE,
  audience_kind text NOT NULL CHECK (audience_kind IN ('workspace','human_profile')),
  confidence double precision NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  version integer NOT NULL CHECK (version > 0),
  supersedes_id uuid REFERENCES institutional_memory_items(id) ON DELETE SET NULL,
  created_by_job_id uuid REFERENCES institutional_memory_jobs(id) ON DELETE SET NULL,
  created_by_command_id text,
  repository text,
  target_commit text,
  path text,
  content_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  deleted_at timestamptz,
  CONSTRAINT institutional_memory_items_body_check CHECK (
    (deleted_at IS NULL AND octet_length(convert_to(body,'UTF8')) BETWEEN 1 AND 4000) OR
    (deleted_at IS NOT NULL AND body='')
  ),
  CONSTRAINT institutional_memory_items_creator_check
    CHECK (NOT (created_by_job_id IS NOT NULL AND created_by_command_id IS NOT NULL)),
  CHECK (
    (kind='workspace_fact' AND subject_identity_id IS NULL AND audience_kind='workspace') OR
    (kind='human_profile_fact' AND subject_identity_id IS NOT NULL AND audience_kind='human_profile')
  )
);
ALTER TABLE institutional_memory_items ALTER COLUMN created_by_job_id DROP NOT NULL;
-- created_by_job_id is PROVENANCE, never ownership. RESTRICT aborts
-- DELETE FROM workspaces (the jobs cascade fires before the items cascade), and
-- CASCADE is worse: a curator job queued against one Room can create a
-- consolidated Workspace fact whose own Room is a different one, so deleting
-- the job's Room would silently destroy a fact that Room never held. The item's
-- lifecycle belongs to its workspace, Room and source message; forgetting which
-- job wrote it is the only thing a job delete may do.
ALTER TABLE institutional_memory_items
  DROP CONSTRAINT IF EXISTS institutional_memory_items_created_by_job_id_fkey;
ALTER TABLE institutional_memory_items
  ADD CONSTRAINT institutional_memory_items_created_by_job_id_fkey
  FOREIGN KEY (created_by_job_id) REFERENCES institutional_memory_jobs(id) ON DELETE SET NULL;
ALTER TABLE institutional_memory_items ADD COLUMN IF NOT EXISTS created_by_command_id text;
ALTER TABLE institutional_memory_items ADD COLUMN IF NOT EXISTS explicit_save boolean NOT NULL DEFAULT false;
-- An item's age resets only on save, update, or an end-of-turn used report
-- (last_used_at); being loaded into a snapshot no longer counts as use.
ALTER TABLE institutional_memory_items ADD COLUMN IF NOT EXISTS last_used_at timestamptz;
ALTER TABLE institutional_memory_items ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE institutional_memory_items ADD COLUMN IF NOT EXISTS curated_at timestamptz;
-- Only a keyword match loads an item into a turn. Rows saved before keywords
-- existed take theirs from the words of their canonical key.
ALTER TABLE institutional_memory_items ADD COLUMN IF NOT EXISTS keywords text[] NOT NULL DEFAULT '{}';
UPDATE institutional_memory_items item SET keywords=ARRAY(
  SELECT DISTINCT word FROM regexp_split_to_table(lower(item.canonical_key),'[^a-z0-9]+') word
  WHERE length(word) BETWEEN 3 AND 32
    AND word NOT IN ('the','and','for','with','user','users','requester','prefers','preference',
                     'preferences','fact','facts','workspace','profile','human')
  ORDER BY word LIMIT 6
) WHERE item.keywords='{}' AND item.deleted_at IS NULL AND item.canonical_key<>'standing';
ALTER TABLE institutional_memory_items DROP CONSTRAINT IF EXISTS institutional_memory_items_body_check;
ALTER TABLE institutional_memory_items ADD CONSTRAINT institutional_memory_items_body_check CHECK (
  (deleted_at IS NULL AND octet_length(convert_to(body,'UTF8')) BETWEEN 1 AND 4000) OR
  (deleted_at IS NOT NULL AND body='')
);
ALTER TABLE institutional_memory_items DROP CONSTRAINT IF EXISTS institutional_memory_items_creator_check;
ALTER TABLE institutional_memory_items ADD CONSTRAINT institutional_memory_items_creator_check
  CHECK (NOT (created_by_job_id IS NOT NULL AND created_by_command_id IS NOT NULL));
-- Meaning-based recall: NULL until the embedding cycle fills it (embed on
-- save and backfill are the same query — see institutional-memory-embeddings.ts).
-- embedding_model records which model produced it, so a future model change
-- re-embeds every row instead of silently mixing incompatible vectors.
ALTER TABLE institutional_memory_items ADD COLUMN IF NOT EXISTS embedding vector(1024);
ALTER TABLE institutional_memory_items ADD COLUMN IF NOT EXISTS embedding_model text;
ALTER TABLE institutional_memory_items ADD COLUMN IF NOT EXISTS embedded_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS institutional_memory_items_current_key_idx
  ON institutional_memory_items(
    workspace_id,kind,COALESCE(subject_identity_id,''),canonical_key,audience_kind
  ) WHERE state='active';
CREATE INDEX IF NOT EXISTS institutional_memory_items_workspace_state_idx
  ON institutional_memory_items(workspace_id,state,updated_at DESC,id);
-- source_room_id/source_corner_id/source_message_id cascade from rooms and
-- messages with no index, so deleting a Room or workspace made Postgres
-- sequentially scan this table to find rows to cascade-delete.
CREATE INDEX IF NOT EXISTS institutional_memory_items_source_room_idx
  ON institutional_memory_items(source_room_id);
CREATE INDEX IF NOT EXISTS institutional_memory_items_source_corner_idx
  ON institutional_memory_items(source_corner_id) WHERE source_corner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS institutional_memory_items_source_message_idx
  ON institutional_memory_items(source_message_id);

CREATE TABLE IF NOT EXISTS institutional_memory_item_sources (
  item_id uuid NOT NULL REFERENCES institutional_memory_items(id) ON DELETE CASCADE,
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  PRIMARY KEY(item_id,message_id)
);
CREATE INDEX IF NOT EXISTS institutional_memory_item_sources_message_idx
  ON institutional_memory_item_sources(message_id,item_id);

CREATE TABLE IF NOT EXISTS institutional_context_serves (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  room_id uuid REFERENCES rooms(id) ON DELETE CASCADE,
  -- The agent whose turn this snapshot was fetched for. One message addressing
  -- two agents runs two turns under ONE request id (C107), so (room, request)
  -- alone cannot say whose prompt the real token count belongs to.
  agent_id text REFERENCES identities(id) ON DELETE CASCADE,
  request_id text,
  requester_identity_id text REFERENCES identities(id) ON DELETE CASCADE,
  snapshot_revision bigint NOT NULL DEFAULT 0 CHECK (snapshot_revision >= 0),
  mode text NOT NULL CHECK (mode IN ('shadow','live')),
  served boolean NOT NULL,
  shadow_job_id uuid REFERENCES institutional_memory_jobs(id) ON DELETE CASCADE,
  item_ids uuid[] NOT NULL DEFAULT '{}',
  skill_candidates text[] NOT NULL DEFAULT '{}',
  workspace_fact_bytes integer NOT NULL DEFAULT 0 CHECK (workspace_fact_bytes >= 0),
  profile_bytes integer NOT NULL DEFAULT 0 CHECK (profile_bytes >= 0),
  skill_index_bytes integer NOT NULL DEFAULT 0 CHECK (skill_index_bytes >= 0),
  wrapper_bytes integer NOT NULL DEFAULT 0 CHECK (wrapper_bytes >= 0),
  total_bytes integer NOT NULL DEFAULT 0 CHECK (total_bytes BETWEEN 0 AND 8000),
  estimated_tokens integer NOT NULL DEFAULT 0 CHECK (estimated_tokens >= 0),
  actual_input_tokens integer CHECK (actual_input_tokens IS NULL OR actual_input_tokens >= 0),
  -- The exact byte length of the prompt the harness actually answered. The p95
  -- budget gate divides the harness's real token count through this figure to
  -- attribute the institutional block's own share, so it is measured at the
  -- send boundary rather than estimated here.
  prompt_bytes integer CHECK (prompt_bytes IS NULL OR prompt_bytes > 0),
  candidate_count integer NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  dropped_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (mode<>'shadow' OR (served=false AND total_bytes=0 AND cardinality(item_ids)=0))
);
ALTER TABLE institutional_context_serves
  ADD COLUMN IF NOT EXISTS prompt_bytes integer;
ALTER TABLE institutional_context_serves
  DROP CONSTRAINT IF EXISTS institutional_context_serves_prompt_bytes_check;
ALTER TABLE institutional_context_serves
  ADD CONSTRAINT institutional_context_serves_prompt_bytes_check
  CHECK (prompt_bytes IS NULL OR prompt_bytes > 0);
ALTER TABLE institutional_context_serves
  ADD COLUMN IF NOT EXISTS agent_id text REFERENCES identities(id) ON DELETE CASCADE;
-- search_memory is the fallback tool this same turn reaches for when the
-- snapshot above missed; both counters ride the serve row a turn already has
-- so the body-side turn trace can read them back after the turn settles
-- (getInstitutionalMemoryTurnStats) with no new table.
ALTER TABLE institutional_context_serves
  ADD COLUMN IF NOT EXISTS search_memory_calls integer NOT NULL DEFAULT 0;
ALTER TABLE institutional_context_serves
  ADD COLUMN IF NOT EXISTS search_memory_misses integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS institutional_context_serves_turn_idx
  ON institutional_context_serves(room_id,request_id,agent_id) WHERE mode='live';
CREATE UNIQUE INDEX IF NOT EXISTS institutional_context_serves_shadow_job_idx
  ON institutional_context_serves(shadow_job_id) WHERE shadow_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS institutional_context_serves_workspace_created_idx
  ON institutional_context_serves(workspace_id,created_at,id);

CREATE TABLE IF NOT EXISTS institutional_memory_outcomes (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  serve_id uuid REFERENCES institutional_context_serves(id) ON DELETE CASCADE,
  job_id uuid REFERENCES institutional_memory_jobs(id) ON DELETE CASCADE,
  room_id uuid REFERENCES rooms(id) ON DELETE CASCADE,
  request_id text,
  kind text NOT NULL CHECK (kind IN (
    'shadow_extracted','turn_completed','ci_green','merged','repeat_correction','repeat_review_finding'
  )),
  success boolean,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (serve_id IS NOT NULL OR job_id IS NOT NULL)
);
ALTER TABLE institutional_memory_outcomes
  DROP CONSTRAINT IF EXISTS institutional_memory_outcomes_kind_check;
ALTER TABLE institutional_memory_outcomes
  ADD CONSTRAINT institutional_memory_outcomes_kind_check CHECK (kind IN (
    'shadow_extracted','memory_extracted','turn_completed','ci_green','merged',
    'procedure_extracted','curator_completed','repeat_correction','repeat_review_finding'
  ));
-- A corner's own outcome — the merge and the green check — belongs to the corner,
-- not to a serve or a job: the recurring-work cycle-time and yield cohorts
-- compare corners that memory reached with corners it never did, so the
-- unserved half must be recordable at all. Exactly one anchor stays required.
ALTER TABLE institutional_memory_outcomes
  DROP CONSTRAINT IF EXISTS institutional_memory_outcomes_check;
ALTER TABLE institutional_memory_outcomes
  ADD CONSTRAINT institutional_memory_outcomes_check
  CHECK (serve_id IS NOT NULL OR job_id IS NOT NULL OR room_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS institutional_memory_outcomes_workspace_created_idx
  ON institutional_memory_outcomes(workspace_id,created_at,id);
-- room_id cascades from rooms with no index, so deleting a Room or workspace
-- made Postgres sequentially scan this table to find rows to cascade-delete.
CREATE INDEX IF NOT EXISTS institutional_memory_outcomes_room_idx
  ON institutional_memory_outcomes(room_id) WHERE room_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS institutional_memory_correction_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requester_identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  job_id uuid NOT NULL UNIQUE REFERENCES institutional_memory_jobs(id) ON DELETE CASCADE,
  source_room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  source_message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  canonical_key text NOT NULL CHECK (length(canonical_key) BETWEEN 1 AND 160),
  body text NOT NULL CHECK (octet_length(convert_to(body,'UTF8')) BETWEEN 1 AND 4000),
  memory_kind text NOT NULL CHECK (memory_kind IN ('workspace_fact','human_profile_fact')),
  classifier_version text NOT NULL,
  confidence double precision NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS institutional_memory_corrections_baseline_idx
  ON institutional_memory_correction_events(workspace_id,requester_identity_id,created_at,id);
-- source_room_id/source_message_id cascade from rooms/messages with no index,
-- so deleting a Room or workspace made Postgres sequentially scan this table
-- to find rows to cascade-delete.
CREATE INDEX IF NOT EXISTS institutional_memory_corrections_source_room_idx
  ON institutional_memory_correction_events(source_room_id);
CREATE INDEX IF NOT EXISTS institutional_memory_corrections_source_message_idx
  ON institutional_memory_correction_events(source_message_id);

CREATE TABLE IF NOT EXISTS institutional_memory_fact_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id uuid NOT NULL UNIQUE REFERENCES institutional_memory_jobs(id) ON DELETE CASCADE,
  source_room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  source_message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  canonical_key text NOT NULL CHECK (length(canonical_key) BETWEEN 1 AND 160),
  body text NOT NULL CHECK (octet_length(convert_to(body,'UTF8')) BETWEEN 1 AND 4000),
  classifier_version text NOT NULL,
  confidence double precision NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS institutional_memory_facts_workspace_created_idx
  ON institutional_memory_fact_events(workspace_id,created_at,id);
-- source_room_id/source_message_id cascade from rooms/messages with no index,
-- so deleting a Room or workspace made Postgres sequentially scan this table
-- to find rows to cascade-delete.
CREATE INDEX IF NOT EXISTS institutional_memory_facts_source_room_idx
  ON institutional_memory_fact_events(source_room_id);
CREATE INDEX IF NOT EXISTS institutional_memory_facts_source_message_idx
  ON institutional_memory_fact_events(source_message_id);
ALTER TABLE institutional_memory_fact_events
  DROP CONSTRAINT IF EXISTS institutional_memory_fact_events_job_id_key;
ALTER TABLE institutional_memory_fact_events
  ADD COLUMN IF NOT EXISTS retirement_reason text;
ALTER TABLE institutional_memory_fact_events
  ADD COLUMN IF NOT EXISTS target_item_id uuid REFERENCES institutional_memory_items(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS institutional_history_searches (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  output_room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  request_id text,
  requester_identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  query_hash text NOT NULL CHECK (query_hash ~ '^[0-9a-f]{64}$'),
  authorized_room_count integer NOT NULL CHECK (authorized_room_count >= 0),
  result_count integer NOT NULL CHECK (result_count BETWEEN 0 AND 10),
  omitted_count integer NOT NULL CHECK (omitted_count >= 0),
  matches_capped boolean NOT NULL DEFAULT false,
  latency_ms integer NOT NULL CHECK (latency_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE institutional_history_searches
  ADD COLUMN IF NOT EXISTS matches_capped boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS institutional_history_searches_workspace_created_idx
  ON institutional_history_searches(workspace_id,created_at,id);
CREATE INDEX IF NOT EXISTS institutional_history_searches_output_room_idx
  ON institutional_history_searches(output_room_id);

CREATE TABLE IF NOT EXISTS workspace_skills (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug)<=64),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 60),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','stale','archived')),
  current_version integer NOT NULL CHECK (current_version > 0),
  revision bigint NOT NULL CHECK (revision > 0),
  source_room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  repository text NOT NULL,
  target_commit text NOT NULL,
  path text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_served_at timestamptz,
  curated_at timestamptz,
  UNIQUE(workspace_id,slug)
);
ALTER TABLE workspace_skills ADD COLUMN IF NOT EXISTS curated_at timestamptz;
-- The git blob id of the anchored file AT the recorded commit, filled by the
-- server's own GitHub read (never asserted by a model), plus the outcome of the
-- last comparison against the repository's current code. A procedure whose
-- anchored file no longer matches is stale advice whatever its age, so the
-- anchor pass and the aging pass both end in the same state vocabulary.
ALTER TABLE workspace_skills ADD COLUMN IF NOT EXISTS code_content_hash text;
ALTER TABLE workspace_skills DROP CONSTRAINT IF EXISTS workspace_skills_code_content_hash_check;
ALTER TABLE workspace_skills ADD CONSTRAINT workspace_skills_code_content_hash_check
  CHECK (code_content_hash IS NULL OR code_content_hash ~ '^[0-9a-f]{40}$');
ALTER TABLE workspace_skills ADD COLUMN IF NOT EXISTS anchor_checked_at timestamptz;
ALTER TABLE workspace_skills ADD COLUMN IF NOT EXISTS anchor_stale_at timestamptz;
ALTER TABLE workspace_skills ADD COLUMN IF NOT EXISTS anchor_stale_reason text;
ALTER TABLE workspace_skills DROP CONSTRAINT IF EXISTS workspace_skills_anchor_stale_reason_check;
ALTER TABLE workspace_skills ADD CONSTRAINT workspace_skills_anchor_stale_reason_check
  CHECK (anchor_stale_reason IS NULL OR length(anchor_stale_reason)<=300);
-- Meaning-based skill lookup (same hybrid as institutional_memory_items,
-- extended to workspace_skills per AGENTS.md's core-workflow note). Embeds
-- slug + description + a short body summary; embedding_version is the
-- current_version the vector answers for, so a new revision re-embeds
-- through the same embed-on-save-and-backfill cycle with no separate job.
ALTER TABLE workspace_skills ADD COLUMN IF NOT EXISTS embedding vector(1024);
ALTER TABLE workspace_skills ADD COLUMN IF NOT EXISTS embedding_model text;
ALTER TABLE workspace_skills ADD COLUMN IF NOT EXISTS embedding_version integer;
ALTER TABLE workspace_skills ADD COLUMN IF NOT EXISTS embedded_at timestamptz;
CREATE INDEX IF NOT EXISTS workspace_skills_catalog_idx
  ON workspace_skills(workspace_id,state,updated_at DESC,id);
CREATE INDEX IF NOT EXISTS workspace_skills_source_room_idx ON workspace_skills(source_room_id);
-- A workflow row is a skill row: a declarative contract, saved/discovered/loaded
-- through the exact same table, index, and load_workspace_skill path as a
-- procedure. repository/target_commit stay populated with '' for a workflow
-- row, which is not anchored to a repo+commit the way a procedure is.
ALTER TABLE workspace_skills ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'procedure';
ALTER TABLE workspace_skills DROP CONSTRAINT IF EXISTS workspace_skills_kind_check;
ALTER TABLE workspace_skills ADD CONSTRAINT workspace_skills_kind_check
  CHECK (kind IN ('procedure','workflow'));

CREATE TABLE IF NOT EXISTS workspace_skill_versions (
  skill_id uuid NOT NULL REFERENCES workspace_skills(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  markdown text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  source_job_id uuid NOT NULL REFERENCES institutional_memory_jobs(id) ON DELETE CASCADE,
  source_message_ids text[] NOT NULL CHECK (cardinality(source_message_ids)>0),
  repository text NOT NULL,
  target_commit text NOT NULL,
  path text,
  extractor_version text NOT NULL,
  model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  source_deleted_at timestamptz,
  PRIMARY KEY(skill_id,version),
  CONSTRAINT workspace_skill_versions_markdown_check CHECK (
    (source_deleted_at IS NULL AND octet_length(convert_to(markdown,'UTF8')) BETWEEN 1 AND 32768) OR
    (source_deleted_at IS NOT NULL AND markdown='')
  )
);
ALTER TABLE workspace_skill_versions ADD COLUMN IF NOT EXISTS source_deleted_at timestamptz;
ALTER TABLE workspace_skill_versions
  DROP CONSTRAINT IF EXISTS workspace_skill_versions_markdown_check;
ALTER TABLE workspace_skill_versions
  ADD CONSTRAINT workspace_skill_versions_markdown_check CHECK (
    (source_deleted_at IS NULL AND octet_length(convert_to(markdown,'UTF8')) BETWEEN 1 AND 32768) OR
    (source_deleted_at IS NOT NULL AND markdown='')
  );
-- A workflow save is synchronous, inside one tool call, never a queued
-- institutional_memory_jobs row: save_workflow writes NULL here.
ALTER TABLE workspace_skill_versions ALTER COLUMN source_job_id DROP NOT NULL;
-- delete_skill archives the row and records who deleted it and the messages
-- that justified it; the versions stay. A later save of the slug restores it.
ALTER TABLE workspace_skills ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE workspace_skills ADD COLUMN IF NOT EXISTS deleted_by text;
ALTER TABLE workspace_skills ADD COLUMN IF NOT EXISTS deleted_source_message_ids text[];

CREATE TABLE IF NOT EXISTS institutional_review_findings (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES institutional_memory_jobs(id) ON DELETE CASCADE,
  source_corner_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  taxonomy text NOT NULL CHECK (length(taxonomy) BETWEEN 1 AND 120),
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 1000),
  severity text NOT NULL CHECK (severity IN ('info','warning','error')),
  path text,
  classifier_version text NOT NULL,
  confidence double precision NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS institutional_review_findings_repeat_idx
  ON institutional_review_findings(workspace_id,taxonomy,path,created_at,id);
CREATE INDEX IF NOT EXISTS institutional_review_findings_source_corner_idx
  ON institutional_review_findings(source_corner_id);

CREATE TABLE IF NOT EXISTS workspace_skill_uses (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  skill_id uuid NOT NULL REFERENCES workspace_skills(id) ON DELETE CASCADE,
  skill_version integer NOT NULL,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  request_id text,
  requester_identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(skill_id,skill_version)
    REFERENCES workspace_skill_versions(skill_id,version) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS workspace_skill_uses_workspace_created_idx
  ON workspace_skill_uses(workspace_id,created_at,id);
CREATE INDEX IF NOT EXISTS workspace_skill_uses_room_idx ON workspace_skill_uses(room_id);

CREATE TABLE IF NOT EXISTS institutional_memory_workspace_rollouts (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  stage text NOT NULL DEFAULT 'live' CHECK (stage IN ('off','shadow','pilot','live','paused')),
  stale_after_days integer NOT NULL DEFAULT 30 CHECK (stale_after_days BETWEEN 7 AND 3650),
  archive_after_days integer NOT NULL DEFAULT 90 CHECK (archive_after_days BETWEEN 14 AND 7300),
  retention_days integer NOT NULL DEFAULT 365 CHECK (retention_days BETWEEN 30 AND 7300),
  expire_after_days integer NOT NULL DEFAULT 90 CHECK (expire_after_days BETWEEN 1 AND 7300),
  -- Unread since explicit saves stopped expiring; kept for older server images.
  explicit_expire_after_days integer NOT NULL DEFAULT 365 CHECK (explicit_expire_after_days BETWEEN 1 AND 7300),
  daily_token_budget integer NOT NULL DEFAULT 100000 CHECK (daily_token_budget BETWEEN 1000 AND 10000000),
  availability_observed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (archive_after_days > stale_after_days),
  CHECK (retention_days >= archive_after_days)
);
-- Institutional memory is on by default. 'off'/'paused' are the explicit off
-- switches; nothing starts in 'shadow'/'pilot', and the release migration
-- (backfillInstitutionalMemoryRollout) advances any existing staged rows to
-- 'live' and enrolls every Workspace that has no row yet.
ALTER TABLE institutional_memory_workspace_rollouts ALTER COLUMN stage SET DEFAULT 'live';
ALTER TABLE institutional_memory_workspace_rollouts
  ADD COLUMN IF NOT EXISTS availability_observed_at timestamptz;
ALTER TABLE institutional_memory_workspace_rollouts
  ADD COLUMN IF NOT EXISTS expire_after_days integer NOT NULL DEFAULT 90;
ALTER TABLE institutional_memory_workspace_rollouts
  ADD COLUMN IF NOT EXISTS explicit_expire_after_days integer NOT NULL DEFAULT 365;

-- Every span in which no authorized helper host could serve this Workspace.
-- Lifecycle aging subtracts these spans, so nothing goes stale, archived or
-- past retention only because a host was offline while the calendar advanced.
CREATE TABLE IF NOT EXISTS institutional_host_availability_gaps (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  CHECK (ended_at > started_at)
);
CREATE INDEX IF NOT EXISTS institutional_host_availability_gaps_workspace_idx
  ON institutional_host_availability_gaps(workspace_id,ended_at,started_at);

CREATE TABLE IF NOT EXISTS institutional_curator_cycles (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  cycle_key text NOT NULL,
  queued_jobs integer NOT NULL DEFAULT 0 CHECK (queued_jobs >= 0),
  stale_items integer NOT NULL DEFAULT 0 CHECK (stale_items >= 0),
  archived_items integer NOT NULL DEFAULT 0 CHECK (archived_items >= 0),
  stale_skills integer NOT NULL DEFAULT 0 CHECK (stale_skills >= 0),
  archived_skills integer NOT NULL DEFAULT 0 CHECK (archived_skills >= 0),
  consolidated_items integer NOT NULL DEFAULT 0 CHECK (consolidated_items >= 0),
  consolidated_skills integer NOT NULL DEFAULT 0 CHECK (consolidated_skills >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(workspace_id,cycle_key)
);

-- Public, credential-free connector discovery shared across server instances.
CREATE TABLE IF NOT EXISTS connector_discovery_cache (
  cache_key text PRIMARY KEY,
  manifests jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS live_outputs (
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES identities(id),
  turn_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('draft', 'thought', 'presence')),
  body jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, agent_id, turn_id, kind)
);

CREATE INDEX IF NOT EXISTS live_outputs_agent_presence ON live_outputs(agent_id,updated_at DESC) WHERE kind='presence';

-- One row per agent: the newest live connection a helper holds for it. The
-- epoch only grows, so a late close of an older socket (on any server
-- instance) can never release a newer connection.
CREATE TABLE IF NOT EXISTS agent_connections (
  agent_id text PRIMARY KEY,
  epoch bigint NOT NULL,
  connection_id text NOT NULL,
  instance_id text NOT NULL,
  connected_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);
CREATE INDEX IF NOT EXISTS agent_connections_held ON agent_connections(instance_id) WHERE released_at IS NULL;

-- Each server instance renews its own row; an instance that stops renewing
-- releases the connections it held, so a crashed server's agents go offline.
CREATE TABLE IF NOT EXISTS live_server_instances (
  instance_id text PRIMARY KEY,
  renewed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS room_read_marks (
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  message_created_at timestamptz NOT NULL,
  message_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, identity_id)
);
-- Clients send a message id, but their clock representation can lose the
-- microseconds needed by the ordered unread comparison. Repair pre-existing
-- marks from the canonical stored message timestamp.
UPDATE room_read_marks
SET message_created_at=messages.created_at
FROM messages
WHERE messages.id=room_read_marks.message_id
  AND messages.room_id=room_read_marks.room_id;

CREATE TABLE IF NOT EXISTS permission_authority (
  permission_id text PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  principal_id text NOT NULL REFERENCES identities(id),
  request_id text NOT NULL,
  action_id text,
  scope jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'authorized', 'denied', 'unavailable', 'started', 'succeeded', 'failed')),
  generation bigint NOT NULL DEFAULT 1,
  result text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS permission_authority_room_idx ON permission_authority(room_id);

-- Retired: empty in production on 2026-11-02 and written by nothing on main.

CREATE TABLE IF NOT EXISTS work_schedules (
  schedule_id text NOT NULL,
  agent_id text NOT NULL REFERENCES identities(id),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  schedule jsonb NOT NULL,
  authority_status text NOT NULL DEFAULT 'authorized',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (schedule_id, revision)
);
CREATE INDEX IF NOT EXISTS work_schedules_agent_idx ON work_schedules(agent_id, room_id);
CREATE INDEX IF NOT EXISTS work_schedules_room_idx ON work_schedules(room_id);

CREATE TABLE IF NOT EXISTS schedule_receipts (
  schedule_id text NOT NULL,
  occurrence_id text NOT NULL,
  agent_id text NOT NULL REFERENCES identities(id),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (schedule_id, occurrence_id)
);
CREATE INDEX IF NOT EXISTS schedule_receipts_room_idx ON schedule_receipts(room_id);

CREATE TABLE IF NOT EXISTS agent_schedules (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES identities(id),
  creator_id text NOT NULL REFERENCES identities(id),
  cadence jsonb NOT NULL,
  message text NOT NULL CHECK (length(trim(message)) > 0),
  max_runs integer,
  run_count integer NOT NULL DEFAULT 0,
  next_run_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS beeline_agent_schedule_due ON agent_schedules;
ALTER TABLE workspace_skills ADD COLUMN IF NOT EXISTS creator_agent_id text REFERENCES identities(id);
ALTER TABLE workspace_skills ADD COLUMN IF NOT EXISTS owner_agent_id text REFERENCES identities(id);
ALTER TABLE workspace_skills ADD COLUMN IF NOT EXISTS ownership_initialized boolean NOT NULL DEFAULT false;
ALTER TABLE agent_schedules ADD COLUMN IF NOT EXISTS workflow_slug text;
ALTER TABLE agent_schedules ADD COLUMN IF NOT EXISTS human_command_message_id text;
ALTER TABLE agent_schedules ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE agent_schedules ADD COLUMN IF NOT EXISTS paused_at timestamptz;
-- Owner-approved labels for the existing #beeline schedules and its corners.
UPDATE agent_schedules SET title=labels.title FROM (VALUES
  ('ea5594a0-42ec-49dd-8957-5582216ebedd'::uuid,'Prompt replay'),
  ('0487e469-2907-47e7-8432-7ec4ec49ad42'::uuid,'Morning card'),
  ('df2db89e-4a28-4db0-9b54-36bd0f671f03'::uuid,'App speed test'),
  ('213bcf80-8846-42b1-9d49-6399b770fe87'::uuid,'Release'),
  ('92803c2f-e007-42af-a244-999750212ae9'::uuid,'Feedback triage'),
  ('b13d3597-6504-4e2a-b89d-b47b02f02e91'::uuid,'Play downloads check')) AS labels(id,title)
WHERE agent_schedules.id=labels.id AND agent_schedules.title IS NULL;

ALTER TABLE agent_schedules ADD COLUMN IF NOT EXISTS last_reported_blocking_run_id text;
ALTER TABLE agent_schedules ADD COLUMN IF NOT EXISTS updated_by text REFERENCES identities(id);
-- Retired: empty in production on 2026-11-02 and written by nothing on main.
WITH resolved AS (
  SELECT schedule.id,${scheduleWorkflowSlugSql('schedule.workspace_id', 'schedule.message')} slug
  FROM agent_schedules schedule WHERE schedule.workflow_slug IS NULL
)
UPDATE agent_schedules schedule SET workflow_slug=resolved.slug
FROM resolved WHERE schedule.id=resolved.id AND resolved.slug IS NOT NULL;
-- A failed occurrence remains parked until an actual schedule revision or due changes.
ALTER TABLE agent_schedules ADD COLUMN IF NOT EXISTS failed_due_at timestamptz;
ALTER TABLE agent_schedules ADD COLUMN IF NOT EXISTS failed_revision timestamptz;
CREATE INDEX IF NOT EXISTS agent_schedules_admitted_due_idx ON agent_schedules(next_run_at,id)
 WHERE failed_due_at IS DISTINCT FROM next_run_at OR failed_revision IS DISTINCT FROM updated_at;
CREATE INDEX IF NOT EXISTS agent_schedules_due_idx ON agent_schedules(next_run_at, id);
CREATE INDEX IF NOT EXISTS agent_schedules_room_idx ON agent_schedules(room_id, created_at, id);
CREATE INDEX IF NOT EXISTS agent_schedules_workspace_idx ON agent_schedules(workspace_id);
ALTER TABLE agent_schedules ADD COLUMN IF NOT EXISTS max_runs integer;
ALTER TABLE agent_schedules ADD COLUMN IF NOT EXISTS run_count integer NOT NULL DEFAULT 0;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
    AND table_name='agent_schedules' AND column_name='workflow_run') THEN
    DELETE FROM agent_schedules WHERE workflow_run IS NOT NULL;
  END IF;
END $$;
ALTER TABLE agent_schedules ADD COLUMN IF NOT EXISTS owner_id text REFERENCES identities(id);

CREATE TABLE IF NOT EXISTS agent_schedule_occurrences (
  schedule_id uuid NOT NULL REFERENCES agent_schedules(id) ON DELETE CASCADE,
  scheduled_for timestamptz NOT NULL,
  message_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (schedule_id, scheduled_for)
);

CREATE TABLE IF NOT EXISTS agent_mandates (
  agent_id text NOT NULL REFERENCES identities(id),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  generation bigint NOT NULL,
  mandate jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
`;
