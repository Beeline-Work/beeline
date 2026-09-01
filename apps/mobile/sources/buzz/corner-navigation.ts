/**
 * Leaving a corner is a lookup, not a stack guess.
 *
 * A Room and a Corner are the same Expo Router route (`buzz/chat/[channelId]`),
 * so "the screen underneath" is not reliably the corner's parent Room:
 *
 * - the Room-list corner dropdown pushes a corner with the Room never on the
 *   stack at all;
 * - a notification uses `router.navigate(..., { dangerouslySingular: true })`,
 *   which lifts the matching chat route out of the middle of the stack and
 *   re-appends it on top — reordering Room and Corner rather than popping, so
 *   a later drill-in can leave a corner sitting *below* its own Room;
 * - a cold notification start can leave the corner as the only route, where a
 *   bare `router.back()` is a silent no-op and the user never leaves.
 *
 * Every one of those ends with the user back inside the corner they tried to
 * leave. `popCountToParentRoom` instead finds the parent Room by id, so the
 * caller pops to exactly that screen — and knows when it has to be created
 * because it genuinely is not on the stack.
 */

import type { Href } from 'expo-router';

export type ChatStackRoute = {
  name?: string;
  params?: Record<string, unknown> | undefined;
};

export type CornerReturnTarget = 'room-list';

export type CornerOpenAction =
  { type: 'open-corner'; cornerId: string } | { type: 'explain'; message: string };

/** Resolve a visible corner action to a destination or a reader-facing reason. */
export function cornerOpenAction(
  subchannelId: string | undefined,
  currentChannelId: string,
): CornerOpenAction {
  const cornerId = subchannelId?.trim();
  if (!cornerId) {
    return {
      type: 'explain',
      message: 'This corner has no channel address yet. Refresh the Room and try again.',
    };
  }
  if (cornerId === currentChannelId) {
    return {
      type: 'explain',
      message: 'This corner points to the channel already on screen.',
    };
  }
  return { type: 'open-corner', cornerId };
}

/** Open a top-level Room transcript. */
export function roomHref(channelId: string): Href {
  return { pathname: '/beeline/chat/[channelId]', params: { channelId } } as unknown as Href;
}

/**
 * Open a corner, carrying what the opener already knows about it. `parent` and
 * `title` are pure hints — they make the corner's header correct on the first
 * frame before the screen's own reads land. `returnTo` records an explicit
 * opening surface whose navigation origin cannot be derived from the parent.
 */
export function cornerHref(
  channelId: string,
  parentChannelId: string,
  title?: string,
  returnTo?: CornerReturnTarget,
): Href {
  return {
    pathname: '/beeline/chat/[channelId]',
    params: {
      channelId,
      parent: parentChannelId,
      ...(title ? { title } : {}),
      ...(returnTo ? { returnTo } : {}),
    },
  } as unknown as Href;
}

/** The channel a chat route is showing, undecorated by URI encoding. */
export function routeChannelId(route: ChatStackRoute | undefined): string | undefined {
  const raw = route?.params?.channelId;
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * How many entries to pop so the parent Room is on top, or `null` when it is
 * not on this stack. Searches downward from the top so a Room that was
 * reordered above an older copy still resolves to the nearest one.
 */
export function popCountToParentRoom(
  routes: readonly ChatStackRoute[],
  parentChannelId: string,
): number | null {
  if (!parentChannelId) return null;
  const top = routes.length - 1;
  for (let index = top - 1; index >= 0; index -= 1) {
    if (routeChannelId(routes[index]) === parentChannelId) return top - index;
  }
  return null;
}

export type ChatBackAction =
  | { type: 'pop'; count: number }
  | { type: 'open-room'; channelId: string }
  | { type: 'back' }
  | { type: 'room-list' };

/**
 * What the chat header's back control should do.
 *
 * A corner with an explicit opening surface returns there. Otherwise it
 * resolves to its parent Room — popped to if already on the stack, opened in
 * place if not. A Room falls back to plain stack behaviour, except when it is
 * the only route, where `router.back()` is a no-op and the Room list is the
 * honest destination.
 */
export function chatBackAction(
  routes: readonly ChatStackRoute[],
  parentChannelId: string | undefined,
  returnTo?: CornerReturnTarget,
): ChatBackAction {
  // A Corner opened from the Room list must return to that list. Its parent
  // Room was never visited, so manufacturing one here both violates Back and
  // flashes a newly mounted transcript during the replacement transition.
  if (returnTo === 'room-list') {
    const top = routes.length - 1;
    for (let index = top - 1; index >= 0; index -= 1) {
      if (routes[index]?.name === 'beeline/channels') return { type: 'pop', count: top - index };
    }
    return { type: 'room-list' };
  }
  if (parentChannelId) {
    const count = popCountToParentRoom(routes, parentChannelId);
    return count === null
      ? { type: 'open-room', channelId: parentChannelId }
      : { type: 'pop', count };
  }
  return routes.length > 1 ? { type: 'back' } : { type: 'room-list' };
}
