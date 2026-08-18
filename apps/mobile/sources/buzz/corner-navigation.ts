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

/** Open a top-level Room transcript. */
export function roomHref(channelId: string): Href {
  return { pathname: '/buzz/chat/[channelId]', params: { channelId } } as unknown as Href;
}

/**
 * Open a corner, carrying what the opener already knows about it. `parent` and
 * `title` are pure hints — they make the corner's header correct on the first
 * frame and give its back button a destination before the screen's own reads
 * land, and the screen overwrites both once they do.
 */
export function cornerHref(channelId: string, parentChannelId: string, title?: string): Href {
  return {
    pathname: '/buzz/chat/[channelId]',
    params: {
      channelId,
      parent: parentChannelId,
      ...(title ? { title } : {}),
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
 * A corner always resolves to its own parent Room — popped to if it is already
 * on the stack, opened in place if it is not. Neither outcome can leave the
 * reader inside the corner they just tried to leave. A Room falls back to plain
 * stack behaviour, except when it is the only route, where `router.back()` is a
 * no-op and the Room list is the honest destination.
 */
export function chatBackAction(
  routes: readonly ChatStackRoute[],
  parentChannelId: string | undefined,
): ChatBackAction {
  if (parentChannelId) {
    const count = popCountToParentRoom(routes, parentChannelId);
    return count === null ? { type: 'open-room', channelId: parentChannelId } : { type: 'pop', count };
  }
  return routes.length > 1 ? { type: 'back' } : { type: 'room-list' };
}
