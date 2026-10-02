import { describe, expect, it } from 'vitest';
import { StackRouter } from '@react-navigation/routers';
import { chatBackAction, type ChatStackRoute } from '@/buzz/corner-navigation';
import {
  navigateToBuzzTargetFromNotification,
  notificationStackRoutes,
  type BuzzNotificationTarget,
} from '@/utils/notificationRouting';
import {
  createNotificationNavigator,
  findStackFor,
  type NotificationResetAction,
} from './notification-stack';

const ROUTE_NAMES = [
  'index',
  'beeline/channels',
  'beeline/chat/[channelId]',
  'beeline/corners/[roomId]',
];
const options = {
  routeNames: ROUTE_NAMES,
  routeParamList: {},
  routeGetIdList: {},
} as never;
const stackRouter = StackRouter({});

type State = ReturnType<typeof stackRouter.getInitialState>;

const roomB: BuzzNotificationTarget = {
  target: 'message',
  workspaceId: 'ws-b',
  roomId: 'room-b1',
  channelId: 'room-b1',
  messageId: 'msg-1',
};
const cornerB: BuzzNotificationTarget = {
  target: 'message',
  workspaceId: 'ws-b',
  roomId: 'room-b1',
  channelId: 'corner-b1',
  cornerId: 'corner-b1',
};

function apply(state: State, action: object): State {
  const next = stackRouter.getStateForAction(state, action as never, options) as State | null;
  if (!next) throw new Error(`unhandled ${JSON.stringify(action)}`);
  return next.stale === false ? next : stackRouter.getRehydratedState(next as never, options);
}

/** Workspace A, two levels deep in a corner of Room A1. */
function deepInWorkspaceA(): State {
  let state = stackRouter.getRehydratedState(
    { routes: [{ name: 'beeline/channels', params: { communityId: 'ws-a' } }] } as never,
    options,
  );
  for (const params of [{ channelId: 'room-a1' }, { channelId: 'corner-a1', parent: 'room-a1' }]) {
    state = apply(state, { type: 'PUSH', payload: { name: 'beeline/chat/[channelId]', params } });
  }
  return state;
}

/** A root navigator ref over one app stack, applying dispatches with the real stack router. */
function appNavigation(initial: State) {
  let stack = initial;
  const ref = {
    getRootState: () => ({
      key: 'drawer',
      routeNames: ['(app)'],
      routes: [{ key: 'app', name: '(app)', state: stack }],
    }),
    dispatch: (action: NotificationResetAction) => {
      expect(action.target).toBe(stack.key);
      stack = apply(stack, action);
    },
  };
  return {
    navigator: createNotificationNavigator(ref),
    get stack() {
      return stack;
    },
    /** The chat header's back control. */
    headerBack() {
      const top = stack.routes.at(-1)!;
      const params = (top.params ?? {}) as Record<string, string>;
      const action = chatBackAction(
        stack.routes as ChatStackRoute[],
        params.parent,
        params.returnTo as never,
      );
      expect(action.type).toBe('pop');
      if (action.type === 'pop') stack = apply(stack, { type: 'POP', payload: { count: action.count } });
    },
    /** Android system back, iOS swipe, and the corners list's `router.back()`. */
    systemBack() {
      stack = apply(stack, { type: 'GO_BACK' });
    },
  };
}

const screens = (state: State) =>
  state.routes.map((route) => {
    const params = (route.params ?? {}) as Record<string, string>;
    return `${route.name}:${params.communityId ?? params.roomId ?? params.channelId ?? ''}`;
  });

