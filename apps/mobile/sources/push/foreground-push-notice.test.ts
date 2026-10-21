import { describe, expect, it } from 'vitest';

import { navigateToBuzzTargetFromNotification } from '@/utils/notificationRouting';
import { foregroundInAppNotice } from './foreground-policy';
import {
  dismissForegroundPushNotice,
  foregroundPushNotice,
  presentForegroundPushNotice,
  resetForegroundPushNoticeForTests,
  setForegroundPushOpenHandler,
  tapForegroundPushNotice,
} from './foreground-push-notice';

const notice = {
  identifier: 'msg-9',
  title: 'Beeline',
  body: 'hello from general',
  data: { channelId: 'room-general' },
};

describe('foreground in-app push notice store', () => {
  it('holds the latest notice until a tap opens it', () => {
    resetForegroundPushNoticeForTests();
    const opened: unknown[] = [];
    const stop = setForegroundPushOpenHandler((tapped) => opened.push(tapped));
    presentForegroundPushNotice(notice);
    expect(foregroundPushNotice()).toEqual(notice);
    tapForegroundPushNotice();
    expect(foregroundPushNotice()).toBeNull();
    expect(opened).toEqual([notice]);
    stop();
  });

  it('replaces an unread notice with the next push', () => {
    resetForegroundPushNoticeForTests();
    presentForegroundPushNotice(notice);
    presentForegroundPushNotice({ ...notice, identifier: 'msg-10', body: 'later' });
    expect(foregroundPushNotice()?.identifier).toBe('msg-10');
    dismissForegroundPushNotice();
    expect(foregroundPushNotice()).toBeNull();
  });

  it('Reproduction android-foreground-push-tap: a foreground data-only push opens the Room through the navigator', () => {
    resetForegroundPushNoticeForTests();
    const notification = {
      request: {
        identifier: 'msg-9',
        content: {
          title: 'Beeline',
          body: 'hello from general',
          data: {
            type: 'channel-activity',
            target: 'message',
            workspaceId: 'ws-1',
            roomId: 'room-general',
            channelId: 'room-general',
            messageId: 'msg-9',
          },
        },
        trigger: { type: 'push', remoteMessage: { data: {}, notification: null } },
      },
    };
    const built = foregroundInAppNotice(notification, {
      platform: 'android',
      appState: 'active',
      openChannelId: 'room-proof',
    });
    expect(built).not.toBeNull();
    const stacks: unknown[] = [];
    const stop = setForegroundPushOpenHandler((tapped) => {
      navigateToBuzzTargetFromNotification(
        { openStack: (routes) => stacks.push(routes) },
        {
          type: 'channel-activity',
          target: 'message',
          workspaceId: String(tapped.data.workspaceId),
          roomId: String(tapped.data.roomId),
          channelId: String(tapped.data.channelId),
          messageId: String(tapped.data.messageId),
        },
        tapped.identifier,
      );
    });
    const started = performance.now();
    presentForegroundPushNotice(built!);
    tapForegroundPushNotice();
    const tapToRoomMs = performance.now() - started;
    stop();
    expect(stacks).toEqual([
      [
        { name: 'beeline/channels', params: { communityId: 'ws-1' } },
        {
          name: 'beeline/chat/[channelId]',
          params: {
            channelId: 'room-general',
            communityId: 'ws-1',
            notificationResponseId: 'msg-9',
            returnTo: 'room-list',
            notificationMessageId: 'msg-9',
            notificationTarget: 'message',
          },
        },
      ],
    ]);
    expect(tapToRoomMs).toBeLessThan(50);
    console.log(
      `Reproduction android-foreground-push-tap tap-to-navigator ${tapToRoomMs.toFixed(2)} ms`,
    );
  });
});
