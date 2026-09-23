import type { SqlDatabase } from './database.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import {
  ARTIFACT_TTL_HOURS,
  MEDIA_SWEEP_INTERVAL_MS,
  mediaTtlHours,
} from './media-ttl.js';
import type { ObjectStorage } from './object-storage.js';
import type { ObjectService } from './object-service.js';
import { tagsKnownIdentitySql } from './message-mentions.js';
import {
  claimReleaseCatchup,
  RELEASE_CATCHUP_CANDIDATES_SQL,
  retireTerminalReleaseCatchups,
} from './release-push-catchup.js';

const BACKGROUND_LOCK_KEY = 0x0bee11;
export const PUSH_DELIVERY_MIN_INTERVAL_MS = 5_000;
/** Bound concurrent device sends after serial claim/suppress. APNS can take
 * up to APNS_REQUEST_TIMEOUT_MS per token; serializing 100 candidates on the
 * sole background leader otherwise stalls attention delivery. */
export const PUSH_DELIVERY_CONCURRENCY = 8;

export interface PushSender {
  send(
    token: string,
    message: { messageId: string; text: string } & (
      | { type: 'test' }
      | {
          workspaceId: string;
          roomId?: string;
          type: 'workspace-join';
        }
      | {
          workspaceId: string;
          roomId: string;
          channelId: string;
          cornerId?: string;
          target: 'message' | 'corner';
          type: 'message';
        }
    ),
  ): Promise<void>;
}

export function createPushTestSender(
  database: SqlDatabase,
  sender: PushSender,
  iosSender?: PushSender,
): (identityId: string) => Promise<void> {
  return async (identityId) => {
    const devices = await database.query<{ token: string; platform: 'android' | 'ios' }>(
      `SELECT token,platform FROM push_devices
       WHERE identity_id=$1 AND (platform='android' OR ($2::boolean AND platform='ios'))`,
      [identityId, Boolean(iosSender)],
    );
    for (const device of devices.rows) {
      const deviceSender = device.platform === 'ios' ? iosSender! : sender;
      await deviceSender.send(device.token, {
        messageId: 'test',
        type: 'test',
        text: 'Beeline notifications are ready.',
      });
    }
  };
}

export function isUnregisteredPushToken(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : '';
  return (
    code === 'messaging/registration-token-not-registered' ||
    code === 'messaging/invalid-registration-token' ||
    code === 'apns/unregistered-device-token' ||
    Boolean(
      error &&
      typeof error === 'object' &&
      'classification' in error &&
      error.classification === 'unregistered',
    ) ||
    (error instanceof Error && /\bNotRegistered\b/.test(error.message))
  );
}

export class PushDeliveryLoop {
  #lastCompletedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly database: SqlDatabase,
    private readonly sender: PushSender,
    private readonly iosSender?: PushSender,
    private readonly minimumIntervalMs = PUSH_DELIVERY_MIN_INTERVAL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async runOnce(): Promise<number> {
    return this.runUnthrottled();
  }

  async runIfDue(): Promise<number> {
    if (this.millisecondsUntilNextRun() > 0) return 0;
    try {
      return await this.runUnthrottled();
    } finally {
      this.#lastCompletedAt = this.now();
    }
  }

