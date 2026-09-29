import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LookupAddress } from 'node:dns';
import { createWebPushSender, validateWebPushSubscription, webPushPublicKey } from './web-push.js';

const sendNotification = vi.hoisted(() => vi.fn(async () => undefined));
const lookup = vi.hoisted(() => vi.fn(async (): Promise<LookupAddress[]> => [{ address: '8.8.8.8', family: 4 }]));
vi.mock('node:dns/promises', () => ({ lookup }));
vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification } }));

const endpoint = 'https://fcm.googleapis.com/fcm/send/test-subscription';
const keys = { p256dh: 'a'.repeat(87), auth: 'b'.repeat(22) };
const environment = {
  WEB_PUSH_VAPID_PUBLIC_KEY: 'public',
  WEB_PUSH_VAPID_PRIVATE_KEY: 'private',
};

describe('web push transport', () => {
  beforeEach(() => {
    lookup.mockReset();
    lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    sendNotification.mockClear();
  });
  it('requires configured VAPID credentials and accepts HTTPS browser push endpoints', async () => {
    expect(webPushPublicKey({})).toBeNull();
    expect(createWebPushSender({ query: vi.fn() } as never, {})).toBeUndefined();
    await expect(validateWebPushSubscription(endpoint, keys)).resolves.toMatchObject({ address: '8.8.8.8' });
    for (const publicEndpoint of [
      'https://web.push.apple.com/QWERTY',
      'https://updates.push.services.mozilla.com/wpush/v2/QWERTY',
      'https://db3.notify.windows.com/?token=QWERTY',
      'https://push.example.org/subscription',
    ]) await expect(validateWebPushSubscription(publicEndpoint, keys)).resolves.toMatchObject({ address: '8.8.8.8' });
    for (const invalidEndpoint of [
      'http://push.example.org/subscription',
      'https://user:pass@push.example.org/subscription',
      'https://push.example.org:8443/subscription',
      'https://push.example.org/subscription#fragment',
    ]) await expect(validateWebPushSubscription(invalidEndpoint, keys)).rejects.toThrow('invalid web push endpoint');
    await expect(validateWebPushSubscription(endpoint, { ...keys, auth: 'bad' })).rejects.toThrow(
      'invalid web push keys',
    );
  });

  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.1.1', '192.168.1.1', '169.254.169.254',
    '100.64.1.1', '0.0.0.0', '192.0.0.1', '198.18.0.1', '224.0.0.1',
    '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1',
  ])('rejects internal address %s at registration and the send boundary', async (address) => {
    lookup.mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }]);
    const host = address.includes(':') ? `[${address}]` : address;
    await expect(validateWebPushSubscription(`https://${host}/push`, keys)).rejects.toThrow('invalid web push endpoint');
    sendNotification.mockClear();
    const sender = createWebPushSender({ query: vi.fn(async () => ({ rows: [{ web_keys: keys }] })) } as never, environment)!;
    await expect(sender.send(`https://${host}/push`, {
      type: 'test', messageId: 'test', text: 'secret', recipientIdentityId: 'person-1',
    })).rejects.toThrow();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('rejects a public hostname with any internal DNS answer and pins the checked send address', async () => {
    lookup.mockResolvedValueOnce([
      { address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 },
    ]);
    await expect(validateWebPushSubscription(endpoint, keys)).rejects.toThrow('invalid web push endpoint');
    lookup.mockResolvedValueOnce([
      { address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 },
    ]);
    sendNotification.mockClear();
    const sender = createWebPushSender({ query: vi.fn(async () => ({ rows: [{ web_keys: keys }] })) } as never, environment)!;
    const message = { type: 'test' as const, messageId: 'test', text: 'secret', recipientIdentityId: 'person-1' };
    await expect(sender.send(endpoint, message)).rejects.toThrow();
    expect(sendNotification).not.toHaveBeenCalled();

    lookup.mockResolvedValueOnce([{ address: '8.8.4.4', family: 4 }]);
    await sender.send(endpoint, message);
    const options = sendNotification.mock.lastCall![2] as { agent: { options: { lookup: Function } } };
    lookup.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    await new Promise<void>((resolve, reject) => options.agent.options.lookup('fcm.googleapis.com', {}, (error: Error | null, address: string, family: number) => {
      if (error) reject(error);
      else {
        expect([address, family]).toEqual(['8.8.4.4', 4]);
        resolve();
      }
    }));
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('rejects DNS rebinding after registration and fails closed on resolution errors', async () => {
    await expect(validateWebPushSubscription(endpoint, keys)).resolves.toMatchObject({ address: '8.8.8.8' });
    lookup.mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]);
    const sender = createWebPushSender({ query: vi.fn(async () => ({ rows: [{ web_keys: keys }] })) } as never, environment)!;
    const message = { type: 'test' as const, messageId: 'test', text: 'secret', recipientIdentityId: 'person-1' };
    await expect(sender.send(endpoint, message)).rejects.toThrow('invalid web push endpoint');
    expect(sendNotification).not.toHaveBeenCalled();
    lookup.mockRejectedValueOnce(new Error('DNS lookup failed with endpoint details'));
    await expect(sender.send(endpoint, message)).rejects.toThrow('invalid web push endpoint');
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('accepts public IPv4 and IPv6 literal or DNS answers', async () => {
    await expect(validateWebPushSubscription('https://8.8.8.8/push', keys)).resolves.toMatchObject({ address: '8.8.8.8' });
    await expect(validateWebPushSubscription('https://[2606:4700:4700::1111]/push', keys)).resolves.toMatchObject({ address: '2606:4700:4700::1111' });
    lookup.mockResolvedValueOnce([{ address: '2606:4700:4700::1111', family: 6 }]);
    await expect(validateWebPushSubscription(endpoint, keys)).resolves.toMatchObject({ address: '2606:4700:4700::1111' });
  });

  it('sends a bounded notification only for the claimed recipient', async () => {
    sendNotification.mockClear();
    const query = vi.fn(async () => ({ rows: [{ web_keys: keys }] }));
    const sender = createWebPushSender({ query } as never, environment)!;
    await sender.send(endpoint, {
      type: 'message',
      messageId: 'message-1',
      workspaceId: 'workspace',
      roomId: 'room',
      channelId: 'room',
      target: 'message',
      text: 'hello',
      recipientIdentityId: 'person-1',
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('identity_id=$2'), [
      endpoint,
      'person-1',
    ]);
    expect(sendNotification).toHaveBeenCalledWith(
      { endpoint, keys },
      expect.stringContaining('hello'),
      expect.objectContaining({ TTL: 3600, agent: expect.anything() }),
    );
    const sent = JSON.parse((sendNotification.mock.calls[0] as unknown as [unknown, string])[1]);
    expect(sent).toMatchObject({ channelId: 'room', roomId: 'room' });
  });

  it('refuses a subscription that moved to another person', async () => {
    sendNotification.mockClear();
    const sender = createWebPushSender(
      { query: vi.fn(async () => ({ rows: [] })) } as never,
      environment,
    )!;
    await expect(
      sender.send(endpoint, {
        type: 'test',
        messageId: 'test',
        text: 'secret',
        recipientIdentityId: 'old-person',
      }),
    ).rejects.toMatchObject({ classification: 'unregistered' });
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
