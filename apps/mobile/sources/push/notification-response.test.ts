import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  routeBuzzNotificationResponse,
  type NotificationResponseRouting,
  type TappedNotificationResponse,
} from './notification-response';

const DEFAULT_ACTION = 'expo.modules.notifications.actions.DEFAULT';

const appLayoutSource = readFileSync(new URL('../app/_layout.tsx', import.meta.url), 'utf8');
const appRootSource = readFileSync(new URL('../app/(app)/index.tsx', import.meta.url), 'utf8');

function tap(id: string, channelId: string, extra: Record<string, string> = {}) {
  return {
    actionIdentifier: DEFAULT_ACTION,
    notification: {
      request: {
        identifier: id,
        content: { data: { type: 'mention', channelId, roomId: channelId, ...extra } },
      },
    },
  } satisfies TappedNotificationResponse;
}

function routing(overrides: Partial<NotificationResponseRouting> = {}) {
  const navigate = vi.fn();
  const base: NotificationResponseRouting = {
    router: { navigate },
    handled: new Set<string>(),
    defaultActionIdentifier: DEFAULT_ACTION,
    waitForInitialLanding: () => Promise.resolve(),
    clearLastResponse: () => Promise.resolve(),
    log: () => {},
    ...overrides,
  };
  return { navigate, routing: base };
}

describe('routeBuzzNotificationResponse', () => {
  // The reported failure: the app is already running when the push is tapped.
  it('opens the Room a tap names while the app is already running', async () => {
    const { navigate, routing: deps } = routing();

    const target = await routeBuzzNotificationResponse(tap('msg-1', 'room-b'), deps);

    expect(target?.channelId).toBe('room-b');
    expect(navigate).toHaveBeenCalledWith(
      {
        pathname: '/beeline/chat/[channelId]',
        params: {
          channelId: 'room-b',
          notificationResponseId: 'msg-1',
          notificationMessageId: undefined,
          notificationTarget: 'message',
        },
      },
      { dangerouslySingular: true },
    );
  });

  it('opens the named Room even when a different Room is already open', async () => {
    const { navigate, routing: deps } = routing();
    await routeBuzzNotificationResponse(tap('msg-a', 'room-a'), deps);
    navigate.mockClear();

    await routeBuzzNotificationResponse(tap('msg-b', 'room-b'), deps);

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0][0].params.channelId).toBe('room-b');
  });

  // The app root replaces whatever route is current the moment its identity
  // check finishes. A push routed before that lands is thrown back to the deck,
  // so the tap waits for the landing instead of racing it.
  it('waits for the app root landing before opening the Room', async () => {
    let releaseLanding = () => {};
    const landing = new Promise<void>((resolve) => {
      releaseLanding = resolve;
    });
    const { navigate, routing: deps } = routing({ waitForInitialLanding: () => landing });

    const routed = routeBuzzNotificationResponse(tap('msg-cold', 'room-c'), deps);
    await Promise.resolve();
    expect(navigate).not.toHaveBeenCalled();

    releaseLanding();
    await routed;
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0][0].params.channelId).toBe('room-c');
  });

  it('routes one response once, however many times it is delivered', async () => {
    const { navigate, routing: deps } = routing();
    const response = tap('msg-dup', 'room-d');

    await routeBuzzNotificationResponse(response, deps);
    await routeBuzzNotificationResponse(response, deps);

    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('ignores an action button and a response the OS never delivered', async () => {
    const { navigate, routing: deps } = routing();

    await routeBuzzNotificationResponse(null, deps);
    await routeBuzzNotificationResponse(
      { ...tap('msg-action', 'room-e'), actionIdentifier: 'reply' },
      deps,
    );

    expect(navigate).not.toHaveBeenCalled();
  });

  it('clears the retained native response even when nothing was routed', async () => {
    const clearLastResponse = vi.fn(() => Promise.resolve());
    const { routing: deps } = routing({ clearLastResponse });

    await routeBuzzNotificationResponse(
      {
        actionIdentifier: DEFAULT_ACTION,
        notification: { request: { identifier: 'msg-empty', content: { data: {} } } },
      },
      deps,
    );

    expect(clearLastResponse).toHaveBeenCalledTimes(1);
  });
});

describe('notification response wiring', () => {
  it('routes warm taps and cold-start responses through the one handler', () => {
    expect(appLayoutSource).toContain('Notifications.addNotificationResponseReceivedListener');
    expect(appLayoutSource).toContain('Notifications.getLastNotificationResponseAsync()');
    expect(appLayoutSource.match(/handleNotificationResponse\(response\)/g)).toHaveLength(2);
    expect(appLayoutSource).toContain('routeBuzzNotificationResponse(response, {');
    expect(appLayoutSource).toContain('waitForInitialLanding: whenInitialLandingResolved');
  });

  it('settles the landing gate on every branch the app root can take', () => {
    expect(appRootSource).toContain('markInitialLandingResolved');
    // Both the redirecting branches and the storage-error screen must settle it,
    // or a tapped push waits out the timeout for a landing that never comes.
    expect(appRootSource.match(/markInitialLandingResolved\(\)/g)).toHaveLength(2);
  });
});
