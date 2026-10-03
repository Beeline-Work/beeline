/**
 * Leaving a chat screen returns to where the reader came from.
 *
 * A Room and a Corner are the same Expo Router route (`buzz/chat/[channelId]`).
 * Back is a stack pop to the screen underneath, with three exceptions:
 *
 * - a screen opened from a notification carries `returnTo`: a Room returns to
 *   the Room list and a corner to its Room's corners list, never whatever the
 *   notification's `dangerouslySingular` navigate happened to leave beneath it;
 * - a corner opened from the Room list or the corners list carries `returnTo`
 *   for that list, so it lands there even when the list is not on the stack;
 * - a lone screen (a cold start) opens the corner's parent Room or the Room
 *   list, because a bare `router.back()` there is a silent no-op.
 */

import type { Href, Router } from 'expo-router';

export type ChatStackRoute = {
  name?: string;
  params?: Record<string, unknown> | undefined;
};

export type CornerReturnTarget = 'room-list' | 'corners';

export type CornerOpenAction =
  { type: 'open-corner'; cornerId: string } | { type: 'explain'; message: string };

export type MentionDirectMessageAction =
  { type: 'open-room'; channelId: string } | { type: 'stay' };

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
export function roomHref(channelId: string, communityId?: string): Href {
  return { pathname: '/beeline/chat/[channelId]', params: { channelId, ...(communityId ? { communityId } : {}) } } as unknown as Href;
}

export function messageJumpHref(channelId: string, notificationMessageId: string, notificationResponseId: string, communityId?: string) {
  return { pathname: '/beeline/chat/[channelId]' as const, params: {
    channelId, notificationMessageId, notificationResponseId,
    ...(communityId ? { communityId } : {}),
  } };
}

/**
 * Open a Room without stacking a second copy of the same channel.
 *
 * `router.push` always appends, so a second tap — or a tap that lands while
 * the previous Room is still the top route — leaves `channels → room → room`.
 * The first back then pops onto the same Room. Navigate with a channel-id
 * identity reuses that screen; a different channel (or a corner) still stacks.
 */
export function navigateToRoom(router: Pick<Router, 'navigate'>, channelId: string): void {
  router.navigate(roomHref(channelId), { dangerouslySingular: true });
}

/** Open the Room's dedicated corners list — the one place archived work is recorded. */
export function roomCornersHref(roomId: string): Href {
  return { pathname: '/beeline/corners/[roomId]', params: { roomId } } as unknown as Href;
}

/** Resolve or create the Workspace-scoped DM behind a tagged member mention. */
export async function resolveMentionDirectMessageAction(
  resolveDirectMessage: (
    workspaceId: string,
    participantId: string,
  ) => Promise<{ channelId: string }>,
  workspaceId: string,
  participantId: string,
  currentChannelId: string,
): Promise<MentionDirectMessageAction> {
  const directMessage = await resolveDirectMessage(workspaceId, participantId);
  return directMessage.channelId === currentChannelId
    ? { type: 'stay' }
    : { type: 'open-room', channelId: directMessage.channelId };
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
 * The Room a corners-list route is showing, undecorated by URI encoding.
 * Only a corners-list route answers; a chat route is never one.
 */
export function routeCornersRoomId(route: ChatStackRoute | undefined): string | undefined {
  if (route?.name !== 'beeline/corners/[roomId]') return undefined;
  const raw = route?.params?.roomId;
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export type ChatBackAction =
  | { type: 'pop'; count: number }
  | { type: 'open-room'; channelId: string }
  | { type: 'open-corners'; roomId: string }
  | { type: 'back' }
  | { type: 'room-list' };

/**
 * What the chat header's back control should do.
 *
 * A screen with an explicit return target goes to that list — popped to if it
 * is on the stack, opened in place if not. Every other screen pops to the one
 * it was opened from, skipping consecutive copies of itself so the first back
 * never lands in the screen the reader just left. A lone screen opens the
 * corner's parent Room, or the Room list for a Room.
 */
export function chatBackAction(
  routes: readonly ChatStackRoute[],
  parentChannelId: string | undefined,
  returnTo?: CornerReturnTarget,
): ChatBackAction {
  const top = routes.length - 1;
  if (returnTo === 'corners' && parentChannelId) {
    for (let index = top - 1; index >= 0; index -= 1) {
      if (routeCornersRoomId(routes[index]) === parentChannelId) {
        return { type: 'pop', count: top - index };
      }
    }
    return { type: 'open-corners', roomId: parentChannelId };
  }
  // Popping to the list rather than replacing keeps a Room that was never
  // visited from flashing a newly mounted transcript during the transition.
  if (returnTo === 'room-list') {
    for (let index = top - 1; index >= 0; index -= 1) {
      if (routes[index]?.name === 'beeline/channels') return { type: 'pop', count: top - index };
    }
    return { type: 'room-list' };
  }
  const selfCount = Math.max(consecutiveTopChannelCount(routes), 1);
  if (routes.length > selfCount) {
    return selfCount > 1 ? { type: 'pop', count: selfCount } : { type: 'back' };
  }
  return parentChannelId ? { type: 'open-room', channelId: parentChannelId } : { type: 'room-list' };
}

/** How many copies of the top channel sit on top of each other. */
export function consecutiveTopChannelCount(routes: readonly ChatStackRoute[]): number {
  const topId = routeChannelId(routes[routes.length - 1]);
  if (!topId) return 0;
  let count = 0;
  for (let index = routes.length - 1; index >= 0; index -= 1) {
    if (routeChannelId(routes[index]) !== topId) break;
    count += 1;
  }
  return count;
}
