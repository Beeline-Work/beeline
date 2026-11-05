import { type SqlDatabase } from './database.js';
import { cutCornerTitle, cutTitle, directMessageTitle, roomTitle, type ChatTitleIdentity, type DerivedCornerState, type PushActionPayload, type ReadClear } from '@beeline/api-contract/phone';
import { PushDeliveryLoop } from './background-push-delivery-loop.js';
import { MediaExpiryLoop, pruneArchivedToolActivity, runMaintenance, BackgroundJobHealth, BackgroundJobRunner } from './background-media-expiry-loop.js';



export const PUSH_MAX_ATTEMPTS = 3;

/** Bound concurrent device sends after serial claim/suppress. APNS can take
 * up to APNS_REQUEST_TIMEOUT_MS per token; serializing 100 candidates on the
 * sole background leader otherwise stalls attention delivery. */
export const PUSH_DELIVERY_CONCURRENCY = 8;


export function isRetryableApnsFailure(error: unknown): boolean {
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


export const PUSH_TITLE_LENGTH = 40;

export const PUSH_TITLE_ROOM_LENGTH = 16;


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
export function messagePointsSql(ids: string, alias: string): string {
  return `unnest(${ids}) ${alias}_ids(id)
    CROSS JOIN LATERAL (SELECT * FROM messages WHERE id=${alias}_ids.id OFFSET 0) ${alias}`;
}


/**
 * One push per recipient per agent turn. An agent message is one of its
 * turn's messages when it shares the Room, the author and the request id.
 * True when this device was already claimed for another message of the same
 * turn, so the later ones stay quiet however many of them qualify.
 */
export function earlierTurnPushSql(message: string, deviceToken: string): string {
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
export { PushDeliveryLoop } from './background-push-delivery-loop.js';
export { MediaExpiryLoop } from './background-media-expiry-loop.js';
export { pruneArchivedToolActivity } from './background-media-expiry-loop.js';
export { runMaintenance } from './background-media-expiry-loop.js';
export type { BackgroundJobHealth } from './background-media-expiry-loop.js';
export { BackgroundJobRunner } from './background-media-expiry-loop.js';