  millisecondsUntilNextRun(): number {
    return Math.max(0, this.#lastCompletedAt + this.minimumIntervalMs - this.now());
  }

  private async runUnthrottled(): Promise<number> {
    // A newly enabled worker must start from its own durable boundary rather than
    // claiming the Room backlog that existed before delivery was enabled.
    await this.database.query(
      `INSERT INTO push_delivery_floors(id) VALUES('message-delivery') ON CONFLICT(id) DO NOTHING`,
    );
    await retireTerminalReleaseCatchups(this.database);
    const candidates = await this.database.query<{
      message_id: string;
      workspace_id: string;
      room_id: string | null;
      channel_id: string | null;
      corner_id: string | null;
      target: 'message' | 'corner';
      notification_type: 'message' | 'workspace-join';
      text: string;
      token: string;
      identity_id: string;
      is_release_catchup: boolean;
      platform: 'android' | 'ios';
    }>(`
      -- Bound message/device pairs before the current-roster tag subquery.
      -- Without this barrier the planner can resolve tags across all history.
      WITH recent_messages AS MATERIALIZED (
        SELECT m.*,d.token push_token,d.identity_id push_identity_id
        FROM messages m
        JOIN push_delivery_floors floor ON floor.id='message-delivery'
        JOIN memberships member ON member.room_id=m.room_id AND member.removed_at IS NULL
          AND member.identity_id<>m.author_id
        JOIN push_devices d ON d.identity_id=member.identity_id AND m.created_at>=d.registered_at
        WHERE m.created_at>=floor.started_at
          AND m.created_at>=now()-interval '1 hour'
          AND m.presentation IS DISTINCT FROM 'activity'
          AND m.card_type IS DISTINCT FROM 'agent-yolo'
          AND m.card_type IS DISTINCT FROM 'turn-failed'
          AND (m.card_type IS DISTINCT FROM 'relay' OR m.card->>'direction' IS DISTINCT FROM 'up')
          AND m.card_type IS DISTINCT FROM 'workspace-member-joined'
          AND btrim(m.text)<>''
          AND NOT EXISTS (
            SELECT 1 FROM push_delivery_claims claim
            WHERE claim.message_id=m.id AND claim.device_token=d.token
          )
      ), candidates AS (
        SELECT m.id message_id,room.workspace_id::text workspace_id,
          COALESCE(room.parent_id,room.id)::text room_id,
          room.id::text channel_id,
          CASE WHEN room.parent_id IS NOT NULL THEN room.id::text END corner_id,
          'message' target,
          'message' notification_type,
          CASE
            -- System/card text already came from the one lifecycle grammar.
            WHEN m.presentation IN ('system','card') THEN btrim(m.text)
            ELSE concat_ws(': ',COALESCE(NULLIF(author.name,''),'Someone'),btrim(m.text))
          END text,
          m.push_token token,m.push_identity_id identity_id,false is_release_catchup,m.created_at
        FROM recent_messages m
        JOIN rooms room ON room.id=m.room_id
        LEFT JOIN memberships workspace_member ON workspace_member.workspace_id=room.workspace_id
          AND workspace_member.room_id IS NULL AND workspace_member.identity_id=m.push_identity_id
          AND workspace_member.removed_at IS NULL
        JOIN identities author ON author.id=m.author_id
        JOIN identities recipient ON recipient.id=m.push_identity_id AND recipient.kind='human'
        WHERE (
            room.direct_participants IS NULL
            OR m.card_type IS NULL
            OR NOT (room.direct_participants @> jsonb_build_array('${SYSTEM_IDENTITY_ID}'::text))
            OR workspace_member.identity_id IS NOT NULL
          )
          -- The push ceiling is four categories: direct messages, tags,
          -- replies to you, and member lifecycle (the separate
          -- workspace-join branch below). Cards and corner lifecycle
          -- never push on their own. Levels are strict subsets of that
          -- ceiling: direct = DMs + tags + replies,
          -- mine = direct + member lifecycle.
          AND recipient.push_level IN ('direct','mine')
          AND (
            room.direct_participants IS NOT NULL
            OR EXISTS (
              SELECT 1 FROM messages addressed
              WHERE addressed.id = m.reply_to_message_id
                AND addressed.author_id=m.push_identity_id
            )
            OR ${tagsKnownIdentitySql('m', 'recipient.id', 'recipient.handle', 'recipient.kind')}
          )
        UNION ALL
        SELECT notification.id message_id,notification.workspace_id::text workspace_id,
          notification.room_id::text room_id,
          notification.room_id::text channel_id,NULL::text corner_id,'message' target,
          'workspace-join' notification_type,
          btrim(notification.text) text,device.device_token token,push_device.identity_id,
          false is_release_catchup,notification.created_at
        FROM workspace_join_notifications notification
        JOIN workspace_join_notification_devices device ON device.notification_id=notification.id
        JOIN push_devices push_device ON push_device.token=device.device_token
        JOIN identities recipient ON recipient.id=push_device.identity_id
          AND recipient.kind='human' AND recipient.push_level='mine'
        JOIN memberships workspace_member ON workspace_member.workspace_id=notification.workspace_id
          AND workspace_member.room_id IS NULL AND workspace_member.identity_id=push_device.identity_id
          AND workspace_member.removed_at IS NULL
        JOIN push_delivery_floors floor ON floor.id='message-delivery'
        WHERE notification.created_at>=push_device.registered_at
          AND notification.created_at>=floor.started_at
          AND btrim(notification.text)<>''
        UNION ALL
        ${RELEASE_CATCHUP_CANDIDATES_SQL}
      ), unclaimed AS (
        SELECT DISTINCT ON (candidate.message_id,candidate.token)
          candidate.message_id,candidate.workspace_id,candidate.room_id,candidate.channel_id,
          candidate.corner_id,candidate.target,
          candidate.notification_type,candidate.text,candidate.token,candidate.identity_id,
          candidate.is_release_catchup,candidate.created_at,device.platform
        FROM candidates candidate
        JOIN push_devices device ON device.token=candidate.token
          AND ${this.iosSender ? "device.platform IN ('android','ios')" : "device.platform='android'"}
        LEFT JOIN push_delivery_claims claim
          ON claim.message_id=candidate.message_id AND claim.device_token=candidate.token
        WHERE claim.message_id IS NULL
        ORDER BY candidate.message_id,candidate.token,candidate.is_release_catchup DESC
      )
      SELECT message_id,workspace_id,room_id,channel_id,corner_id,target,
        notification_type,text,token,identity_id,is_release_catchup,platform
      FROM unclaimed ORDER BY created_at,message_id LIMIT 100
    `);
    let delivered = 0;
    type ClaimedDelivery = {
      candidate: (typeof candidates.rows)[number];
      message:
        | {
            messageId: string;
            workspaceId: string;
            roomId?: string;
            type: 'workspace-join';
            text: string;
          }
        | {
            messageId: string;
            workspaceId: string;
            roomId: string;
            channelId: string;
            cornerId?: string;
            target: 'message' | 'corner';
            type: 'message';
            text: string;
          };
    };
    const claimedDeliveries: ClaimedDelivery[] = [];
    for (const candidate of candidates.rows) {
      const claimed = candidate.is_release_catchup
        ? await claimReleaseCatchup(
            this.database,
            candidate.message_id,
            candidate.token,
            candidate.identity_id,
          )
        : Boolean(
            (
              await this.database.query(
                `INSERT INTO push_delivery_claims(message_id,device_token,status)
                 SELECT $1,$2,'claimed'
                 WHERE EXISTS (SELECT 1 FROM push_devices WHERE token=$2 AND identity_id=$3)
                   AND EXISTS (SELECT 1 FROM identities WHERE id=$3 AND push_level<>'off')
                   AND (
                     ($6='workspace-join' AND EXISTS (
                       SELECT 1 FROM memberships
                       WHERE workspace_id=$4 AND room_id IS NULL AND identity_id=$3
                         AND removed_at IS NULL
                     ))
                     OR ($6='message' AND (
                       NOT EXISTS (
                         SELECT 1 FROM messages message JOIN rooms room ON room.id=message.room_id
                         WHERE message.id=$1 AND message.card_type IS NOT NULL
                           AND room.direct_participants @> jsonb_build_array($5::text)
                       )
                       OR EXISTS (
                         SELECT 1 FROM memberships
                         WHERE workspace_id=$4 AND room_id IS NULL AND identity_id=$3
                           AND removed_at IS NULL
                       )
                     ))
                   )
                 ON CONFLICT DO NOTHING`,
                [
                  candidate.message_id,
                  candidate.token,
                  candidate.identity_id,
                  candidate.workspace_id,
                  SYSTEM_IDENTITY_ID,
                  candidate.notification_type,
                ],
              )
            ).rowCount,
          );
      if (!claimed) continue;
      claimedDeliveries.push({
        candidate,
        message:
          candidate.notification_type === 'workspace-join'
            ? {
                messageId: candidate.message_id,
                workspaceId: candidate.workspace_id,
                ...(candidate.room_id ? { roomId: candidate.room_id } : {}),
                type: 'workspace-join' as const,
                text: candidate.text,
              }
            : {
                messageId: candidate.message_id,
                workspaceId: candidate.workspace_id,
                roomId: candidate.room_id!,
                channelId: candidate.channel_id!,
                ...(candidate.corner_id ? { cornerId: candidate.corner_id } : {}),
                target: candidate.target,
                type: 'message' as const,
                text: candidate.text,
              },
      });
    }
    let nextClaim = 0;
    const workerResults = await Promise.all(
      Array.from(
        { length: Math.min(PUSH_DELIVERY_CONCURRENCY, claimedDeliveries.length) },
        async () => {
          let localDelivered = 0;
          while (nextClaim < claimedDeliveries.length) {
            const index = nextClaim++;
            const { candidate, message } = claimedDeliveries[index]!;
            try {
              const sender = candidate.platform === 'ios' ? this.iosSender! : this.sender;
              await sender.send(candidate.token, message);
              await this.database.query(
                `UPDATE push_delivery_claims SET status='delivered',completed_at=now() WHERE message_id=$1 AND device_token=$2`,
                [candidate.message_id, candidate.token],
              );
              if (candidate.is_release_catchup)
                await this.database.query(
                  `DELETE FROM push_release_catchups WHERE device_token=$1 AND message_id=$2`,
                  [candidate.token, candidate.message_id],
                );
              localDelivered += 1;
            } catch (error) {
              await this.database.query(
                `UPDATE push_delivery_claims SET status='failed',completed_at=now(),error=$3 WHERE message_id=$1 AND device_token=$2`,
                [
                  candidate.message_id,
                  candidate.token,
                  error instanceof Error ? error.message : String(error),
                ],
              );
              if (isUnregisteredPushToken(error))
                await this.database.query(`DELETE FROM push_devices WHERE token=$1`, [
                  candidate.token,
                ]);
            }
          }
          return localDelivered;
        },
      ),
    );
    delivered = workerResults.reduce((sum, count) => sum + count, 0);
    return delivered;
  }
}

/**
 * The hourly object sweep. Attachment bytes are the one row class large enough
 * that keeping them forever is a storage decision rather than a bookkeeping
 * one, so they get a TTL (`media-ttl.ts`) and nothing else does: the messages
 * that reference them are untouched and keep their attachment metadata.
 *
 * It rides the one-second background cycle like every other job and throttles
 * itself, because a TTL measured in hours does not need a per-second DELETE.
 * The interval is in memory only: a restart re-sweeps at most one extra time,
 * and the sweep is idempotent.
 */
export class MediaExpiryLoop {
  #lastSweep = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly database: SqlDatabase,
    private readonly ttlHours = mediaTtlHours(),
    private readonly intervalMs = MEDIA_SWEEP_INTERVAL_MS,
    private readonly objects?: {
      storage: ObjectStorage;
      /** Read-side facts (`readMediaObject`/`mediaLink`) need storage too; the
       *  sweep only uses `deleteObject`, batched and idempotent. */
      service: ObjectService;
    },
    private readonly artifactTtlHours = ARTIFACT_TTL_HOURS,
  ) {}

