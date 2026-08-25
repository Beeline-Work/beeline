import { describe, expect, it } from 'vitest';

import {
  resetOpenBuzzChannelIdsForTests,
  getOpenBuzzChannelId,
  pushOpenBuzzChannelId,
  releaseOpenBuzzChannelId,
} from '@/buzz/open-room-tracker';
import {
  decideForegroundNotificationDisplay,
  foregroundNotificationChannelIds,
} from './foreground-policy';

function buzzData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'message', channelId: 'room-1', roomId: 'room-1', ...overrides };
}

describe('foreground notification display policy', () => {
  it('suppresses a banner for an unrelated Room while the app is active', () => {
    const decision = decideForegroundNotificationDisplay({
      appState: 'active',
      openChannelId: 'room-2',
      data: buzzData(),
    });
    expect(decision).toEqual({ shouldPresent: false, reason: 'app-active' });
  });

  it('suppresses a banner when the notification is for the currently open Room, regardless of app state', () => {
    for (const appState of ['active', 'background', 'inactive', undefined]) {
      const decision = decideForegroundNotificationDisplay({
        appState,
        openChannelId: 'room-1',
        data: buzzData(),
      });
      expect(decision).toEqual({ shouldPresent: false, reason: 'open-room-match' });
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
    expect(decision).toEqual({ shouldPresent: true, reason: 'app-inactive' });
  });

  it('suppresses notifications with missing channel metadata only via the active-app rule', () => {
    const missingMetadata = { type: 'message' };
    expect(
      decideForegroundNotificationDisplay({
        appState: 'active',
        openChannelId: 'room-1',
        data: missingMetadata,
      }),
    ).toEqual({ shouldPresent: false, reason: 'app-active' });
    expect(
      decideForegroundNotificationDisplay({
        appState: 'background',
        openChannelId: 'room-1',
        data: missingMetadata,
      }),
    ).toEqual({ shouldPresent: true, reason: 'app-inactive' });
    // And with no chat screen open at all.
    expect(
      decideForegroundNotificationDisplay({
        appState: 'background',
        openChannelId: null,
        data: missingMetadata,
      }).shouldPresent,
    ).toBe(true);
  });

  it('flips the decision as app state transitions between active and background', () => {
    const input = {
      openChannelId: 'room-2' as string | null,
      data: buzzData() as unknown,
    };
    const active = decideForegroundNotificationDisplay({ ...input, appState: 'active' });
    const background = decideForegroundNotificationDisplay({ ...input, appState: 'background' });
    expect(active.shouldPresent).toBe(false);
    expect(background.shouldPresent).toBe(true);
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
