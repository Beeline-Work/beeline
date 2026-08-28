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
  /** Current display name of a destination corner's parent Room, resolved from relay truth. */
  parentRoomName?: string;
  /** Display name of the destination corner channel itself. */
  cornerName?: string;
  /** Derived from the immutable Room create's existing buzz-dm marker. */
  isDirectMessage?: boolean;
  /** True when the immutable create names a parent channel — a corner worktree channel. */
  isChildChannel?: boolean;
  /** Immutable parent Room id for a corner worktree channel. */
  parentChannelId?: string;
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

export type PushNotificationType =
  'mention' | 'direct-message' | 'merge-approval-request' | 'agent-question' | 'agent-attention';

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

/**
 * The app's @mention encoding: the mentioned member's pubkey rides a `p` tag on
 * the kind:9 message (see buzz-client's buildMessage `mentionPubkeys`). A
 * mention qualifies for the quiet default policy but never bypasses fixture or
 * persistent-Workspace suppression, and never reaches the message's own author.
 */
export function mentionsMember(event: NostrEvent, recipientPubkey: string): boolean {
  return event.kind === 9 && tagValues(event, 'p').includes(recipientPubkey);
}

/** A new agent-authored fact that changes a corner from working to waiting on a person. */
export function isWaitingOnHumanEvent(event: NostrEvent): boolean {
  if (event.kind !== 9) return false;
  const markers = tagValues(event, 't');
  // Repository activity is ambient Room content even when an issue title or
  // review comment happens to contain a question mark. It never pages a phone.
  if (markers.includes('github-event')) return false;
  const mergeReady =
    markers.includes('body-control') &&
    Boolean(tagValue(event, 'repo') && tagValue(event, 'branch') && tagValue(event, 'tip'));
  const needsAttention =
    tagValue(event, 'display-status') === 'needs-attention' ||
    tagValue(event, 'status') === 'needs-attention';
  const agentQuestion = markers.includes('agent-message') && /\?/.test(event.content);
  return mergeReady || needsAttention || agentQuestion;
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

/**
 * Channel-naming convention (captain, 2026-08): a Room notification is titled
 * `#<room>`; a Corner notification is titled `#<room>/<corner>`, where the Room
 * half is the PARENT Room's current display name resolved from relay truth —
 * never invented, duplicated, or derived from the corner's own name.
 *
 * When the parent metadata is absent or deleted, the title falls back to this
 * gateway's long-standing shape: the event channel's own resolved name, then
 * the sender. A room name is never fabricated.
 */
const locationTitle = (
  resolvedParentRoomName: string | undefined,
  resolvedCornerName: string | undefined,
  resolvedRoomName: string | undefined,
): string | undefined => {
  if (!resolvedParentRoomName) return roomTitle(resolvedRoomName);
  return resolvedCornerName
    ? `${roomTitle(resolvedParentRoomName)}/${resolvedCornerName}`
    : roomTitle(resolvedParentRoomName);
};

export function mapEventToNotification(
  event: NostrEvent,
  context: NotificationContext,
  options: NotificationFormattingOptions = {},
): PushNotificationPlan | null {
  const channelId = tagValue(event, 'h');
  if (!channelId) return null;

  const markers = tagValues(event, 't');
  if (markers.includes('github-event')) return null;
  const isMergeRequest =
    markers.includes('body-control') &&
    Boolean(tagValue(event, 'repo') && tagValue(event, 'branch') && tagValue(event, 'tip'));
  const mentioned = options.recipientMentioned === true;
  const question = markers.includes('agent-message') && /\?/.test(event.content);
  const waitingOnHuman = isWaitingOnHumanEvent(event);
  if (!mentioned && !context.isDirectMessage && !waitingOnHuman) return null;
  const attentionTarget = tagValue(event, 'subchannel') ?? channelId;
  const type: PushNotificationType = isMergeRequest
    ? 'merge-approval-request'
    : mentioned
      ? 'mention'
      : context.isDirectMessage
        ? 'direct-message'
        : question
          ? 'agent-question'
          : 'agent-attention';
  const resolvedRoomName = normalizedDisplayText(context.roomName, 80);
  const roomName = resolvedRoomName ?? 'Room';
  const senderName =
    normalizedDisplayText(context.senderName, 80) ?? fallbackPersonName(event.pubkey);
  const showMessagePreview = options.showMessagePreview ?? true;
  const preview = formatMessagePreview(event.content);
  const composedTitle = locationTitle(
    normalizedDisplayText(context.parentRoomName, 80),
    normalizedDisplayText(context.cornerName, 80),
    resolvedRoomName,
  );
  const cornerId =
    isMergeRequest || context.parentChannelId
      ? channelId
      : type === 'agent-attention' && attentionTarget !== channelId
        ? attentionTarget
        : undefined;
  const destinationChannelId = cornerId ?? channelId;
  const roomId = context.parentChannelId ?? channelId;
  const target = isMergeRequest ? 'approval' : type === 'agent-attention' ? 'corner' : 'message';

  return {
    channelId,
    title: isMergeRequest
      ? 'Merge approval requested'
      : context.isDirectMessage
        ? senderName
        : (composedTitle ?? senderName),
    body: isMergeRequest
      ? `Review requested in ${roomName}`
      : mentioned
        ? showMessagePreview && preview
          ? `${senderName} mentioned you: ${preview}`
          : `${senderName} mentioned you`
        : context.isDirectMessage
          ? showMessagePreview && preview
            ? preview
            : `New direct message from ${senderName}`
          : question
            ? showMessagePreview && preview
              ? `${senderName} needs your reply: ${preview}`
              : `${senderName} needs your reply`
            : showMessagePreview && preview
              ? `${senderName} needs your attention: ${preview}`
              : `${senderName} needs your attention`,
    data: {
      target,
      roomId,
      channelId: destinationChannelId,
      roomName,
      type,
      eventId: event.id,
      ...(cornerId ? { cornerId } : {}),
      ...(target === 'message' ? { messageId: event.id } : {}),
      ...(target === 'approval' ? { approvalId: event.id } : {}),
    },
  };
}
