import type { SqlDatabase } from './database.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { PushActionPayload } from '@beeline/api-contract/phone';
import { ARTIFACT_TTL_HOURS, MEDIA_SWEEP_INTERVAL_MS, mediaTtlHours } from './media-ttl.js';
import type { ObjectStorage } from './object-storage.js';
import type { ObjectService } from './object-service.js';
import { addressedToPersonSql } from './corner-owed.js';
import {
  claimReleaseCatchup,
  PUSH_MAX_ATTEMPTS,
  RELEASE_CATCHUP_CANDIDATES_SQL,
  retireTerminalReleaseCatchups,
} from './release-push-catchup.js';

const BACKGROUND_LOCK_KEY = 0x0bee11;
export const PUSH_DELIVERY_MIN_INTERVAL_MS = 5_000;
/** Bound concurrent device sends after serial claim/suppress. APNS can take
 * up to APNS_REQUEST_TIMEOUT_MS per token; serializing 100 candidates on the
 * sole background leader otherwise stalls attention delivery. */
export const PUSH_DELIVERY_CONCURRENCY = 8;

function isRetryableApnsFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message === 'APNs request timed out') return true;
  if ('classification' in error) return error.classification === 'retryable';
  const code = 'code' in error ? error.code : undefined;
  return [
    'ECONNRESET',
    'ETIMEDOUT',
    'ERR_HTTP2_STREAM_CANCEL',
    'ERR_HTTP2_GOAWAY_SESSION',
    'ERR_HTTP2_INVALID_SESSION',
  ].includes(String(code));
}

/** What a person can do from the notification itself; see `push-actions.ts`. */
export type PushAction = PushActionPayload;

