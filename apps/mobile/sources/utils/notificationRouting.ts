import type { Router } from 'expo-router';

function getObjectValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return (value as Record<string, unknown>)[key];
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeNotificationData(data: unknown): unknown {
  if (typeof data === 'string') {
    return parseJson(data);
  }
  return data;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

type BuzzNotificationTargetBase = {
  type: string;
  eventId?: string;
  messageId?: string;
};

export type BuzzNotificationTarget = BuzzNotificationTargetBase &
  (
    | {
        target: 'workspace';
        workspaceId: string;
        roomId?: never;
        channelId?: never;
        cornerId?: never;
      }
    | {
        target: 'message' | 'corner';
        workspaceId?: string;
        roomId: string;
        channelId: string;
        cornerId?: string;
      }
  );

export type NotificationRoomTruth = {
  room: { id: string; workspaceId: string; parentId?: string; archived: boolean };
  parent?: { id: string };
  cornerLifecycle?: { lifecycle: string };
};

export type BuzzNotificationResolver = {
  activateWorkspace: (workspaceId: string) => Promise<void>;
  readRoom: (roomId: string) => Promise<NotificationRoomTruth>;
  isUnavailableError?: (error: unknown) => boolean;
};

/** Parse the FCM string-only data contract without trusting arbitrary route input. */
export function getBuzzNotificationTargetFromData(data: unknown): BuzzNotificationTarget | null {
  const normalizedData = normalizeNotificationData(data);
  if (!normalizedData || typeof normalizedData !== 'object' || Array.isArray(normalizedData)) {
    return null;
  }
  const type = nonEmptyString(getObjectValue(normalizedData, 'type'));
  const rawChannelId = nonEmptyString(getObjectValue(normalizedData, 'channelId'));
  if (!type) return null;

  const cornerId = nonEmptyString(getObjectValue(normalizedData, 'cornerId'));
  const targetValue = nonEmptyString(getObjectValue(normalizedData, 'target'));
  const workspaceId = nonEmptyString(getObjectValue(normalizedData, 'workspaceId'));
  if ((targetValue === 'workspace' || (type === 'workspace-join' && !rawChannelId)) && workspaceId)
    return { type, target: 'workspace', workspaceId };
  if (!rawChannelId) return null;
  const target: BuzzNotificationTarget['target'] =
    targetValue === 'message' || targetValue === 'corner'
      ? targetValue
      : type === 'agent-attention' || type === 'pull-request-opened'
        ? 'corner'
        : 'message';
  // A corner id is the most specific destination in the push contract. Older
  // producers used the parent Room as `channelId` even for a message inside a
  // corner, so preferring `cornerId` keeps those retained notifications from
  // opening the parent and looking for a message that cannot exist there.
  const channelId = cornerId ?? rawChannelId;
  const roomId =
    nonEmptyString(getObjectValue(normalizedData, 'roomId')) ??
    (cornerId && cornerId !== rawChannelId ? rawChannelId : channelId);
  const eventId = nonEmptyString(getObjectValue(normalizedData, 'eventId'));
  const messageId = nonEmptyString(getObjectValue(normalizedData, 'messageId'));
  return {
    type,
    target,
    ...(workspaceId ? { workspaceId } : {}),
    roomId,
    channelId,
    ...(cornerId ? { cornerId } : {}),
    ...(eventId ? { eventId } : {}),
    ...(messageId ? { messageId } : {}),
  };
}

/** Backward-compatible channel-only projection for older call sites and payloads. */
export function getBuzzChannelIdFromNotificationData(data: unknown): string | null {
  return getBuzzNotificationTargetFromData(data)?.channelId ?? null;
}

/**
 * The one notification destination resolver. Workspace selection is committed
 * before Room truth is read, and an unavailable/finished corner degrades only
 * to its parent Room. A transient read failure keeps the named destination;
 * it never converts a routable push into the chat list.
 */
export async function resolveBuzzNotificationTarget(
  target: BuzzNotificationTarget,
  resolver: BuzzNotificationResolver,
): Promise<BuzzNotificationTarget> {
  if (target.workspaceId) await resolver.activateWorkspace(target.workspaceId);
  if (target.target === 'workspace') return target;

  try {
    const truth = await resolver.readRoom(target.channelId);
    const workspaceId = truth.room.workspaceId || target.workspaceId;
    if (workspaceId && workspaceId !== target.workspaceId) {
      await resolver.activateWorkspace(workspaceId);
    }
    const parentId = truth.parent?.id ?? truth.room.parentId;
    const isFinishedCorner =
      Boolean(parentId) && (truth.room.archived || truth.cornerLifecycle?.lifecycle === 'done');
    if (isFinishedCorner && parentId) {
      return {
        type: target.type,
        target: 'message',
        ...(workspaceId ? { workspaceId } : {}),
        roomId: parentId,
        channelId: parentId,
        ...(target.eventId ? { eventId: target.eventId } : {}),
      };
    }
    if (!parentId) return { ...target, ...(workspaceId ? { workspaceId } : {}) };
    return {
      ...target,
      ...(workspaceId ? { workspaceId } : {}),
      roomId: parentId,
      channelId: truth.room.id,
      cornerId: truth.room.id,
    };
  } catch (error) {
    if (
      resolver.isUnavailableError?.(error) &&
      target.roomId &&
      target.roomId !== target.channelId
    ) {
      return {
        type: target.type,
        target: 'message',
        ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
        roomId: target.roomId,
        channelId: target.roomId,
        ...(target.eventId ? { eventId: target.eventId } : {}),
      };
    }
    return target;
  }
}

/**
 * Bring a notification's Room to the front without creating another copy.
 * The response id also invalidates the retained screen's transcript backfill.
 */
export function navigateToBuzzChannelFromNotification(
  router: Pick<Router, 'navigate'>,
  channelId: string,
  notificationResponseId: string,
): void {
  router.navigate(
    {
      pathname: '/beeline/chat/[channelId]',
      params: { channelId, notificationResponseId },
    },
    { dangerouslySingular: true },
  );
}

/** Navigate to the exact push source, carrying enough context to reveal it or fall back safely. */
export function navigateToBuzzTargetFromNotification(
  router: Pick<Router, 'navigate'>,
  target: BuzzNotificationTarget,
  notificationResponseId: string,
): void {
  if (target.target === 'workspace') {
    router.navigate(
      {
        pathname: '/beeline/channels',
        params: { communityId: target.workspaceId, notificationResponseId },
      },
      { dangerouslySingular: true },
    );
    return;
  }
  const channelId = target.channelId;
  router.navigate(
    {
      pathname: '/beeline/chat/[channelId]',
      params: {
        channelId,
        ...(target.workspaceId ? { communityId: target.workspaceId } : {}),
        notificationResponseId,
        ...(target.roomId !== target.channelId ? { parent: target.roomId } : {}),
        ...(target.target === 'message' && target.messageId
          ? { notificationMessageId: target.messageId }
          : {}),
        notificationTarget: target.target,
      },
    },
    { dangerouslySingular: true },
  );
}

/** Parse an Expo response and navigate to its exact Buzz source when supported. */
export function navigateToBuzzNotificationResponse(
  router: Pick<Router, 'navigate'>,
  response: unknown,
): BuzzNotificationTarget | null {
  const request = getObjectValue(getObjectValue(response, 'notification'), 'request');
  const responseId = nonEmptyString(getObjectValue(request, 'identifier'));
  const content = getObjectValue(request, 'content');
  const target = getBuzzNotificationTargetFromData(getObjectValue(content, 'data'));
  if (!responseId || !target) return null;
  navigateToBuzzTargetFromNotification(router, target, responseId);
  return target;
}
