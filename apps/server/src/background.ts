import { cleanupUnfinishedAppSignIns } from './unfinished-app-sign-ins.js';
import { captureServerError } from './sentry.js';
import { deliverMcpMemberWebhooks, retryMcpMemberRoutes } from './rooms-mcp-members.js';
import { DatabaseTransactionStartError, type SqlDatabase } from './database.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import {
  cutCornerTitle,
  cutTitle,
  directMessageTitle,
  roomTitle,
  type ChatTitleIdentity,
  type DerivedCornerState,
  type PushActionPayload,
  type ReadClear,
} from '@beeline/api-contract/phone';
import { ARTIFACT_TTL_HOURS, MEDIA_SWEEP_INTERVAL_MS, mediaTtlHours } from './media-ttl.js';
import type { ObjectStorage } from './object-storage.js';
import { apnsReadClearBatch } from './apns-push.js';
import { firebaseReadClearBatch } from './firebase-push.js';
import { TERMINAL_PUSH_CLAIMS_SQL } from './push-claim-cleanup.js';
import type { ObjectService } from './object-service.js';
import { cornerFactsSql, cornerRowState, type CornerStateRow } from './chat-corner-counts.js';
import { addressedToPersonSql } from './corner-owed.js';
import { pushDirectAttentionSql } from './push-attention.js';
import { SERVER_LEASE_EXPIRY_MS } from './connection-presence.js';

const BACKGROUND_LOCK_KEY = 0x0bee11;
const PUSH_MAX_ATTEMPTS = 3;
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
          /** Canonical server projection; transport serializers never derive it. */
          cornerState?: DerivedCornerState;
          target: 'message' | 'corner';
          type: 'message';
          /** The in-app title: `#room`, `#room/corner` or `@peer`. */
          title?: string;
        }
    ),
  ): Promise<void>;
  /** iOS and Android: a silent push that clears these conversations from the shade. */
  clearRead?(token: string, reads: readonly ReadClear[]): Promise<void>;
}

/** Minimum gap between read-clear pushes to one device. */
export const READ_CLEAR_INTERVAL_SECONDS = 30;
/** Channels per push, oldest read mark first. */
export const READ_CLEAR_MAX_CHANNELS = 50;
/** Message ids per channel, newest first. */
export const READ_CLEAR_MAX_MESSAGE_IDS = 20;

const PUSH_TITLE_LENGTH = 40;
const PUSH_TITLE_ROOM_LENGTH = 16;

