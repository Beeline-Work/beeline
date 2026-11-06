import { messageColumns } from './message-columns.js';
import { captureServerError } from './sentry.js';
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
import { apnsReadClearBatch } from './apns-push.js';
import { firebaseReadClearBatch } from './firebase-push.js';
import { cornerFactsSql, cornerRowState, type CornerStateRow } from './chat-corner-counts.js';
import { pushDirectAttentionSql } from './push-attention.js';
import { SERVER_LEASE_EXPIRY_MS } from './connection-presence.js';

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
    CROSS JOIN LATERAL (SELECT ${messageColumns('stored')} FROM messages stored WHERE id=${alias}_ids.id OFFSET 0) ${alias}`;
}

/**
 * One push per recipient per agent turn. An agent message is one of its
 * turn's messages when it shares the Room, the author and the request id.
 * True when this device was already claimed for another message of the same
 * turn, so the later ones stay quiet however many of them qualify.
 */
function earlierTurnPushSql(message: string, deviceToken: string): string {
  return `EXISTS (
    SELECT 1 FROM ${messagePointsSql(`COALESCE((SELECT turn.turn_ids FROM push_turn_context turn
      WHERE turn.room_id=${message}.room_id AND turn.author_id=${message}.author_id AND turn.request_id=${message}.request_id),
      (SELECT context.turn_ids FROM push_message_context context WHERE context.message_id=${message}.id),ARRAY[]::text[])`, 'sibling')}
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
  constructor(
    private readonly database: SqlDatabase,
    private readonly sender: PushSender | undefined,
    private readonly iosSender?: PushSender,
    private readonly webSender?: PushSender,
  ) {}

  async runOnce(): Promise<number> {
    const delivered = await this.runUnthrottled();
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
                 JOIN LATERAL (SELECT ${messageColumns('stored')} FROM messages stored WHERE id=claim.message_id OFFSET 0) message ON true
                 WHERE claim.device_token=device.token AND claim.status='delivered'
                   AND claim.read_cleared_at IS NULL
                   AND message.room_id=mark.room_id AND message.created_at>=device.registered_at
                   AND (message.created_at,message.id)<(mark.message_created_at,mark.message_id)
                 ORDER BY message.created_at DESC,message.id DESC
               ) pushed
             ),'[]'::jsonb) read_ids
           FROM room_read_marks mark
           WHERE mark.identity_id=device.identity_id
             AND EXISTS (
               SELECT 1 FROM push_delivery_claims claim
               JOIN LATERAL (SELECT ${messageColumns('stored')} FROM messages stored WHERE id=claim.message_id OFFSET 0) message ON true
               WHERE claim.device_token=device.token AND claim.status='delivered'
                 AND claim.read_cleared_at IS NULL
                 AND message.room_id=mark.room_id AND message.created_at>=device.registered_at
                 AND (message.created_at,message.id)<=(mark.message_created_at,mark.message_id))
           ORDER BY mark.message_created_at,mark.room_id::text
         ) pending
       ) batch
       WHERE device.platform=ANY($1::text[]) AND batch.channel_ids IS NOT NULL
