import { describe, expect, it } from 'vitest';

import {
  resetOpenBuzzChannelIdsForTests,
  getOpenBuzzChannelId,
  pushOpenBuzzChannelId,
  releaseOpenBuzzChannelId,
} from '@/buzz/open-room-tracker';
import {
  decideForegroundNotificationDisplay,
  foregroundDataOnlyRepresentation,
  foregroundNotificationBehavior,
  foregroundNotificationChannelIds,
} from './foreground-policy';

function buzzData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'message', channelId: 'room-1', roomId: 'room-1', ...overrides };
}

describe('foreground notification display policy', () => {
  it('shows and lists an unrelated Room notification silently while the app is active', () => {
    const decision = decideForegroundNotificationDisplay({
      appState: 'active',
      openChannelId: 'room-2',
      data: buzzData(),
    });
    expect(decision).toEqual({ shouldPresent: true, shouldPlaySound: false, reason: 'app-active' });
    expect(foregroundNotificationBehavior(decision)).toEqual({
      shouldShowAlert: true,
      shouldPlaySound: false,
      shouldSetBadge: true,
      shouldShowBanner: true,
      shouldShowList: true,
    });
  });

  it('suppresses a banner when the notification is for the currently open Room, regardless of app state', () => {
    for (const appState of ['active', 'background', 'inactive', undefined]) {
      const decision = decideForegroundNotificationDisplay({
        appState,
        openChannelId: 'room-1',
        data: buzzData(),
      });
      expect(decision).toEqual({
        shouldPresent: false,
        shouldPlaySound: false,
        reason: 'open-room-match',
      });
      expect(foregroundNotificationBehavior(decision)).toEqual({
        shouldShowAlert: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
        shouldShowBanner: false,
        shouldShowList: false,
      });
    }
  });

  it('matches a corner notification against its parent Room and against the open corner channel', () => {
    // Viewing the parent Room: a corner-of-that-Room push names the Room as roomId.
    expect(
      decideForegroundNotificationDisplay({
        appState: 'background',
        openChannelId: 'room-1',
        data: buzzData({ target: 'corner', channelId: 'room-1', cornerId: 'corner-9' }),
      }).reason,
    ).toBe('open-room-match');
    // Viewing the corner itself: the resolved channel id is the corner.
    expect(
      decideForegroundNotificationDisplay({
        appState: 'active',
        openChannelId: 'corner-9',
        data: buzzData({ target: 'corner', channelId: 'room-1', cornerId: 'corner-9' }),
      }).reason,
    ).toBe('open-room-match');
  });

  it('keeps background display of an unrelated Room notification', () => {
    const decision = decideForegroundNotificationDisplay({
      appState: 'background',
      openChannelId: 'room-2',
      data: buzzData(),
    });
    expect(decision).toEqual({
      shouldPresent: true,
      shouldPlaySound: true,
      reason: 'app-inactive',
    });
    expect(foregroundNotificationBehavior(decision)).toEqual({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
      shouldShowBanner: true,
      shouldShowList: true,
    });
  });

  it('applies only the app-state rule to notifications with missing channel metadata', () => {
    const missingMetadata = { type: 'message' };
    expect(
      decideForegroundNotificationDisplay({
        appState: 'active',
        openChannelId: 'room-1',
        data: missingMetadata,
      }),
    ).toEqual({ shouldPresent: true, shouldPlaySound: false, reason: 'app-active' });
    expect(
      decideForegroundNotificationDisplay({
        appState: 'background',
        openChannelId: 'room-1',
        data: missingMetadata,
      }),
    ).toEqual({ shouldPresent: true, shouldPlaySound: true, reason: 'app-inactive' });
    // And with no chat screen open at all.
    expect(
      decideForegroundNotificationDisplay({
        appState: 'background',
        openChannelId: null,
        data: missingMetadata,
      }).shouldPresent,
    ).toBe(true);
  });

  it('rings only once the app leaves the foreground', () => {
    const input = {
      openChannelId: 'room-2' as string | null,
      data: buzzData() as unknown,
    };
    const active = decideForegroundNotificationDisplay({ ...input, appState: 'active' });
    const background = decideForegroundNotificationDisplay({ ...input, appState: 'background' });
    expect(active).toMatchObject({ shouldPresent: true, shouldPlaySound: false });
    expect(background).toMatchObject({ shouldPresent: true, shouldPlaySound: true });
  });

  it('parses both string-JSON and object FCM payloads for channel ids', () => {
    const asObject = foregroundNotificationChannelIds(buzzData());
    expect(asObject).toEqual({ channelId: 'room-1', roomId: 'room-1' });
    const asString = foregroundNotificationChannelIds(JSON.stringify(buzzData()));
    expect(asString).toEqual({ channelId: 'room-1', roomId: 'room-1' });
    expect(foregroundNotificationChannelIds(undefined)).toEqual({
      channelId: null,
      roomId: null,
    });
  });
});

