import type { NostrEvent } from '@buzzy/nostr';

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

function displayChannel(channelId: string, channelName?: string): string {
  const normalizedName = channelName?.trim().replace(/\s+/g, ' ');
  return normalizedName ? normalizedName.slice(0, 80) : channelId.slice(0, 8);
}

/**
 * Map relay events to privacy-preserving Android notification content.
 * Event content is deliberately never read or copied into the notification.
 */
export function mapEventToNotification(
  event: NostrEvent,
  channelName?: string,
): PushNotificationPlan | null {
  if (event.kind !== 9) return null;
  const channelId = tagValue(event, 'h');
  if (!channelId) return null;

  const markers = tagValues(event, 't');
  if (markers.includes('agent-activity') || markers.includes('buzz-merge-approval')) return null;

  const channel = displayChannel(channelId, channelName);
  const isMergeRequest =
    markers.includes('body-control') &&
    Boolean(tagValue(event, 'repo') && tagValue(event, 'branch') && tagValue(event, 'tip'));

  if (markers.includes('body-control') && !isMergeRequest) return null;

  return {
    channelId,
    title: isMergeRequest ? 'Merge approval requested' : 'New Buzzy activity',
    body: isMergeRequest ? `Review requested in ${channel}` : `New activity in ${channel}`,
    data: {
      channelId,
      type: isMergeRequest ? 'merge-approval-request' : 'channel-activity',
    },
  };
}
