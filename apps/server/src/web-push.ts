import webpush from 'web-push';
import { lookup } from 'node:dns/promises';
import { Agent } from 'node:https';
import { isIP } from 'node:net';
import { parse as parseLegacyUrl } from 'node:url';
import ipaddr from 'ipaddr.js';
import type { SqlDatabase } from './database.js';
import type { PushSender } from './background.js';

export type WebPushKeys = { p256dh: string; auth: string };

export function webPushPublicKey(environment: NodeJS.ProcessEnv): string | null {
  return environment.WEB_PUSH_VAPID_PUBLIC_KEY && environment.WEB_PUSH_VAPID_PRIVATE_KEY
    ? environment.WEB_PUSH_VAPID_PUBLIC_KEY
    : null;
}

/** Browser push services provide opaque HTTPS endpoints across browser vendors. */
function isPublicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address);
    if (parsed.range() !== 'unicast') return false;
    // IPv6 global unicast is 2000::/3; documentation addresses are never endpoints.
    return parsed.kind() === 'ipv4' ||
      (parsed.match(ipaddr.parseCIDR('2000::/3')) && !parsed.match(ipaddr.parseCIDR('2001:db8::/32')));
  } catch {
    return false;
  }
}

async function resolvePublicAddress(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  const host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  try {
    const answers = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await lookup(host, { all: true, verbatim: true });
    if (!answers.length || answers.some(({ address }) => !isPublicAddress(address)))
      throw new Error('unsafe address');
    const answer = answers[0];
    if (!answer || (answer.family !== 4 && answer.family !== 6)) throw new Error('invalid address family');
    return { address: answer.address, family: answer.family };
  } catch {
    // Never expose a subscription endpoint or DNS error in a client response.
    throw new Error('invalid web push endpoint');
  }
}

export async function validateWebPushSubscription(endpoint: string, keys: WebPushKeys | undefined): Promise<{ hostname: string; address: string; family: 4 | 6 }> {
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
  // web-push uses node:url.parse for https.request; verify its actual host.
  if (parseLegacyUrl(url.href).hostname !== url.hostname.replace(/^\[|\]$/g, ''))
    throw new Error('invalid web push endpoint');
  if (
    !keys ||
    !/^[A-Za-z0-9_-]{80,100}$/.test(keys.p256dh) ||
    !/^[A-Za-z0-9_-]{16,40}$/.test(keys.auth)
  )
    throw new Error('invalid web push keys');
  return { hostname: url.hostname, ...await resolvePublicAddress(url.hostname) };
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
      const checked = await validateWebPushSubscription(endpoint, keys);
      // A fresh agent pins this request's connect address while HTTPS keeps the
      // original hostname for SNI and certificate verification.
      const agent = new Agent({ autoSelectFamily: false, lookup(hostname, _options, callback) {
        if (hostname !== checked.hostname && hostname !== checked.hostname.replace(/^\[|\]$/g, ''))
          return callback(new Error('invalid web push endpoint'), '', 4);
        callback(null, checked.address, checked.family);
      } });
      const url =
        message.type === 'test'
          ? '/beeline/channels'
          : message.type === 'workspace-join' && !message.roomId
            ? `/beeline/channels?communityId=${encodeURIComponent(message.workspaceId)}`
            : `/beeline/chat/${encodeURIComponent(message.type === 'message' ? message.channelId : message.roomId!)}?communityId=${encodeURIComponent(message.workspaceId)}`;
      try {
        await webpush.sendNotification(
          { endpoint: new URL(endpoint).href, keys },
          JSON.stringify({
            body: message.text.slice(0, 200),
            url,
            messageId: message.messageId,
            ...(message.type === 'message'
              ? { channelId: message.channelId, roomId: message.roomId }
              : {}),
          }),
          { TTL: 60 * 60, urgency: 'normal', agent },
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
      } finally {
        agent.destroy();
      }
    },
  };
}
