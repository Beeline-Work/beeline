import { describe, expect, it, vi } from 'vitest';
import {
  createHandledActionStore,
  handleNotificationAction,
  notificationActionCategories,
  readNotificationAction,
  replyDraftFromResponse,
  type NotificationActionDeps,
  type OutcomeNotification,
} from './notification-actions';

const grantData = {
  type: 'channel-activity',
  target: 'message',
  workspaceId: 'workspace-1',
  roomId: 'system-dm',
  channelId: 'system-dm',
  messageId: 'card-1',
  categoryId: 'beeline-grant',
  grantId: 'grant-1',
  grantKind: 'host',
  grantTarget: 'api.stripe.com',
  agentName: 'wren',
  title: 'Beeline',
  message: '@wren asked @charles for host api.stripe.com · checking the invoice webhook',
  tag: 'card-1',
};

const replyData = {
  type: 'channel-activity',
  target: 'message',
  workspaceId: 'workspace-1',
  roomId: 'room-1',
  channelId: 'corner-1',
  cornerId: 'corner-1',
  messageId: 'message-1',
  categoryId: 'beeline-reply',
  authorName: 'Maya',
  message: 'Maya: @charles the deploy check is red, can you look?',
};

/** The Android task payload: expo's serialized NotificationResponse bundle. */
function response(actionIdentifier: string, data: Record<string, string>, userText?: string) {
  return {
    actionIdentifier,
    ...(userText !== undefined ? { userText } : {}),
    notification: {
      request: {
        identifier: data.tag ?? data.messageId,
        content: { title: 'Beeline', body: data.message, data },
      },
    },
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => void values.set(key, value),
  };
}

function deps(
  platform: 'android' | 'ios',
  overrides: Partial<NotificationActionDeps> = {},
): NotificationActionDeps & { presented: OutcomeNotification[] } {
  const presented: OutcomeNotification[] = [];
  return {
    platform,
    decideGrant: vi.fn().mockResolvedValue({ grantId: 'grant-1', status: 'once', roomId: 'x' }),
    sendReply: vi.fn().mockResolvedValue({ messageId: 'new' }),
    newMessageId: () => 'f'.repeat(64),
    present: async (notification) => void presented.push(notification),
    handled: createHandledActionStore(memoryStorage()),
    inFlight: new Set(),
    presented,
    ...overrides,
  };
}

describe('notification action categories', () => {
  it('reads like the in-app card on Android and never asks for an unlock there', () => {
    const [grant, reply] = notificationActionCategories('android');
    expect(grant!.identifier).toBe('beeline-grant');
    expect(grant!.actions.map((action) => action.buttonTitle)).toEqual(['No', 'Once', 'Always']);
    for (const action of [...grant!.actions, ...reply!.actions]) {
      expect(action.options.opensAppToForeground).toBe(false);
      expect(action.options).not.toHaveProperty('isAuthenticationRequired');
    }
    expect(reply).toMatchObject({
      identifier: 'beeline-reply',
      actions: [
        { identifier: 'reply', buttonTitle: 'Reply', textInput: { submitButtonTitle: 'Send' } },
      ],
    });
  });

  it('lists No last on iOS and asks for Face ID before any action runs', () => {
    const [grant, reply] = notificationActionCategories('ios');
    expect(grant!.actions.map((action) => action.buttonTitle)).toEqual(['Always', 'Once', 'No']);
    expect(grant!.actions[2]!.options.isDestructive).toBe(true);
    for (const action of [...grant!.actions, ...reply!.actions])
      expect(action.options).toMatchObject({
        opensAppToForeground: false,
        isAuthenticationRequired: true,
      });
  });
});

describe('reading a tapped action', () => {
  it('reads a grant decision and a reply from the payload the push carried', () => {
    expect(readNotificationAction(response('grant-always', grantData))).toMatchObject({
      kind: 'grant',
      grantId: 'grant-1',
      decision: 'always',
      key: 'card-1:grant-always:0',
    });
    expect(readNotificationAction(response('reply', replyData, '  On it  '))).toMatchObject({
      kind: 'reply',
      roomId: 'corner-1',
      parentMessageId: 'message-1',
      text: 'On it',
    });
  });

  it('accepts data serialized as a JSON string', () => {
    const payload = response('grant-once', grantData);
    (payload.notification.request.content as { data: unknown }).data = JSON.stringify(grantData);
    expect(readNotificationAction(payload)).toMatchObject({ kind: 'grant', decision: 'once' });
  });

  it('ignores a body tap, an empty reply, and an action the push did not offer', () => {
    expect(
      readNotificationAction(response('expo.modules.notifications.actions.DEFAULT', grantData)),
    ).toBeNull();
    expect(readNotificationAction(response('reply', replyData, '   '))).toBeNull();
    expect(readNotificationAction(response('grant-once', replyData))).toBeNull();
    expect(readNotificationAction(response('reply', grantData, 'hi'))).toBeNull();
    expect(readNotificationAction({ notification: null })).toBeNull();
  });
});

