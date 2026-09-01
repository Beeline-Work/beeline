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

export type BuzzNotificationTarget = {
  type: string;
  target: 'message' | 'corner';
  roomId: string;
  channelId: string;
  cornerId?: string;
  eventId?: string;
  messageId?: string;
};

/** Parse the FCM string-only data contract without trusting arbitrary route input. */
export function getBuzzNotificationTargetFromData(data: unknown): BuzzNotificationTarget | null {
  const normalizedData = normalizeNotificationData(data);
  if (!normalizedData || typeof normalizedData !== 'object' || Array.isArray(normalizedData)) {
    return null;
  }
  const type = nonEmptyString(getObjectValue(normalizedData, 'type'));
  const rawChannelId = nonEmptyString(getObjectValue(normalizedData, 'channelId'));
  if (!type || !rawChannelId) return null;

  const cornerId = nonEmptyString(getObjectValue(normalizedData, 'cornerId'));
  const targetValue = nonEmptyString(getObjectValue(normalizedData, 'target'));
  const target: BuzzNotificationTarget['target'] =
    targetValue === 'message' || targetValue === 'corner'
      ? targetValue
      : type === 'agent-attention' || type === 'pull-request-opened'
        ? 'corner'
        : 'message';
  const channelId = cornerId && target !== 'message' ? cornerId : rawChannelId;
  const roomId =
    nonEmptyString(getObjectValue(normalizedData, 'roomId')) ??
    (cornerId && cornerId !== rawChannelId ? rawChannelId : channelId);
  const eventId = nonEmptyString(getObjectValue(normalizedData, 'eventId'));
  const messageId = nonEmptyString(getObjectValue(normalizedData, 'messageId'));
  return {
    type,
    target,
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
  options: { targetExists?: boolean } = {},
): void {
  const useFallback = options.targetExists === false && target.roomId !== target.channelId;
  const channelId = useFallback ? target.roomId : target.channelId;
  router.navigate(
    {
      pathname: '/beeline/chat/[channelId]',
      params: {
        channelId,
        notificationResponseId,
        ...(!useFallback && target.roomId !== target.channelId
          ? {
              parent: target.roomId,
              notificationFallbackChannelId: target.roomId,
            }
          : {}),
        ...(!useFallback && target.target === 'message' && target.messageId
          ? { notificationMessageId: target.messageId }
          : {}),
        ...(!useFallback ? { notificationTarget: target.target } : {}),
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
