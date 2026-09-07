import { SCHEDULE_RAN_VERB } from '@beeline/api-contract/scheduled-prompts';
import { seedDefaultWorkspace } from './default-workspace.js';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

const TRANSIENT_CONNECTION_CODES = new Set(['57P01', '08006', '08003', '08000']);
const TRANSIENT_CONNECTION_MESSAGE =
  /Connection terminated|ECONNRESET|server closed the connection|terminating connection/i;
const RETRY_DELAYS_MS = [100, 300, 700];

export function isTransientDatabaseConnectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    (typeof candidate.code === 'string' && TRANSIENT_CONNECTION_CODES.has(candidate.code)) ||
    (typeof candidate.message === 'string' && TRANSIENT_CONNECTION_MESSAGE.test(candidate.message))
  );
}

type Pause = (milliseconds: number) => Promise<void>;

const pause: Pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export interface PostgresDatabaseOptions {
  pool?: Pool;
  pause?: Pause;
}

export interface QueryResult<Row> {
  rows: Row[];
  rowCount: number;
}

export interface SqlDatabase {
  query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
  transaction<T>(work: (database: SqlDatabase) => Promise<T>): Promise<T>;
}

export interface ClosableDatabase extends SqlDatabase {
  close(): Promise<void>;
  connectDedicated(): Promise<PoolClient>;
}

export class PostgresDatabase implements ClosableDatabase {
  readonly #pool: Pool;
  readonly #pause: Pause;