describe('answering a tapped action', () => {
  it('decides the grant through the phone operation and rewrites the Android notification in place', async () => {
    const d = deps('android');
    expect(await handleNotificationAction(response('grant-once', grantData), d)).toBe('done');
    expect(d.decideGrant).toHaveBeenCalledWith('grant-1', 'once');
    expect(d.presented).toEqual([
      {
        identifier: 'card-1',
        title: 'Beeline',
        body: grantData.message,
        subtitle: 'Allowed once',
        data: expect.not.objectContaining({ categoryId: expect.anything() }),
        quiet: true,
      },
    ]);
    expect(d.presented[0]!.data).toMatchObject({ channelId: 'system-dm', messageId: 'card-1' });
  });

  it.each([
    ['grant-always', 'always', 'Always allowed'],
    ['grant-deny', 'deny', 'Denied'],
  ] as const)('%s answers %s', async (action, decision, words) => {
    const d = deps('android');
    await handleNotificationAction(response(action, grantData), d);
    expect(d.decideGrant).toHaveBeenCalledWith('grant-1', decision);
    expect(d.presented[0]!.subtitle).toBe(words);
  });

  it('posts a quiet new notification on iOS, which closed the tapped one', async () => {
    const d = deps('ios');
    await handleNotificationAction(response('grant-once', grantData), d);
    expect(d.presented[0]).toMatchObject({
      identifier: 'card-1#done',
      body: 'Allowed once · @wren can reach api.stripe.com',
      quiet: true,
    });
    expect(d.presented[0]!.categoryIdentifier).toBeUndefined();
  });

  it('says the grant was already answered when the server refuses a second decision', async () => {
    const d = deps('android', {
      decideGrant: vi.fn().mockRejectedValue(Object.assign(new Error('conflict'), { status: 409 })),
    });
    expect(await handleNotificationAction(response('grant-once', grantData), d)).toBe('settled');
    expect(d.presented[0]).toMatchObject({
      identifier: 'card-1',
      subtitle: 'Already answered · tap to open',
    });
    expect(d.presented[0]!.categoryIdentifier).toBeUndefined();
  });

  it('keeps the choices on a failure and answers the retry as a new response', async () => {
    const decideGrant = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ grantId: 'grant-1', status: 'once', roomId: 'x' });
    const d = deps('android', { decideGrant });
    expect(await handleNotificationAction(response('grant-once', grantData), d)).toBe('failed');
    const failed = d.presented[0]!;
    // Rewritten in place: Android cannot take down a notification mid inline-reply.
    expect(failed).toMatchObject({
      identifier: 'card-1',
      subtitle: "Couldn't send · tap to open",
      categoryIdentifier: 'beeline-grant',
      data: expect.objectContaining({
        categoryId: 'beeline-grant',
        grantId: 'grant-1',
        attempt: '1',
      }),
    });
    const retry = response('grant-once', grantData);
    retry.notification.request.content.data = failed.data as typeof grantData;
    expect(await handleNotificationAction(retry, d)).toBe('done');
    expect(decideGrant).toHaveBeenCalledTimes(2);
    expect(d.presented[1]).toMatchObject({ identifier: 'card-1', subtitle: 'Allowed once' });
  });

  it('posts the reply into the exact corner as a reply to the tagged message', async () => {
    const d = deps('android');
    expect(await handleNotificationAction(response('reply', replyData, 'On it'), d)).toBe('done');
    expect(d.sendReply).toHaveBeenCalledWith({
      roomId: 'corner-1',
      parentMessageId: 'message-1',
      text: 'On it',
      messageId: 'f'.repeat(64),
    });
    expect(d.presented[0]).toMatchObject({
      identifier: 'message-1',
      body: `${replyData.message}\nYou: On it`,
      subtitle: 'Replied',
      quiet: true,
    });
    expect(d.presented[0]!.categoryIdentifier).toBeUndefined();
  });

  it('confirms an iOS reply quietly, naming who was answered', async () => {
    const d = deps('ios');
    await handleNotificationAction(response('reply', replyData, 'On it'), d);
    expect(d.presented[0]).toMatchObject({ body: 'Replied to Maya · On it', quiet: true });
  });

  it('keeps Reply and the typed text on a failed reply', async () => {
    const d = deps('ios', { sendReply: vi.fn().mockRejectedValue(new Error('offline')) });
    expect(await handleNotificationAction(response('reply', replyData, 'On it'), d)).toBe('failed');
    const failed = d.presented[0]!;
    expect(failed).toMatchObject({
      identifier: 'message-1#retry-1',
      body: "Couldn't send your reply to Maya · tap to open",
      categoryIdentifier: 'beeline-reply',
      quiet: false,
    });
    expect(
      replyDraftFromResponse({ notification: { request: { content: { data: failed.data } } } }),
    ).toEqual({ roomId: 'corner-1', text: 'On it' });
  });

  it('answers a response once even when the task and a listener both see it', async () => {
    const d = deps('android');
    const payload = response('grant-once', grantData);
    const results = await Promise.all([
      handleNotificationAction(payload, d),
      handleNotificationAction(payload, d),
    ]);
    expect(results.filter(Boolean)).toEqual(['done']);
    expect(await handleNotificationAction(payload, d)).toBeNull();
    expect(d.decideGrant).toHaveBeenCalledTimes(1);
  });

  it('never replays a failed response on a later start', async () => {
    const d = deps('android', { sendReply: vi.fn().mockRejectedValue(new Error('offline')) });
    const payload = response('reply', replyData, 'On it');
    await handleNotificationAction(payload, d);
    expect(await handleNotificationAction(payload, d)).toBeNull();
    expect(d.sendReply).toHaveBeenCalledTimes(1);
  });
});