  /** Objects deleted by this call; 0 when the sweep was throttled or found nothing. */
  async runOnce(now = Date.now()): Promise<number> {
    if (now - this.#lastSweep < this.intervalMs) return 0;
    this.#lastSweep = now;
    return this.sweepObjects();
  }

  /**
   * The object half of the sweep. Storage is deleted first, then the row and
   * the tombstone land together, so a crashed sweep at worst leaves a row
   * whose object is already gone — the next pass re-deletes (a 404 is
   * success) and finishes the row. Pending orphans older than an hour are
   * reaped the same way; a tombstone is only written for objects that were
   * once readable.
   */
  private async sweepObjects(): Promise<number> {
    if (!this.objects) return 0;
    const candidates = await this.database.query<{
      id: string;
      key: string;
      kind: 'media' | 'artifact';
      state: string;
    }>(
      `SELECT id::text id,key,kind,state FROM objects
       WHERE expires_at < now()
          OR (state='pending' AND created_at < now() - interval '1 hour')
       LIMIT 100`,
    );
    let deleted = 0;
    for (const object of candidates.rows) {
      try {
        await this.objects.storage.deleteObject(object.key);
      } catch (error) {
        console.warn(
          '[media-ttl] object delete failed, will retry next sweep',
          object.id,
          error instanceof Error ? error.message : error,
        );
        continue;
      }
      if (object.state === 'ready')
        await this.database.query(
          `INSERT INTO object_expirations(id,retention_hours) VALUES ($1,$2)
           ON CONFLICT(id) DO NOTHING`,
          [object.id, object.kind === 'artifact' ? this.artifactTtlHours : this.ttlHours],
        );
      await this.database.query(`DELETE FROM objects WHERE id=$1`, [object.id]);
      deleted += 1;
    }
    return deleted;
  }
}

export async function runMaintenance(database: SqlDatabase): Promise<void> {
  await database.query(
    `DELETE FROM agent_commands WHERE state IN ('complete','cancelled') AND completed_at<now()-interval '30 days'`,
  );
  await database.query(`DELETE FROM phone_access_tokens WHERE expires_at<now()`);
  await database.query(`DELETE FROM phone_sessions WHERE expires_at<now()`);
  await database.query(
    `DELETE FROM live_outputs WHERE updated_at<now()-interval '2 hours'
       AND kind<>'presence'`,
  );
  await database.query(`DELETE FROM github_auth_flows WHERE expires_at<now()-interval '1 day'`);
  await database.query(
    `DELETE FROM daemon_token_exchanges WHERE expires_at<now()-interval '1 day'`,
  );
}

/**
 * Exactly one process owns background work. PostgreSQL releases the advisory
 * lock automatically when this dedicated connection dies, allowing its peer
 * to acquire it without a queue, worker process, or lease clock.
 */
export class BackgroundLeader {
  #stopped = false;
  #client: LeaderConnection | undefined;
  #wake: (() => void) | undefined;
  #wakePending = false;

