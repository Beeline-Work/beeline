import type { NostrEvent } from '@beeline/nostr';

const tagValue = (event: NostrEvent, name: string): string | undefined =>
  event.tags.find((tag) => tag[0] === name)?.[1];

const tagValues = (event: NostrEvent, name: string): string[] =>
  event.tags.filter((tag) => tag[0] === name && tag[1]).map((tag) => tag[1]!);

export interface PushNotificationPlan {
  channelId: string;
  title: string;
  body: string;
  data: Record<string, string>;
}

export interface NotificationContext {
  roomName: string;
  senderName?: string;
}

export interface NotificationFormattingOptions {
  /** Localized policy switch for a future per-recipient preview preference. */
  showMessagePreview?: boolean;
}

const MESSAGE_PREVIEW_LENGTH = 120;

function normalizedDisplayText(value: string | undefined, maxLength: number): string | undefined {
  const normalized = value?.trim().replace(/\s+/g, ' ');
  return normalized ? [...normalized].slice(0, maxLength).join('') : undefined;
}

export function formatMessagePreview(content: string): string {
  const normalized = normalizedDisplayText(content, Number.MAX_SAFE_INTEGER) ?? '';
  const characters = [...normalized];
  if (characters.length <= MESSAGE_PREVIEW_LENGTH) return normalized;
  return `${characters.slice(0, MESSAGE_PREVIEW_LENGTH - 1).join('')}…`;
}

export function isNotifiableEvent(event: NostrEvent): boolean {
  if (event.kind !== 9 || !tagValue(event, 'h')) return false;
  const markers = tagValues(event, 't');
  if (markers.includes('agent-activity') || markers.includes('buzz-merge-approval')) return false;
  if (!markers.includes('body-control')) return true;
  return Boolean(tagValue(event, 'repo') && tagValue(event, 'branch') && tagValue(event, 'tip'));
}

/** The single notification-content policy seam, including message-preview privacy. */
export function mapEventToNotification(
  event: NostrEvent,
  context: NotificationContext,
  options: NotificationFormattingOptions = {},
): PushNotificationPlan | null {
  if (!isNotifiableEvent(event)) return null;
  const channelId = tagValue(event, 'h');
  if (!channelId) return null;

  const markers = tagValues(event, 't');
  const isMergeRequest =
    markers.includes('body-control') &&
    Boolean(tagValue(event, 'repo') && tagValue(event, 'branch') && tagValue(event, 'tip'));
  const roomName = normalizedDisplayText(context.roomName, 80) ?? 'Room';
  const senderName = normalizedDisplayText(context.senderName, 80) ?? roomName;
  const showMessagePreview = options.showMessagePreview ?? true;
  const preview = formatMessagePreview(event.content);

  return {
    channelId,
    title: isMergeRequest ? 'Merge approval requested' : senderName,
    body: isMergeRequest
      ? `Review requested in ${roomName}`
      : showMessagePreview && preview
        ? preview
        : `New message in ${roomName}`,
    data: {
      channelId,
      roomName,
      type: isMergeRequest ? 'merge-approval-request' : 'channel-activity',
    },
  };
}