export interface PushSender {
  send(
    token: string,
    message: {
      messageId: string;
      text: string;
      action?: PushAction;
      /** A permission ask: its text is delivered whole, never cut to fit. */
      permission?: true;
      recipientIdentityId?: string;
      /** Replacement slot; attention uses its own message or human-burst id. */
      collapseId?: string;
    } & (
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
  sender: PushSender | undefined,
  iosSender?: PushSender,
  webSender?: PushSender,
): (identityId: string) => Promise<void> {
  return async (identityId) => {
    const devices = await database.query<{ token: string; platform: 'android' | 'ios' | 'web' }>(
      `SELECT token,platform FROM push_devices
       WHERE identity_id=$1 AND (($2::boolean AND platform='android') OR ($3::boolean AND platform='ios') OR ($4::boolean AND platform='web'))`,
      [identityId, Boolean(sender), Boolean(iosSender), Boolean(webSender)],
    );
    for (const device of devices.rows) {
      const deviceSender =
        device.platform === 'ios' ? iosSender! : device.platform === 'web' ? webSender! : sender!;
      await deviceSender.send(device.token, {
        messageId: 'test',
        type: 'test',
        text: 'Beeline notifications are ready.',
        recipientIdentityId: identityId,
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

/**
 * One push per recipient per agent turn. An agent message is one of its
 * turn's messages when it shares the Room, the author and the request id.
 * True when this device was already claimed for another message of the same
 * turn, so the later ones stay quiet however many of them qualify.
 */
function earlierTurnPushSql(message: string, deviceToken: string): string {
  return `EXISTS (
    SELECT 1 FROM messages sibling
    JOIN identities sibling_author ON sibling_author.id=sibling.author_id
      AND sibling_author.kind='agent'
    JOIN push_delivery_claims sibling_claim ON sibling_claim.message_id=sibling.id
      AND sibling_claim.device_token=${deviceToken}
    WHERE ${message}.request_id IS NOT NULL
      AND sibling.room_id=${message}.room_id AND sibling.author_id=${message}.author_id
      AND sibling.request_id=${message}.request_id AND sibling.id<>${message}.id
  )`;
}

export class PushDeliveryLoop {
  #lastCompletedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly database: SqlDatabase,
    private readonly sender: PushSender | undefined,
    private readonly iosSender?: PushSender,
    private readonly minimumIntervalMs = PUSH_DELIVERY_MIN_INTERVAL_MS,
    private readonly now: () => number = Date.now,
    private readonly webSender?: PushSender,
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
      platform: 'android' | 'ios' | 'web';
      action: 'grant' | 'reply' | null;
      grant_id: string | null;
      grant_kind: string | null;
      grant_target: string | null;
      grant_agent_name: string | null;
      author_name: string | null;
      collapse_id: string | null;
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
          -- An automatic access receipt asks nothing of anyone.
          AND m.card_type IS DISTINCT FROM 'grant-auto'
          AND m.card_type IS DISTINCT FROM 'turn-failed'
          AND (m.card_type IS DISTINCT FROM 'relay' OR m.card->>'direction' IS DISTINCT FROM 'up')
          AND m.card_type IS DISTINCT FROM 'workspace-member-joined'
          AND m.deleted_at IS NULL
          AND btrim(m.text)<>''
          AND NOT EXISTS (
            SELECT 1 FROM push_delivery_claims claim
            WHERE claim.message_id=m.id AND claim.device_token=d.token
              AND (claim.status<>'retryable' OR claim.next_retry_at>now()
                OR claim.attempts>=${PUSH_MAX_ATTEMPTS})
          )
          AND NOT ${earlierTurnPushSql('m', 'd.token')}
          -- A completed turn's decision/tag metadata qualifies its final prose,
          -- rather than winning the turn's one push before that prose.
          AND NOT (m.presentation IN ('system','card') AND m.request_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM agent_turns t WHERE t.room_id=m.room_id
              AND t.request_id=m.request_id AND t.agent_id=m.author_id AND t.status='complete')
            AND EXISTS (SELECT 1 FROM messages final WHERE final.room_id=m.room_id
              AND final.author_id=m.author_id AND final.request_id=m.request_id
              AND final.presentation='message' AND final.deleted_at IS NULL))
          -- Durable chat from agents waits for completion and selects final prose.
          AND (m.presentation<>'message' OR m.request_id IS NULL
            OR NOT EXISTS (SELECT 1 FROM identities a WHERE a.id=m.author_id AND a.kind='agent')
            OR (NOT EXISTS (SELECT 1 FROM agent_turns t WHERE t.room_id=m.room_id
                AND t.request_id=m.request_id AND t.agent_id=m.author_id AND t.status='working')
              AND NOT EXISTS (SELECT 1 FROM messages newer WHERE newer.room_id=m.room_id
                AND newer.author_id=m.author_id AND newer.request_id=m.request_id
                AND newer.presentation='message' AND newer.card_type IS NULL AND newer.deleted_at IS NULL
                AND (newer.created_at,newer.id)>(m.created_at,m.id))))
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
          m.push_token token,m.push_identity_id identity_id,false is_release_catchup,m.created_at,
          -- Inline notification actions. A grant card answers from the
          -- notification only while it asks exactly one thing that is still
          -- pending, since three buttons cannot answer two asks. A reply is offered
          -- on messages from people and agents, never on a card, a system line,
          -- or the read-only @system DM.
          CASE
            WHEN m.card_type='grant-request' AND jsonb_typeof(m.card->'grants')='array'
              AND jsonb_array_length(m.card->'grants')=1
              AND EXISTS (
                SELECT 1 FROM agent_grants pending_grant
                WHERE pending_grant.id::text=m.card->'grants'->0->>'grantId'
                  AND pending_grant.status='pending'
              ) THEN 'grant'
            WHEN m.presentation='message' AND m.card_type IS NULL
              AND NOT COALESCE(room.direct_participants @> jsonb_build_array('${SYSTEM_IDENTITY_ID}'::text),false)
              THEN 'reply'
          END action,
          m.card->'grants'->0->>'grantId' grant_id,
          m.card->'grants'->0->>'kind' grant_kind,
          m.card->'grants'->0->>'target' grant_target,
          m.card->'agent'->>'name' grant_agent_name,
          COALESCE(NULLIF(author.name,''),'Someone') author_name,
          CASE WHEN attention.direct OR m.presentation<>'message' THEN
            CASE WHEN author.kind='human' AND m.presentation='message' THEN (
              SELECT burst.id FROM messages burst
              WHERE burst.room_id=m.room_id AND burst.author_id=m.author_id
                AND burst.presentation='message' AND burst.deleted_at IS NULL
                AND burst.created_at>=m.created_at-interval '20 seconds'
                AND (burst.created_at,burst.id)<=(m.created_at,m.id)
                AND NOT EXISTS (SELECT 1 FROM messages interruption
                  WHERE interruption.room_id=m.room_id AND interruption.author_id<>m.author_id
                    AND interruption.presentation='message'
                    AND (interruption.created_at,interruption.id)>(burst.created_at,burst.id)
                    AND (interruption.created_at,interruption.id)<(m.created_at,m.id))
                AND (room.direct_participants IS NOT NULL OR ${addressedToPersonSql('burst', 'recipient.id', 'recipient.handle', 'recipient.kind', false)})
              ORDER BY burst.created_at,burst.id LIMIT 1)
            ELSE m.id END
          -- Keep human prose visible when a subsequent agent summary replaces its slot.
          ELSE CASE WHEN author.kind='human' THEN room.id::text ELSE 'agent:'||room.id::text END
          END collapse_id
        FROM recent_messages m
        JOIN rooms room ON room.id=m.room_id
        LEFT JOIN memberships workspace_member ON workspace_member.workspace_id=room.workspace_id
          AND workspace_member.room_id IS NULL AND workspace_member.identity_id=m.push_identity_id
          AND workspace_member.removed_at IS NULL
        JOIN identities author ON author.id=m.author_id
        JOIN identities recipient ON recipient.id=m.push_identity_id AND recipient.kind='human'
        CROSS JOIN LATERAL (SELECT (
          (room.direct_participants IS NOT NULL AND (m.presentation='message' OR m.card_type IS NULL OR m.card_type='grant-request'))
          OR ${addressedToPersonSql('m', 'recipient.id', 'recipient.handle', 'recipient.kind', false)}
          OR (author.kind='agent' AND m.presentation='message' AND m.request_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM messages part WHERE part.room_id=m.room_id
              AND part.author_id=m.author_id AND part.request_id=m.request_id
              AND part.deleted_at IS NULL
              AND ${addressedToPersonSql('part', 'recipient.id', 'recipient.handle', 'recipient.kind', false)}))
        ) direct) attention

        WHERE (
            room.direct_participants IS NULL
            OR m.card_type IS NULL
            OR NOT (room.direct_participants @> jsonb_build_array('${SYSTEM_IDENTITY_ID}'::text))
            OR workspace_member.identity_id IS NOT NULL
          )
          AND recipient.push_level IN ('direct','mine','all')
          AND (
            attention.direct
            OR (recipient.push_level IN ('mine','all')
              AND ${addressedToPersonSql('m', 'recipient.id', 'recipient.handle', 'recipient.kind')})
            OR (m.presentation='message' AND m.card_type IS NULL
              AND (recipient.push_level='all'
                OR (recipient.push_level='mine' AND room.parent_id IS NOT NULL
                  AND (room.created_by=recipient.id OR EXISTS (
                    SELECT 1 FROM corner_facts mine WHERE mine.corner_id=room.id
                      AND mine.commissioned_by=recipient.id)))))
          )
        UNION ALL
        SELECT notification.id message_id,notification.workspace_id::text workspace_id,
          notification.room_id::text room_id,
          notification.room_id::text channel_id,NULL::text corner_id,'message' target,
          'workspace-join' notification_type,
          btrim(notification.text) text,device.device_token token,push_device.identity_id,
          false is_release_catchup,notification.created_at,
          NULL::text action,NULL::text grant_id,NULL::text grant_kind,NULL::text grant_target,
          NULL::text grant_agent_name,NULL::text author_name,NULL::text collapse_id
        FROM workspace_join_notifications notification
        JOIN workspace_join_notification_devices device ON device.notification_id=notification.id
        JOIN push_devices push_device ON push_device.token=device.device_token
        JOIN identities recipient ON recipient.id=push_device.identity_id
          AND recipient.kind='human' AND recipient.push_level IN ('mine','all')
        JOIN memberships workspace_member ON workspace_member.workspace_id=notification.workspace_id
          AND workspace_member.room_id IS NULL AND workspace_member.identity_id=push_device.identity_id
          AND workspace_member.removed_at IS NULL
        JOIN push_delivery_floors floor ON floor.id='message-delivery'
        WHERE notification.created_at>=push_device.registered_at
          AND notification.created_at>=floor.started_at
          AND btrim(notification.text)<>''
        UNION ALL
        SELECT catchup.*,NULL::text collapse_id FROM (${RELEASE_CATCHUP_CANDIDATES_SQL}) catchup
      ), unclaimed AS (
        SELECT DISTINCT ON (candidate.message_id,candidate.token)
          candidate.message_id,candidate.workspace_id,candidate.room_id,candidate.channel_id,
          candidate.corner_id,candidate.target,
          candidate.notification_type,candidate.text,candidate.token,candidate.identity_id,
          candidate.is_release_catchup,candidate.created_at,device.platform,
          candidate.action,candidate.grant_id,candidate.grant_kind,candidate.grant_target,
          candidate.grant_agent_name,candidate.author_name,candidate.collapse_id
        FROM candidates candidate
        JOIN push_devices device ON device.token=candidate.token
          AND device.platform IN (${[this.sender && "'android'", this.iosSender && "'ios'", this.webSender && "'web'"].filter(Boolean).join(',') || "'none'"})
        LEFT JOIN push_delivery_claims claim
          ON claim.message_id=candidate.message_id AND claim.device_token=candidate.token
        WHERE claim.message_id IS NULL OR (claim.status='retryable'
          AND claim.next_retry_at<=now() AND claim.attempts<${PUSH_MAX_ATTEMPTS})
        ORDER BY candidate.message_id,candidate.token,candidate.is_release_catchup DESC
      )
      SELECT message_id,workspace_id,room_id,channel_id,corner_id,target,
        notification_type,text,token,identity_id,is_release_catchup,platform,
        action,grant_id,grant_kind,grant_target,grant_agent_name,author_name,collapse_id
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
            action?: PushAction;
            permission?: true;
            collapseId?: string;
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
                `INSERT INTO push_delivery_claims AS claim(message_id,device_token,status)
                 SELECT $1,$2,'claimed'
                 WHERE EXISTS (SELECT 1 FROM push_devices WHERE token=$2 AND identity_id=$3)
                   AND EXISTS (SELECT 1 FROM identities WHERE id=$3 AND push_level<>'off')
                   AND ($6<>'message' OR EXISTS (
                     SELECT 1 FROM messages m JOIN memberships member ON member.room_id=m.room_id
                     WHERE m.id=$1 AND member.identity_id=$3 AND member.removed_at IS NULL))
                   AND NOT EXISTS (
                     SELECT 1 FROM messages m WHERE m.id=$1 AND ${earlierTurnPushSql('m', '$2')}
                   )
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
                 ON CONFLICT(message_id,device_token) DO UPDATE
                   SET status='claimed',attempts=claim.attempts+1,claimed_at=now(),
                     completed_at=NULL,error=NULL,next_retry_at=NULL
                   WHERE claim.status='retryable' AND claim.next_retry_at<=now()
                     AND claim.attempts<${PUSH_MAX_ATTEMPTS}`,
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
      // Consume suppressed candidates permanently, so leaving a Room does not replay them.
      const suppressed =
        candidate.channel_id &&
        (
          await this.database.query(
            `SELECT 1 FROM memberships member
         WHERE member.room_id=$1 AND member.identity_id=$2
           AND (member.removed_at IS NOT NULL OR member.push_muted)
         UNION ALL
         SELECT 1 FROM room_push_views WHERE room_id=$1 AND identity_id=$2 AND expires_at>now()
         UNION ALL
         SELECT 1 FROM room_read_marks mark WHERE mark.room_id=$1 AND mark.identity_id=$2
           AND (mark.updated_at>now()-interval '30 seconds' OR EXISTS (
             SELECT 1 FROM messages m WHERE m.id=$3
               AND (mark.message_created_at,mark.message_id)>=(m.created_at,m.id)))
         LIMIT 1`,
            [candidate.channel_id, candidate.identity_id, candidate.message_id],
          )
        ).rowCount;
      if (suppressed) {
        await this.database.query(
          `UPDATE push_delivery_claims SET status='suppressed',completed_at=now() WHERE message_id=$1 AND device_token=$2`,
          [candidate.message_id, candidate.token],
        );
        continue;
      }
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
                ...(candidate.collapse_id ? { collapseId: candidate.collapse_id } : {}),
                ...pushActionFor(candidate),
                // Only a grant-request card carries `grants`, so its first
                // grant id marks a permission ask.
                ...(candidate.grant_id ? { permission: true as const } : {}),
              },
      });
    }
    const slotSends = new Map<string, Promise<void>>();
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
              const sender =
                candidate.platform === 'ios'
                  ? this.iosSender!
                  : candidate.platform === 'web'
                    ? this.webSender!
                    : this.sender!;
              const slot = `${candidate.token}:${candidate.collapse_id ?? candidate.message_id}`;
              const sending = (slotSends.get(slot) ?? Promise.resolve())
                .catch(() => undefined)
                .then(() =>
                  sender.send(candidate.token, {
                    ...message,
                    recipientIdentityId: candidate.identity_id,
                  }),
                );
              slotSends.set(slot, sending);
              await sending;
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
                `UPDATE push_delivery_claims
                 SET status=CASE WHEN $4::boolean AND attempts<${PUSH_MAX_ATTEMPTS}
                   THEN 'retryable' ELSE 'failed' END,
                   completed_at=now(),error=$3,
                   next_retry_at=CASE WHEN $4::boolean AND attempts<${PUSH_MAX_ATTEMPTS}
                     THEN now()+(interval '15 seconds' * power(2,attempts-1)) ELSE NULL END
                 WHERE message_id=$1 AND device_token=$2`,
                [
                  candidate.message_id,
                  candidate.token,
                  error instanceof Error ? error.message : String(error),
                  candidate.platform === 'ios' && isRetryableApnsFailure(error),
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

function pushActionFor(candidate: {
  action: 'grant' | 'reply' | null;
  grant_id: string | null;
  grant_kind: string | null;
  grant_target: string | null;
  grant_agent_name: string | null;
  author_name: string | null;
}): { action?: PushAction } {
  if (
    candidate.action === 'grant' &&
    candidate.grant_id &&
    candidate.grant_kind &&
    candidate.grant_target
  )
    return {
      action: {
        kind: 'grant',
        grantId: candidate.grant_id,
        grantKind: candidate.grant_kind,
        grantTarget: candidate.grant_target,
        agentName: candidate.grant_agent_name ?? '',
      },
    };
  if (candidate.action === 'reply')
    return { action: { kind: 'reply', authorName: candidate.author_name ?? 'Someone' } };
  return {};
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
       WHERE (expires_at < now()
          OR (state='pending' AND created_at < now() - interval '1 hour')
         ) AND NOT EXISTS (
           SELECT 1 FROM corner_brief_revisions brief
           JOIN rooms corner ON corner.id=brief.corner_id AND corner.archived_at IS NULL
           CROSS JOIN LATERAL jsonb_array_elements(brief.attachments) file
           WHERE file->>'objectId'=objects.id::text
         )
       LIMIT 100`,
    );
    let deleted = 0;
    for (const object of candidates.rows) {
      try {
        const removed = await this.database.transaction(async (db) => {
          // A brief's attachment validation takes a share lock on this same
          // object. Recheck after taking the write lock so an assignment that
          // committed since the candidate scan keeps its bytes.
          const current = (
            await db.query<{ key: string; kind: 'media' | 'artifact'; state: string }>(
              `SELECT key,kind,state FROM objects WHERE id=$1 FOR UPDATE`,
              [object.id],
            )
          ).rows[0];
          if (!current) return false;
          const pinned = await db.query(
            `SELECT 1 FROM corner_brief_revisions brief
             JOIN rooms corner ON corner.id=brief.corner_id AND corner.archived_at IS NULL
             CROSS JOIN LATERAL jsonb_array_elements(brief.attachments) file
             WHERE file->>'objectId'=$1 LIMIT 1`,
            [object.id],
          );
          if (pinned.rowCount) return false;
          await this.objects!.storage.deleteObject(current.key);
          if (current.state === 'ready')
            await db.query(
              `INSERT INTO object_expirations(id,retention_hours) VALUES ($1,$2)
               ON CONFLICT(id) DO NOTHING`,
              [object.id, current.kind === 'artifact' ? this.artifactTtlHours : this.ttlHours],
            );
          await db.query(`DELETE FROM objects WHERE id=$1`, [object.id]);
          return true;
        });
        if (removed) deleted += 1;
      } catch (error) {
        console.warn(
          '[media-ttl] object delete failed, will retry next sweep',
          object.id,
          error instanceof Error ? error.message : error,
        );
        continue;
      }
    }
    return deleted;
  }
}

export async function runMaintenance(database: SqlDatabase): Promise<void> {
  await database.query(`DELETE FROM room_push_views WHERE expires_at<now()`);
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
  // A deferred mention notice is spent once written or withdrawn; its row has
  // no further use after the source message and the notice are both long gone.
  await database.query(`DELETE FROM pending_mention_notices WHERE due_at<now()-interval '30 days'`);
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
      } catch (error) {
        console.error('[background] leader cycle failed', error);
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

export interface BackgroundJobHealth {
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastDurationMs: number | null;
  consecutiveFailures: number;
}

/** One advisory leader, independent failure boundaries for each job class. */
export class BackgroundJobRunner {
  readonly #health = new Map<string, BackgroundJobHealth>();

  constructor(private readonly now: () => number = Date.now) {}

  snapshot(): Record<string, BackgroundJobHealth> {
    return Object.fromEntries([...this.#health].map(([name, health]) => [name, { ...health }]));
  }

  async run<T>(
    name: string,
    work: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    const health = this.#health.get(name) ?? {
      lastSuccessAt: null,
      lastErrorAt: null,
      lastDurationMs: null,
      consecutiveFailures: 0,
    };
    this.#health.set(name, health);
    const startedAt = this.now();
    try {
      const value = await work();
      health.lastSuccessAt = this.now();
      health.consecutiveFailures = 0;
      return { ok: true, value };
    } catch (error) {
      health.lastErrorAt = this.now();
      health.consecutiveFailures++;
      console.error(`[background] ${name} failed`, error);
      return { ok: false };
    } finally {
      health.lastDurationMs = Math.max(0, this.now() - startedAt);
    }
  }
}

export interface LeaderConnection {
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
  release(destroy?: boolean): void;
}