  constructor(
    private readonly database: { connectDedicated(): Promise<LeaderConnection> },
    private readonly cycle: () => Promise<number | void>,
    private readonly reconciliationMs = 60_000,
  ) {}

  async run(): Promise<void> {
    while (!this.#stopped) {
      try {
        const client = await this.database.connectDedicated();
        this.#client = client;
        const lock = await client.query<{ locked: boolean }>(
          `SELECT pg_try_advisory_lock($1) locked`,
          [BACKGROUND_LOCK_KEY],
        );
        if (!lock.rows[0]?.locked) {
          client.release();
          this.#client = undefined;
          await this.wait();
          continue;
        }
        while (!this.#stopped) {
          // Detect a dead lock-owning connection before any work can fire.
          await client.query('SELECT 1');
          const nextDelay = await this.cycle();
          await this.wait(
            typeof nextDelay === 'number'
              ? Math.max(0, Math.min(nextDelay, this.reconciliationMs))
              : this.reconciliationMs,
          );
        }
      } catch {
        await this.wait();
      } finally {
        this.#client?.release(true);
        this.#client = undefined;
      }
    }
  }

  stop(): void {
    this.#stopped = true;
    this.#wake?.();
    this.#client?.release(true);
    this.#client = undefined;
  }

  /** Recompute background work after a committed database notification. */
  wake(): void {
    if (this.#wake) this.#wake();
    else this.#wakePending = true;
  }

  private wait(milliseconds = this.reconciliationMs): Promise<void> {
    if (this.#wakePending) {
      this.#wakePending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(done, milliseconds);
      timer.unref?.();
      const self = this;
      function done() {
        clearTimeout(timer);
        if (self.#wake === done) self.#wake = undefined;
        self.#wakePending = false;
        resolve();
      }
      this.#wake = done;
    });
  }
}

export interface LeaderConnection {
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
  release(destroy?: boolean): void;
}
