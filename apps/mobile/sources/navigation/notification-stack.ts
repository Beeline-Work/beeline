import type { NotificationNavigator, NotificationStackRoute } from '@/utils/notificationRouting';

/**
 * Replace the app stack with a notification's fixed ancestry in one reset.
 *
 * A `navigate` would stack the notified screen on top of whatever history the
 * reader had — another Workspace's screens, or a copy of the same Room pulled
 * out of the middle of the stack — and back would walk into it. A reset
 * leaves exactly the screens in `notificationStackRoutes`.
 */

type StackRoute = { key: string; name: string; params?: object; state?: unknown };
type StackState = { key: string; routeNames?: string[]; routes: StackRoute[] };

/** React Navigation's `CommonActions.reset` action, optionally aimed at one navigator. */
export type NotificationResetAction = {
  type: 'RESET';
  payload: { index: number; routes: object[] };
  target?: string;
};

export type NotificationNavigationRef = {
  getRootState: () => unknown;
  dispatch: (action: NotificationResetAction) => void;
};

/** The Expo Router group that owns the app stack. */
const APP_GROUP_ROUTE = '(app)';

function isStackState(value: unknown): value is StackState {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as StackState).key === 'string' &&
    Array.isArray((value as StackState).routes)
  );
}

/** The mounted navigator that can show `routeName`, searched depth-first. */
export function findStackFor(state: unknown, routeName: string): StackState | undefined {
  if (!isStackState(state)) return undefined;
  if (state.routeNames?.includes(routeName)) return state;
  for (const route of state.routes) {
    const found = findStackFor(route.state, routeName);
    if (found) return found;
  }
  return undefined;
}

function screenIdentity(name: string, params: object | undefined): string {
  const value = (params ?? {}) as Record<string, unknown>;
  if (name === 'beeline/channels') return `${name}:${String(value.communityId ?? '')}`;
  if (name === 'beeline/corners/[roomId]') return `${name}:${String(value.roomId ?? '')}`;
  if (name === 'beeline/chat/[channelId]') return `${name}:${String(value.channelId ?? '')}`;
  return name;
}

/**
 * Keep an already mounted screen only where it already sits, so the Room list
 * the reader was on is not rebuilt. A screen is never moved to another slot:
 * reordering a mounted native screen is what can leave it frozen or blank.
 */
function keepMountedInPlace(
  routes: NotificationStackRoute[],
  existing: readonly StackRoute[],
): Array<NotificationStackRoute & { key?: string }> {
  return routes.map((route, index) => {
    const current = existing[index];
    return current &&
      screenIdentity(current.name, current.params) === screenIdentity(route.name, route.params)
      ? { ...route, key: current.key }
      : route;
  });
}

export function createNotificationNavigator(ref: NotificationNavigationRef): NotificationNavigator {
  return {
    openStack(routes) {
      const stack = findStackFor(ref.getRootState(), routes[0]!.name);
      if (stack) {
        ref.dispatch({
          type: 'RESET',
          payload: { index: routes.length - 1, routes: keepMountedInPlace(routes, stack.routes) },
          target: stack.key,
        });
        return;
      }
      // The app stack is not mounted yet: open it, holding the ancestry.
      ref.dispatch({
        type: 'RESET',
        payload: {
          index: 0,
          routes: [{ name: APP_GROUP_ROUTE, state: { index: routes.length - 1, routes } }],
        },
      });
    },
  };
}