describe('notificationStackRoutes', () => {
  it('puts a Room on its own Workspace Room list', () => {
    expect(notificationStackRoutes(roomB, 'r1').map((route) => route.name)).toEqual([
      'beeline/channels',
      'beeline/chat/[channelId]',
    ]);
    expect(notificationStackRoutes(roomB, 'r1')[0]!.params).toEqual({ communityId: 'ws-b' });
  });

  it('puts a corner on its Room corners list above that Room list', () => {
    expect(notificationStackRoutes(cornerB, 'r1')).toEqual([
      { name: 'beeline/channels', params: { communityId: 'ws-b' } },
      { name: 'beeline/corners/[roomId]', params: { roomId: 'room-b1' } },
      expect.objectContaining({ name: 'beeline/chat/[channelId]' }),
    ]);
  });

  it('opens a Workspace target as that Room list alone', () => {
    expect(
      notificationStackRoutes({ target: 'workspace', workspaceId: 'ws-b' }, 'r1'),
    ).toEqual([
      { name: 'beeline/channels', params: { communityId: 'ws-b', notificationResponseId: 'r1' } },
    ]);
  });
});

describe('back from a notification (Reproduction R-NAV-1)', () => {
  it('lands on the notified Workspace Room list, not the stack the reader was in', () => {
    const app = appNavigation(deepInWorkspaceA());

    navigateToBuzzTargetFromNotification(app.navigator, roomB, 'r1');
    expect(screens(app.stack)).toEqual([
      'beeline/channels:ws-b',
      'beeline/chat/[channelId]:ws-b',
    ]);

    app.headerBack();
    expect(screens(app.stack)).toEqual(['beeline/channels:ws-b']);
  });

  it('system back from a notified Room also stays in its Workspace', () => {
    const app = appNavigation(deepInWorkspaceA());
    navigateToBuzzTargetFromNotification(app.navigator, roomB, 'r1');

    app.systemBack();
    expect(screens(app.stack)).toEqual(['beeline/channels:ws-b']);
  });

  it('walks a notified corner up through its corners list to its Room list', () => {
    const app = appNavigation(deepInWorkspaceA());
    navigateToBuzzTargetFromNotification(app.navigator, cornerB, 'r1');
    expect(app.stack.routes).toHaveLength(3);

    app.headerBack();
    expect(screens(app.stack)).toEqual(['beeline/channels:ws-b', 'beeline/corners/[roomId]:room-b1']);
    app.systemBack();
    expect(screens(app.stack)).toEqual(['beeline/channels:ws-b']);
  });
});

describe('createNotificationNavigator', () => {
  it('keeps a mounted screen only in the slot it already occupies', () => {
    const app = appNavigation(
      stackRouter.getRehydratedState(
        {
          routes: [
            { name: 'beeline/channels', params: { communityId: 'ws-b' } },
            { name: 'beeline/chat/[channelId]', params: { channelId: 'corner-b1' } },
          ],
        } as never,
        options,
      ),
    );
    const [roomList, corner] = app.stack.routes;

    navigateToBuzzTargetFromNotification(app.navigator, cornerB, 'r1');

    // The Room list stays mounted; the corner moved up a slot, so it is a new screen.
    expect(app.stack.routes[0]!.key).toBe(roomList!.key);
    expect(app.stack.routes[2]!.key).not.toBe(corner!.key);
  });

  it('opens the app group when its stack is not mounted yet', () => {
    const dispatched: NotificationResetAction[] = [];
    createNotificationNavigator({
      getRootState: () => ({ key: 'drawer', routeNames: ['(app)'], routes: [{ key: 'app', name: '(app)' }] }),
      dispatch: (action) => dispatched.push(action),
    }).openStack(notificationStackRoutes(roomB, 'r1'));

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.target).toBeUndefined();
    expect(dispatched[0]!.payload.routes).toEqual([
      { name: '(app)', state: { index: 1, routes: notificationStackRoutes(roomB, 'r1') } },
    ]);
  });

  it('finds the stack that owns the Room list', () => {
    expect(
      findStackFor(
        { key: 'drawer', routeNames: ['(app)'], routes: [{ key: 'app', name: '(app)', state: { key: 'stack', routeNames: ['beeline/channels'], routes: [] } }] },
        'beeline/channels',
      )?.key,
    ).toBe('stack');
  });
});
