import { beforeEach, expect, it, vi } from 'vitest';
import { StackRouter } from '@react-navigation/routers';

const early = vi.hoisted(() => ({ response: null as unknown, prefetch: vi.fn() }));
vi.mock('expo-notifications', () => ({
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  getLastNotificationResponse: () => early.response,
}));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('./push-room-prefetch', () => ({ prefetchPushRoom: early.prefetch }));
import { prefetchLastPushedRoom } from './early-room-prefetch';
import { firebasePushMessage } from '../../../server/src/firebase-push';
// Metro uses this published mapper for both the listener and cold replay.
import { mapNotificationContent } from '../../node_modules/expo-notifications/build/utils/mapNotificationResponse';
import { createNotificationNavigator, type NotificationNavigationAction } from '@/navigation/notification-stack';
import {
  markInitialLandingResolved,
  resetInitialLandingForTests,
  suppressInitialLandingNavigation,
  whenInitialLandingResolved,
} from '@/navigation/initial-landing';
import {
  createConsumedNotificationResponseStore,
  routeBuzzNotificationResponse,
  startNotificationResponseEntries,
  type TappedNotificationResponse,
} from './notification-response';

const options = {
  routeNames: ['index', 'beeline/channels', 'beeline/chat/[channelId]', 'beeline/corners/[roomId]'],
  routeParamList: {},
  routeGetIdList: {},
};
const stackRouter = StackRouter({ initialRouteName: 'index' });
const defaultAction = 'expo.modules.notifications.actions.DEFAULT';
const messageId = 'a'.repeat(64);
const serverPush = (id: string) => firebasePushMessage('fixture-device-token', {
  type: 'message', target: 'message', workspaceId: 'workspace', roomId: 'room', channelId: 'room',
  messageId: id, text: 'A server-built notification', collapseId: 'room-slot',
});
type Push = ReturnType<typeof serverPush>;
const wrappers = {
  FCM: (push: Push) => mapNotificationContent({ data: push.data } as never).data,
  'JSON data': (push: Push) => JSON.stringify(push.data),
  'Expo envelope': (push: Push) => mapNotificationContent({
    dataString: JSON.stringify({ data: push.data }),
  } as never).data,
};

beforeEach(() => { resetInitialLandingForTests(); early.response = null; early.prefetch.mockClear(); });

for (const [wrapper, wrap] of Object.entries(wrappers)) {
  for (const entry of ['cold', 'background', 'foreground'] as const) {
    it.each(['room', 'other-room'])(`opens the new message after an inline action: ${entry}, ${wrapper}, from %s`, async (currentRoom) => {
      let state = stackRouter.getInitialState(options);
      const dispatch = vi.fn((action: NotificationNavigationAction) => {
        const next = stackRouter.getStateForAction(state, action as never, options);
        if (!next) throw new Error('Unhandled notification navigation');
        state = stackRouter.getRehydratedState(next, options);
      });
      const navigator = createNotificationNavigator({
        getRootState: () => ({
          key: 'drawer', routeNames: ['(app)'],
          routes: [{ key: 'app', name: '(app)', state }],
        }),
        dispatch,
      });
      const values = new Map<string, string>();
      const storage = {
        getItem: async (key: string) => values.get(key) ?? null,
        setItem: async (key: string, value: string) => { values.set(key, value); },
      };
      let consumed = createConsumedNotificationResponseStore(storage);
      let handled = new Set<string>();
      const clearLastResponse = vi.fn(async () => {});
      const tap = (id: string): TappedNotificationResponse => {
        const push = serverPush(id);
        return {
          actionIdentifier: defaultAction,
          notification: { request: { identifier: push.data!.tag, content: { data: wrap(push) } } },
        };
      };
      const route = (response: TappedNotificationResponse) => routeBuzzNotificationResponse(response, {
        navigator, handled, defaultActionIdentifier: defaultAction,
        waitForRootReady: async () => {}, waitForInitialLanding: whenInitialLandingResolved,
        suppressPendingInitialLanding: suppressInitialLandingNavigation,
        clearLastResponse, consumedResponses: consumed,
        resolveTarget: async (target) => target, log: () => {},
      });

      markInitialLandingResolved();
      await route(tap('b'.repeat(64)));
      expect(state.routes[state.index]?.name).toBe('beeline/chat/[channelId]');
      // Keep a Room mounted while another message replaces its Android slot.
      // The tap must switch Rooms or update the same Room's message anchor.
      state.routes[state.index] = { ...state.routes[state.index]!, params: { channelId: currentRoom } };
      dispatch.mockClear();
      clearLastResponse.mockClear();
      if (entry === 'cold') {
        resetInitialLandingForTests();
        handled = new Set();
        consumed = createConsumedNotificationResponseStore(storage);
      }

      let listener!: (response: TappedNotificationResponse) => void;
      let finish!: () => void;
      let fail!: (error: unknown) => void;
      const delivered = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
      const response = tap(messageId);
      await route({ ...response, actionIdentifier: 'beeline.reply' });
      expect(dispatch).not.toHaveBeenCalled();
      expect(clearLastResponse).not.toHaveBeenCalled();
      early.response = response;
      prefetchLastPushedRoom();
      expect(early.prefetch).toHaveBeenCalledExactlyOnceWith(messageId, 'room');
      const stop = startNotificationResponseEntries({
        addResponseListener: (callback) => { listener = callback; return { remove: vi.fn() }; },
        getLastResponse: async () => entry === 'cold' ? response : null,
        getAppState: () => entry === 'foreground' ? 'active' : 'background',
        consumedResponses: consumed,
        route: async (next) => { try { await route(next); finish(); } catch (error) { fail(error); } },
        log: (message, error) => { if (error) fail(error); else if (message.includes('Skipping leftover')) finish(); },
      });
      try {
        if (entry === 'cold') {
          expect(dispatch).not.toHaveBeenCalled();
          markInitialLandingResolved();
        } else listener(response);
        await delivered;
        expect(state.routes[state.index]).toMatchObject({
          name: 'beeline/chat/[channelId]',
          params: { channelId: 'room', communityId: 'workspace', notificationMessageId: messageId, notificationResponseId: messageId },
        });
        expect(clearLastResponse).toHaveBeenCalledOnce();
        dispatch.mockClear();
        expect(await route(response)).toBeNull();
        expect(dispatch).not.toHaveBeenCalled();
      } finally { stop(); }
    });
  }
}

