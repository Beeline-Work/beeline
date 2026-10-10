import { describe, expect, it, vi } from 'vitest';
import { readClearPushData } from '@beeline/api-contract/phone';

vi.mock('expo-notifications', () => ({}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

import { handleReadClearPayload } from './read-clear-runtime';

const roomA = '11111111-1111-4111-8111-111111111111';
const cornerA = '22222222-2222-4222-8222-222222222222';
const roomB = '33333333-3333-4333-8333-333333333333';

// iOS reports a presented notification's date in epoch seconds.
const READ_AT = 1_760_000_000;
const BEFORE_READ = READ_AT - 60;

/** The server read cursor: the last read message and its creation time (ms). */
function cursor(channelId: string, identifier: string, createdAtSeconds = BEFORE_READ) {
  return {
    channelId,
    messageId: `${identifier}-message`,
    messageCreatedAt: createdAtSeconds * 1000,
  };
}

// The routing data the server's message push carries (`pushMessageData`).
function push(identifier: string, channelId: string, roomId: string, date = BEFORE_READ) {
  const data = {
    type: 'channel-activity',
    target: channelId === roomId ? 'message' : 'corner',
    workspaceId: 'workspace-1',
    roomId,
    threadId: roomId,
    channelId,
    ...(channelId === roomId ? {} : { cornerId: channelId }),
    messageId: `${identifier}-message`,
  };
  return { date, request: { identifier, content: { data } } };
}

function shade(
  presented = [
    push('a1', roomA, roomA),
    push('a2', roomA, roomA),
    push('c1', cornerA, roomA),
    push('b1', roomB, roomB),
  ],
) {
  return {
    getPresentedNotificationsAsync: vi.fn(() => Promise.resolve(presented)),
    dismissNotificationAsync: vi.fn(() => Promise.resolve()),
    setBadgeCountAsync: vi.fn(() => Promise.resolve(true)),
  };
}

describe('read-clear push on iOS', () => {
  // Audit 9.3: a Room read on another device used to leave the phone's shade
  // and badge untouched until the phone opened that Room itself.
  it('clears the read Room and corner from the shade and recounts the badge', async () => {
    const api = shade();
    const payload = {
      data: {
        dataString: JSON.stringify(readClearPushData([cursor(roomA, 'a2'), cursor(cornerA, 'c1')])),
      },
    };

    await expect(handleReadClearPayload(payload, api, 'ios')).resolves.toBe(true);

    expect(api.dismissNotificationAsync.mock.calls).toEqual([['a1'], ['a2'], ['c1']]);
    expect(api.setBadgeCountAsync).toHaveBeenCalledWith(1);
  });

  it('reads the flat payload shape too', async () => {
    const api = shade();
    await handleReadClearPayload(
      {
        aps: { 'content-available': 1 },
        ...readClearPushData([cursor(roomB, 'b1')]),
      },
      api,
      'ios',
    );
    expect(api.dismissNotificationAsync.mock.calls).toEqual([['b1']]);
    expect(api.setBadgeCountAsync).toHaveBeenCalledWith(3);
  });

  // G9-R3: reading message 1 dismissed message 2's notification too and set
  // the badge to 0, though message 2 is still unread on the server.
  it('keeps notifications newer than the read message, and counts them', async () => {
    const api = shade([push('a1', roomA, roomA), push('a2', roomA, roomA, READ_AT - 5)]);
    await handleReadClearPayload(readClearPushData([cursor(roomA, 'a1')]), api, 'ios');
    expect(api.dismissNotificationAsync.mock.calls).toEqual([['a1']]);
    expect(api.setBadgeCountAsync).toHaveBeenCalledWith(1);
  });

  it('falls back to the read message time when its notification is gone', async () => {
    const api = shade([
      push('a0', roomA, roomA, BEFORE_READ - 30),
      push('a2', roomA, roomA, BEFORE_READ + 30),
    ]);
    await handleReadClearPayload(readClearPushData([cursor(roomA, 'a1')]), api, 'ios');
    expect(api.dismissNotificationAsync.mock.calls).toEqual([['a0']]);
    expect(api.setBadgeCountAsync).toHaveBeenCalledWith(1);
  });

  it('leaves the shade alone for any other background push', async () => {
    const api = shade();
    await expect(
      handleReadClearPayload({ data: { type: 'channel-activity', channelId: roomA } }, api, 'ios'),
    ).resolves.toBe(false);
    expect(api.getPresentedNotificationsAsync).not.toHaveBeenCalled();
    expect(api.setBadgeCountAsync).not.toHaveBeenCalled();
  });
});
