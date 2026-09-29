import webpush from 'web-push';
import type { SqlDatabase } from './database.js';
import type { PushSender } from './background.js';

export type WebPushKeys = { p256dh: string; auth: string };

export function webPushPublicKey(environment: NodeJS.ProcessEnv): string | null {
  return environment.WEB_PUSH_VAPID_PUBLIC_KEY && environment.WEB_PUSH_VAPID_PRIVATE_KEY
    ? environment.WEB_PUSH_VAPID_PUBLIC_KEY
    : null;
}

/** Browser push services provide opaque HTTPS endpoints across browser vendors. */
export function validateWebPushSubscription(endpoint: string, keys: WebPushKeys | undefined): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('invalid web push endpoint');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    endpoint.length > 2048
  )
    throw new Error('invalid web push endpoint');
  if (
    !keys ||
    !/^[A-Za-z0-9_-]{80,100}$/.test(keys.p256dh) ||
    !/^[A-Za-z0-9_-]{16,40}$/.test(keys.auth)
  )
    throw new Error('invalid web push keys');
}

export function createWebPushSender(
  database: SqlDatabase,
  environment: NodeJS.ProcessEnv,
): PushSender | undefined {
  const publicKey = webPushPublicKey(environment);
  if (!publicKey) return undefined;
  webpush.setVapidDetails(
    environment.WEB_PUSH_VAPID_SUBJECT || 'mailto:support@usebeeline.app',
    publicKey,
    environment.WEB_PUSH_VAPID_PRIVATE_KEY!,
  );
  return {
    async send(endpoint, message) {
      const row = await database.query<{ web_keys: WebPushKeys | null }>(
        `SELECT web_keys FROM push_devices WHERE token=$1 AND identity_id=$2 AND platform='web'`,
        [endpoint, message.recipientIdentityId],
      );
      const keys = row.rows[0]?.web_keys;
      if (!keys)
        throw Object.assign(new Error('web push subscription unavailable'), {
          classification: 'unregistered',
        });
      const url =
        message.type === 'test'
          ? '/beeline/channels'
          : message.type === 'workspace-join' && !message.roomId
            ? `/beeline/channels?communityId=${encodeURIComponent(message.workspaceId)}`
            : `/beeline/chat/${encodeURIComponent(message.type === 'message' ? message.channelId : message.roomId!)}?communityId=${encodeURIComponent(message.workspaceId)}`;
      try {
        await webpush.sendNotification(
          { endpoint, keys },
          JSON.stringify({
            body: message.text.slice(0, 200),
            url,
            messageId: message.messageId,
            ...(message.type === 'message'
              ? { channelId: message.channelId, roomId: message.roomId }
              : {}),
          }),
          { TTL: 60 * 60, urgency: 'normal' },
        );
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'statusCode' in error &&
          (error.statusCode === 404 || error.statusCode === 410)
        )
          throw Object.assign(new Error('web push subscription expired'), {
            classification: 'unregistered',
          });
        // Never forward an endpoint, key, or payload from the vendor error into delivery claims.
        throw new Error('web push delivery failed');
      }
    },
  };
}
