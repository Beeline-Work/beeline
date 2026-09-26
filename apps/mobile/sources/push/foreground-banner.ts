import {
  getBuzzNotificationTargetFromData,
  type BuzzNotificationTarget,
} from '@/utils/notificationRouting';

export type ForegroundBannerEntry = {
  id: string;
  title: string;
  body: string;
  kind: string;
  target: BuzzNotificationTarget;
  count: number;
  receivedAt: number;
  urgent: boolean;
};

type NotificationLike = {
  request: {
    identifier: string;
    content: { title?: string | null; body?: string | null; data?: unknown };
  };
};

function notificationKind(type: string): string {
  if (type === 'agent-attention' || type.includes('approval')) return 'Approval';
  if (type.includes('mention')) return 'Mention';
  return 'New message';
}

/** Convert only routable Beeline pushes into an in-app banner. */
export function foregroundBannerEntry(
  notification: NotificationLike,
  receivedAt = Date.now(),
): ForegroundBannerEntry | null {
  const target = getBuzzNotificationTargetFromData(notification.request.content.data);
  if (!target) return null;
  const kind = notificationKind(target.type);
  return {
    id: notification.request.identifier,
    title: notification.request.content.title?.trim() || kind,
    body: notification.request.content.body?.trim() || '',
    kind,
    target,
    count: 1,
    receivedAt,
    urgent: kind === 'Approval' || kind === 'Mention',
  };
}

/** Bursts share one plate; the most actionable arrival supplies its copy. */
export function collapseForegroundBanner(
  current: ForegroundBannerEntry | null,
  incoming: ForegroundBannerEntry,
): ForegroundBannerEntry {
  if (!current) return incoming;
  const primary = incoming.urgent && !current.urgent ? incoming : current;
  return {
    ...primary,
    count: current.count + 1,
    receivedAt: incoming.receivedAt,
  };
}
