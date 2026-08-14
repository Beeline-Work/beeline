import { fallbackPersonName } from '@beeline/buzz-client';
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
  roomName?: string;
  senderName?: string;
  /** Derived from the immutable Room create's existing buzz-dm marker. */
  isDirectMessage?: boolean;
  /** True only after resolving an immutable Room create linked to a real Workspace create. */
  persistentWorkspaceRoom?: boolean;
  workspaceName?: string;
  /** Names and repository identifiers carried by the Room/Workspace records. */
  fixtureCandidates?: string[];
  /** Recognized fixture markers carried by the Room/Workspace records. */
  fixtureMarkers?: string[];
}

export interface NotificationFormattingOptions {
  /** Localized policy switch for a future per-recipient preview preference. */
  showMessagePreview?: boolean;
}

const MESSAGE_PREVIEW_LENGTH = 120;
const CHAT_MESSAGE_MARKERS = new Set(['agent-message', 'buzz-agent-request', 'buzz-attachment']);

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
  if (markers.includes('body-control')) {
    return Boolean(tagValue(event, 'repo') && tagValue(event, 'branch') && tagValue(event, 'tip'));
  }
  return markers.every((marker) => CHAT_MESSAGE_MARKERS.has(marker));
}

const FIXTURE_NAME_PATTERNS = [
  /(?:^|[\s._-])ui-demo(?:$|[\s._-])/i,
  /(?:^|[\s._-])uidemo(?:$|[\s._-])/i,
  /(?:^|[\s._-])research-no-findings(?:$|[\s._-])/i,
  /(?:^|[\s._-])review-corner(?:$|[\s._-])/i,
  /(?:^|[\s._-])room-invite-(?:repair|visibility)(?:$|[\s._-])/i,
  /^(?:live-agent-iteration|merged-gate-proof|archived-copy-spike)$/i,
];

const THROWAWAY_WORKSPACE_PATTERN =
  /(?:^|[\s._-])(?:test|tests|testing|demo|fixture|fixtures|throwaway|temporary|temp|tmp|smoke|e2e|proof)(?:$|[\s._-])/i;

const FIXTURE_EVENT_MARKERS = new Set([
  'change-review',
  'change-review-file',
  'change-review-manifest',
  'ui-test',
  'ui-demo',
  'uidemo',
  'test-fixture',
]);

function fixtureName(value: string | undefined): boolean {
  return Boolean(value && FIXTURE_NAME_PATTERNS.some((pattern) => pattern.test(value)));
}

/** Fail closed for checked-in demo/live-test fixtures that must never reach real devices. */
export function isSuppressedFixtureNotification(
  event: NostrEvent,
  context: NotificationContext,
): boolean {
  // Positive safety boundary: ACL visibility is necessary but not sufficient.
  // Standalone/legacy groups and partially resolved groups do not reach FCM.
  if (context.persistentWorkspaceRoom !== true) return true;

  // An explicit fixture tag is itself authoritative, regardless of its value.
  if (event.tags.some((tag) => tag[0] === 'fixture')) return true;
  if (tagValues(event, 't').some((marker) => FIXTURE_EVENT_MARKERS.has(marker.toLowerCase()))) {
    return true;
  }
  if ((context.fixtureMarkers?.length ?? 0) > 0) return true;

  const repo = tagValue(event, 'repo')?.split('/').at(-1);
  const candidates = [context.roomName, repo, ...(context.fixtureCandidates ?? [])];
  if (candidates.some(fixtureName)) return true;

  // Membership inherited from an obvious test/demo Workspace must never make
  // a production device eligible, even when the Room name itself looks real.
  return Boolean(
    context.workspaceName &&
    (fixtureName(context.workspaceName) || THROWAWAY_WORKSPACE_PATTERN.test(context.workspaceName)),
  );
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
  const resolvedRoomName = normalizedDisplayText(context.roomName, 80);
  const roomName = resolvedRoomName ?? 'Room';
  const senderName =
    normalizedDisplayText(context.senderName, 80) ?? fallbackPersonName(event.pubkey);
  const showMessagePreview = options.showMessagePreview ?? true;
  const preview = formatMessagePreview(event.content);

  return {
    channelId,
    title: isMergeRequest
      ? 'Merge approval requested'
      : context.isDirectMessage
        ? senderName
        : resolvedRoomName
          ? resolvedRoomName.startsWith('#')
            ? resolvedRoomName
            : `#${resolvedRoomName}`
          : senderName,
    body: isMergeRequest
      ? `Review requested in ${roomName}`
      : showMessagePreview && preview
        ? context.isDirectMessage
          ? preview
          : `${senderName}: ${preview}`
        : `New message in ${roomName}`,
    data: {
      channelId,
      roomName,
      type: isMergeRequest ? 'merge-approval-request' : 'channel-activity',
    },
  };
}
