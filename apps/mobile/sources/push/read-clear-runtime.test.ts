import { describe, expect, it, vi } from 'vitest';
import { readClearPushData } from '@beeline/api-contract/phone';

vi.mock('expo-notifications', () => ({}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

import { handleReadClearPayload } from './read-clear-runtime';

const roomA = '11111111-1111-4111-8111-111111111111';
const cornerA = '22222222-2222-4222-8222-222222222222';
const roomB = '33333333-3333-4333-8333-333333333333';

// The routing data the server's message push carries (`pushMessageData`).
function push(identifier: string, channelId: string, roomId: string) {
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
  return { request: { identifier, content: { data } } };
}

function shade() {
  const presented = [
    push('a1', roomA, roomA),
    push('a2', roomA, roomA),
    push('c1', cornerA, roomA),
    push('b1', roomB, roomB),
  ];
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
    const payload = { data: { dataString: JSON.stringify(readClearPushData([roomA, cornerA])) } };

    await expect(handleReadClearPayload(payload, api, 'ios')).resolves.toBe(true);

    expect(api.dismissNotificationAsync.mock.calls).toEqual([['a1'], ['a2'], ['c1']]);
    expect(api.setBadgeCountAsync).toHaveBeenCalledWith(1);
  });

  it('reads the flat payload shape too', async () => {
    const api = shade();
    await handleReadClearPayload(
      { aps: { 'content-available': 1 }, ...readClearPushData([roomB]) },
      api,
      'ios',
    );
    expect(api.dismissNotificationAsync.mock.calls).toEqual([['b1']]);
    expect(api.setBadgeCountAsync).toHaveBeenCalledWith(3);
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
