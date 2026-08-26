import { randomUUID } from 'node:crypto';
import type { NostrEvent } from '@beeline/nostr';
import {
  CHANNEL_SNAPSHOT_PROJECTION_VERSION,
  CHANNEL_SNAPSHOT_SCHEMA_VERSION,
  type ChannelSnapshotCursorV1,
  type StoredChannelSnapshotV1,
} from '@beeline/buzz-client';
import {
  eventFromRow,
  type DatabaseQueryable,
  type DatabaseTransactional,
  type EventRow,
} from './database.js';

export type DirtyChannelClaim = {
  readonly tenantId: string;
  readonly channelId: string;
  readonly dirtyRevision: number;
  readonly claimToken: string;
};

export type ProjectionInput = {
  readonly tenantId: string;
  readonly channelId: string;
  readonly channelIds: readonly string[];
  readonly events: readonly NostrEvent[];
  readonly cursor: ChannelSnapshotCursorV1;
  readonly messageCursor?: MessagePageCursor;
  readonly messagesExhausted: boolean;
};

export type MessagePageCursor = {
  readonly createdAt: number;
  readonly eventId: string;
};

export type ChannelMessagePage = {
  readonly events: readonly NostrEvent[];
  readonly cursor?: MessagePageCursor;
  readonly exhausted: boolean;
};

export type MessageScanContinuation = {
  readonly cursor: MessagePageCursor;
  readonly eventIds: readonly string[];
};

export type CurrentChannelMember = {
  readonly channelId: string;
  readonly pubkey: string;
};

export type ViewerSnapshotRow = {
  readonly tenantId: string;
  readonly payload?: unknown;
  readonly digest?: string;
  readonly lagMs: number;
};

export type SnapshotQueueStatus = {
  readonly depth: number;
  readonly oldestDirtyAgeMs: number;
};

const SNAPSHOT_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS beeline_channel_snapshot_v1 (
  relay_tenant_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  schema_version integer NOT NULL,
  projection_version integer NOT NULL,
  revision bigint NOT NULL,
  cursor_created_at bigint NOT NULL,
  cursor_event_ids jsonb NOT NULL,
  projected_at timestamptz NOT NULL,
  payload_sha256 text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (relay_tenant_id, channel_id)
);

CREATE SEQUENCE IF NOT EXISTS beeline_snapshot_dirty_revision_seq;

CREATE TABLE IF NOT EXISTS beeline_snapshot_dirty (
  relay_tenant_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  dirty_revision bigint NOT NULL DEFAULT nextval('beeline_snapshot_dirty_revision_seq'),
  dirty_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_until timestamptz,
  claimed_token text,
  last_claimed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  scan_cursor_created_at bigint,
  scan_cursor_event_id text,
  scan_event_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (relay_tenant_id, channel_id)
);

CREATE INDEX IF NOT EXISTS beeline_snapshot_dirty_due_idx
  ON beeline_snapshot_dirty (next_attempt_at, last_claimed_at, dirty_at);

ALTER TABLE beeline_snapshot_dirty
  ALTER COLUMN dirty_revision SET DEFAULT nextval('beeline_snapshot_dirty_revision_seq');

ALTER TABLE beeline_snapshot_dirty
  ADD COLUMN IF NOT EXISTS claimed_token text;

ALTER TABLE beeline_snapshot_dirty
  ADD COLUMN IF NOT EXISTS scan_cursor_created_at bigint;

ALTER TABLE beeline_snapshot_dirty
  ADD COLUMN IF NOT EXISTS scan_cursor_event_id text;

