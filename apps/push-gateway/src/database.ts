import type { NostrEvent } from '@beeline/nostr';
import { Pool } from 'pg';
import type { RelayEventReader } from './metadata.js';

interface QueryResult<Row> {
  rows: Row[];
}

export interface DatabaseQueryable {
  query<Row>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
}

export interface DatabaseTransactional extends DatabaseQueryable {
  transaction<T>(work: (database: DatabaseQueryable) => Promise<T>): Promise<T>;
}

export interface MaterializerReservationPersistence<T> {
  load(): Promise<unknown | undefined>;
  save(value: T): Promise<void>;
}

const MATERIALIZER_RESERVATION_SQL = `
CREATE TABLE IF NOT EXISTS beeline_materializer_reservations (
  consumer text PRIMARY KEY,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

export async function migrateMaterializerReservations(database: DatabaseQueryable): Promise<void> {
  await database.query(MATERIALIZER_RESERVATION_SQL);
}

const ROOM_READ_MARK_SQL = `
CREATE TABLE IF NOT EXISTS beeline_room_read_marks (
  community_id uuid NOT NULL,
  room_id uuid NOT NULL,
  viewer_pubkey bytea NOT NULL,
  message_created_at timestamptz NOT NULL,
  message_id bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, room_id, viewer_pubkey)
);
`;

const ROOM_READ_MARK_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION beeline_mark_room_read(
  target_community uuid,
  target_room uuid,
  target_viewer bytea,
  target_created_at timestamptz,
  target_message_id bytea
) RETURNS boolean LANGUAGE sql VOLATILE STRICT AS $$
  INSERT INTO beeline_room_read_marks (
    community_id, room_id, viewer_pubkey, message_created_at, message_id, updated_at
  ) VALUES (
    target_community, target_room, target_viewer, target_created_at, target_message_id, now()
  )
  ON CONFLICT (community_id, room_id, viewer_pubkey) DO UPDATE SET
    message_created_at = EXCLUDED.message_created_at,
    message_id = EXCLUDED.message_id,
    updated_at = EXCLUDED.updated_at
  WHERE EXCLUDED.message_created_at > beeline_room_read_marks.message_created_at
    OR (EXCLUDED.message_created_at = beeline_room_read_marks.message_created_at
      AND EXCLUDED.message_id < beeline_room_read_marks.message_id)
  RETURNING true;
$$;
`;

/** Cross-device Room read cursors are indexer state, never phone state. */
export async function migrateRoomReadMarks(database: DatabaseQueryable): Promise<void> {
  await database.query(ROOM_READ_MARK_SQL);
  await database.query(ROOM_READ_MARK_FUNCTION_SQL);
}

const AGENT_PAIRING_CLAIM_SQL = `
CREATE TABLE IF NOT EXISTS beeline_agent_pairing_claims (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  community_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  minter_pubkey bytea NOT NULL,
  agent_pubkey bytea NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now()
);
`;

/** Durable single-use reservation for private-Workspace agent pairing codes. */
export async function migrateAgentPairingClaims(database: DatabaseQueryable): Promise<void> {
  await database.query(AGENT_PAIRING_CLAIM_SQL);
}

const DELETE_SNAPSHOT_CONTRACT_SQL = [
  'DROP TRIGGER IF EXISTS beeline_snapshot_events_dirty ON events',
  'DROP TRIGGER IF EXISTS beeline_snapshot_channels_dirty ON channels',
  'DROP TRIGGER IF EXISTS beeline_snapshot_members_dirty ON channel_members',
  'DROP FUNCTION IF EXISTS beeline_snapshot_event_dirty_trigger()',
  'DROP FUNCTION IF EXISTS beeline_snapshot_channel_dirty_trigger()',
  'DROP FUNCTION IF EXISTS beeline_snapshot_member_dirty_trigger()',
  'DROP FUNCTION IF EXISTS beeline_mark_snapshot_family_dirty(uuid, uuid)',
  'DROP FUNCTION IF EXISTS beeline_mark_snapshot_family_dirty_preserving_repository(uuid, uuid)',
  'DROP FUNCTION IF EXISTS beeline_mark_snapshot_dirty(uuid, uuid)',
  'DROP FUNCTION IF EXISTS beeline_mark_snapshot_dirty_preserving_repository(uuid, uuid)',
  'DROP TABLE IF EXISTS beeline_snapshot_nip98_replays',
  'DROP TABLE IF EXISTS beeline_snapshot_dirty',
  'DROP TABLE IF EXISTS beeline_channel_snapshot_v1',
  'DROP SEQUENCE IF EXISTS beeline_snapshot_dirty_revision_seq',
] as const;