describe('open-room tracker', () => {
  it('tracks the top-most open chat screen across stacked Room/corner navigation', () => {
    resetOpenBuzzChannelIdsForTests();
    expect(getOpenBuzzChannelId()).toBeNull();

    pushOpenBuzzChannelId('room-1');
    expect(getOpenBuzzChannelId()).toBe('room-1');

    // Corner pushed on top of the still-mounted Room.
    pushOpenBuzzChannelId('corner-9');
    expect(getOpenBuzzChannelId()).toBe('corner-9');

    // Popping the corner falls back to the Room underneath, not to nothing.
    releaseOpenBuzzChannelId('corner-9');
    expect(getOpenBuzzChannelId()).toBe('room-1');

    releaseOpenBuzzChannelId('room-1');
    expect(getOpenBuzzChannelId()).toBeNull();
  });

  it('handles param replacement on the same route instance without stale entries', () => {
    resetOpenBuzzChannelIdsForTests();
    pushOpenBuzzChannelId('room-1');
    // Navigating (e.g. replace) to another room reuses the mounted screen:
    // release old, then push new.
    releaseOpenBuzzChannelId('room-1');
    pushOpenBuzzChannelId('room-3');
    expect(getOpenBuzzChannelId()).toBe('room-3');
    releaseOpenBuzzChannelId('room-3');
    expect(getOpenBuzzChannelId()).toBeNull();
  });
});

describe('foreground Android data-only push re-presentation', () => {
  // The server's firebasePushMessage data payload, as Expo hands it to the
  // received listener for a foreground data-only push (Reproduction F3).
  const pushData = {
    type: 'channel-activity',
    target: 'message',
    workspaceId: 'ws-1',
    roomId: 'room-general',
    threadId: 'room-general',
    channelId: 'room-general',
    messageId: 'msg-9',
    title: 'Beeline',
    message: 'hello from general',
    tag: 'msg-9',
  };
  function dataOnlyPush(overrides: { notification?: unknown; data?: unknown } = {}) {
    return {
      request: {
        identifier: 'msg-9',
        content: {
          title: 'Beeline',
          subtitle: null,
          body: 'hello from general',
          data: overrides.data ?? pushData,
          categoryIdentifier: 'beeline-reply',
        },
        trigger: {
          type: 'push',
          remoteMessage: { data: pushData, notification: overrides.notification ?? null },
        },
      },
    };
  }

  it('presents a push for another Room under the same identifier and data', () => {
    expect(
      foregroundDataOnlyRepresentation(dataOnlyPush(), {
        platform: 'android',
        appState: 'active',
        openChannelId: 'room-proof',
      }),
    ).toEqual({
      identifier: 'msg-9',
      content: {
        title: 'Beeline',
        body: 'hello from general',
        data: pushData,
        categoryIdentifier: 'beeline-reply',
      },
      trigger: null,
    });
  });

  it('presents a push while no Room is open', () => {
    expect(
      foregroundDataOnlyRepresentation(dataOnlyPush(), { platform: 'android', appState: 'active' }),
    ).not.toBeNull();
  });

  it('does not present a push for the open Room', () => {
    expect(
      foregroundDataOnlyRepresentation(dataOnlyPush(), {
        platform: 'android',
        appState: 'active',
        openChannelId: 'room-general',
      }),
    ).toBeNull();
  });

  it('leaves a push with a notification block to Expo', () => {
    expect(
      foregroundDataOnlyRepresentation(dataOnlyPush({ notification: { title: 'Beeline' } }), {
        platform: 'android',
        appState: 'active',
      }),
    ).toBeNull();
  });

  it('does not re-present a local notification, including its own re-presentation', () => {
    const local = { request: { ...dataOnlyPush().request, trigger: null } };
    expect(
      foregroundDataOnlyRepresentation(local, { platform: 'android', appState: 'active' }),
    ).toBeNull();
  });

  it('does not present a silent push with no text', () => {
    const silent = dataOnlyPush();
    silent.request.content.title = '';
    silent.request.content.body = '';
    expect(
      foregroundDataOnlyRepresentation(silent, { platform: 'android', appState: 'active' }),
    ).toBeNull();
  });

  it('changes nothing on iOS', () => {
    expect(
      foregroundDataOnlyRepresentation(dataOnlyPush(), { platform: 'ios', appState: 'active' }),
    ).toBeNull();
  });
});
