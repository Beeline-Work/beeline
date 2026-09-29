import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platform: { OS: 'web' as string },
}));

vi.mock('expo-notifications', () => ({
  addNotificationReceivedListener: () => ({ remove: () => undefined }),
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({}),
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  class Value {
    constructor(public value: number) {}
    interpolate() {
      return this;
    }
    setValue() {}
    stopAnimation() {}
  }
  const animatedCall = () => ({
    start: (done?: (result: { finished: boolean }) => void) => done?.({ finished: true }),
  });
  return {
    Animated: {
      Value,
      View: host('AnimatedView'),
      timing: animatedCall,
      spring: animatedCall,
    },
    AppState: { currentState: 'active' },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    // A live reference to `mocks.platform` (not a snapshot) so a test can flip
    // `Platform.OS` after this module already imported it.
    Platform: mocks.platform,
    Pressable: host('Pressable'),
    Text: host('Text'),
    View: host('View'),
  };
});

vi.mock('@/buzz/open-room-tracker', () => ({
  getOpenBuzzChannelId: () => null,
}));
vi.mock('@/push/notification-destination', () => ({
  resolveBuzzNotificationDestination: async () => null,
}));
vi.mock('@/push/foreground-banner', () => ({
  collapseForegroundBanner: (_current: unknown, next: unknown) => next,
  foregroundBannerEntry: (notification: unknown) => notification,
}));
vi.mock('@/utils/notificationRouting', () => ({
  navigateToBuzzTargetFromNotification: () => undefined,
}));
vi.mock('@/constants/Typography', () => ({
  Typography: { ledger: () => ({}), mono: () => ({}) },
}));

import { ForegroundNotificationBanner } from './ForegroundNotificationBanner';

const globalScope = globalThis as unknown as {
  __DEV__?: boolean;
  window?: unknown;
};
const hadWindow = 'window' in globalScope;
const originalWindow = globalScope.window;
const originalDev = globalScope.__DEV__;

const originalConsoleError = console.error;
beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
    originalConsoleError(message, ...args);
  });
});

afterEach(() => {
  mocks.platform.OS = 'web';
  globalScope.__DEV__ = originalDev;
  if (hadWindow) globalScope.window = originalWindow;
  else delete globalScope.window;
});

afterAll(() => vi.restoreAllMocks());

describe('ForegroundNotificationBanner dev-only web bridge', () => {
  it('does not throw when window exists without addEventListener (Android dev-client shape)', () => {
    globalScope.__DEV__ = true;
    mocks.platform.OS = 'android';
    // The Android dev-client/Metro harness defines a partial `window` global
    // (for its own WebSocket/dev tooling) with no `addEventListener`.
    globalScope.window = {};

    expect(() => {
      act(() => {
        create(<ForegroundNotificationBanner top={0} left={0} />);
      });
    }).not.toThrow();
  });

  it('still subscribes to the development bridge event on web', () => {
    globalScope.__DEV__ = true;
    mocks.platform.OS = 'web';
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    globalScope.window = { addEventListener, removeEventListener };

    act(() => {
      create(<ForegroundNotificationBanner top={0} left={0} />);
    });

    expect(addEventListener).toHaveBeenCalledWith(
      'beeline:foreground-notification',
      expect.any(Function),
    );
  });
});