/** Use the in-app conversation title, cut to one push line. */
export function pushTitleFor(
  roomName: string | null,
  cornerName: string | null,
  channelId: string | null,
  dmPeer: ChatTitleIdentity | null = null,
): { title?: string } {
  if (dmPeer) return { title: cutTitle(directMessageTitle(dmPeer), PUSH_TITLE_LENGTH) };
  const room = roomTitle(roomName);
  if (!room) return {};
  if (cornerName === null || !channelId) return { title: cutTitle(room, PUSH_TITLE_LENGTH) };
  return {
    title: cutCornerTitle(
      roomName,
      cornerName,
      channelId,
      PUSH_TITLE_LENGTH,
      PUSH_TITLE_ROOM_LENGTH,
    ),
  };
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

/** The lateral boundary prevents sibling filters from becoming history index scans. */
function messagePointsSql(ids: string, alias: string): string {
  return `unnest(${ids}) ${alias}_ids(id)
    CROSS JOIN LATERAL (SELECT * FROM messages WHERE id=${alias}_ids.id OFFSET 0) ${alias}`;
}

/**
 * One push per recipient per agent turn. An agent message is one of its
 * turn's messages when it shares the Room, the author and the request id.
 * True when this device was already claimed for another message of the same
 * turn, so the later ones stay quiet however many of them qualify.
 */
function earlierTurnPushSql(message: string, deviceToken: string): string {
  return `EXISTS (
    SELECT 1 FROM ${messagePointsSql(`COALESCE((SELECT context.turn_ids FROM push_message_context context
      WHERE context.message_id=${message}.id),ARRAY[]::text[])`, 'sibling')}
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
  #repeatBatch = false;
  #lastBacklogCheck = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly database: SqlDatabase,
    private readonly sender: PushSender | undefined,
    private readonly iosSender?: PushSender,
    private readonly webSender?: PushSender,
  ) {}

  async nextDueAt(): Promise<Date | null> {
    const due = await this.database.query<{ not_before: Date }>(
      `SELECT not_before FROM push_outbox ORDER BY not_before,message_id,device_token LIMIT 1`);
    return due.rows[0]?.not_before ?? null;
  }

  async runOnce(): Promise<number> {
    let delivered = 0;
    if (Date.now() - this.#lastBacklogCheck >= 60_000) {
      this.#lastBacklogCheck = Date.now();
      const backlog = await this.database.query(`SELECT 1 FROM push_outbox
        WHERE not_before<=now() LIMIT 1001`);
      if (backlog.rows.length > 1000) captureServerError(new Error('Push outbox backlog exceeds 1000 due rows'),
        { background_job: 'push', signal: 'push-outbox-backlog' });
    }
    // Yield to other jobs even during a sustained incoming stream.
    for (let batch = 0; batch < 10; batch++) {
      delivered += await this.runUnthrottled();
      if (!this.#repeatBatch) break;
    }
    await this.sendReadClears();
    return delivered;
  }

  /** Batch delivered claims at or before each read mark into one silent push per device. */
  private async sendReadClears(): Promise<void> {
    // One rule for both platforms; each sender keeps its own size limit.
    const platforms = {
      ios: { sender: this.iosSender, batch: apnsReadClearBatch },
      android: { sender: this.sender, batch: firebaseReadClearBatch },
    };
    const enabled = Object.entries(platforms).flatMap(([platform, { sender }]) =>
      sender?.clearRead ? [platform] : []);
    if (enabled.length === 0) return;
    const due = await this.database.query<{
      token: string;
      platform: 'ios' | 'android';
      channel_ids: string[];
      message_ids: string[];
      read_message_ids: string[];
    }>(
      // Registered-device claims beyond any cap remain due for a later push.
      `SELECT device.token,device.platform,batch.channel_ids,batch.message_ids,batch.read_message_ids
       FROM push_devices device
       LEFT JOIN push_read_clears clear ON clear.device_token=device.token
       CROSS JOIN LATERAL (
         SELECT array_agg(pending.room_id ORDER BY pending.message_created_at,pending.room_id) channel_ids,
           array_agg(pending.message_id ORDER BY pending.message_created_at,pending.room_id) message_ids,
           array_agg(pending.read_ids::text
             ORDER BY pending.message_created_at,pending.room_id) read_message_ids
         FROM (
           SELECT mark.room_id::text room_id,mark.message_created_at,mark.message_id,
             COALESCE((
               SELECT jsonb_agg(pushed.id ORDER BY pushed.created_at DESC,pushed.id DESC)
               FROM (
                 SELECT message.id,message.created_at
                 FROM push_delivery_claims claim
                 JOIN LATERAL (SELECT * FROM messages WHERE id=claim.message_id OFFSET 0) message ON true
                 WHERE claim.device_token=device.token AND claim.status='delivered'
                   AND claim.read_cleared_at IS NULL
                   AND message.room_id=mark.room_id AND message.created_at>=device.registered_at
                   AND (message.created_at,message.id)<(mark.message_created_at,mark.message_id)
                 ORDER BY message.created_at DESC,message.id DESC
                 LIMIT ${READ_CLEAR_MAX_MESSAGE_IDS}
               ) pushed
             ),'[]'::jsonb) read_ids
           FROM room_read_marks mark
           WHERE mark.identity_id=device.identity_id
             AND EXISTS (
               SELECT 1 FROM push_delivery_claims claim
               JOIN LATERAL (SELECT * FROM messages WHERE id=claim.message_id OFFSET 0) message ON true
               WHERE claim.device_token=device.token AND claim.status='delivered'
                 AND claim.read_cleared_at IS NULL
                 AND message.room_id=mark.room_id AND message.created_at>=device.registered_at
                 AND (message.created_at,message.id)<=(mark.message_created_at,mark.message_id))
           ORDER BY mark.message_created_at,mark.room_id::text
           LIMIT ${READ_CLEAR_MAX_CHANNELS}
         ) pending
       ) batch
       WHERE device.platform=ANY($1::text[]) AND batch.channel_ids IS NOT NULL
         AND COALESCE(clear.sent_at,'-infinity'::timestamptz)
           <now()-interval '${READ_CLEAR_INTERVAL_SECONDS} seconds'
       LIMIT 100`,
      [enabled],
    );
    for (const row of due.rows) {
      const { sender, batch } = platforms[row.platform];
      if (!sender?.clearRead) continue;
      const reads = batch(
        row.channel_ids.map((channelId, index) => ({
          channelId,
          messageId: row.message_ids[index]!,
          readMessageIds: JSON.parse(row.read_message_ids[index]!) as string[],
        })),
      );
      try {
        await sender.clearRead(row.token, reads);
        await this.database.query(
          `UPDATE push_delivery_claims SET read_cleared_at=now()
           WHERE device_token=$1 AND message_id=ANY($2::text[])`,
          [row.token, reads.flatMap((read) => [read.messageId, ...read.readMessageIds])],
        );
      } catch (error) {
        if (isUnregisteredPushToken(error)) {
          await this.database.query(`DELETE FROM push_devices WHERE token=$1`, [row.token]);
          continue;
        }
        // Unnamed claims retry after the interval.
      }
      await this.database.query(
        `INSERT INTO push_read_clears(device_token,sent_at) VALUES($1,now())
         ON CONFLICT(device_token) DO UPDATE SET sent_at=EXCLUDED.sent_at`,
        [row.token],
      );
    }
  }

  private async runUnthrottled(): Promise<number> {
    // A newly enabled worker must start from its own durable boundary rather than
    // claiming the Room backlog that existed before delivery was enabled.
    await this.database.query(
      `INSERT INTO push_delivery_floors(id) VALUES('message-delivery') ON CONFLICT(id) DO NOTHING`,
    );
    // Candidate messages expire after an hour. A terminal claim outside that
    // window cannot suppress a future push.
    // Retain mobile claims for read-clear for at most a week.
    await this.database.query(TERMINAL_PUSH_CLAIMS_SQL, [1000]);
    await this.database.query(`DELETE FROM push_outbox_retirements WHERE (message_id,device_token) IN (
      SELECT message_id,device_token FROM push_outbox_retirements
      WHERE retired_at<now()-interval '1 hour' ORDER BY retired_at LIMIT 1000 FOR UPDATE SKIP LOCKED)`);
    await this.database.query(`DELETE FROM push_message_context WHERE message_id IN (
      SELECT message_id FROM push_message_context WHERE expires_at<=now()
      ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED)`);
    const expired = await this.database.query(`WITH retired AS (
      DELETE FROM push_outbox WHERE (message_id,device_token) IN (
        SELECT message_id,device_token FROM push_outbox WHERE expires_at<=now()
        ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED)
      RETURNING message_id,device_token
    ), recorded AS (
      INSERT INTO push_outbox_retirements(message_id,device_token,reason)
      SELECT message_id,device_token,'expired' FROM retired
      ON CONFLICT(message_id,device_token) DO UPDATE SET reason=EXCLUDED.reason,retired_at=now()
    ) SELECT * FROM retired`);
    const due = await this.database.query<{ message_id: string; device_token: string; expires_at: Date; lease_until: string }>(`
      WITH due AS (
        SELECT message_id,device_token FROM push_outbox
        WHERE not_before<=now() AND expires_at>now() ORDER BY not_before,message_id,device_token
        LIMIT 100 FOR UPDATE SKIP LOCKED
      )
      UPDATE push_outbox queue SET not_before=now()+interval '30 seconds'
      FROM due WHERE queue.message_id=due.message_id AND queue.device_token=due.device_token
      RETURNING queue.message_id,queue.device_token,queue.expires_at,queue.not_before::text lease_until
    `);
    if (due.rows.length === 0) {
      this.#repeatBatch = (expired.rowCount ?? 0) === 1000;
      return 0;
    }
    const candidates = await this.database.transaction(async tx => {
      // Do not depend on connection defaults or the separate global JIT fix.
      await tx.query('SET LOCAL jit=off');
      return tx.query<{
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
      platform: 'android' | 'ios' | 'web';
      action: 'grant' | 'reply' | null;
      grant_id: string | null;
      grant_kind: string | null;
      grant_target: string | null;
      grant_agent_name: string | null;
      author_name: string | null;
      collapse_id: string | null;
      direct_attention: boolean;
      room_name: string | null;
      corner_name: string | null;
      dm_peer: ChatTitleIdentity | null;
    }>(`
      -- Only leased message/device IDs enter eligibility and title projection.
      WITH queued_messages AS MATERIALIZED (
        SELECT m.*,context.turn_ids,context.burst_ids,d.token push_token,d.identity_id push_identity_id
        FROM jsonb_to_recordset($1::jsonb) queued(message_id text,device_token text)
        JOIN LATERAL (SELECT * FROM messages WHERE id=queued.message_id OFFSET 0) m ON true
        JOIN push_message_context context ON context.message_id=m.id
        JOIN push_delivery_floors floor ON floor.id='message-delivery'
        JOIN push_devices d ON d.token=queued.device_token AND m.created_at>=d.registered_at
        JOIN LATERAL (SELECT 1 FROM effective_memberships member
          WHERE member.room_id=m.room_id AND member.identity_id=d.identity_id
            AND member.removed_at IS NULL AND member.identity_id<>m.author_id LIMIT 1) member ON true
        WHERE m.created_at>=floor.started_at
          AND m.created_at>=now()-interval '1 hour'
          AND m.presentation IS DISTINCT FROM 'activity'
          AND m.card_type IS DISTINCT FROM 'agent-yolo'
          -- An automatic access receipt asks nothing of anyone.
          AND m.card_type IS DISTINCT FROM 'grant-auto'
          AND m.card_type IS DISTINCT FROM 'turn-failed'
          AND (m.card_type IS DISTINCT FROM 'relay' OR m.card->>'direction' IS DISTINCT FROM 'up')
          AND m.card_type IS DISTINCT FROM 'workspace-member-joined'
          -- An agent's order or report record is reference for corner readers.
          AND m.card_type IS DISTINCT FROM 'agent-command'
          AND m.deleted_at IS NULL
          AND btrim(m.text)<>''
          -- A closed corner is done: nothing posted there may push anyone.
          AND NOT EXISTS (SELECT 1 FROM rooms closed WHERE closed.id=m.room_id
            AND closed.parent_id IS NOT NULL AND closed.archived_at IS NOT NULL)
          AND NOT EXISTS (
            SELECT 1 FROM push_delivery_claims claim
            WHERE claim.message_id=m.id AND claim.device_token=d.token
              AND NOT ((claim.status='retryable' AND claim.next_retry_at<=now()
                AND claim.attempts<${PUSH_MAX_ATTEMPTS}) OR (claim.status='claimed'
                AND claim.claimed_at<now()-interval '1 minute' AND claim.attempts<${PUSH_MAX_ATTEMPTS}))
          )
          AND NOT ${earlierTurnPushSql('m', 'd.token')}
          -- A completed turn's decision/tag metadata qualifies its final prose,
          -- rather than winning the turn's one push before that prose.
          AND NOT (m.presentation IN ('system','card') AND m.request_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM agent_turns t WHERE t.room_id=m.room_id
              AND t.request_id=m.request_id AND t.agent_id=m.author_id AND t.status='complete')
            AND EXISTS (SELECT 1 FROM ${messagePointsSql('context.turn_ids', 'final')} WHERE final.room_id=m.room_id
              AND final.author_id=m.author_id AND final.request_id=m.request_id
              AND final.presentation='message' AND final.deleted_at IS NULL))
          -- Durable chat from agents waits for completion and selects final prose.
          AND (m.presentation<>'message' OR m.request_id IS NULL
            OR NOT EXISTS (SELECT 1 FROM identities a WHERE a.id=m.author_id AND a.kind='agent')
            OR (NOT EXISTS (SELECT 1 FROM agent_turns t WHERE t.room_id=m.room_id
                AND t.request_id=m.request_id AND t.agent_id=m.author_id AND t.status='working')
              AND NOT EXISTS (SELECT 1 FROM ${messagePointsSql('context.turn_ids', 'newer')} WHERE newer.room_id=m.room_id
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
          m.push_token token,m.push_identity_id identity_id,m.created_at,
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
              SELECT burst.id FROM ${messagePointsSql('m.burst_ids', 'burst')}
              WHERE burst.room_id=m.room_id AND burst.author_id=m.author_id
                AND burst.presentation='message' AND burst.deleted_at IS NULL
                AND burst.created_at>=m.created_at-interval '20 seconds'
                AND (burst.created_at,burst.id)<=(m.created_at,m.id)
                AND (room.direct_participants IS NOT NULL OR ${addressedToPersonSql('burst', 'recipient.id', 'recipient.handle', 'recipient.kind', false)})
              ORDER BY burst.created_at,burst.id LIMIT 1)
            ELSE m.id END
          -- Keep human prose visible when a subsequent agent summary replaces its slot.
          ELSE CASE WHEN author.kind='human' THEN room.id::text ELSE 'agent:'||room.id::text END
          END collapse_id,
          COALESCE(attention.direct,false) direct_attention,
          -- A DM takes its title from dm_peer below, not from a Room name. A
          -- corner under a DM is titled from the DM's stored name, as in the app.
          CASE WHEN room.direct_participants IS NULL
            THEN COALESCE(parent.name,room.name) END room_name,
          CASE WHEN parent.id IS NOT NULL THEN room.name END corner_name,
          -- A DM is titled by its peer, who is this message's author.
          CASE WHEN room.direct_participants IS NOT NULL THEN jsonb_build_object(
            'name',COALESCE(NULLIF(author.name,''),'Someone'),
            'handle',author.handle,'avatar',author.avatar) END dm_peer
        FROM queued_messages m
        JOIN rooms room ON room.id=m.room_id
        LEFT JOIN rooms parent ON parent.id=room.parent_id
        LEFT JOIN memberships workspace_member ON workspace_member.workspace_id=room.workspace_id
          AND workspace_member.room_id IS NULL AND workspace_member.identity_id=m.push_identity_id
          AND workspace_member.removed_at IS NULL
        JOIN identities author ON author.id=m.author_id
        JOIN identities recipient ON recipient.id=m.push_identity_id AND recipient.kind='human'
        CROSS JOIN LATERAL (SELECT ${pushDirectAttentionSql('m.turn_ids')} direct) attention

        WHERE (
            room.direct_participants IS NULL
            OR m.card_type IS NULL
            OR NOT (room.direct_participants @> jsonb_build_array('${SYSTEM_IDENTITY_ID}'::text))
            OR workspace_member.identity_id IS NOT NULL
          )
          AND recipient.push_level IN ('attention','full')
          AND (
            attention.direct
            OR (recipient.push_level='full' AND m.presentation='message' AND m.card_type IS NULL)
          )
        UNION ALL
        SELECT notification.id message_id,notification.workspace_id::text workspace_id,
          notification.room_id::text room_id,
          notification.room_id::text channel_id,NULL::text corner_id,'message' target,
          'workspace-join' notification_type,
          btrim(notification.text) text,device.device_token token,push_device.identity_id,
          notification.created_at,
          NULL::text action,NULL::text grant_id,NULL::text grant_kind,NULL::text grant_target,
          NULL::text grant_agent_name,NULL::text author_name,NULL::text collapse_id,
          false direct_attention,NULL::text room_name,NULL::text corner_name,NULL::jsonb dm_peer
        FROM jsonb_to_recordset($1::jsonb) queued(message_id text,device_token text)
        JOIN workspace_join_notifications notification ON notification.id=queued.message_id
        JOIN workspace_join_notification_devices device ON device.notification_id=notification.id AND device.device_token=queued.device_token
        JOIN push_devices push_device ON push_device.token=device.device_token
        JOIN identities recipient ON recipient.id=push_device.identity_id
          AND recipient.kind='human' AND recipient.push_level IN ('full')
        JOIN memberships workspace_member ON workspace_member.workspace_id=notification.workspace_id
          AND workspace_member.room_id IS NULL AND workspace_member.identity_id=push_device.identity_id
          AND workspace_member.removed_at IS NULL
        JOIN push_delivery_floors floor ON floor.id='message-delivery'
        WHERE notification.created_at>=push_device.registered_at
          AND notification.created_at>=floor.started_at
          AND notification.created_at>=now()-interval '1 hour'
          AND btrim(notification.text)<>''
      ), unclaimed AS (
        SELECT DISTINCT ON (candidate.message_id,candidate.token)
          candidate.message_id,candidate.workspace_id,candidate.room_id,candidate.channel_id,
          candidate.corner_id,candidate.target,
          candidate.notification_type,candidate.text,candidate.token,candidate.identity_id,
          candidate.created_at,device.platform,
          candidate.action,candidate.grant_id,candidate.grant_kind,candidate.grant_target,
          candidate.grant_agent_name,candidate.author_name,candidate.collapse_id,
          candidate.direct_attention,candidate.room_name,candidate.corner_name,candidate.dm_peer
        FROM candidates candidate
        JOIN push_devices device ON device.token=candidate.token
          AND device.platform IN (${[this.sender && "'android'", this.iosSender && "'ios'", this.webSender && "'web'"].filter(Boolean).join(',') || "'none'"})
        LEFT JOIN push_delivery_claims claim
          ON claim.message_id=candidate.message_id AND claim.device_token=candidate.token
        WHERE claim.message_id IS NULL OR (claim.status='retryable'
          AND claim.next_retry_at<=now() AND claim.attempts<${PUSH_MAX_ATTEMPTS})
          OR (claim.status='claimed' AND claim.claimed_at<now()-interval '1 minute'
            AND claim.attempts<${PUSH_MAX_ATTEMPTS})
        ORDER BY candidate.message_id,candidate.token
      )
      SELECT message_id,workspace_id,room_id,channel_id,corner_id,target,
        notification_type,text,token,identity_id,platform,
        action,grant_id,grant_kind,grant_target,grant_agent_name,author_name,collapse_id,
        direct_attention,room_name,corner_name,dm_peer
      FROM unclaimed ORDER BY created_at,message_id LIMIT 100
    `, [JSON.stringify(due.rows)]);
    });
    const cornerIds = [...new Set(candidates.rows.flatMap((row) => row.corner_id ? [row.corner_id] : []))];
    const cornerStates = new Map<string, DerivedCornerState>();
    if (cornerIds.length) {
      // State is viewer-independent. Use the same indexed facts as phone reads,
      // once per distinct corner in this bounded delivery batch.
      const facts = cornerFactsSql('NULL::text');
      const rows = await this.database.query<CornerStateRow & { id: string }>(
        `SELECT c.id,c.archived_at,${facts.columns} FROM rooms c ${facts.joins}
         WHERE c.id=ANY($1::uuid[])`, [cornerIds],
      );
      for (const row of rows.rows) cornerStates.set(row.id, cornerRowState(row));
    }
    let delivered = 0;
    type ClaimedDelivery = {
      candidate: (typeof candidates.rows)[number];
      message: Parameters<PushSender['send']>[1];
    };
    const claimedDeliveries: ClaimedDelivery[] = [];
    // Resolve the same mute, presence and read rules once for the whole batch.
    const suppression = await this.database.transaction(async tx => {
      await tx.query('SET LOCAL jit=off');
      return tx.query<{ message_id: string; token: string }>(`
        SELECT candidate.message_id,candidate.token
        FROM jsonb_to_recordset($1::jsonb) candidate(message_id text,token text,
          channel_id uuid,room_id uuid,identity_id text,direct_attention boolean)
        WHERE candidate.channel_id IS NOT NULL AND (
          EXISTS (SELECT 1 FROM effective_memberships member
            WHERE member.room_id=candidate.channel_id AND member.identity_id=candidate.identity_id
              AND member.removed_at IS NOT NULL)
          OR EXISTS (SELECT 1 FROM effective_memberships member
            WHERE member.room_id=candidate.room_id AND member.identity_id=candidate.identity_id
              AND member.push_muted AND (NOT candidate.direct_attention OR EXISTS (
                SELECT 1 FROM rooms dm WHERE dm.id=candidate.channel_id AND dm.direct_participants IS NOT NULL)))
          OR EXISTS (SELECT 1 FROM room_push_views view
            WHERE view.room_id=candidate.channel_id AND view.identity_id=candidate.identity_id
              AND (view.expires_at>now() OR EXISTS (SELECT 1 FROM live_server_instances server
                WHERE server.instance_id=view.instance_id
                  AND server.renewed_at>clock_timestamp()-make_interval(secs=>$2::double precision/1000))))
          OR EXISTS (SELECT 1 FROM room_read_marks mark
            WHERE mark.room_id=candidate.channel_id AND mark.identity_id=candidate.identity_id
              AND (mark.updated_at>now()-interval '30 seconds' OR EXISTS (SELECT 1 FROM messages m
                WHERE m.id=candidate.message_id
                  AND (mark.message_created_at,mark.message_id)>=(m.created_at,m.id))))
        )`, [JSON.stringify(candidates.rows), SERVER_LEASE_EXPIRY_MS]);
    });
    const suppressedKeys = new Set(suppression.rows.map(row => JSON.stringify([row.message_id,row.token])));
    for (const candidate of candidates.rows) {
      const claimed = Boolean(
        (
          await this.database.query(
            `INSERT INTO push_delivery_claims AS claim(message_id,device_token,status)
             SELECT $1,$2,'claimed'
             WHERE EXISTS (SELECT 1 FROM push_devices WHERE token=$2 AND identity_id=$3)
               AND EXISTS (SELECT 1 FROM identities WHERE id=$3 AND push_level<>'off')
               AND ($6<>'message' OR EXISTS (
                 SELECT 1 FROM messages m JOIN effective_memberships member ON member.room_id=m.room_id
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
               WHERE ((claim.status='retryable' AND claim.next_retry_at<=now())
                 OR (claim.status='claimed' AND claim.claimed_at<now()-interval '1 minute'))
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
      const suppressed = suppressedKeys.has(JSON.stringify([candidate.message_id,candidate.token]));
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
                ...(candidate.corner_id
                  ? { cornerId: candidate.corner_id, cornerState: cornerStates.get(candidate.corner_id) }
                  : {}),
                target: candidate.target,
                type: 'message' as const,
                text: candidate.text,
                ...(candidate.collapse_id ? { collapseId: candidate.collapse_id } : {}),
                ...pushTitleFor(
                  candidate.room_name,
                  candidate.corner_name,
                  candidate.channel_id,
                  candidate.dm_peer,
                ),
                ...pushActionFor(candidate),
                // Only a grant-request card carries `grants`, so its first
                // grant id marks a permission ask.
                ...(candidate.grant_id ? { permission: true as const } : {}),
              },
      });
    }
    const expiryByKey = new Map(due.rows.map(row => [JSON.stringify([row.message_id,row.device_token]), new Date(row.expires_at).getTime()]));
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
                .then(() => {
                  if (Date.now() >= expiryByKey.get(JSON.stringify([candidate.message_id,candidate.token]))!)
                    throw new Error('Push expired before provider send');
                  return sender.send(candidate.token, {
                    ...message,
                    recipientIdentityId: candidate.identity_id,
                  });
                });
              slotSends.set(slot, sending);
              await sending;
              await this.database.query(
                `UPDATE push_delivery_claims SET status='delivered',completed_at=now() WHERE message_id=$1 AND device_token=$2`,
                [candidate.message_id, candidate.token],
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
    // Terminal claims are authoritative during rolling cutover as well as retries.
    await this.database.query(`WITH retired AS (DELETE FROM push_outbox queue
      USING jsonb_to_recordset($1::jsonb) due(message_id text,device_token text)
      WHERE queue.message_id=due.message_id AND queue.device_token=due.device_token
        AND (queue.expires_at<=now() OR (
          NOT EXISTS (SELECT 1 FROM jsonb_to_recordset($2::jsonb) candidate(message_id text,token text)
            WHERE candidate.message_id=queue.message_id AND candidate.token=queue.device_token)
          -- Preserve only work that can become eligible without a message write.
          AND NOT EXISTS (SELECT 1 FROM push_devices device JOIN identities recipient ON recipient.id=device.identity_id
            WHERE device.token=queue.device_token AND (recipient.push_level='off'
              OR (recipient.push_level='attention' AND (
                EXISTS (SELECT 1 FROM messages m WHERE m.id=queue.message_id
                  AND m.presentation='message' AND m.card_type IS NULL)
                OR EXISTS (SELECT 1 FROM workspace_join_notifications notification
                  WHERE notification.id=queue.message_id)))
              OR NOT (device.platform=ANY($3::text[]))))
          AND NOT EXISTS (SELECT 1 FROM push_delivery_claims claim
            WHERE claim.message_id=queue.message_id AND claim.device_token=queue.device_token
              AND claim.status IN ('retryable','claimed'))
          AND NOT EXISTS (SELECT 1 FROM messages m JOIN agent_turns turn
            ON turn.room_id=m.room_id AND turn.agent_id=m.author_id AND turn.request_id=m.request_id
            WHERE m.id=queue.message_id AND turn.status='working')
        ) OR EXISTS (
          SELECT 1 FROM push_delivery_claims claim WHERE claim.message_id=queue.message_id
            AND claim.device_token=queue.device_token AND claim.status IN ('delivered','failed','suppressed')))
      RETURNING queue.message_id,queue.device_token,queue.expires_at)
      INSERT INTO push_outbox_retirements(message_id,device_token,reason)
      SELECT message_id,device_token,
        CASE WHEN expires_at<=now() THEN 'expired' ELSE 'ineligible' END FROM retired
      WHERE NOT EXISTS (SELECT 1 FROM push_delivery_claims claim
        WHERE claim.message_id=retired.message_id AND claim.device_token=retired.device_token
          AND claim.status IN ('delivered','failed','suppressed'))
      ON CONFLICT(message_id,device_token) DO UPDATE SET reason=EXCLUDED.reason,retired_at=now()`,
      [JSON.stringify(due.rows), JSON.stringify(candidates.rows),
        [this.sender && 'android', this.iosSender && 'ios', this.webSender && 'web'].filter(Boolean)]);
    await this.database.query(`UPDATE push_outbox queue SET not_before=COALESCE(
        (SELECT CASE WHEN claim.status='claimed' THEN claim.claimed_at+interval '1 minute' ELSE claim.next_retry_at END FROM push_delivery_claims claim
         WHERE claim.message_id=queue.message_id AND claim.device_token=queue.device_token
           AND claim.status IN ('retryable','claimed')),
        CASE WHEN NOT EXISTS (
          SELECT 1 FROM jsonb_to_recordset($2::jsonb) candidate(message_id text,token text)
          WHERE candidate.message_id=queue.message_id AND candidate.token=queue.device_token)
          AND EXISTS (SELECT 1 FROM push_devices device JOIN identities recipient ON recipient.id=device.identity_id
            WHERE device.token=queue.device_token AND recipient.push_level IN ('off','attention')
              AND device.platform=ANY($3::text[]))
        -- Preference changes already reset not_before in the write transaction.
        -- Retain these rows without repeatedly competing with deliverable pushes.
        THEN queue.expires_at ELSE now()+interval '1 minute' END)
      FROM jsonb_to_recordset($1::jsonb) due(message_id text,device_token text,lease_until timestamptz)
      WHERE queue.message_id=due.message_id AND queue.device_token=due.device_token
        -- A concurrent preference/turn write owns its new deadline.
        AND queue.not_before=due.lease_until`,
      [JSON.stringify(due.rows), JSON.stringify(candidates.rows),
        [this.sender && 'android', this.iosSender && 'ios', this.webSender && 'web'].filter(Boolean)]);
    this.#repeatBatch = due.rows.length === 100 || (expired.rowCount ?? 0) === 1000;
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
  await cleanupUnfinishedAppSignIns(database, true);
  // Outgoing MCP member webhooks leave the wake transaction here.
  try { await retryMcpMemberRoutes(database); } catch (error) { captureServerError(error); }
  try { await deliverMcpMemberWebhooks(database); } catch (error) { captureServerError(error); }
  // Each autocommitted batch fits the jobs pool budget; later cycles finish backlogs.
  const expired = [
    ['agent_turn_traces', "created_at<now()-interval '30 days'"],
    ['room_push_views', 'expires_at<now()'],
    ['agent_commands', "state IN ('complete','cancelled') AND completed_at<now()-interval '30 days'"],
    ['phone_access_tokens', 'expires_at<now()'],
    ['rooms_mcp_flows', 'expires_at<now()'],
    ['rooms_mcp_codes', 'expires_at<now()'],
    ['rooms_mcp_tokens', 'expires_at<now()'],
    ['rooms_mcp_families', "revoked_at<now()-interval '30 days'"],
    ['rooms_mcp_connections', "revoked_at<now()-interval '30 days'"],
    ['rooms_mcp_audit', "created_at<now()-interval '30 days'"],
    ['rooms_mcp_pending_routes', "created_at<now()-interval '7 days'"],
    ['rooms_mcp_admission', "window_at<now()-interval '1 day'"],
    ['rooms_mcp_clients', "created_at<now()-interval '30 days' AND NOT preregistered AND NOT EXISTS(SELECT 1 FROM rooms_mcp_connections WHERE client_id=rooms_mcp_clients.id) AND NOT EXISTS(SELECT 1 FROM rooms_mcp_tokens WHERE client_id=rooms_mcp_clients.id) AND NOT EXISTS(SELECT 1 FROM rooms_mcp_flows WHERE client_id=rooms_mcp_clients.id) AND NOT EXISTS(SELECT 1 FROM rooms_mcp_codes WHERE client_id=rooms_mcp_clients.id)"],
    ['live_outputs', "updated_at<now()-interval '2 hours' AND kind<>'presence'"],
    ['github_auth_flows', "expires_at<now()-interval '1 day'"],
    ['daemon_token_exchanges', "expires_at<now()-interval '1 day'"],
    ['pending_mention_notices', "due_at<now()-interval '30 days'"],
  ] as const;
  for (const [table, predicate] of expired) {
    await database.query(`DELETE FROM ${table} WHERE ctid IN (
      SELECT ctid FROM ${table} WHERE ${predicate} LIMIT 1000 FOR UPDATE SKIP LOCKED)`);
  }
}

/**
 * Exactly one process owns background work. PostgreSQL releases the advisory
 * lock automatically when this dedicated connection dies, allowing its peer
 * to acquire it without a queue, worker process, or lease clock.
 */
export class BackgroundLeader {
  #stopped = false;
  #running: Promise<void> | undefined;
  #client: LeaderConnection | undefined;
  #wake: (() => void) | undefined;
  #wakePending = false;

  constructor(
    private readonly database: { connectDedicated(): Promise<LeaderConnection> },
    private readonly cycle: (newLeader: boolean) => Promise<number | void>,
    private readonly reconciliationMs = 60_000,
  ) {}

  run(): Promise<void> {
    return this.#running ??= this.runLoop();
  }

  private async runLoop(): Promise<void> {
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
        let newLeader = true;
        while (!this.#stopped) {
          // Detect a dead lock-owning connection before any work can fire.
          await client.query('SELECT 1');
          if (this.#stopped) break;
          const nextDelay = await this.cycle(newLeader);
          newLeader = false;
          await this.wait(
            typeof nextDelay === 'number'
              ? Math.max(0, Math.min(nextDelay, this.reconciliationMs))
              : this.reconciliationMs,
          );
        }
      } catch (error) {
        captureServerError(error);
        console.error('[background] leader cycle failed', error);
        await this.wait();
      } finally {
        this.#client?.release(true);
        this.#client = undefined;
      }
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#wake?.();
    await this.#running;
  }

  /** Recompute background work after a committed database notification. */
  wake(): void {
    if (this.#wake) this.#wake();
    else this.#wakePending = true;
  }

  private wait(milliseconds = this.reconciliationMs): Promise<void> {
    if (this.#stopped) return Promise.resolve();
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
      // Operator deliveries stay pending when BEGIN/checkout fails. The next
      // leader loop retries them; keep a continuing outage at error level.
      if (name === 'operator-system-dms' && error instanceof DatabaseTransactionStartError &&
          health.consecutiveFailures === 1) {
        console.warn(`[background] ${name} deferred until next loop`, error);
        return { ok: false };
      }
      captureServerError(error, { background_job: name });
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