`,
      [enabled],
    );
    for (const row of due.rows) {
      const { sender, batch } = platforms[row.platform];
      if (!sender?.clearRead) continue;
      let pending = row.channel_ids.map((channelId, index) => ({
        channelId, messageId: row.message_ids[index]!,
        readMessageIds: JSON.parse(row.read_message_ids[index]!) as string[],
      }));
      while (pending.length) {
        const reads = batch(pending);
        try {
          await sender.clearRead(row.token, reads);
          await this.database.query(
            `UPDATE push_delivery_claims SET read_cleared_at=now()
             WHERE device_token=$1 AND message_id=ANY($2::text[])`,
            [row.token, reads.flatMap(read => [read.messageId, ...read.readMessageIds])]);
        } catch (error) {
          if (isUnregisteredPushToken(error)) await this.database.query(`DELETE FROM push_devices WHERE token=$1`, [row.token]);
          break;
        }
        const sent = new Map(reads.map(read => [read.channelId, new Set([read.messageId, ...read.readMessageIds])]));
        pending = pending.flatMap(read => {
          const ids = sent.get(read.channelId);
          if (!ids) return [read];
          const remaining = read.readMessageIds.filter(id => !ids.has(id));
          return remaining.length ? [{ ...read, readMessageIds: remaining }] : [];
        });
      }
    }
  }

  private async runUnthrottled(): Promise<number> {
    // A newly enabled worker must start from its own durable boundary rather than
    // claiming the Room backlog that existed before delivery was enabled.
    await this.database.query(
      `INSERT INTO push_delivery_floors(id) VALUES('message-delivery') ON CONFLICT(id) DO NOTHING`,
    );
    const due = await this.database.query<{ message_id: string; device_token: string; expires_at: Date }>(`
      DELETE FROM push_outbox RETURNING message_id,device_token,expires_at
    `);
    if (!due.rows.length) return 0;
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
        SELECT m.*,COALESCE(turn.turn_ids,context.turn_ids) turn_ids,d.token push_token,d.identity_id push_identity_id
        FROM jsonb_to_recordset($1::jsonb) queued(message_id text,device_token text)
        JOIN LATERAL (SELECT ${messageColumns('stored')} FROM messages stored WHERE id=queued.message_id OFFSET 0) m ON true
        JOIN push_message_context context ON context.message_id=m.id
        LEFT JOIN push_turn_context turn ON turn.room_id=m.room_id AND turn.author_id=m.author_id AND turn.request_id=m.request_id
        JOIN push_delivery_floors floor ON floor.id='message-delivery'
        JOIN push_devices d ON d.token=queued.device_token AND m.created_at>=d.registered_at
        JOIN LATERAL (SELECT 1 FROM room_access member
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

          )
          AND NOT ${earlierTurnPushSql('m', 'd.token')}
          -- A completed turn's decision/tag metadata qualifies its final prose,
          -- rather than winning the turn's one push before that prose.
          AND NOT (m.presentation IN ('system','card') AND m.request_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM agent_turns t WHERE t.room_id=m.room_id
              AND t.request_id=m.request_id AND t.agent_id=m.author_id AND t.status='complete')
            AND EXISTS (SELECT 1 FROM ${messagePointsSql('COALESCE(turn.turn_ids,context.turn_ids)', 'final')} WHERE final.room_id=m.room_id
              AND final.author_id=m.author_id AND final.request_id=m.request_id
              AND final.presentation='message' AND final.deleted_at IS NULL))
          -- Durable chat from agents waits for completion and selects final prose.
          AND (m.presentation<>'message' OR m.request_id IS NULL
            OR NOT EXISTS (SELECT 1 FROM identities a WHERE a.id=m.author_id AND a.kind='agent')
            OR (NOT EXISTS (SELECT 1 FROM agent_turns t WHERE t.room_id=m.room_id
                AND t.request_id=m.request_id AND t.agent_id=m.author_id AND t.status='working')
              AND NOT EXISTS (SELECT 1 FROM ${messagePointsSql('COALESCE(turn.turn_ids,context.turn_ids)', 'newer')} WHERE newer.room_id=m.room_id
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
          CASE WHEN attention.direct OR m.presentation<>'message' THEN m.id
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
        WHERE claim.message_id IS NULL
        ORDER BY candidate.message_id,candidate.token
      )
      SELECT message_id,workspace_id,room_id,channel_id,corner_id,target,
        notification_type,text,token,identity_id,platform,
        action,grant_id,grant_kind,grant_target,grant_agent_name,author_name,collapse_id,
        direct_attention,room_name,corner_name,dm_peer
      FROM unclaimed ORDER BY created_at,message_id
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
          EXISTS (SELECT 1 FROM room_access member
            WHERE member.room_id=candidate.channel_id AND member.identity_id=candidate.identity_id
              AND member.removed_at IS NOT NULL)
          OR EXISTS (SELECT 1 FROM room_access member
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
                 SELECT 1 FROM messages m JOIN room_access member ON member.room_id=m.room_id
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
             ON CONFLICT(message_id,device_token) DO NOTHING`,
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
    const workerResults = await Promise.all(
      claimedDeliveries.map(async ({ candidate, message }) => {
          let localDelivered = 0;

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
                 SET status='failed',completed_at=now(),error=$3
                 WHERE message_id=$1 AND device_token=$2`,
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
          return localDelivered;
        }),
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

export interface BackgroundJobHealth {
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastDurationMs: number | null;
  consecutiveFailures: number;
}

/** Independent failure reporting for committed event jobs. */
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
      // committed delivery or real recovery may resume them; keep a
      // continuing outage at error level without creating a retry timer.
      if (name === 'operator-system-dms' && error instanceof DatabaseTransactionStartError &&
          health.consecutiveFailures === 1) {
        console.warn(`[background] ${name} deferred until committed delivery or recovery`, error);
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
