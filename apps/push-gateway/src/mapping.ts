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
  /** Stable profile handle when one is available; `senderName` remains the display fallback. */
  senderHandle?: string;
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
  'mention' | 'direct-message' | 'pull-request-opened' | 'actionable-failure';

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

/**
 * A terminal failure is interrupt-worthy only when its publisher explicitly
 * says automatic recovery is blocked. Broad `needs-attention` narration and
 * agent questions are intentionally ordinary in-app Room activity.
 */
export function isActionableHumanFailureEvent(event: NostrEvent): boolean {
  if (event.kind !== 9) return false;
  const markers = tagValues(event, 't');
  // Repository activity is ambient Room content even when an issue title or
  // review comment happens to contain a question mark. It never pages a phone.
  if (markers.includes('github-event')) return false;
  return tagValues(event, 'status').includes('failed') && tagValue(event, 'retry') === 'blocked';
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

const FIXTURE_EVENT_MARKERS = new Set(['ui-test', 'ui-demo', 'uidemo', 'test-fixture']);

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
  const isPullRequestFact =
    event.kind === 9 && markers.includes('corner-pr') && markers.includes('github-event');
  const mentioned = options.recipientMentioned === true;
  const actionableFailure = isActionableHumanFailureEvent(event);
  if (!mentioned && !context.isDirectMessage && !isPullRequestFact && !actionableFailure)
    return null;
  const attentionTarget = tagValue(event, 'subchannel') ?? channelId;
  const type: PushNotificationType = isPullRequestFact
    ? 'pull-request-opened'
    : mentioned
      ? 'mention'
      : context.isDirectMessage
        ? 'direct-message'
        : 'actionable-failure';
  const resolvedRoomName = normalizedDisplayText(context.roomName, 80);
  const roomName = resolvedRoomName ?? 'Room';
  const senderName =
    normalizedDisplayText(context.senderName, 80) ?? fallbackPersonName(event.pubkey);
  const senderHandle =
    normalizedDisplayText(context.senderHandle, 80)?.replace(/^@+/, '') ?? senderName;
  const showMessagePreview = options.showMessagePreview ?? true;
  const preview = isPullRequestFact
    ? formatMessagePreview(event.content)
    : formatMessagePreview(event.content);
  const bodyMessage = showMessagePreview && preview ? preview : 'New message';
  const composedTitle = locationTitle(
    normalizedDisplayText(context.parentRoomName, 80),
    normalizedDisplayText(context.cornerName, 80),
    resolvedRoomName,
  );
  const cornerId =
    isPullRequestFact || context.parentChannelId
      ? channelId
      : type === 'actionable-failure'
        ? attentionTarget
        : undefined;
  const destinationChannelId = cornerId ?? channelId;
  const roomId = context.parentChannelId ?? channelId;
  const target =
    isPullRequestFact || type === 'actionable-failure' ? 'corner' : 'message';

  return {
    channelId,
    title: isPullRequestFact
      ? 'Pull request opened'
      : context.isDirectMessage
        ? senderName
        : (composedTitle ?? senderName),
    body: `@${senderHandle}: ${bodyMessage}`,
    data: {
      target,
      roomId,
      channelId: destinationChannelId,
      roomName,
      type,
      eventId: event.id,
      ...(cornerId ? { cornerId } : {}),
      ...(target === 'message' ? { messageId: event.id } : {}),
    },
  };
}