/** Delete the retired snapshot storage, queue, replay ledger, and trigger fan-out. */
export async function deleteSnapshotContract(database: DatabaseQueryable): Promise<void> {
  for (const statement of DELETE_SNAPSHOT_CONTRACT_SQL) await database.query(statement);
}

/**
 * One physical reservation store, partitioned by consumer name.
 *
 * Push and repository events keep independent state machines. This table only
 * gives them one Postgres durability owner.
 */
export class PostgresReservationPersistence<T> implements MaterializerReservationPersistence<T> {
  constructor(
    private readonly database: DatabaseQueryable,
    private readonly consumer: string,
  ) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(consumer)) {
      throw new Error('materializer reservation consumer is invalid');
    }
  }

  async load(): Promise<unknown | undefined> {
    const current = await this.database.query<{ state: unknown }>(
      `SELECT state FROM beeline_materializer_reservations WHERE consumer = $1`,
      [this.consumer],
    );
    if (current.rows[0]) return current.rows[0].state;

    return undefined;
  }

  async save(value: T): Promise<void> {
    await this.database.query(
      `INSERT INTO beeline_materializer_reservations (consumer, state, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (consumer) DO UPDATE SET
         state = EXCLUDED.state,
         updated_at = EXCLUDED.updated_at`,
      [this.consumer, JSON.stringify(value)],
    );
  }
}

export interface EventRow {
  community_id: string;
  id: Uint8Array;
  pubkey: Uint8Array;
  created_at: Date;
  kind: number;
  tags: unknown;
  content: string;
  sig: Uint8Array;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => Number.isSafeInteger(item))
    : [];
}

function safeLimit(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? Math.max(1, Math.min(value, 2_000))
    : 100;
}

export function eventFromRow(row: EventRow): NostrEvent {
  if (!Array.isArray(row.tags)) throw new Error('push database returned non-array event tags');
  return {
    id: Buffer.from(row.id).toString('hex'),
    pubkey: Buffer.from(row.pubkey).toString('hex'),
    created_at: Math.floor(row.created_at.getTime() / 1_000),
    kind: row.kind,
    tags: row.tags as string[][],
    content: row.content,
    sig: Buffer.from(row.sig).toString('hex'),
  };
}

/**
 * A recipient-scoped event reader backed by Buzz's authoritative Postgres rows.
 *
 * An unbound reader is used only for the live candidate feed and requires an
 * active channel_members row for every result. Once the poller selects an
 * event, `forEvent` binds all metadata reads to that event's server-stamped
 * community_id. This deliberately avoids hostname-to-community resolution:
 * relay aliases and domain migrations cannot starve or cross-wire the feed.
 */
export class DatabaseEventReader implements RelayEventReader {
  private readonly eventCommunities = new WeakMap<NostrEvent, string>();
  readonly scopeKey: string | undefined;

  constructor(
    private readonly database: DatabaseQueryable,
    private readonly recipientPubkey: string,
    private readonly communityId?: string,
  ) {
    if (!/^[0-9a-f]{64}$/i.test(recipientPubkey)) {
      throw new Error('recipient pubkey must be 64 hex characters');
    }
    this.scopeKey = communityId;
  }

