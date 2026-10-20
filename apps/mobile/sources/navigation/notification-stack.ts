import type { NotificationNavigator, NotificationStackRoute } from '@/utils/notificationRouting';
import { markRoomOpen } from '@/buzz/room-open-trace';

/**
 * Replace the app stack with a notification's fixed ancestry in one reset.
 *
 * A `navigate` would stack the notified screen on top of whatever history the
 * reader had — another Workspace's screens, or a copy of the same Room pulled
 * out of the middle of the stack — and back would walk into it. A reset
 * leaves exactly the screens in `notificationStackRoutes`.
 */

type StackRoute = { key: string; name: string; params?: object; state?: unknown };
type StackState = { key: string; index?: number; routeNames?: string[]; routes: StackRoute[] };

/** React Navigation's `CommonActions.reset` action, optionally aimed at one navigator. */
export type NotificationResetAction = {
  type: 'RESET';
  payload: { index: number; routes: object[]; stale?: false; routeNames?: string[] };
  target?: string;
};

export type NotificationNavigationAction = NotificationResetAction | {
  type: 'PUSH';
  payload: { name: string; params?: object };
  target: string;
};

export type NotificationNavigationRef = {
  getRootState: () => unknown;
  dispatch: (action: NotificationNavigationAction) => void;
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
): Array<StackRoute | NotificationStackRoute> {
  return routes.map((route, index) => {
    const current = existing[index];
    if (!current || screenIdentity(current.name, current.params) !== screenIdentity(route.name, route.params)) {
      return route;
    }
    const previousParams = (current.params ?? {}) as Record<string, unknown>;
    const nextParams = (route.params ?? {}) as Record<string, unknown>;
    // A push keeps its unchanged Room-list ancestor just as a normal push
    // would. Replacing its route object makes the mounted list render again.
    if (
      Object.keys(previousParams).length === Object.keys(nextParams).length &&
      Object.keys(nextParams).every((key) => Object.is(previousParams[key], nextParams[key]))
    ) {
      return current;
    }
    return { ...route, key: current.key };
  });
}

export function createNotificationNavigator(ref: NotificationNavigationRef): NotificationNavigator {
  return {
    openStack(routes) {
      const stack = findStackFor(ref.getRootState(), routes[0]!.name);
      markRoomOpen('push-stack-before', stack?.routes.map((route) => route.name).join(','));
      if (stack) {
        const retained = keepMountedInPlace(routes, stack.routes);
        // The exact ancestry is already on screen. Use the same native push
        // as a Room-list tap instead of replacing the mounted stack.
        if (
          stack.routes.length === routes.length - 1 &&
          stack.index === stack.routes.length - 1 &&
          stack.routes.every((route, index) => retained[index] === route)
        ) {
          const destination = routes.at(-1)!;
          ref.dispatch({ type: 'PUSH', payload: destination, target: stack.key });
          return;
        }
        ref.dispatch({
          type: 'RESET',
          payload: {
            ...stack,
            stale: false,
            routeNames: stack.routeNames!,
            index: routes.length - 1,
            routes: retained,
          },
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