it('does not let an inline action consume a later body tap for the same message', async () => {
  const navigator = { openStack: vi.fn() };
  const handled = new Set<string>();
  const clearLastResponse = vi.fn(async () => {});
  const routing = {
    navigator, handled, defaultActionIdentifier: defaultAction,
    waitForInitialLanding: async () => 'committed' as const,
    suppressPendingInitialLanding: vi.fn(), clearLastResponse,
    resolveTarget: async (target: import('@/utils/notificationRouting').BuzzNotificationTarget) => target,
    log: () => {},
  };
  const notification = { request: { identifier: 'room-slot', content: { data: serverPush(messageId).data } } };
  await routeBuzzNotificationResponse({ actionIdentifier: 'beeline.reply', notification }, routing);
  expect(navigator.openStack).not.toHaveBeenCalled();
  expect(clearLastResponse).not.toHaveBeenCalled();
  await routeBuzzNotificationResponse({ actionIdentifier: defaultAction, notification }, routing);
  expect(navigator.openStack).toHaveBeenCalledOnce();
});

it('discards a stale cold response when a live tap arrives while the native getter is pending', async () => {
  let listener!: (response: TappedNotificationResponse) => void;
  let resolveCold!: (response: TappedNotificationResponse) => void;
  const cold = new Promise<TappedNotificationResponse>((resolve) => { resolveCold = resolve; });
  const route = vi.fn(async () => {});
  const stop = startNotificationResponseEntries({
    addResponseListener: (callback) => { listener = callback; return { remove: vi.fn() }; },
    getLastResponse: () => cold,
    getAppState: () => 'active', route,
  });
  const response = (id: string) => ({ actionIdentifier: defaultAction,
    notification: { request: { identifier: id, content: { data: serverPush(id).data } } } });
  try {
    const latest = response(messageId);
    listener(latest);
    resolveCold(response('b'.repeat(64)));
    await cold;
    await Promise.resolve();
    expect(route).toHaveBeenCalledExactlyOnceWith(latest, 'foreground');
  } finally { stop(); }
});

it('cancels a cold replay waiting for durable deduplication when a newer live tap arrives', async () => {
  let listener!: (response: TappedNotificationResponse) => void;
  let releaseCold!: (consumed: boolean) => void;
  let coldChecked!: () => void;
  const checking = new Promise<void>((resolve) => { coldChecked = resolve; });
  const check = new Promise<boolean>((resolve) => { releaseCold = resolve; });
  const response = (id: string) => ({ actionIdentifier: defaultAction,
    notification: { request: { identifier: id, content: { data: serverPush(id).data } } } });
  const old = response('b'.repeat(64));
  const latest = response(messageId);
  const route = vi.fn(async () => {});
  const stop = startNotificationResponseEntries({
    addResponseListener: (callback) => { listener = callback; return { remove: vi.fn() }; },
    getLastResponse: async () => old, getAppState: () => 'background', route,
    consumedResponses: {
      has: async (id) => { if (id === messageId) return false; coldChecked(); return check; },
      add: async () => {},
    },
  });
  try {
    await checking;
    listener(latest);
    releaseCold(false);
    await check;
    await Promise.resolve();
    expect(route).toHaveBeenCalledExactlyOnceWith(latest, 'background');
  } finally { stop(); }
});