  constructor(
    connectionString: string,
    maximumConnections = 5,
    options: PostgresDatabaseOptions = {},
  ) {
    this.#pool = options.pool ?? new Pool({ connectionString, max: maximumConnections });
    this.#pause = options.pause ?? pause;
    this.#pool.on('error', (error) => {
      console.error('postgres idle client error', error);
    });
  }

  async query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const raw = await this.#retryTransientConnection(() =>
      values.length ? this.#pool.query<Row>(sql, values) : this.#pool.query<Row>(sql),
    );
    const result = Array.isArray(raw) ? raw.at(-1) : raw;
    return { rows: result?.rows ?? [], rowCount: result?.rowCount ?? result?.rows.length ?? 0 };
  }

  async transaction<T>(work: (database: SqlDatabase) => Promise<T>): Promise<T> {
    const client = await this.#beginTransaction();
    let releaseError: Error | undefined;
    try {
      const database: SqlDatabase = {
        query: async <Row extends QueryResultRow = QueryResultRow>(
          sql: string,
          values: unknown[] = [],
        ) => {
          const raw = values.length
            ? await client.query<Row>(sql, values)
            : await client.query<Row>(sql);
          const result = Array.isArray(raw) ? raw.at(-1) : raw;
          return {
            rows: result?.rows ?? [],
            rowCount: result?.rowCount ?? result?.rows.length ?? 0,
          };
        },
        transaction: async <Result>(nested: (database: SqlDatabase) => Promise<Result>) =>
          nested(database),
      };
      const result = await work(database);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (isTransientDatabaseConnectionError(error))
        releaseError = error instanceof Error ? error : new Error('transaction connection failed');
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        // The original error is more useful than a rollback failure on a dead connection.
        releaseError =
          rollbackError instanceof Error ? rollbackError : new Error('transaction rollback failed');
      }
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  async connectDedicated(): Promise<PoolClient> {
    return this.#retryTransientConnection(async () => {
      const client = await this.#pool.connect();
      client.on('error', (error) => {
        console.error('dedicated postgres client error', error);
      });
      return client;
    });
  }

  close(): Promise<void> {
    return this.#pool.end();
  }

  async #beginTransaction(): Promise<PoolClient> {
    return this.#retryTransientConnection(async () => {
      const client = await this.#pool.connect();
      try {
        await client.query('BEGIN');
        return client;
      } catch (error) {
        client.release(error instanceof Error ? error : new Error('transaction begin failed'));
        throw error;
      }
    });
  }

  async #retryTransientConnection<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        if (!isTransientDatabaseConnectionError(error) || attempt >= RETRY_DELAYS_MS.length)
          throw error;
        await this.#pause(RETRY_DELAYS_MS[attempt]!);
      }
    }
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS identities (
  id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL CHECK (kind IN ('human', 'agent')),
  name text NOT NULL,
  handle text,
  avatar text,
  hidden_from_roster boolean NOT NULL DEFAULT false,
  github_subject text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE identities ADD COLUMN IF NOT EXISTS hidden_from_roster boolean NOT NULL DEFAULT false;
ALTER TABLE identities ADD COLUMN IF NOT EXISTS face_id text NULL;

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
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS phone_sessions_identity_idx ON phone_sessions(identity_id, expires_at);

CREATE TABLE IF NOT EXISTS phone_access_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  family_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS phone_access_tokens_expiry_idx ON phone_access_tokens(expires_at);

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

CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  about text,
  avatar text,
  visibility text NOT NULL DEFAULT 'invite-only' CHECK (visibility IN ('public', 'invite-only')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Retained but unused: the workspace-level seeded-souls switch was removed
-- (C99); every agent now always carries its seeded soul as before that
-- switch existed. Dropping the column is left for a later migration.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS seeded_souls_enabled boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS rooms (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES rooms(id) ON DELETE CASCADE,
  created_by text REFERENCES identities(id),
  name text NOT NULL,
  about text,
  avatar text,
  visibility text NOT NULL DEFAULT 'invite-only' CHECK (visibility IN ('public', 'invite-only')),
  archived_at timestamptz,
  direct_participants jsonb,
  repository_key text,
  repository_name text,
  repository_remote text,
  repository_target_branch text NOT NULL DEFAULT 'main',
  repository_updated_at timestamptz,
  repository_resolution text NOT NULL DEFAULT 'none' CHECK (repository_resolution IN ('repository', 'none', 'unverified')),
  github_installation_id bigint,
  github_events_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS created_by text REFERENCES identities(id);
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS repository_updated_at timestamptz;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS repository_name text;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS repository_resolution text NOT NULL DEFAULT 'none';
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
  joined_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz
);
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS identity_profile jsonb;
-- What this member reacts to in THIS Room. An event happens in a Room, so the
-- subscription lives on the Room membership row and not on the identity: an
-- agent in several Rooms would otherwise inherit one Room's job everywhere.
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS event_subscriptions jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS memberships_identity_idx ON memberships(identity_id, removed_at);
CREATE UNIQUE INDEX IF NOT EXISTS memberships_workspace_unique
  ON memberships(workspace_id, identity_id) WHERE room_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS memberships_room_unique
  ON memberships(room_id, identity_id) WHERE room_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agents (
  agent_id text PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES identities(id),
  access_policy jsonb NOT NULL DEFAULT '{"type":"everyone"}'::jsonb,
  soul jsonb,
  selected_model text,
  selected_effort text,
  model_catalog jsonb NOT NULL DEFAULT '[]'::jsonb,
  commands jsonb NOT NULL DEFAULT '[]'::jsonb,
  schedule_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  yolo_mode boolean NOT NULL DEFAULT true,
  yolo_set_by text,
  yolo_set_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS schedule_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS yolo_mode boolean NOT NULL DEFAULT true;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS yolo_set_by text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS yolo_set_at timestamptz;
-- An agent nobody but its owner may address is indistinguishable from a dead one,
-- so a newly connected agent now answers everyone (agent-access.ts). Only the
-- DEFAULT moves: every existing row keeps the policy its owner is running with and
-- changes it from the members page.
ALTER TABLE agents ALTER COLUMN access_policy SET DEFAULT '{"type":"everyone"}'::jsonb;
-- Consent moved from a mid-conversation ask to one up-front owner choice, so yolo is
-- now the default for a NEW agent. Unlike the access_policy default change above,
-- existing rows are flipped too (backfillYoloModeDefault): leaving them behind after
-- the last default change left agents refusing everyone for hours. The two hard
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
  mention_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
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
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS agent_hop_count integer NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS system_event jsonb;
-- Where an event line came from. The cause is the message that triggered the
-- turn that emitted it; the root is the first line of that whole cascade, and
-- the depth is how far this line sits from it. Columns rather than more json
-- because the loop guard COUNTS over the root and the partial index is what
-- makes that count cheap; nothing outside a cascade carries them.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS event_cause_id text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS event_root_cause_id text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS event_depth integer;
CREATE INDEX IF NOT EXISTS messages_event_root_idx ON messages(event_root_cause_id)
  WHERE event_root_cause_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_room_page_idx ON messages(room_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS messages_request_idx ON messages(room_id, request_id) WHERE request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS legacy_room_events (
  id text PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  kind integer NOT NULL,
  created_at timestamptz NOT NULL,
  raw_page_candidate boolean NOT NULL DEFAULT true,
  conversation_candidate boolean NOT NULL DEFAULT false
);
ALTER TABLE legacy_room_events ADD COLUMN IF NOT EXISTS raw_page_candidate boolean NOT NULL DEFAULT true;
ALTER TABLE legacy_room_events ADD COLUMN IF NOT EXISTS conversation_candidate boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS legacy_room_events_page_idx
  ON legacy_room_events(room_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS agent_turns (
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  agent_id text NOT NULL REFERENCES identities(id),
  status text NOT NULL CHECK (status IN ('working', 'complete', 'failed')),
  generation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  failure_reason text,
  PRIMARY KEY (room_id, request_id, agent_id)
);
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS failure_reason text;

CREATE TABLE IF NOT EXISTS live_outputs (
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES identities(id),
  turn_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('draft', 'thought', 'presence')),
  body jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, agent_id, turn_id, kind)
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

CREATE TABLE IF NOT EXISTS mission_authority (
  mission_id text NOT NULL,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  principal_id text NOT NULL REFERENCES identities(id),
  exercise text NOT NULL,
  status text NOT NULL CHECK (status IN ('authorized', 'denied', 'unavailable')),
  generation bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (mission_id, room_id, principal_id, exercise)
);

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

CREATE TABLE IF NOT EXISTS schedule_receipts (
  schedule_id text NOT NULL,
  occurrence_id text NOT NULL,
  agent_id text NOT NULL REFERENCES identities(id),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (schedule_id, occurrence_id)
);

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
CREATE INDEX IF NOT EXISTS agent_schedules_due_idx ON agent_schedules(next_run_at, id);
CREATE INDEX IF NOT EXISTS agent_schedules_room_idx ON agent_schedules(room_id, created_at, id);
ALTER TABLE agent_schedules ADD COLUMN IF NOT EXISTS max_runs integer;
ALTER TABLE agent_schedules ADD COLUMN IF NOT EXISTS run_count integer NOT NULL DEFAULT 0;

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
  PRIMARY KEY (agent_id, room_id)
);

CREATE TABLE IF NOT EXISTS corner_facts (
  corner_id uuid PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  owner_agent_id text REFERENCES identities(id),
  objective text NOT NULL DEFAULT '',
  lifecycle jsonb NOT NULL DEFAULT '{"lifecycle":"unknown","checks":"unknown"}'::jsonb,
  plan jsonb,
  request_id text,
  feature_branch text,
  close_requested boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE corner_facts ADD COLUMN IF NOT EXISTS owner_agent_id text REFERENCES identities(id);
CREATE INDEX IF NOT EXISTS corner_facts_owner_agent_idx ON corner_facts(owner_agent_id);

CREATE TABLE IF NOT EXISTS corner_check_facts (
  corner_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  name text NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','passed','failed')),
  conclusion text,
  url text,
  head_sha text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (corner_id, name)
);

CREATE TABLE IF NOT EXISTS corner_merge_approvals (
  corner_id uuid PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  approved_by text NOT NULL REFERENCES identities(id),
  force boolean NOT NULL DEFAULT false,
  approved_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invites (
  token_hash text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by text NOT NULL REFERENCES identities(id),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE TABLE IF NOT EXISTS agent_pairing_codes (
  code_hash text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by text NOT NULL REFERENCES identities(id),
  expires_at timestamptz NOT NULL,
  claimed_by text REFERENCES identities(id),
  claimed_at timestamptz
);

CREATE TABLE IF NOT EXISTS media (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES identities(id),
  bytes bytea NOT NULL,
  mime_type text NOT NULL,
  name text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, sha256)
);
CREATE INDEX IF NOT EXISTS media_sha_idx ON media(sha256);
CREATE INDEX IF NOT EXISTS media_created_idx ON media(created_at);

-- Bytes expire (media-ttl.ts); the fact that they existed does not. One row per
-- swept media id, so the media endpoint answers 410 Gone instead of 404 and the
-- attachment projection can state expiry as a fact rather than infer it.
CREATE TABLE IF NOT EXISTS media_expirations (
  id uuid PRIMARY KEY,
  expired_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS legacy_media_urls (
  legacy_url text PRIMARY KEY,
  media_id uuid NOT NULL REFERENCES media(id) ON DELETE CASCADE
);

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
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE TABLE IF NOT EXISTS push_devices (
  token text PRIMARY KEY,
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('android', 'ios')),
  environment text NOT NULL CHECK (environment IN ('physical', 'emulator')),
  registered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE push_devices ADD COLUMN IF NOT EXISTS registered_at timestamptz;
UPDATE push_devices SET registered_at=updated_at WHERE registered_at IS NULL;
ALTER TABLE push_devices ALTER COLUMN registered_at SET DEFAULT now();
ALTER TABLE push_devices ALTER COLUMN registered_at SET NOT NULL;
CREATE INDEX IF NOT EXISTS push_devices_identity_idx ON push_devices(identity_id);

CREATE TABLE IF NOT EXISTS push_delivery_floors (
  id text PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_join_notifications (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  room_id uuid REFERENCES rooms(id) ON DELETE SET NULL,
  joining_identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_join_notification_devices (
  notification_id text NOT NULL REFERENCES workspace_join_notifications(id) ON DELETE CASCADE,
  device_token text NOT NULL REFERENCES push_devices(token) ON DELETE CASCADE,
  PRIMARY KEY (notification_id, device_token)
);

CREATE TABLE IF NOT EXISTS push_delivery_claims (
  message_id text NOT NULL,
  device_token text NOT NULL REFERENCES push_devices(token) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('claimed', 'delivered', 'failed')),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error text,
  PRIMARY KEY (message_id, device_token)
);

CREATE TABLE IF NOT EXISTS device_update_receipts (
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  receipt jsonb NOT NULL,
  reported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (identity_id, device_id)
);

-- Attachments queued by an agent's beeline-agent attach_file tool, drained onto
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

-- Agent Grants (slice 2): the grant store. One row per ask; a 'once' grant is
-- spent by setting expires_at at its first run; revoke flips status.
CREATE TABLE IF NOT EXISTS agent_grants (
  id uuid PRIMARY KEY,
  agent_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('path','host','secret','device','budget','command')),
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
CREATE INDEX IF NOT EXISTS agent_grants_agent_idx ON agent_grants(agent_id, workspace_id, status);
CREATE INDEX IF NOT EXISTS agent_grants_room_idx ON agent_grants(room_id, created_at DESC);

CREATE TABLE IF NOT EXISTS import_runs (
  import_id text PRIMARY KEY,
  source_fingerprint text NOT NULL,
  state text NOT NULL CHECK (state IN ('running', 'complete', 'failed')),
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error text
);

CREATE TABLE IF NOT EXISTS import_items (
  import_id text NOT NULL REFERENCES import_runs(import_id) ON DELETE CASCADE,
  source_type text NOT NULL,
  source_id text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (import_id, source_type, source_id)
);
`;

export async function migrate(database: SqlDatabase): Promise<void> {
  await database.query(SCHEMA);
  await backfillCornerOwners(database);
  await backfillSystemEventKinds(database);
  await backfillYoloModeDefault(database);
  await seedDefaultWorkspace(database);
}

/**
 * Flips every existing agent to the new yolo default. Explicit and unconditional —
 * the access_policy default change left old rows behind and the captain's agents
 * spent hours silently refusing people; this time the migration itself moves them,
 * and logs exactly how many rows it touched so a deploy's logs carry the count.
 */
export async function backfillYoloModeDefault(database: SqlDatabase): Promise<number> {
  const result = await database.query(`UPDATE agents SET yolo_mode = true WHERE yolo_mode = false`);
  console.log(`backfillYoloModeDefault: flipped ${result.rowCount} agent row(s) to yolo_mode=true`);
  return result.rowCount;
}

/**
 * Scheduled-prompt lines predate the `kind` beside their verb. They are the one
 * shape a live subscriber can already be waiting on, so they are stamped; older
 * join/corner/check lines get nothing, because no subscriber can want an event
 * that already happened. Idempotent through the `IS NULL` guard.
 */
export async function backfillSystemEventKinds(database: SqlDatabase): Promise<void> {
  await database.query(
    `UPDATE messages SET system_event = system_event || jsonb_build_object('kind','schedule-ran')
     WHERE system_event->>'verb' = $1 AND system_event->>'kind' IS NULL`,
    [SCHEDULE_RAN_VERB],
  );
}

/**
 * Older corners predate an explicit owner fact. The creating agent is authoritative
 * when present; imported/legacy corners fall back to their first agent-authored post.
 */
export async function backfillCornerOwners(database: SqlDatabase): Promise<void> {
  await database.query(`
    UPDATE corner_facts fact
    SET owner_agent_id=COALESCE(
      (
        SELECT room.created_by FROM rooms room JOIN identities agent ON agent.id=room.created_by
        WHERE room.id=fact.corner_id AND agent.kind='agent'
      ),
      (
        SELECT message.author_id FROM messages message JOIN identities agent ON agent.id=message.author_id
        WHERE message.room_id=fact.corner_id AND agent.kind='agent'
        ORDER BY message.created_at,message.id LIMIT 1
      )
    )
    WHERE fact.owner_agent_id IS NULL
  `);
}

export async function measureDatabase(database: SqlDatabase): Promise<{
  tables: Array<{ name: string; bytes: number }>;
  totalBytes: number;
  fitsNeonFree: boolean;
}> {
  const result = await database.query<{ name: string; bytes: string }>(`
    SELECT c.relname AS name, pg_total_relation_size(c.oid)::text AS bytes
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  `);
  const tables = result.rows.map((row) => ({ name: row.name, bytes: Number(row.bytes) }));
  const totalBytes = tables.reduce((sum, row) => sum + row.bytes, 0);
  return { tables, totalBytes, fitsNeonFree: totalBytes < 500_000_000 };
}

export async function measureDatabaseBreakdown(database: SqlDatabase): Promise<{
  topTables: Array<{ name: string; bytes: number }>;
  eventTypes: Array<{ type: string; rows: number; logicalBytes: number }>;
  media: Array<{ type: string; objects: number; bytes: number }>;
}> {
  const total = await measureDatabase(database);
  const events = await database.query<{ type: string; rows: string; logical_bytes: string }>(`
    WITH message_types AS (
      SELECT CASE
        WHEN m.presentation='activity' THEN 'activity'
        WHEN m.durable_fact IS NOT NULL OR m.card_type IN ('daemon-fact','github-event','corner','target-branch') THEN 'facts'
        WHEN i.kind='human' AND m.presentation='message' THEN 'human-messages'
        WHEN i.kind='agent' AND m.presentation='message' THEN 'agent-messages'
        WHEN m.legacy_event->>'retired'='true' THEN 'retired-kinds'
        ELSE 'other-kept-events' END type, pg_column_size(m)::bigint bytes
      FROM messages m JOIN identities i ON i.id=m.author_id
    ), operational AS (
      SELECT 'receipts' type,pg_column_size(t)::bigint bytes FROM agent_turns t
      UNION ALL SELECT 'presence-adjacent',pg_column_size(l)::bigint FROM live_outputs l
    )
    SELECT type,count(*)::text rows,sum(bytes)::text logical_bytes FROM (SELECT * FROM message_types UNION ALL SELECT * FROM operational) typed GROUP BY type ORDER BY sum(bytes) DESC,type`);
  const media = await database.query<{ type: string; objects: string; bytes: string }>(`
    WITH refs AS (
      SELECT DISTINCT (regexp_match(candidate.url,'/v1/media/([0-9a-f-]+)$'))[1] id
      FROM messages m CROSS JOIN LATERAL jsonb_array_elements(m.attachments) a
      CROSS JOIN LATERAL (VALUES(a->>'url'),(a->>'thumbnailUrl')) candidate(url)
      WHERE candidate.url ~ '/v1/media/[0-9a-f-]+$'
    ), classified AS (
      SELECT octet_length(m.bytes)::bigint bytes,
        CASE WHEN refs.id IS NOT NULL THEN 'referenced-by-kept-message'
          WHEN m.name ~* '(canary|test|fixture|sample|probe)' OR EXISTS(SELECT 1 FROM legacy_media_urls l WHERE l.media_id=m.id AND l.legacy_url ~* '(canary|test|fixture|sample|probe)') THEN 'orphan-likely-canary-or-test'
          ELSE 'orphan-unreferenced' END type
      FROM media m LEFT JOIN refs ON refs.id=m.id::text
    ) SELECT type,count(*)::text objects,sum(bytes)::text bytes FROM classified GROUP BY type ORDER BY sum(bytes) DESC,type`);
  const eventByType = new Map(
    events.rows.map((row) => [
      row.type,
      { type: row.type, rows: Number(row.rows), logicalBytes: Number(row.logical_bytes) },
    ]),
  );
  const mediaByType = new Map(
    media.rows.map((row) => [
      row.type,
      { type: row.type, objects: Number(row.objects), bytes: Number(row.bytes) },
    ]),
  );
  return {
    topTables: total.tables.sort((left, right) => right.bytes - left.bytes).slice(0, 10),
    eventTypes: [
      'human-messages',
      'agent-messages',
      'receipts',
      'activity',
      'facts',
      'presence-adjacent',
      'retired-kinds',
      'other-kept-events',
    ].map((type) => eventByType.get(type) ?? { type, rows: 0, logicalBytes: 0 }),
    media: [
      'referenced-by-kept-message',
      'orphan-unreferenced',
      'orphan-likely-canary-or-test',
    ].map((type) => mediaByType.get(type) ?? { type, objects: 0, bytes: 0 }),
  };
}