  async query(filters: Record<string, unknown>[]): Promise<NostrEvent[]> {
    const seen = new Set<string>();
    const events: NostrEvent[] = [];
    for (const filter of filters) {
      const { text, values } = this.buildQuery(filter);
      const result = await this.database.query<EventRow>(text, values);
      for (const row of result.rows) {
        const event = eventFromRow(row);
        const key = `${row.community_id}:${event.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        this.eventCommunities.set(event, row.community_id);
        events.push(event);
      }
    }
    return events;
  }

  forEvent(event: NostrEvent): RelayEventReader {
    const communityId = this.eventCommunities.get(event);
    if (!communityId) throw new Error(`push database lost community scope for event ${event.id}`);
    return new DatabaseEventReader(this.database, this.recipientPubkey, communityId);
  }

  disconnect(): void {
    // The owning PostgresMaterializerStore holds one shared connection pool.
  }

  private buildQuery(filter: Record<string, unknown>): { text: string; values: unknown[] } {
    const values: unknown[] = [];
    const parameter = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };
    const clauses = ['e.deleted_at IS NULL'];
    if (this.communityId) {
      clauses.push(`e.community_id = ${parameter(this.communityId)}::uuid`);
    }

    const kinds = numberArray(filter.kinds);
    if (kinds.length > 0) clauses.push(`e.kind = ANY(${parameter(kinds)}::int[])`);
    const ids = stringArray(filter.ids);
    if (ids.length > 0) clauses.push(`encode(e.id, 'hex') = ANY(${parameter(ids)}::text[])`);
    const authors = stringArray(filter.authors);
    if (authors.length > 0) {
      clauses.push(`encode(e.pubkey, 'hex') = ANY(${parameter(authors)}::text[])`);
    }
    if (typeof filter.since === 'number' && Number.isSafeInteger(filter.since)) {
      clauses.push(`e.created_at >= to_timestamp(${parameter(filter.since)})`);
    }
    if (typeof filter.until === 'number' && Number.isSafeInteger(filter.until)) {
      clauses.push(`e.created_at <= to_timestamp(${parameter(filter.until)})`);
    }

    for (const [key, rawValues] of Object.entries(filter)) {
      if (!key.startsWith('#')) continue;
      const tags = stringArray(rawValues);
      if (tags.length === 0) continue;
      const tagName = parameter(key.slice(1));
      const tagValues = parameter(tags);
      clauses.push(
        `EXISTS (` +
          `SELECT 1 FROM jsonb_array_elements(e.tags) AS tag ` +
          `WHERE tag->>0 = ${tagName} AND tag->>1 = ANY(${tagValues}::text[])` +
          `)`,
      );
    }

    const recipient = parameter(this.recipientPubkey.toLowerCase());
    const membership =
      `EXISTS (` +
      `SELECT 1 FROM channel_members cm ` +
      `WHERE cm.community_id = e.community_id ` +
      `AND cm.pubkey = decode(${recipient}, 'hex') ` +
      `AND cm.removed_at IS NULL ` +
      `AND (` +
      `cm.channel_id = e.channel_id OR EXISTS (` +
      `SELECT 1 FROM jsonb_array_elements(e.tags) AS room_tag ` +
      `WHERE room_tag->>0 = 'h' AND room_tag->>1 = cm.channel_id::text` +
      `)` +
      `)` +
      `)`;
    // Candidate-feed reads are intentionally member-only. Community-bound
    // metadata reads mirror relay visibility: global rows and open channels
    // are readable for presentation, but can never become feed candidates.
    const openChannel =
      `EXISTS (` +
      `SELECT 1 FROM channels c ` +
      `WHERE c.community_id = e.community_id ` +
      `AND c.id = e.channel_id ` +
      `AND c.visibility = 'open' ` +
      `AND c.deleted_at IS NULL` +
      `)`;
    clauses.push(
      this.communityId ? `(e.channel_id IS NULL OR ${membership} OR ${openChannel})` : membership,
    );

    const limit = parameter(safeLimit(filter.limit));
    return {
      text:
        `SELECT e.community_id, e.id, e.pubkey, e.created_at, e.kind, e.tags, e.content, e.sig ` +
        `FROM events e WHERE ${clauses.join(' AND ')} ` +
        `ORDER BY e.created_at DESC, e.id ASC LIMIT ${limit}`,
      values,
    };
  }
}

export class PostgresMaterializerStore implements DatabaseTransactional {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 5 });
  }

  async connect(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async migrateReservations(): Promise<void> {
    await migrateMaterializerReservations(this.pool);
  }

  async migrateRoomReadMarks(): Promise<void> {
    await migrateRoomReadMarks(this.pool);
  }

  async migrateAgentPairingClaims(): Promise<void> {
    await migrateAgentPairingClaims(this.pool);
  }

  async deleteSnapshotContract(): Promise<void> {
    await deleteSnapshotContract(this.pool);
  }

  reservation<T>(consumer: string): MaterializerReservationPersistence<T> {
    return new PostgresReservationPersistence<T>(this.pool, consumer);
  }

  async query<Row>(text: string, values?: unknown[]): Promise<QueryResult<Row>> {
    const result = await this.pool.query(text, values);
    return { rows: result.rows as Row[] };
  }

  async transaction<T>(work: (database: DatabaseQueryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work({
        query: async <Row>(text: string, values?: unknown[]) => {
          const response = await client.query(text, values);
          return { rows: response.rows as Row[] };
        },
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  readerFor(recipientPubkey: string): DatabaseEventReader {
    return new DatabaseEventReader(this.pool, recipientPubkey);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
