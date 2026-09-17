import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isInitialLandingNavigationSuppressed,
  resetInitialLandingForTests,
  suppressInitialLandingNavigation,
} from '../navigation/initial-landing';
import {
  routeBuzzNotificationResponse,
  startNotificationResponseEntries,
  type NotificationResponseRouting,
  type TappedNotificationResponse,
} from './notification-response';

const DEFAULT_ACTION = 'expo.modules.notifications.actions.DEFAULT';

beforeEach(() => {
  resetInitialLandingForTests();
});

const appLayoutSource = readFileSync(new URL('../app/_layout.tsx', import.meta.url), 'utf8');
const appRootSource = readFileSync(new URL('../app/(app)/index.tsx', import.meta.url), 'utf8');

function tap(
  id: string,
  channelId: string,
  extra: Record<string, string> = {},
) {
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
  const suppressPendingInitialLanding = vi.fn();
  const base: NotificationResponseRouting = {
    router: { navigate },
    handled: new Set<string>(),
    defaultActionIdentifier: DEFAULT_ACTION,
    waitForInitialLanding: () => Promise.resolve('committed'),
    suppressPendingInitialLanding,
    clearLastResponse: () => Promise.resolve(),
    resolveTarget: async (target) => target,
    log: () => {},
    ...overrides,
  };
  return { navigate, suppressPendingInitialLanding, routing: base };
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
    const landing = new Promise<'committed'>((resolve) => {
      releaseLanding = () => resolve('committed');
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

  it('routes directly when the initial landing commit times out', async () => {
    const log = vi.fn();
    const { navigate, routing: deps } = routing({
      waitForInitialLanding: async () => 'timeout',
      log,
    });

    await routeBuzzNotificationResponse(tap('msg-timeout', 'room-timeout'), deps);

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0][0].params.channelId).toBe('room-timeout');
    expect(log).toHaveBeenCalledWith(
      '[PUSH ROUTING] Initial landing did not commit before timeout; routing directly',
    );
  });

  // The cold-start race behind the wrong-workspace deck: the landing decision
  // is slow, the wait times out, the push routes directly — and the app root's
  // landing replace, still pending, must then be suppressed or it lands the
  // previously-active workspace's deck over the notification destination.
  it('claims the destination on the timeout path before resolving and navigating', async () => {
    const { navigate, routing: deps } = routing({
      waitForInitialLanding: async () => 'timeout',
      suppressPendingInitialLanding: suppressInitialLandingNavigation,
      resolveTarget: async (target) => {
        // The app root reads this flag before its landing replace; it must
        // already see the push's claim here, or the replace would still run.
        expect(isInitialLandingNavigationSuppressed()).toBe(true);
        return target;
      },
    });

    await routeBuzzNotificationResponse(tap('msg-cold-race', 'room-race'), deps);

    expect(isInitialLandingNavigationSuppressed()).toBe(true);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0][0].params.channelId).toBe('room-race');
  });

  it('suppresses with the real gate state so the app root replace is refused', async () => {
    const { suppressPendingInitialLanding, routing: deps } = routing({
      suppressPendingInitialLanding: suppressInitialLandingNavigation,
    });

    await routeBuzzNotificationResponse(tap('msg-real-gate', 'room-gate'), deps);

    expect(isInitialLandingNavigationSuppressed()).toBe(true);
  });

  it('does not suppress the landing when the payload carries no route', async () => {
    const { suppressPendingInitialLanding, routing: deps } = routing();

    await routeBuzzNotificationResponse(
      {
        actionIdentifier: DEFAULT_ACTION,
        notification: { request: { identifier: 'msg-empty', content: { data: {} } } },
      },
      deps,
    );

    expect(suppressPendingInitialLanding).not.toHaveBeenCalled();
  });

  // A workspace-target push (e.g. a workspace join) must render the pushed
  // workspace's deck, not the previously-active one: the Workspace selection
  // commits in the resolver before the navigation names it via `communityId`.
  it('commits the pushed workspace before navigating to its deck', async () => {
    const { navigate, routing: deps } = routing({
      resolveTarget: async (target) => target,
    });

    const routed = await routeBuzzNotificationResponse(
      {
        actionIdentifier: DEFAULT_ACTION,
        notification: {
          request: {
            identifier: 'msg-ws',
            content: {
              data: { type: 'workspace-join', target: 'workspace', workspaceId: 'ws-burd' },
            },
          },
        },
      },
      deps,
    );

    expect(routed?.target).toBe('workspace');
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(
      {
        pathname: '/beeline/channels',
        params: { communityId: 'ws-burd', notificationResponseId: 'msg-ws' },
      },
      { dangerouslySingular: true },
    );
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
  it.each([
    ['foreground', 'active'],
    ['background', 'background'],
  ] as const)('passes a %s response payload to the resolver', async (entry, appState) => {
    let listener: ((response: TappedNotificationResponse) => void) | undefined;
    const route = vi.fn().mockResolvedValue(undefined);
    startNotificationResponseEntries({
      addResponseListener: (next) => {
        listener = next;
        return { remove() {} };
      },
      getLastResponse: async () => null,
      getAppState: () => appState,
      route,
    });
    const response = tap(`msg-${entry}`, `room-${entry}`);
    listener?.(response);
    await Promise.resolve();
    expect(route).toHaveBeenCalledWith(response, entry);
  });

  it('passes a killed-app response payload to the resolver as cold', async () => {
    const response = tap('msg-cold-entry', 'room-cold-entry');
    const route = vi.fn().mockResolvedValue(undefined);
    startNotificationResponseEntries({
      addResponseListener: () => ({ remove() {} }),
      getLastResponse: async () => response,
      getAppState: () => 'active',
      route,
    });
    await vi.waitFor(() => expect(route).toHaveBeenCalledWith(response, 'cold'));
  });

  it('routes all Expo taps through the one entry adapter', () => {
    expect(appLayoutSource).toContain('Notifications.addNotificationResponseReceivedListener');
    expect(appLayoutSource).toContain('Notifications.getLastNotificationResponseAsync');
    expect(appLayoutSource).toContain('startNotificationResponseEntries({');
    expect(appLayoutSource).toContain('routeBuzzNotificationResponse(response, {');
    expect(appLayoutSource).toContain('waitForInitialLanding: whenInitialLandingResolved');
    expect(appLayoutSource).toContain(
      'suppressPendingInitialLanding: suppressInitialLandingNavigation',
    );
  });

  it('settles the landing gate on every branch the app root can take', () => {
    expect(appLayoutSource).toContain("if (pathname !== '/') markInitialLandingResolved()");
    // A storage error stays on `/`, so it remains the one branch that settles
    // without a committed destination route.
    expect(appRootSource.match(/markInitialLandingResolved\(\)/g)).toHaveLength(1);
  });

  // The cold-start regression behind the wrong-workspace deck: the landing
  // decision is slow, the push's wait times out and routes directly, and the
  // app root's replace — still pending — would land the previously-active
  // workspace's deck over the notification destination. The replace must be
  // refused once a push has claimed the destination.
  it('refuses the app root landing replace once a push claimed the destination', () => {
    const suppressCheck = appRootSource.indexOf('isInitialLandingNavigationSuppressed()');
    const firstReplace = appRootSource.indexOf('router.replace');
    expect(suppressCheck).toBeGreaterThan(-1);
    expect(firstReplace).toBeGreaterThan(suppressCheck);
  });
});
