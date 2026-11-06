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
    it(`opens the new message in a replaced notification slot: ${entry}, ${wrapper}`, async () => {
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
      // The reader returns to the deck, then another message replaces the
      // same Android notification slot. A slot is not a response identity.
      state = stackRouter.getInitialState(options);
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
