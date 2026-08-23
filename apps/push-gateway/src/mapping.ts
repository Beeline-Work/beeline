import { fallbackPersonName, KIND_PUT_USER } from '@beeline/buzz-client';
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
  /** True when the immutable create names a parent channel — a corner worktree channel. */
  isChildChannel?: boolean;
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
  /** The recipient's own pubkey rides the message's `p` tag — higher-signal copy. */
  recipientMentioned?: boolean;
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

/**
 * The app's @mention encoding: the mentioned member's pubkey rides a `p` tag on
 * the kind:9 message (see buzz-client's buildMessage `mentionAgent`). A mention
 * forces delivery past the plain-chat marker gate but never past fixture or
 * persistent-Workspace suppression, and never for the message's own author.
 */
export function mentionsMember(event: NostrEvent, recipientPubkey: string): boolean {
  return event.kind === 9 && tagValues(event, 'p').includes(recipientPubkey);
}

export interface MembershipJoin {
  channelId: string;
  joinerPubkey: string;
  role?: string;
}

/** A NIP-29 put-user (kind:9000) membership add for one channel. */
export function membershipJoin(event: NostrEvent): MembershipJoin | null {
  if (event.kind !== KIND_PUT_USER) return null;
  const channelId = tagValue(event, 'h');
  const joinerPubkey = tagValue(event, 'p');
  if (!channelId || !joinerPubkey) return null;
  const role = tagValue(event, 'role');
  return { channelId, joinerPubkey, ...(role ? { role } : {}) };
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
const roomTitle = (resolvedRoomName: string | undefined): string | undefined =>
  resolvedRoomName
    ? resolvedRoomName.startsWith('#')
      ? resolvedRoomName
      : `#${resolvedRoomName}`
    : undefined;

export function mapEventToNotification(
  event: NostrEvent,
  context: NotificationContext,
  options: NotificationFormattingOptions = {},
): PushNotificationPlan | null {
  // An @mention qualifies even when the plain-chat marker gate would reject the
  // message's own markers; the gateway has already verified the p-tag recipient.
  if (!isNotifiableEvent(event) && options.recipientMentioned !== true) return null;
  const channelId = tagValue(event, 'h');
  if (!channelId) return null;

  const markers = tagValues(event, 't');
  const isMergeRequest =
    markers.includes('body-control') &&
    Boolean(tagValue(event, 'repo') && tagValue(event, 'branch') && tagValue(event, 'tip'));
  const mentioned = options.recipientMentioned === true;
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
        : (roomTitle(resolvedRoomName) ?? senderName),
    body: isMergeRequest
      ? `Review requested in ${roomName}`
      : mentioned
        ? showMessagePreview && preview
          ? `${senderName} mentioned you: ${preview}`
          : `${senderName} mentioned you`
        : showMessagePreview && preview
          ? context.isDirectMessage
            ? preview
            : `${senderName}: ${preview}`
          : `New message in ${roomName}`,
    data: {
      channelId,
      roomName,
      type: isMergeRequest ? 'merge-approval-request' : mentioned ? 'mention' : 'channel-activity',
      ...(isMergeRequest ? { cornerId: channelId } : {}),
    },
  };
}

/** "N joined <room>" — one bounded card per kind:9000 join event. */
export function mapMembershipJoinToNotification(
  event: NostrEvent,
  context: NotificationContext,
  joinerName?: string,
): PushNotificationPlan | null {
  const join = membershipJoin(event);
  if (!join) return null;
  const resolvedRoomName = normalizedDisplayText(context.roomName, 80);
  const roomName = resolvedRoomName ?? 'Room';
  const name = normalizedDisplayText(joinerName, 80) ?? fallbackPersonName(join.joinerPubkey);
  return {
    channelId: join.channelId,
    title: roomTitle(resolvedRoomName) ?? name,
    body: `${name} joined ${roomName}`,
    data: { channelId: join.channelId, roomName, type: 'member-join' },
  };
}