ALTER TABLE beeline_snapshot_dirty
  ADD COLUMN IF NOT EXISTS scan_event_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS beeline_snapshot_nip98_replays (
  event_id text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION beeline_mark_snapshot_dirty(p_tenant uuid, p_channel uuid)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO beeline_snapshot_dirty (relay_tenant_id, channel_id)
  VALUES (p_tenant, p_channel)
  ON CONFLICT (relay_tenant_id, channel_id) DO UPDATE SET
    dirty_revision = nextval('beeline_snapshot_dirty_revision_seq'),
    dirty_at = LEAST(beeline_snapshot_dirty.dirty_at, now()),
    next_attempt_at = LEAST(beeline_snapshot_dirty.next_attempt_at, now()),
    attempts = 0,
    last_error = NULL,
    scan_cursor_created_at = NULL,
    scan_cursor_event_id = NULL,
    scan_event_ids = '[]'::jsonb
$$;

CREATE OR REPLACE FUNCTION beeline_snapshot_event_dirty_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_tenant uuid;
  source_channel uuid;
  source_pubkey bytea;
  source_tags jsonb;
  candidate text;
  affected record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    source_tenant := OLD.community_id;
    source_channel := OLD.channel_id;
    source_pubkey := OLD.pubkey;
    source_tags := OLD.tags;
  ELSE
    source_tenant := NEW.community_id;
    source_channel := NEW.channel_id;
    source_pubkey := NEW.pubkey;
    source_tags := NEW.tags;
  END IF;
  IF source_channel IS NULL THEN
    FOR affected IN
      SELECT cm.community_id, cm.channel_id
      FROM channel_members cm
      WHERE cm.pubkey = source_pubkey AND cm.removed_at IS NULL
        AND (source_tenant IS NULL OR cm.community_id = source_tenant)
    LOOP
      PERFORM beeline_mark_snapshot_dirty(affected.community_id, affected.channel_id);
    END LOOP;
  END IF;
  IF source_tenant IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF source_channel IS NOT NULL THEN
    PERFORM beeline_mark_snapshot_dirty(source_tenant, source_channel);
  END IF;
  FOR candidate IN
    SELECT DISTINCT tag->>1
    FROM jsonb_array_elements(COALESCE(source_tags, '[]'::jsonb)) AS tag
    WHERE tag->>0 IN ('h', 'parent', 'subchannel')
      AND tag->>1 ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  LOOP
    PERFORM beeline_mark_snapshot_dirty(source_tenant, candidate::uuid);
  END LOOP;
  FOR candidate IN
    SELECT substring(
      tag->>1 FROM
      '^buzz-corner-state:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$'
    )
    FROM jsonb_array_elements(COALESCE(source_tags, '[]'::jsonb)) AS tag
    WHERE tag->>0 = 'd' AND tag->>1 LIKE 'buzz-corner-state:%'
  LOOP
    IF candidate IS NOT NULL THEN
      PERFORM beeline_mark_snapshot_dirty(source_tenant, candidate::uuid);
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION beeline_snapshot_channel_dirty_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM beeline_mark_snapshot_dirty(OLD.community_id, OLD.id);
    RETURN OLD;
  END IF;
  PERFORM beeline_mark_snapshot_dirty(NEW.community_id, NEW.id);
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION beeline_snapshot_member_dirty_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM beeline_mark_snapshot_dirty(OLD.community_id, OLD.channel_id);
    RETURN OLD;
  END IF;
  PERFORM beeline_mark_snapshot_dirty(NEW.community_id, NEW.channel_id);
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS beeline_snapshot_events_dirty ON events;
CREATE TRIGGER beeline_snapshot_events_dirty
AFTER INSERT OR UPDATE OR DELETE ON events
FOR EACH ROW EXECUTE FUNCTION beeline_snapshot_event_dirty_trigger();

DROP TRIGGER IF EXISTS beeline_snapshot_channels_dirty ON channels;
CREATE TRIGGER beeline_snapshot_channels_dirty
AFTER INSERT OR UPDATE OR DELETE ON channels
FOR EACH ROW EXECUTE FUNCTION beeline_snapshot_channel_dirty_trigger();

DROP TRIGGER IF EXISTS beeline_snapshot_members_dirty ON channel_members;
CREATE TRIGGER beeline_snapshot_members_dirty
AFTER INSERT OR UPDATE OR DELETE ON channel_members
FOR EACH ROW EXECUTE FUNCTION beeline_snapshot_member_dirty_trigger();
`;

function numberValue(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new Error('snapshot database returned an invalid integer');
  return parsed;
}

/** Postgres is the durable worklist, projection source, replay ledger, and snapshot store. */
export class ChannelSnapshotStore {
  constructor(
    private readonly database: DatabaseTransactional,
    private readonly now: () => number = Date.now,
  ) {}

  async migrate(): Promise<void> {
    await this.database.query(SNAPSHOT_MIGRATION_SQL);
  }

  async enqueueBackfill(): Promise<void> {
    await this.database.query(
      `INSERT INTO beeline_snapshot_dirty (relay_tenant_id, channel_id)
       SELECT c.community_id, c.id FROM channels c
       LEFT JOIN beeline_channel_snapshot_v1 s
         ON s.relay_tenant_id = c.community_id AND s.channel_id = c.id
       WHERE c.deleted_at IS NULL
         AND (s.channel_id IS NULL OR s.schema_version <> $1 OR s.projection_version <> $2)
       ON CONFLICT (relay_tenant_id, channel_id) DO NOTHING`,
      [CHANNEL_SNAPSHOT_SCHEMA_VERSION, CHANNEL_SNAPSHOT_PROJECTION_VERSION],
    );
  }

  async claimDirty(
    limit: number,
    leaseMs: number,
    coalesceMs = 0,
  ): Promise<readonly DirtyChannelClaim[]> {
    return this.database.transaction(async (transaction) => {
      const selected = await transaction.query<{
        relay_tenant_id: string;
        channel_id: string;
        dirty_revision: string | number;
      }>(
        `SELECT relay_tenant_id, channel_id, dirty_revision
         FROM beeline_snapshot_dirty
         WHERE next_attempt_at <= now()
           AND dirty_at <= now() - ($2::text || ' milliseconds')::interval
           AND (claimed_until IS NULL OR claimed_until < now())
         ORDER BY last_claimed_at ASC NULLS FIRST, dirty_at ASC, channel_id ASC
         FOR UPDATE SKIP LOCKED LIMIT $1`,
        [Math.max(1, Math.min(32, Math.floor(limit))), Math.max(0, Math.floor(coalesceMs))],
      );
      const claims = selected.rows.map((row) => ({
        tenantId: row.relay_tenant_id,
        channelId: row.channel_id,
        dirtyRevision: numberValue(row.dirty_revision),
        claimToken: randomUUID(),
      }));
      for (const claim of claims) {
        await transaction.query(
          `UPDATE beeline_snapshot_dirty
           SET claimed_until = now() + ($3::text || ' milliseconds')::interval,
               claimed_token = $4,
               last_claimed_at = now()
           WHERE relay_tenant_id = $1 AND channel_id = $2 AND dirty_revision = $5`,
          [claim.tenantId, claim.channelId, leaseMs, claim.claimToken, claim.dirtyRevision],
        );
      }
      return claims;
    });
  }

  async loadProjectionInput(claim: DirtyChannelClaim): Promise<ProjectionInput | null> {
    const channels = await this.database.query<{ channel_id: string }>(
      `WITH target_channel AS (
         SELECT c.id FROM channels c
         WHERE c.community_id = $1::uuid AND c.id = $2::uuid AND c.deleted_at IS NULL
       ), target_create AS (
         SELECT e.tags FROM events e, target_channel target
         WHERE e.community_id = $1::uuid AND e.channel_id = target.id
           AND e.kind = 9007 AND e.deleted_at IS NULL
         ORDER BY e.created_at ASC, e.id ASC LIMIT 1
       ), parent AS (
         SELECT tag->>1 AS channel_id FROM target_create,
           LATERAL jsonb_array_elements(target_create.tags) AS tag
         WHERE tag->>0 = 'parent' LIMIT 1
       ), family_root AS (
         SELECT COALESCE((SELECT channel_id FROM parent), target.id::text) AS channel_id
         FROM target_channel target
       )
       SELECT DISTINCT family.channel_id FROM (
         SELECT id::text AS channel_id FROM target_channel
         UNION ALL SELECT channel_id FROM family_root
         UNION ALL
         SELECT e.channel_id::text FROM events e, family_root root
         WHERE e.community_id = $1::uuid AND e.kind = 9007 AND e.deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(e.tags) AS tag
             WHERE tag->>0 = 'parent' AND tag->>1 = root.channel_id
           )
       ) family
       WHERE family.channel_id IS NOT NULL`,
      [claim.tenantId, claim.channelId],
    );
    const channelIds = [...new Set(channels.rows.map((row) => row.channel_id))];
    if (channelIds.length === 0) return null;

    const continuationResult = await this.database.query<{
      scan_cursor_created_at: string | number | null;
      scan_cursor_event_id: string | null;
      scan_event_ids: unknown;
    }>(
      `SELECT scan_cursor_created_at, scan_cursor_event_id, scan_event_ids
       FROM beeline_snapshot_dirty
       WHERE relay_tenant_id = $1::uuid AND channel_id = $2::uuid
         AND dirty_revision = $3 AND claimed_token = $4`,
      [claim.tenantId, claim.channelId, claim.dirtyRevision, claim.claimToken],
    );
    const continuationRow = continuationResult.rows[0];
    const continuationEventIds = Array.isArray(continuationRow?.scan_event_ids)
      ? continuationRow.scan_event_ids.filter(
          (eventId): eventId is string =>
            typeof eventId === 'string' && /^[0-9a-f]{64}$/.test(eventId),
        )
      : [];
    const continuationCursor =
      continuationRow?.scan_cursor_created_at !== null &&
      continuationRow?.scan_cursor_created_at !== undefined &&
      continuationRow.scan_cursor_event_id &&
      /^[0-9a-f]{64}$/.test(continuationRow.scan_cursor_event_id)
        ? {
            createdAt: numberValue(continuationRow.scan_cursor_created_at),
            eventId: continuationRow.scan_cursor_event_id,
          }
        : undefined;

    const [
      messages,
      headMessages,
      carriedMessages,
      statusControls,
      structural,
      createAnchors,
      cursorRows,
    ] = await Promise.all([
      this.loadMessagePage(claim.tenantId, claim.channelId, continuationCursor),
      continuationCursor
        ? this.loadMessagePage(claim.tenantId, claim.channelId)
        : Promise.resolve(undefined),
      this.database.query<EventRow>(
        `SELECT e.community_id, e.id, e.pubkey, e.created_at, e.kind, e.tags, e.content, e.sig
           FROM events e
           WHERE e.community_id = $1::uuid AND e.deleted_at IS NULL
             AND encode(e.id, 'hex') = ANY($2::text[])`,
        [claim.tenantId, continuationEventIds],
      ),
      this.database.query<EventRow>(
        `SELECT e.community_id, e.id, e.pubkey, e.created_at, e.kind, e.tags, e.content, e.sig
         FROM events e
         WHERE e.community_id = $1::uuid AND e.deleted_at IS NULL AND e.kind = 9
           AND octet_length(e.content) <= 65536
           AND (e.channel_id = $2::uuid OR EXISTS (
             SELECT 1 FROM jsonb_array_elements(e.tags) AS room_tag
             WHERE room_tag->>0 = 'h' AND room_tag->>1 = $2::text
           ))
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(e.tags) AS marker
             WHERE marker->>0 = 't' AND marker->>1 = ANY($3::text[])
           )
         ORDER BY e.created_at DESC, e.id ASC LIMIT 256`,
        [
          claim.tenantId,
          claim.channelId,
          [
            'body-control',
            'merge-ready',
            'merge-not-ready',
            'landed',
            'buzz-merge-approval',
            'buzz-merge-approval-ack',
          ],
        ],
      ),
      this.database.query<EventRow>(
        `SELECT e.community_id, e.id, e.pubkey, e.created_at, e.kind, e.tags, e.content, e.sig
         FROM events e
         WHERE e.community_id = $1::uuid AND e.deleted_at IS NULL AND e.kind <> 9
           AND octet_length(e.content) <= 131072
           AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(e.tags) AS file_tag
             WHERE file_tag->>0 = 't' AND file_tag->>1 = 'change-review-file'
           )
           AND (e.channel_id = ANY($2::uuid[]) OR EXISTS (
             SELECT 1 FROM jsonb_array_elements(e.tags) AS tag
             WHERE (tag->>0 IN ('h', 'parent', 'subchannel')
                    AND tag->>1 = ANY($2::text[]))
                OR (tag->>0 = 'd' AND (
                  tag->>1 = ANY($2::text[])
                  OR tag->>1 = ANY(
                    SELECT 'buzz-corner-state:' || channel_id
                    FROM unnest($2::text[]) AS channel_id
                  )
                ))
           ))
         ORDER BY e.created_at DESC, e.id ASC LIMIT 2500`,
        [claim.tenantId, channelIds],
      ),
      this.database.query<EventRow>(
        `SELECT e.community_id, e.id, e.pubkey, e.created_at, e.kind, e.tags, e.content, e.sig
         FROM events e
         WHERE e.community_id = $1::uuid AND e.deleted_at IS NULL AND e.kind = 9007
           AND (e.channel_id = ANY($2::uuid[]) OR EXISTS (
             SELECT 1 FROM jsonb_array_elements(e.tags) AS tag
             WHERE tag->>0 = 'h' AND tag->>1 = ANY($2::text[])
           ))
         ORDER BY e.created_at ASC, e.id ASC LIMIT 1024`,
        [claim.tenantId, channelIds],
      ),
      this.database.query<{ created_at: string | number; event_id: string }>(
        `SELECT EXTRACT(EPOCH FROM e.created_at)::bigint AS created_at,
                  encode(e.id, 'hex') AS event_id
           FROM events e
           WHERE e.community_id = $1::uuid AND e.channel_id = $2::uuid
             AND e.deleted_at IS NULL
             AND e.created_at = (
               SELECT MAX(latest.created_at)
               FROM events latest
               WHERE latest.community_id = $1::uuid AND latest.channel_id = $2::uuid
                 AND latest.deleted_at IS NULL
             )
           ORDER BY e.id ASC`,
        [claim.tenantId, claim.channelId],
      ),
    ]);
    const cursorCreatedAt = cursorRows.rows[0]?.created_at;
    const cursorEventIds = cursorRows.rows.map((row) => row.event_id);
    if (
      cursorCreatedAt === undefined ||
      cursorEventIds.length === 0 ||
      cursorEventIds.some((eventId) => !/^[0-9a-f]{64}$/.test(eventId))
    ) {
      throw new Error('snapshot projection has no authoritative channel cursor');
    }
    const cursor: ChannelSnapshotCursorV1 = {
      createdAt: numberValue(cursorCreatedAt),
      eventIds: [...new Set(cursorEventIds)].sort(),
    };
    const byId = new Map<string, NostrEvent>();
    for (const event of headMessages?.events ?? []) byId.set(event.id, event);
    for (const row of carriedMessages.rows) {
      const event = eventFromRow(row);
      byId.set(event.id, event);
    }
    for (const event of messages.events) byId.set(event.id, event);
    for (const row of [...statusControls.rows, ...structural.rows, ...createAnchors.rows]) {
      const event = eventFromRow(row);
      byId.set(event.id, event);
    }
    return {
      tenantId: claim.tenantId,
      channelId: claim.channelId,
      channelIds,
      events: [...byId.values()],
      cursor,
      ...(messages.cursor ? { messageCursor: messages.cursor } : {}),
      messagesExhausted: messages.exhausted,
    };
  }

  async loadMessagePage(
    tenantId: string,
    channelId: string,
    cursor?: MessagePageCursor,
    limit = 160,
  ): Promise<ChannelMessagePage> {
    const pageSize = Math.max(1, Math.min(500, Math.floor(limit)));
    const result = await this.database.query<EventRow>(
      `SELECT e.community_id, e.id, e.pubkey, e.created_at, e.kind, e.tags, e.content, e.sig
       FROM events e
       WHERE e.community_id = $1::uuid AND e.deleted_at IS NULL AND e.kind = 9
         AND octet_length(e.content) <= 65536
         AND (e.channel_id = $2::uuid OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(e.tags) AS tag
           WHERE tag->>0 = 'h' AND tag->>1 = $2::text
         ))
         AND ($3::bigint IS NULL
           OR e.created_at < to_timestamp($3)
           OR (e.created_at = to_timestamp($3) AND e.id > decode($4, 'hex')))
       ORDER BY e.created_at DESC, e.id ASC LIMIT $5`,
      [tenantId, channelId, cursor?.createdAt ?? null, cursor?.eventId ?? null, pageSize + 1],
    );
    const events = result.rows.slice(0, pageSize).map(eventFromRow);
    const last = events.at(-1);
    return {
      events,
      ...(last ? { cursor: { createdAt: last.created_at, eventId: last.id } } : {}),
      exhausted: result.rows.length <= pageSize,
    };
  }

  async loadMessageEvents(
    tenantId: string,
    channelId: string,
    eventIds: readonly string[],
  ): Promise<readonly NostrEvent[]> {
    const ids = [...new Set(eventIds.filter((eventId) => /^[0-9a-f]{64}$/.test(eventId)))].slice(
      0,
      60,
    );
    if (ids.length === 0) return [];
    const result = await this.database.query<EventRow>(
      `SELECT e.community_id, e.id, e.pubkey, e.created_at, e.kind, e.tags, e.content, e.sig
       FROM events e
       WHERE e.community_id = $1::uuid AND e.deleted_at IS NULL AND e.kind = 9
         AND octet_length(e.content) <= 65536
         AND encode(e.id, 'hex') = ANY($3::text[])
         AND (e.channel_id = $2::uuid OR (e.channel_id IS NULL AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(e.tags) AS tag
           WHERE tag->>0 = 'h' AND tag->>1 = $2::text
         )))
       ORDER BY e.created_at DESC, e.id ASC`,
      [tenantId, channelId, ids],
    );
    return result.rows.map(eventFromRow);
  }

  async loadIdentityEvents(
    tenantId: string,
    pubkeys: readonly string[],
  ): Promise<readonly NostrEvent[]> {
    if (pubkeys.length === 0) return [];
    const result = await this.database.query<EventRow>(
      `SELECT e.community_id, e.id, e.pubkey, e.created_at, e.kind, e.tags, e.content, e.sig
       FROM events e
       WHERE (e.community_id = $1::uuid OR e.community_id IS NULL) AND e.deleted_at IS NULL
         AND encode(e.pubkey, 'hex') = ANY($2::text[])
         AND octet_length(e.content) <= 65536
         AND (e.kind = 0 OR (e.kind = 9 AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(e.tags) AS tag
           WHERE tag->>0 = 't' AND tag->>1 = 'buzz-agent'
         )))
       ORDER BY e.created_at DESC, e.id ASC LIMIT 1000`,
      [tenantId, [...new Set(pubkeys)]],
    );
    return result.rows.map(eventFromRow);
  }

  async loadCurrentMembers(
    tenantId: string,
    channelIds: readonly string[],
  ): Promise<readonly CurrentChannelMember[]> {
    if (channelIds.length === 0) return [];
    const result = await this.database.query<{ channel_id: string; pubkey: string }>(
      `SELECT cm.channel_id::text AS channel_id, encode(cm.pubkey, 'hex') AS pubkey
       FROM channel_members cm
       WHERE cm.community_id = $1::uuid AND cm.channel_id = ANY($2::uuid[])
         AND cm.removed_at IS NULL
       ORDER BY cm.channel_id, cm.pubkey`,
      [tenantId, channelIds],
    );
    return result.rows.map((row) => ({ channelId: row.channel_id, pubkey: row.pubkey }));
  }

  async nextRevision(tenantId: string, channelId: string): Promise<number> {
    const result = await this.database.query<{ revision: string | number }>(
      `SELECT COALESCE(MAX(revision), 0) + 1 AS revision
       FROM beeline_channel_snapshot_v1
       WHERE relay_tenant_id = $1::uuid AND channel_id = $2::uuid`,
      [tenantId, channelId],
    );
    return numberValue(result.rows[0]?.revision ?? 1);
  }

  async continueScan(
    claim: DirtyChannelClaim,
    continuation: MessageScanContinuation,
  ): Promise<void> {
    await this.database.query(
      `UPDATE beeline_snapshot_dirty SET
         scan_cursor_created_at = $5,
         scan_cursor_event_id = $6,
         scan_event_ids = $7::jsonb,
         claimed_until = NULL,
         claimed_token = NULL,
         next_attempt_at = now()
       WHERE relay_tenant_id = $1::uuid AND channel_id = $2::uuid
         AND dirty_revision = $3 AND claimed_token = $4`,
      [
        claim.tenantId,
        claim.channelId,
        claim.dirtyRevision,
        claim.claimToken,
        continuation.cursor.createdAt,
        continuation.cursor.eventId,
        JSON.stringify(continuation.eventIds),
      ],
    );
    await this.database.query(
      `UPDATE beeline_snapshot_dirty SET claimed_until = NULL, claimed_token = NULL
       WHERE relay_tenant_id = $1::uuid AND channel_id = $2::uuid AND claimed_token = $3`,
      [claim.tenantId, claim.channelId, claim.claimToken],
    );
  }

  async complete(
    claim: DirtyChannelClaim,
    payload: StoredChannelSnapshotV1,
    digest: string,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const current = await transaction.query<{ dirty_revision: string | number }>(
        `SELECT dirty_revision FROM beeline_snapshot_dirty
         WHERE relay_tenant_id = $1::uuid AND channel_id = $2::uuid
           AND claimed_token = $3
         FOR UPDATE`,
        [claim.tenantId, claim.channelId, claim.claimToken],
      );
      if (current.rows.length !== 1) return;
      if (numberValue(current.rows[0]!.dirty_revision) !== claim.dirtyRevision) {
        await transaction.query(
          `UPDATE beeline_snapshot_dirty SET claimed_until = NULL, claimed_token = NULL
           WHERE relay_tenant_id = $1::uuid AND channel_id = $2::uuid AND claimed_token = $3`,
          [claim.tenantId, claim.channelId, claim.claimToken],
        );
        return;
      }
      await transaction.query(
        `INSERT INTO beeline_channel_snapshot_v1
           (relay_tenant_id, channel_id, schema_version, projection_version, revision,
            cursor_created_at, cursor_event_ids, projected_at, payload_sha256, payload)
         VALUES ($1::uuid, $2::uuid, $3, $4, 1, $5, $6::jsonb, to_timestamp($7 / 1000.0), $8, $9::jsonb)
         ON CONFLICT (relay_tenant_id, channel_id) DO UPDATE SET
           schema_version = EXCLUDED.schema_version,
           projection_version = EXCLUDED.projection_version,
           revision = beeline_channel_snapshot_v1.revision + 1,
           cursor_created_at = EXCLUDED.cursor_created_at,
           cursor_event_ids = EXCLUDED.cursor_event_ids,
           projected_at = EXCLUDED.projected_at,
           payload_sha256 = EXCLUDED.payload_sha256,
           payload = EXCLUDED.payload`,
        [
          claim.tenantId,
          claim.channelId,
          payload.schemaVersion,
          payload.projectionVersion,
          payload.cursor.createdAt,
          JSON.stringify(payload.cursor.eventIds),
          payload.projectedAt,
          digest,
          JSON.stringify(payload),
        ],
      );
      await transaction.query(
        `DELETE FROM beeline_snapshot_dirty
         WHERE relay_tenant_id = $1::uuid AND channel_id = $2::uuid
           AND dirty_revision = $3 AND claimed_token = $4`,
        [claim.tenantId, claim.channelId, claim.dirtyRevision, claim.claimToken],
      );
      await transaction.query(
        `UPDATE beeline_snapshot_dirty SET claimed_until = NULL, claimed_token = NULL
         WHERE relay_tenant_id = $1::uuid AND channel_id = $2::uuid AND claimed_token = $3`,
        [claim.tenantId, claim.channelId, claim.claimToken],
      );
    });
  }

  async fail(claim: DirtyChannelClaim, error: unknown): Promise<void> {
    const detail = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    await this.database.query(
      `UPDATE beeline_snapshot_dirty SET
         attempts = attempts + 1,
         last_error = $4,
         claimed_until = NULL,
         claimed_token = NULL,
         next_attempt_at = now() + (LEAST(60, POWER(2, LEAST(attempts, 6)))::text || ' seconds')::interval
       WHERE relay_tenant_id = $1::uuid AND channel_id = $2::uuid AND claimed_token = $3`,
      [claim.tenantId, claim.channelId, claim.claimToken, detail],
    );
  }

  async discard(claim: DirtyChannelClaim): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const current = await transaction.query<{ dirty_revision: string | number }>(
        `SELECT dirty_revision FROM beeline_snapshot_dirty
         WHERE relay_tenant_id = $1::uuid AND channel_id = $2::uuid
           AND claimed_token = $3
         FOR UPDATE`,
        [claim.tenantId, claim.channelId, claim.claimToken],
      );
      if (current.rows.length !== 1) return;
      if (numberValue(current.rows[0]!.dirty_revision) !== claim.dirtyRevision) {
        await transaction.query(
          `UPDATE beeline_snapshot_dirty SET claimed_until = NULL, claimed_token = NULL
           WHERE relay_tenant_id = $1::uuid AND channel_id = $2::uuid AND claimed_token = $3`,
          [claim.tenantId, claim.channelId, claim.claimToken],
        );
        return;
      }
      await transaction.query(
        `DELETE FROM beeline_channel_snapshot_v1
         WHERE relay_tenant_id = $1::uuid AND channel_id = $2::uuid`,
        [claim.tenantId, claim.channelId],
      );
      await transaction.query(
        `DELETE FROM beeline_snapshot_dirty
         WHERE relay_tenant_id = $1::uuid AND channel_id = $2::uuid
           AND dirty_revision = $3 AND claimed_token = $4`,
        [claim.tenantId, claim.channelId, claim.dirtyRevision, claim.claimToken],
      );
    });
  }

  async readForViewer(channelId: string, viewerPubkey: string): Promise<ViewerSnapshotRow | null> {
    const result = await this.database.query<{
      community_id: string;
      payload: unknown;
      payload_sha256: string | null;
      dirty_at: Date | string | null;
    }>(
      `SELECT c.community_id, s.payload, s.payload_sha256, d.dirty_at
       FROM channels c
       JOIN channel_members cm
         ON cm.community_id = c.community_id AND cm.channel_id = c.id
        AND cm.pubkey = decode($2, 'hex') AND cm.removed_at IS NULL
       LEFT JOIN beeline_channel_snapshot_v1 s
         ON s.relay_tenant_id = c.community_id AND s.channel_id = c.id
       LEFT JOIN beeline_snapshot_dirty d
         ON d.relay_tenant_id = c.community_id AND d.channel_id = c.id
       WHERE c.id = $1::uuid AND c.deleted_at IS NULL
       ORDER BY c.community_id LIMIT 2`,
      [channelId, viewerPubkey.toLowerCase()],
    );
    // Both absence and an ambiguous cross-tenant membership are deliberately
    // the same non-enumerating result.
    if (result.rows.length !== 1) return null;
    const row = result.rows[0]!;
    const dirtyAt = row.dirty_at ? new Date(row.dirty_at).getTime() : undefined;
    return {
      tenantId: row.community_id,
      ...(row.payload !== null && row.payload !== undefined ? { payload: row.payload } : {}),
      ...(row.payload_sha256 ? { digest: row.payload_sha256 } : {}),
      lagMs: dirtyAt === undefined ? 0 : Math.max(0, this.now() - dirtyAt),
    };
  }

  async claimNip98Event(eventId: string, ttlMs = 2 * 60_000): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      await transaction.query(
        `DELETE FROM beeline_snapshot_nip98_replays WHERE expires_at < now()`,
      );
      const inserted = await transaction.query<{ event_id: string }>(
        `INSERT INTO beeline_snapshot_nip98_replays (event_id, expires_at)
         VALUES ($1, now() + ($2::text || ' milliseconds')::interval)
         ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
        [eventId, ttlMs],
      );
      return inserted.rows.length === 1;
    });
  }

  async status(): Promise<SnapshotQueueStatus> {
    const result = await this.database.query<{
      depth: string | number;
      oldest: Date | string | null;
    }>(`SELECT COUNT(*) AS depth, MIN(dirty_at) AS oldest FROM beeline_snapshot_dirty`);
    const row = result.rows[0];
    const oldest = row?.oldest ? new Date(row.oldest).getTime() : undefined;
    return {
      depth: numberValue(row?.depth ?? 0),
      oldestDirtyAgeMs: oldest === undefined ? 0 : Math.max(0, this.now() - oldest),
    };
  }
}
