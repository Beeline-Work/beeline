import { Pool, type PoolClient, type QueryResultRow } from 'pg';

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

  constructor(connectionString: string, maximumConnections = 5) {
    this.#pool = new Pool({ connectionString, max: maximumConnections });
  }

  async query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const raw = values.length
      ? await this.#pool.query<Row>(sql, values)
      : await this.#pool.query<Row>(sql);
    const result = Array.isArray(raw) ? raw.at(-1) : raw;
    return { rows: result?.rows ?? [], rowCount: result?.rowCount ?? result?.rows.length ?? 0 };
  }

  async transaction<T>(work: (database: SqlDatabase) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
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
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  connectDedicated(): Promise<PoolClient> {
    return this.#pool.connect();
  }

  close(): Promise<void> {
    return this.#pool.end();
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS identities (
  id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL CHECK (kind IN ('human', 'agent')),
  name text NOT NULL,
  handle text,
  avatar text,
  github_subject text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS identity_external_links (
  provider text NOT NULL,
  subject text NOT NULL,
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  issuer text NOT NULL,
  audience text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS identity_external_links_identity_idx ON identity_external_links(identity_id);

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

CREATE TABLE IF NOT EXISTS rooms (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES rooms(id) ON DELETE CASCADE,
  name text NOT NULL,
  about text,
  avatar text,
  visibility text NOT NULL DEFAULT 'invite-only' CHECK (visibility IN ('public', 'invite-only')),
  archived_at timestamptz,
  direct_participants jsonb,
  repository_key text,
  repository_remote text,
  repository_target_branch text NOT NULL DEFAULT 'main',
  github_installation_id bigint,
  github_events_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rooms_workspace_idx ON rooms(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS rooms_parent_idx ON rooms(parent_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS memberships (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  room_id uuid REFERENCES rooms(id) ON DELETE CASCADE,
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  generation bigint NOT NULL DEFAULT 1,
  joined_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz
);
CREATE INDEX IF NOT EXISTS memberships_identity_idx ON memberships(identity_id, removed_at);
CREATE UNIQUE INDEX IF NOT EXISTS memberships_workspace_unique
  ON memberships(workspace_id, identity_id) WHERE room_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS memberships_room_unique
  ON memberships(room_id, identity_id) WHERE room_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agents (
  agent_id text PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES identities(id),
  access_policy jsonb NOT NULL DEFAULT '{"type":"creator"}'::jsonb,
  soul jsonb,
  selected_model text,
  selected_effort text,
  model_catalog jsonb NOT NULL DEFAULT '[]'::jsonb,
  commands jsonb NOT NULL DEFAULT '[]'::jsonb,
  schedule_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS schedule_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

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
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_room_page_idx ON messages(room_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS messages_request_idx ON messages(room_id, request_id) WHERE request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_turns (
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  agent_id text NOT NULL REFERENCES identities(id),
  status text NOT NULL CHECK (status IN ('working', 'complete', 'failed')),
  generation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, request_id, agent_id)
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

CREATE TABLE IF NOT EXISTS room_read_marks (
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  message_created_at timestamptz NOT NULL,
  message_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, identity_id)
);

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
  objective text NOT NULL DEFAULT '',
  lifecycle jsonb NOT NULL DEFAULT '{"lifecycle":"unknown","checks":"unknown"}'::jsonb,
  plan jsonb,
  request_id text,
  feature_branch text,
  close_requested boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
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

CREATE TABLE IF NOT EXISTS legacy_media_urls (
  legacy_url text PRIMARY KEY,
  media_id uuid NOT NULL REFERENCES media(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS github_installations (
  installation_id bigint PRIMARY KEY,
  owner_id text NOT NULL REFERENCES identities(id),
  account_login text NOT NULL,
  account_type text NOT NULL,
  encrypted_token text,
  status text NOT NULL DEFAULT 'active',
  updated_at timestamptz NOT NULL DEFAULT now()
);

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
  updated_at timestamptz NOT NULL DEFAULT now()
);

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
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_devices_identity_idx ON push_devices(identity_id);

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
      SELECT DISTINCT (regexp_match(a->>'url','/v1/media/([0-9a-f-]+)$'))[1] id
      FROM messages m CROSS JOIN LATERAL jsonb_array_elements(m.attachments) a
      WHERE a->>'url' ~ '/v1/media/[0-9a-f-]+$'
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
