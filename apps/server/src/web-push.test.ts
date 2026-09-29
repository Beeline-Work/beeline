import { describe, expect, it, vi } from 'vitest';
import { createWebPushSender, validateWebPushSubscription, webPushPublicKey } from './web-push.js';

const sendNotification = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification } }));

const endpoint = 'https://fcm.googleapis.com/fcm/send/test-subscription';
const keys = { p256dh: 'a'.repeat(87), auth: 'b'.repeat(22) };
const environment = {
  WEB_PUSH_VAPID_PUBLIC_KEY: 'public',
  WEB_PUSH_VAPID_PRIVATE_KEY: 'private',
};

describe('web push transport', () => {
  it('requires configured VAPID credentials and a Chrome push endpoint', () => {
    expect(webPushPublicKey({})).toBeNull();
    expect(createWebPushSender({ query: vi.fn() } as never, {})).toBeUndefined();
    expect(() => validateWebPushSubscription(endpoint, keys)).not.toThrow();
    expect(() => validateWebPushSubscription('https://evil.example/collect', keys)).toThrow(
      'invalid web push endpoint',
    );
    expect(() => validateWebPushSubscription(endpoint, { ...keys, auth: 'bad' })).toThrow(
      'invalid web push keys',
    );
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
      expect.objectContaining({ TTL: 3600 }),
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
