/**
 * Buzz Chat — single channel/session chat screen (P2: subchannels + merge + provenance).
 *
 * Grok Mono Hull design: neutral metal surfaces with redundant state encoding.
 */
import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import {
  AppState,
  View,
  Text,
  Image,
  FlatList,
  Linking,
  Pressable,
  ScrollView,
  Share,
  TextInput,
  TouchableOpacity,
  Platform,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as WebBrowser from 'expo-web-browser';
import { KeyboardAvoidingView, useKeyboardState } from 'react-native-keyboard-controller';
import { Swipeable } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useNavigation, router, type Href } from 'expo-router';
import { loadBuzzIdentity, getEffectiveRelayUrl } from '@/auth/buzz-identity-storage';
import {
  githubInstallationRedirectUri,
  githubRepositoryRefreshFeedback,
  resumeInitialGitHubInstallation,
  runGitHubInstallationSession,
} from '@/auth/github-auth-session';
import { authSessionOptions } from '@/auth/auth-session';
import { Modal } from '@/modal';
import { BuzzRigTransport } from '@/sync/transport';
import {
  type ChannelRole,
  type MergeTarget,
  type AttachmentReference,
  type RoomRepository,
  type GitHubInstallationAccess,
  type AgentCommandList,
  type KnownMessageReference,
  RoomViewClient,
  RoomViewHttpError,
  SurfaceRefreshScheduler,
  LiveOverlayDecoder,
  applyLiveOverlay,
  visibleLiveOverlays,
  addRoomPage,
  isRoomView,
  type LiveOverlay,
  type RoomView,
  type RoomViewMessage,
  KIND_AGENT_DRAFT,
  AGENT_PRESENCE_STALE_MS,
  CORNER_ACTIVITY_FRESHNESS_MS,
  personHandle,
} from '@beeline/buzz-client';
import {
  createRoomMessageProjector,
  displayRoomMessages,
  mergeDisplayPages,
  reconcileRoomView,
  type ChatDisplayMessage,
  type DeliveryRetryPosture,
  cornerSummaries,
  memberAgent,
  workspaceRailItem,
} from '@/buzz/room-view-presentation';
import {
  buildChannelReferenceIndex,
  type ChannelReferenceIndex,
  type ChannelReferenceTarget,
} from '@/buzz/channel-reference';
import { pushOpenBuzzChannelId, releaseOpenBuzzChannelId } from '@/buzz/open-room-tracker';
import { createRoomOutbox, mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { afterInteractions } from '@/buzz/defer-interaction';
import { buildTurnActivity, latestCornerPlan } from '@/buzz/activity-timeline';
import { cornerObjectiveLine, type RoomContextEntry } from '@/buzz/corner-context';
import { groknight } from '@/buzz/groknight';
import { continuedSpeakerIds, ledgerSpeakerKey } from '@/buzz/ledger-attribution';
import { splitLedgerText } from '@/buzz/ledger-text';
import { shouldShowReplyReference } from '@/buzz/reply-reference';
import { publishFailurePresentation } from '@/buzz/publish-failure';
import { ledgerStamp } from '@/buzz/relative-time';
import { CORNER_LABEL, ROOM_LABEL } from '@/buzz/vocabulary';
import { selectTurnProgressAgentPubkey } from '@/buzz/room-indicators';
import { useRoomSendFrame } from '@/buzz/room-send-frame';
import {
  activeMentionAtCursor,
  filterMentionCandidates,
  formatRoomParticipantTotal,
  mentionedAgentPubkey,
  replaceActiveMention,
  resolveComposerMentions,
  sectionRoomParticipants,
  sectionRoomRoster,
  selectedMentionAgentPubkey,
} from '@/buzz/room-participants';
import {
  resolveAgentDisplayIdentity,
  resolveCornerCardAgentPubkey,
  resolvePendingAgentDisplay,
} from '@/buzz/agent-display';
import {
  currentCornerStatus,
  roomListCorners,
  resolveCornerLifecycleStatus,
  type CornerStatus,
  type CornerSummary,
} from '@/buzz/corners';
import { cornerActionSurface } from '@/buzz/corner-attention';
import { personIdentityLabel, shortMemberNpub } from '@/buzz/member-display';
import { useVerifiedNip05Status } from '@/buzz/nip05-verification';
import {
  canRenameRoom,
  canManageRoomRepository,
  canRemoveRoomParticipant,
  normalizedRoomRole,
  roomLifecycleAction,
} from '@/buzz/room-management';
import {
  looksLikeCornerOpenIntent,
  GITHUB_REPOSITORY_SELECTION_INSTRUCTION,
  githubFullNameFromInput,
  githubRepositoryLinkagePlan,
  roomRepoChipLabel,
  type RepoCandidate,
} from '@/buzz/room-repo-picker';
import {
  OwnerGrantNeededCard,
  ownerGrantShareMessage,
  type OwnerGrantNeeded,
} from '@/components/buzz/OwnerGrantNeededCard';
import {
  isPinnedCornerLive,
  isPinnedCornerReadyForReview,
  selectPinnedCorner,
} from '@/buzz/room-indicators';
import { displayCornerTitle } from '@/buzz/room-list-row';
import {
  loadActiveCommunityId,
  saveActiveCommunityId,
  saveLastViewedChannel,
} from '@/buzz/community-storage';
import {
  attachmentOpenUrl,
  formatAttachmentSize,
  uploadChatAttachment,
  type PickedChatAttachment,
} from '@/buzz/chat-attachment';
import { describeWriteRequest } from '@/buzz/write-request-copy';
import {
  availableSlashVerbs,
  slashVerbQuery,
  agentMentionSlashQuery,
  matchesAgentCommand,
  type BuiltInSlashVerbId,
} from '@/buzz/slash-verbs';
import {
  cachedChannelKind,
  channelHeaderTitle,
  changeReviewSummary,
  resolveCornerViewAgentPubkey,
  type ChannelKind,
} from '@/buzz/corner-session';
import {
  chatBackAction,
  cornerHref,
  roomHref,
  type ChatStackRoute,
} from '@/buzz/corner-navigation';
import { isNearChatBottom } from '@/buzz/chat-scroll';
import {
  replyMessageText,
  type MessageReplyDisplayTarget,
  type MessageReplyTarget,
} from '@/buzz/message-reply';
import { mentionKeyboardAction } from '@/buzz/composer-keyboard';
import { copyEntireTurn } from '@/buzz/message-copy';
import { useRoomMessageRenderItem } from '@/buzz/room-message-cell';
import { isWorkspaceManagerRole } from '@/buzz/workspace-role';
import {
  isAgentPresenceOnlineWithReconnectGrace,
  isAgentOfflineAfterPresenceResolved,
  isAgentTurnActive,
  mergeAgentPresence,
  mergeAgentPresenceBatch,
  nextAgentPresenceTransitionAt,
  nextAgentTurnExpiryAt,
  onlineVerdicts,
  activeMentionCandidates,
  AGENT_PRESENCE_BACKGROUND_GRACE_MS,
  type RoomAgentPresence,
} from '@/buzz/agent-presence';
import {
  sameMessageRefMap,
  sameSelectedMembers,
  sameStringSet,
  shallowEqualRecord,
  useStable,
} from '@/buzz/use-stable';
import { BuzzCommunityShell } from '@/components/buzz/CommunityRail';
import { Typography } from '@/constants/Typography';
import { ChangeReviewPanel } from '@/components/buzz/ChangeReviewPanel';
import { CornerLiveBar } from '@/components/buzz/CornerLiveBar';
import { CornerPlanPin } from '@/components/buzz/CornerPlanPin';
import { RoomContextPreamble } from '@/components/buzz/RoomContextPreamble';
import { TurnProgressLine } from '@/components/buzz/TurnProgressLine';
import { WritePermissionOutcome } from '@/components/buzz/WritePermissionOutcome';
import { ActivityTimeline } from '@/components/buzz/ActivityTimeline';
import { AttachmentPickerSheet } from '@/components/buzz/AttachmentPickerSheet';
import { HullFloatingSurface, HullModal } from '@/components/buzz/HullDialog';
import { EmptyLedgerState, type EmptyLedgerVariant } from '@/components/buzz/EmptyLedgerState';
import { HeaderIdentitySlot, HeaderMetaCaps, HeaderMetaRow } from '@/components/buzz/HeaderLadder';
import {
  LEDGER_MARGINALIA_WIDTH,
  LedgerEntry,
  LedgerGhostLine,
  LedgerRoomUpdate,
  LedgerSteer,
  type LedgerByline,
} from '@/components/buzz/Ledger';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { RoomRosterSheet, type RoomRosterParticipant } from '@/components/buzz/RoomRosterSheet';
import { RepoPicker } from '@/components/buzz/RepoPicker';
import { SlashVerbPicker } from '@/components/buzz/SlashVerbPicker';
import {
  CornerGlyph,
  HullSurface,
  MonoButton,
  NewMessageMaterialize,
  PixelLoader,
} from '@/components/buzz/MonoHull';
import {
  APPROVAL_ACK_TIMEOUT_MS,
  approvalTimeoutMessage,
  nextApprovalState,
  type ApprovalUiState,
} from '@/buzz/approval-state';

type RoomMemberOption = RoomRosterParticipant;

/** Known body pubkeys for provenance display (hardcoded for dev). */
const BODY_PUBKEYS = new Set<string>();
const COMPOSER_MIN_HEIGHT = 40;
const COMPOSER_MAX_HEIGHT = 120;
// Open on the tail of a long transcript instead of the full history, then
// page older messages in as the reader scrolls up.
const INITIAL_MESSAGE_WINDOW = 30;
const OLDER_MESSAGES_PAGE_SIZE = 30;
const OUTBOX_CONFIRMATION_TIMEOUT_MS = 15_000;
// This deliberately remains the sole color seam for the human merge decision.
// If the product ever approves a non-monochrome exception, change only this value.
const MERGE_APPROVAL_ACCENT = groknight.accent;

/**
 * The voice a transcript entry belongs to, or `null` for anything that is not
 * one, is decided by THE shared projection helper (`buzz/ledger-attribution.ts`
 * — Rooms and corners alike). This screen only supplies its roster union:
 * registered agents plus the daemon's own body keys.
 */
const knownAgentPubkeysFor = (agentByPubkey: Map<string, unknown>): Set<string> => {
  const keys = new Set<string>(BODY_PUBKEYS);
  for (const pubkey of agentByPubkey.keys()) keys.add(pubkey);
  return keys;
};

/** The live thought/tool/message lanes for one signed WORKING turn. A Room
 * passes `handle` because several agents can be working there; a Corner names
 * its one agent in the top bar instead. The selector removes this row at turn
 * end, so none of its machine telemetry can become replayable history. */
function LedgerActivity({
  message,
  active,
  handle,
  stamp,
}: {
  message: ChatDisplayMessage;
  active: boolean;
  handle?: string;
  stamp: string;
}) {
  // A fresh fallback array literal on every render would defeat
  // ActivityTimeline's memoization below (its `items` prop would never be
  // reference-stable), so this stays memoized on the same inputs.
  const activity = useMemo(
    () =>
      message.activity?.length
        ? message.activity
        : [{ kind: 'output' as const, title: 'Output', text: message.text }],
    [message.activity, message.text],
  );
  return (
    <View style={styles.activityGroup} testID="corner-activity">
      <ActivityTimeline
        active={active}
        handle={handle}
        items={activity}
        thought={message.agentThought}
        messageDraft={message.agentMessageDraft}
        stamp={stamp}
        testID="corner-activity-timeline"
      />
    </View>
  );
}

function durableFactLine(message: ChatDisplayMessage): string {
  const turn = buildTurnActivity(message.activity ?? []);
  const step =
    message.durableFact?.kind === 'failure'
      ? [...turn.steps].reverse().find((candidate) => candidate.outcome === 'failure')
      : turn.steps.at(-1);
  const glyph = message.durableFact?.kind === 'failure' ? '✗' : '✓';
  const label = step?.label ?? (message.durableFact?.kind === 'merge' ? 'change merged' : 'action');
  return `${glyph} ${label}${step?.reason ? ` · ${step.reason}` : ''}`;
}

/**
 * Memoized: rendered once per agent transcript row inside FlatList's
 * renderItem, which is recreated on every presence tick — without this,
 * every row's presence dot re-renders even when only one other agent's
 * status actually changed. `online` is the only prop, so a shallow compare
 * bails correctly whenever this row's own agent status is unchanged.
 */
const AgentPresenceLight = React.memo(function AgentPresenceLight({
  decorative = false,
  online,
  testID,
}: {
  decorative?: boolean;
  online: boolean;
  testID?: string;
}) {
  return (
    <View
      accessibilityElementsHidden={decorative}
      accessibilityLabel={decorative ? undefined : online ? 'Agent online' : 'Agent offline'}
      accessibilityRole={decorative ? undefined : 'image'}
      accessible={!decorative}
      importantForAccessibility={decorative ? 'no' : 'auto'}
      style={[
        styles.agentPresenceLight,
        online ? styles.agentPresenceOnline : styles.agentPresenceOffline,
      ]}
      testID={testID}
    />
  );
});
function AttachmentCard({ attachment }: { attachment: AttachmentReference }) {
  const image = attachment.mimeType.startsWith('image/') && attachment.thumbnailUrl;
  const open = () => {
    void Linking.openURL(attachmentOpenUrl(attachment)).catch(() => {
      Modal.alert('Could not open attachment', 'The file link could not be opened on this device.');
    });
  };
  return (
    <Pressable
      accessibilityLabel={`Open attachment ${attachment.name}`}
      accessibilityRole="link"
      onPress={open}
      style={styles.attachmentCard}
      testID={`chat-attachment-${attachment.name}`}
    >
      {image ? (
        <Image
          accessibilityIgnoresInvertColors
          resizeMode="cover"
          source={{ uri: attachment.thumbnailUrl }}
          style={styles.attachmentThumbnail}
        />
      ) : (
        <View style={styles.attachmentFileGlyph}>
          <Text style={styles.attachmentFileGlyphText}>▧</Text>
        </View>
      )}
      <View style={styles.attachmentCopy}>
        <Text numberOfLines={1} style={styles.attachmentName}>
          {attachment.name}
        </Text>
        <Text numberOfLines={1} style={styles.attachmentMeta}>
          {attachment.mimeType.toUpperCase()} · {formatAttachmentSize(attachment.size)}
        </Text>
      </View>
      <Text style={styles.attachmentOpenGlyph}>↗</Text>
    </Pressable>
  );
}

function SwipeToReply({
  children,
  messageId,
  onLongPress,
  onReply,
}: {
  children: React.ReactNode;
  messageId: string;
  onLongPress: () => void;
  onReply: () => void;
}) {
  const swipeableRef = useRef<Swipeable | null>(null);

  const message = (
    <Pressable
      accessibilityHint="Long press to copy the entire message"
      accessibilityLabel="Message"
      delayLongPress={450}
      onLongPress={onLongPress}
      testID={`copy-message-${messageId}`}
    >
      {children}
    </Pressable>
  );

  if (Platform.OS === 'web') return message;

  return (
    <Swipeable
      ref={swipeableRef}
      dragOffsetFromRightEdge={18}
      friction={1.35}
      onSwipeableOpen={(direction) => {
        if (direction !== 'right') return;
        swipeableRef.current?.close();
        onReply();
      }}
      overshootRight={false}
      renderRightActions={() => (
        <View
          accessibilityLabel="Reply to message"
          style={styles.replySwipeAction}
          testID={`reply-swipe-action-${messageId}`}
        >
          <Text style={styles.replySwipeGlyph}>↩</Text>
          <Text style={styles.replySwipeLabel}>REPLY</Text>
        </View>
      )}
      testID={`swipe-reply-${messageId}`}
    >
      {message}
    </Swipeable>
  );
}

export default function BuzzChat() {
  const { theme } = useUnistyles();
  // `parent`/`title` are hints, not authority: every surface that opens a
  // corner already knows both, so passing them makes the header correct on the
  // first frame instead of one relay round trip later. The screen's own reads
  // still run and still win.
  const {
    channelId,
    notificationResponseId,
    notificationTarget,
    notificationMessageId,
    notificationApprovalId,
    notificationFallbackChannelId,
    parent,
    title,
    returnTo,
  } = useLocalSearchParams<{
    channelId: string;
    notificationResponseId?: string;
    notificationTarget?: string;
    notificationMessageId?: string;
    notificationApprovalId?: string;
    notificationFallbackChannelId?: string;
    parent?: string;
    title?: string;
    returnTo?: string;
  }>();
  const decodedId = channelId ? decodeURIComponent(channelId) : '';
  const routeParentChannelId = parent?.trim() || undefined;
  const routeChannelTitle = title?.trim() || undefined;
  const cornerReturnTarget = returnTo === 'room-list' ? returnTo : undefined;
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const flatListRef = useRef<FlatList<ChatDisplayMessage>>(null);
  const handledNotificationAnchorRef = useRef<string | null>(null);
  const handledNotificationFallbackRef = useRef<string | null>(null);
  const composerRef = useRef<TextInput>(null);
  // React state can lag the final Android native text event when the user
  // immediately taps send. Keep the authoritative in-flight draft beside the
  // native TextInput so an @mention never drops trailing text.
  const inputTextRef = useRef('');
  // The picker knows the exact agent key, whereas text-only lookup is a
  // fallback for manually typed mentions. Keep that identity through trailing
  // typing so an async roster refresh cannot turn a selected agent into an
  // unaddressed plain Room message.
  const selectedAgentMentionsRef = useRef(new Map<string, string>());
  const selectedMentionsRef = useRef(new Map<string, string>());
  // When each agent was last told about, so a standing offline condition is
  const sendInFlightRef = useRef(false);
  const outboxRef = useRef<ReturnType<typeof createRoomOutbox> | null>(null);
  const roomSchedulerRef = useRef<SurfaceRefreshScheduler<RoomView> | null>(null);
  const reconciledRoomViewRef = useRef<RoomView | null>(null);
  const roomMessageProjectorRef = useRef<ReturnType<typeof createRoomMessageProjector> | null>(
    null,
  );
  const roomMessageProjector =
    roomMessageProjectorRef.current ??
    (roomMessageProjectorRef.current = createRoomMessageProjector());
  const outboxConfirmationTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // Publish the open conversation to the foreground notification policy. The
  // root notification handler runs outside the React tree, so it reads this
  // tracker instead of route state. Synchronous, no relay work.
  useEffect(() => {
    pushOpenBuzzChannelId(decodedId || null);
    return () => releaseOpenBuzzChannelId(decodedId || null);
  }, [decodedId]);

  const [transport, setTransport] = useState<BuzzRigTransport | null>(null);
  const [roomClient, setRoomClient] = useState<RoomViewClient | null>(null);
  const [roomSurface, setRoomSurface] = useState<RoomView | null>(null);
  const [liveOverlays, setLiveOverlays] = useState<readonly LiveOverlay[]>([]);
  const [transcriptHydrationAttempt, setTranscriptHydrationAttempt] = useState(0);
  const [transcriptHydrationFailed, setTranscriptHydrationFailed] = useState(false);
  const [transcriptHydrationError, setTranscriptHydrationError] = useState<string | null>(null);
  const [inputText, setInputText] = useState('');
  const [replyTarget, setReplyTarget] = useState<MessageReplyTarget | null>(null);
  const [composerHeight, setComposerHeight] = useState(COMPOSER_MIN_HEIGHT);
  const [inputSelection, setInputSelection] = useState({ start: 0, end: 0 });
  const [highlightedMentionIndex, setHighlightedMentionIndex] = useState(0);
  const [dismissedMentionKey, setDismissedMentionKey] = useState<string | null>(null);
  const [highlightedSlashVerbIndex, setHighlightedSlashVerbIndex] = useState(0);
  const [dismissedSlashText, setDismissedSlashText] = useState<string | null>(null);
  /** Per-Room+agent command lists (null = read resolved and no record exists). */
  const [agentCommandsByScope, setAgentCommandsByScope] = useState<
    Record<string, AgentCommandList | null>
  >({});
  const [sending, setSending] = useState(false);
  const [failedOutboxIds, setFailedOutboxIds] = useState<ReadonlySet<string>>(new Set());
  const [pendingAttachment, setPendingAttachment] = useState<PickedChatAttachment | null>(null);
  const [attachmentPickerVisible, setAttachmentPickerVisible] = useState(false);
  const [userPubkey, setUserPubkey] = useState<string>('');
  // Local relay acceptance and daemon landing are separate visible states;
  // neither is terminal until a durable landed event names the resulting tip.
  // 'failed' means a durable publish on the landing path (push, land, or
  // merge-gate attempt) failed or could not be confirmed. Whether anything is
  // still happening after that is NOT inferable here — the daemon says so on
  // the failure event itself, and `deliveryRetry` below carries its answer.
  const [approvalActionState, setApprovalState] = useState<ApprovalUiState>('none');
  // The daemon confirmed it CONSUMED the signed approval (`decision=accepted`
  // ack) and is landing it. This is what lets DELIVERING resolve on evidence:
  // before this existed, a missed archive event or silent daemon left the
  // spinner up forever. Cleared whenever the panel reopens for a new review.
  const [approvalPublishAcked, setApprovalAcked] = useState(false);
  // The daemon's own posture after a failed land. This screen used to hard-code
  // "RETRYING AUTOMATICALLY", which is false for a land the daemon has stopped
  // re-attempting (a moved target being rebased, or one it has given up on) —
  // exactly the case that reads as a dead end to the person holding the phone.
  // Reviewable tip currently on screen. Held on a ref, not read off
  // `mergeTarget`, because a whole live batch is applied before any re-render.
  const mergeTargetTipRef = useRef<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [cornerStateNow, setCornerStateNow] = useState(Date.now());
  // "No corner on record" and "the corner list has not answered yet" are
  // different answers, and only the first one may let a freshly permitted
  // corner onto the pinned line — see `selectPinnedCorner`.
  // What this corner inherited from the Room it was opened out of: the task
  // the daemon recorded on its create event, and the bounded window of Room
  // conversation that preceded it. Corner-only; a Room never reads it.
  const [addingMemberPubkey, setAddingMemberPubkey] = useState<string | null>(null);
  // The repo this Room owns, or `null` for a chat-only Room. Corners never
  // read this — a corner has no room-repository binding of its own; the
  // daemon resolves its working repo from its parent Room instead.
  const [showRoomRepoPicker, setShowRoomRepoPicker] = useState(false);
  const [roomRepoCandidates, setRoomRepoCandidates] = useState<RepoCandidate[]>([]);
  const [githubInstallations, setGitHubInstallations] = useState<GitHubInstallationAccess[]>([]);
  const [roomRepoBusy, setRoomRepoBusy] = useState(false);
  const [roomRepoError, setRoomRepoError] = useState<string | null>(null);
  const [roomRepoNotice, setRoomRepoNotice] = useState<string | null>(null);
  // Typed "the App does not cover this repository yet" state: rendered as a
  // share-with-owner CTA, never an error wall. `uncoveredOwners` feeds the
  // paste-flow plan so a foreign repo plans the share path instead of a
  // doomed self-connect.
  const [ownerGrant, setOwnerGrant] = useState<OwnerGrantNeeded | null>(null);
  const uncoveredOwnersRef = useRef<Set<string>>(new Set());
  const [cornerOpenRepoPrompt, setCornerOpenRepoPrompt] = useState(false);
  const [roomRepoAccessIssue, setRoomRepoAccessIssue] = useState<{
    fullName: string;
    reason: 'revoked' | 'not_granted';
    installationId?: number;
  } | null>(null);
  const [rosterVisible, setRosterVisible] = useState(false);
  const closeRoster = useCallback(() => setRosterVisible(false), []);
  const [roomActionsVisible, setRoomActionsVisible] = useState(false);
  const [cornerActionsVisible, setCornerActionsVisible] = useState(false);
  const [renameEditing, setRenameEditing] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [participantPickerVisible, setParticipantPickerVisible] = useState(false);
  const [participantPickerKind, setParticipantPickerKind] = useState<'person' | 'agent' | null>(
    null,
  );
  const [membershipError, setMembershipError] = useState<string | null>(null);
  const [membershipActionPubkey, setMembershipActionPubkey] = useState<string | null>(null);
  const [roomLifecycleBusy, setRoomLifecycleBusy] = useState(false);
  const directMessage = roomSurface?.directMessage ?? null;
  const [composerFocused, setComposerFocused] = useState(false);
  const [permissionActionId, setPermissionActionId] = useState<string | null>(null);
  /** Proposal currently being confirmed, and the last refusal/failure text. */
  const [targetBranchActionId, setTargetBranchActionId] = useState<string | null>(null);
  const [targetBranchNotice, setTargetBranchNotice] = useState<{
    proposalId: string;
    text: string;
  } | null>(null);
  const [heartbeatPresences, setAgentPresences] = useState<Record<string, RoomAgentPresence>>({});
  const [presenceResolved, setPresenceResolved] = useState(false);
  const [presenceReconnectGrace, setPresenceReconnectGrace] = useState<Record<string, number>>({});
  const [presenceNow, setPresenceNow] = useState(Date.now());
  const agentPresencesRef = useRef(heartbeatPresences);
  const presenceReconnectGraceRef = useRef(presenceReconnectGrace);
  // The ref is the *heartbeat* map, because it is what live presence events
  // merge into and what the reconnect grace is keyed off. The derived map
  // below is a read-only view for everything that decides "is it online".
  agentPresencesRef.current = heartbeatPresences;
  presenceReconnectGraceRef.current = presenceReconnectGrace;
  const cacheViewerPubkey = userPubkey;
  const isArchived = roomSurface?.room.archived ?? false;
  const parentChannelId = roomSurface?.parent?.id ?? routeParentChannelId;
  const channelKind: ChannelKind = roomSurface
    ? roomSurface.parent
      ? 'corner'
      : 'room'
    : routeParentChannelId
      ? 'corner'
      : 'unknown';
  const isCorner = Boolean(parentChannelId);
  const resolvedChannelName = roomSurface?.room.name ?? routeChannelTitle ?? null;
  const activeCommunityId = roomSurface?.room.workspaceId ?? null;
  const viewerIsAgent = roomSurface?.viewer.identity.kind === 'agent';
  const viewerChannelRole = roomSurface?.viewer.role ?? null;
  const canManageWorkspace = viewerChannelRole === 'owner' || viewerChannelRole === 'admin';
  const communities = useMemo(
    () =>
      roomSurface
        ? [
            workspaceRailItem({
              id: roomSurface.room.workspaceId,
              name: roomSurface.parent?.name ?? roomSurface.room.name,
              visibility: 'invite-only',
              role: roomSurface.viewer.role,
              updatedAt: roomSurface.room.updatedAt,
            }),
          ]
        : [],
    [roomSurface?.parent, roomSurface?.room, roomSurface?.viewer.role],
  );
  const cornerLifecycle = useMemo(
    () => (roomSurface ? cornerSummaries(roomSurface) : []),
    [roomSurface?.corners],
  );
  const cornerLifecycleStatus =
    cornerLifecycle.find((corner) => corner.id === decodedId)?.status ?? null;
  const cornerTask = roomSurface?.parent ? roomSurface.room.about : undefined;
  const roomContext = useMemo<RoomContextEntry[]>(
    () =>
      displayRoomMessages(roomSurface?.briefing ?? [], cacheViewerPubkey).map((message) => ({
        id: message.id,
        text: message.text,
        timestamp: message.timestamp,
        ...(message.pubkey ? { pubkey: message.pubkey } : {}),
        isAgent: Boolean(message.isAgentAuthor),
      })),
    [cacheViewerPubkey, roomSurface?.briefing],
  );
  const roomRepository = useMemo<RoomRepository | null>(() => {
    if (isCorner || !roomSurface?.repository) return null;
    const repository = roomSurface.repository;
    return {
      channelId: decodedId,
      communityId: roomSurface.room.workspaceId,
      binding: {
        key: repository.key,
        name: repository.name,
        remote: repository.remote,
        localOnly: false,
        ...(repository.githubInstallationId
          ? { githubInstallationId: repository.githubInstallationId }
          : {}),
      },
      targetBranch: repository.targetBranch,
      githubEventsEnabled: repository.githubEventsEnabled,
      source: 'config',
    };
  }, [decodedId, isCorner, roomSurface?.repository, roomSurface?.room.workspaceId]);
  const roomRepositoryState = roomSurface?.repositoryResolution;
  // A loaded surface with no repository field is not enough to prompt. The
  // indexer distinguishes a proven empty Room from an unverified binding,
  // including bindings authored by a predecessor key.
  const roomRepositoryResolved = roomRepositoryState === 'none';
  useEffect(() => {
    // A stale cached `none` response can briefly open the lazy prompt before a
    // fresh server read discovers a binding it cannot verify. Do not leave the
    // stronger, fresh fact painted as the false "not linked" banner.
    if (roomRepositoryState !== 'none' && !roomRepoAccessIssue) {
      setCornerOpenRepoPrompt(false);
    }
  }, [roomRepoAccessIssue, roomRepositoryState]);
  const mergeTarget = useMemo<MergeTarget | null>(
    () =>
      roomSurface?.review?.status === 'ready' &&
      roomSurface.review.artifact &&
      roomSurface.repository
        ? {
            repo: roomSurface.repository.key,
            branch: roomSurface.repository.targetBranch.startsWith('refs/')
              ? roomSurface.repository.targetBranch
              : `refs/heads/${roomSurface.repository.targetBranch}`,
            tip: roomSurface.review.artifact.tip,
            patchId: roomSurface.review.artifact.patchId,
          }
        : null,
    [roomSurface],
  );
  const latestMerge = useMemo(
    () => [...(roomSurface?.messages ?? [])].reverse().find((message) => message.merge)?.merge,
    [roomSurface?.messages],
  );
  const approvalState: ApprovalUiState =
    latestMerge?.action === 'landed'
      ? 'merged'
      : latestMerge?.action === 'failed'
        ? 'failed'
        : approvalActionState;
  const approvalAcked =
    approvalPublishAcked ||
    Boolean(
      [...(roomSurface?.messages ?? [])]
        .reverse()
        .find(
          (message) =>
            message.merge?.action === 'approval-ack' && message.merge.decision === 'accepted',
        ),
    );
  const previewUrl = latestMerge?.previewUrl ?? null;
  const mergeNotReadyReason =
    roomSurface?.review?.status === 'not-ready' ? (roomSurface.review.reason ?? null) : null;
  const reviewFiles = roomSurface?.review?.files.map((file) => file.path) ?? null;
  const landedApprovalTip =
    latestMerge?.action === 'landed' ? (latestMerge.tip ?? mergeTarget?.tip ?? null) : null;
  const deliveryRetry: DeliveryRetryPosture | undefined =
    latestMerge?.action === 'failed' ? latestMerge.retry : undefined;
  const cachedMessages = useMemo(
    () =>
      roomSurface && cacheViewerPubkey
        ? roomMessageProjector.project(roomSurface.messages, cacheViewerPubkey)
        : [],
    [cacheViewerPubkey, roomMessageProjector, roomSurface?.messages],
  );
  // Resolve references only within the Room family returned by this surface.
  const channelReferenceIndex = useMemo<ChannelReferenceIndex>(() => {
    return buildChannelReferenceIndex(
      [
        ...(roomSurface?.parent
          ? [{ channelId: roomSurface.parent.id, name: roomSurface.parent.name }]
          : []),
        ...(parentChannelId
          ? []
          : [{ channelId: decodedId, name: resolvedChannelName || routeChannelTitle || '' }]),
      ].filter((room): room is { channelId: string; name: string } => room !== null),
      [
        ...cornerLifecycle.map((corner) => ({
          channelId: corner.id,
          parentChannelId: parentChannelId ?? decodedId,
          name: corner.name,
        })),
        ...(parentChannelId
          ? [
              {
                channelId: decodedId,
                parentChannelId,
                name: resolvedChannelName || routeChannelTitle || '',
              },
            ]
          : []),
      ],
    );
  }, [
    cornerLifecycle,
    decodedId,
    parentChannelId,
    resolvedChannelName,
    roomSurface?.parent,
    routeChannelTitle,
  ]);
  /** Navigate to exactly the referenced Room/Corner through the existing
   * conventions; a reference to the transcript you are already in is a no-op. */
  const handleOpenChannelReference = useCallback(
    (target: ChannelReferenceTarget) => {
      if (!target.channelId || target.channelId === decodedId) return;
      if (target.kind === 'corner')
        router.push(cornerHref(target.channelId, target.parentChannelId));
      else router.push(roomHref(target.channelId));
    },
    [decodedId],
  );
  // The cold-open deadline bounds the single authenticated Room request.
  // A rejected request surfaces through `onStepFailed('transcript')` below.
  // Older pages loaded on demand via "scroll up" pagination. Kept out of the
  // shared cache (which bounds to the recent tail) and merged in only here.
  // History stays as verbatim server rows in page-lifetime partitions. It is
  // converted to render props only below, never persisted as a derived
  // transcript or folded into the current Room response.
  const [olderPages, setOlderPages] = useState<readonly (readonly RoomViewMessage[])[]>([]);
  const [visibleMessageCount, setVisibleMessageCount] = useState(INITIAL_MESSAGE_WINDOW);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const hasMoreHistoryRef = useRef(true);
  const committedMessageIds = useMemo(
    () => new Set(cachedMessages.map((message) => message.id)),
    [cachedMessages],
  );
  const liveMessages = useMemo<ChatDisplayMessage[]>(() => {
    if (!roomSurface) return [];
    return visibleLiveOverlays(liveOverlays, roomSurface.messages).flatMap((overlay) => {
      if (overlay.kind === 'presence') return [];
      return [
        {
          id: overlay.kind === 'draft' ? overlay.stableId : overlay.key,
          text: overlay.kind === 'draft' ? (overlay.text ?? '') : '',
          isUser: false,
          timestamp: overlay.createdAt,
          pubkey: overlay.agentPubkey,
          isAgentAuthor: true,
          isAgentActivity: true,
          isAgentLiveTurn: true,
          ...(overlay.kind === 'draft'
            ? { isAgentDraft: true, agentMessageDraft: overlay.text ?? '' }
            : { agentThought: overlay.text ?? '' }),
        },
      ];
    });
  }, [liveOverlays, roomSurface]);
  const olderMessages = useMemo(
    () => (cacheViewerPubkey ? displayRoomMessages(olderPages.flat(), cacheViewerPubkey) : []),
    [cacheViewerPubkey, olderPages],
  );
  const durableMessages = useMemo(
    () => mergeDisplayPages(olderMessages, cachedMessages, liveMessages),
    [cachedMessages, liveMessages, olderMessages],
  );
  const {
    frame: roomSendFrame,
    append: addMessages,
    remove: removeOptimistic,
    clear: clearOptimistic,
  } = useRoomSendFrame(durableMessages, committedMessageIds, isCorner);
  // All four display partitions share the same chronological merge. A durable
  // outbox row may be older than the current server tail after an interrupted
  // publish, so it must never claim the inverted list's newest slot.
  const combinedMessages = useMemo(
    () => mergeDisplayPages(durableMessages, roomSendFrame.optimistic),
    [durableMessages, roomSendFrame.optimistic],
  );
  // Open on the tail; older history reveals from what's already resident here
  // first, then pages in from the relay once that's exhausted.
  const unprojectedMessages = useMemo(
    () => combinedMessages.slice(-visibleMessageCount),
    [combinedMessages, visibleMessageCount],
  );
  // The most recent plan the agent has published, for the pinned checklist —
  // a plan update replaces the whole checklist, so only the latest matters.
  // Scoped to `combinedMessages` (everything currently loaded), not the
  // windowed `messages`, so paging the visible window never drops a plan
  // that was established earlier in a long corner.
  const cornerPlan = useMemo(() => latestCornerPlan(combinedMessages), [combinedMessages]);
  // The immutable task tag wins. Plan objective is a compatibility fallback
  // for older corners; the task-slugged name is the final fallback.
  const cornerObjective = useMemo(
    () =>
      cornerObjectiveLine({
        ...(cornerTask ? { task: cornerTask } : {}),
        ...(cornerPlan?.objective ? { planObjective: cornerPlan.objective } : {}),
        ...(resolvedChannelName ? { cornerName: resolvedChannelName } : {}),
      }),
    [cornerPlan?.objective, cornerTask, resolvedChannelName],
  );

  const loadOlderTranscriptMessages = useCallback(() => {
    if (loadingOlderMessages) return;
    if (visibleMessageCount < combinedMessages.length) {
      setVisibleMessageCount((count) =>
        Math.min(combinedMessages.length, count + OLDER_MESSAGES_PAGE_SIZE),
      );
      return;
    }
    const oldest = combinedMessages[0];
    if (!hasMoreHistoryRef.current || !roomClient || !oldest || !cacheViewerPubkey) return;
    setLoadingOlderMessages(true);
    void roomClient
      .history(decodedId, { createdAt: oldest.timestamp, id: oldest.relayId ?? oldest.id })
      .then((page) => {
        const fresh = page.messages.filter((message) => message.id !== oldest.id);
        if (!page.nextBefore) hasMoreHistoryRef.current = false;
        if (fresh.length === 0) return;
        setOlderPages(
          (current) =>
            addRoomPage({ ...(roomSurface ? { tail: roomSurface } : {}), pages: current }, fresh)
              .pages,
        );
        setVisibleMessageCount((count) => count + fresh.length);
      })
      .catch((err) => console.warn('Failed to load older messages:', err))
      .finally(() => setLoadingOlderMessages(false));
  }, [
    cacheViewerPubkey,
    combinedMessages,
    decodedId,
    loadingOlderMessages,
    roomClient,
    roomSurface,
    visibleMessageCount,
  ]);
  const availableAgents = useMemo(
    () =>
      (roomSurface?.members ?? [])
        .filter((member) => member.identity.kind === 'agent')
        .map((member) => memberAgent(member, roomSurface?.room.workspaceId ?? '')),
    [roomSurface?.members, roomSurface?.room.workspaceId],
  );
  const availablePeople = useMemo(
    () =>
      (roomSurface?.members ?? [])
        .filter((member) => member.identity.kind === 'human')
        .map((member) => ({ pubkey: member.identity.pubkey, role: member.role })),
    [roomSurface?.members],
  );
  const selectedMembersRaw = useMemo(
    () =>
      (roomSurface?.members ?? []).map((member) => ({
        pubkey: member.identity.pubkey,
        role: member.role,
        kind: member.identity.kind,
        identity: {
          kind: member.identity.kind,
          displayName: member.identity.name,
          handle: member.identity.handle,
        },
      })),
    [roomSurface?.members],
  );
  // The membership projection rebuilds every wrapper object on each snapshot
  // commit. Downstream memos (memberOptions, roomParticipants) and ultimately
  // renderItem's dependency array only care about the VALUE, so preserve the
  // previous reference until a member/role/identity actually moved.
  const selectedMembers = useStable(selectedMembersRaw, sameSelectedMembers);
  const roomMembers = useMemo(
    () => selectedMembers.map((member) => ({ pubkey: member.pubkey, role: member.role })),
    [selectedMembers],
  );
  const roomMemberPubkeys = useMemo(
    () => new Set<string>(roomMembers.map((member) => member.pubkey)),
    [roomMembers],
  );
  const personProfiles = useMemo(
    () =>
      (roomSurface?.members ?? [])
        .filter((member) => member.identity.kind === 'human')
        .map((member) => ({
          pubkey: member.identity.pubkey,
          name: member.identity.name,
          ...(member.identity.avatar ? { avatar: member.identity.avatar } : {}),
        })),
    [roomSurface?.members],
  );
  const participantsHydrated = roomSurface !== null;
  const agentByPubkey = useMemo(
    () => new Map(availableAgents.map((agent) => [agent.pubkey, agent])),
    [availableAgents],
  );
  const personProfileByPubkey = useMemo(
    () => new Map(personProfiles.map((profile) => [profile.pubkey, profile])),
    [personProfiles],
  );
  const memberOptions = useMemo<RoomMemberOption[]>(() => {
    const options = new Map<string, RoomMemberOption>();
    // The viewer, always and first. `availablePeople` is a Workspace roster
    // read; until it lands (or if it comes back partial) the reader was absent
    // from their own Room's participant list, because a roster entry is what
    // the list is built from. A later real entry overwrites this one.
    if (userPubkey) {
      const selfProfileName = personProfileByPubkey.get(userPubkey)?.name;
      options.set(userPubkey, {
        pubkey: userPubkey,
        name: 'You',
        handle: selfProfileName
          ? personHandle(selfProfileName, userPubkey)
          : shortMemberNpub(userPubkey).replace(/[^a-zA-Z0-9_-]/g, ''),
        kind: 'person',
      });
    }
    for (const person of availablePeople) {
      const shortNpub = shortMemberNpub(person.pubkey);
      const profileName = personProfileByPubkey.get(person.pubkey)?.name;
      options.set(person.pubkey, {
        pubkey: person.pubkey,
        name: person.pubkey === userPubkey ? 'You' : (profileName ?? shortNpub),
        handle: profileName
          ? personHandle(profileName, person.pubkey)
          : shortNpub.replace(/[^a-zA-Z0-9_-]/g, ''),
        kind: 'person',
      });
    }
    for (const agent of availableAgents) {
      const display = resolveAgentDisplayIdentity(agent.pubkey, agent);
      options.set(agent.pubkey, {
        pubkey: agent.pubkey,
        name: display.name,
        handle: display.handle,
        kind: 'agent',
        agent,
      });
    }
    // The snapshot membership selector is the Room roster authority. Workspace
    // People and Agent reads only enrich/classify those keys, and can be partial
    // or stale. Any member absent from both secondary reads remains visible as
    // a person-shaped identity instead of disappearing from the count.
    for (const member of roomMembers) {
      if (options.has(member.pubkey)) continue;
      const shortNpub = shortMemberNpub(member.pubkey);
      const profileName = personProfileByPubkey.get(member.pubkey)?.name;
      options.set(member.pubkey, {
        pubkey: member.pubkey,
        name: member.pubkey === userPubkey ? 'You' : (profileName ?? shortNpub),
        handle: profileName
          ? personHandle(profileName, member.pubkey)
          : shortNpub.replace(/[^a-zA-Z0-9_-]/g, ''),
        kind: 'person',
      });
    }
    return [...options.values()].sort((a, b) => {
      if (a.pubkey === userPubkey) return -1;
      if (b.pubkey === userPubkey) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [availableAgents, availablePeople, personProfileByPubkey, roomMembers, userPubkey]);
  const roomParticipants = useMemo(
    () =>
      selectedMembers.map((member) => {
        const known = memberOptions.find((option) => option.pubkey === member.pubkey);
        if (known) return known;
        const name = member.identity?.displayName ?? member.identity?.handle;
        return {
          pubkey: member.pubkey,
          name: member.pubkey === userPubkey ? 'You' : (name ?? shortMemberNpub(member.pubkey)),
          handle: name
            ? personHandle(name, member.pubkey)
            : shortMemberNpub(member.pubkey).replace(/[^a-zA-Z0-9_-]/g, ''),
          kind: member.kind === 'agent' ? 'agent' : 'person',
          ...(member.kind === 'agent' && agentByPubkey.get(member.pubkey)
            ? { agent: agentByPubkey.get(member.pubkey) }
            : {}),
        } satisfies RoomMemberOption;
      }),
    [agentByPubkey, memberOptions, selectedMembers, userPubkey],
  );
  const participantPickerOptions = useMemo(
    () =>
      participantPickerKind
        ? memberOptions.filter((option) => option.kind === participantPickerKind)
        : memberOptions,
    [memberOptions, participantPickerKind],
  );
  const participantPickerSections = useMemo(
    () => sectionRoomRoster(participantPickerOptions, roomMemberPubkeys),
    [participantPickerOptions, roomMemberPubkeys],
  );
  const visibleRosterSections = useMemo(
    () => sectionRoomParticipants(roomParticipants),
    [roomParticipants],
  );
  const roomParticipantTotal = roomParticipants.length;
  const roomAgents = useMemo(
    () => roomParticipants.filter((participant) => participant.kind === 'agent'),
    [roomParticipants],
  );
  // kind:30078 is the sole liveness truth. Transcript/activity events can
  // describe work, but they never mint or renew a presence lease.
  const agentPresences = heartbeatPresences;
  const onlineAgentCount = roomAgents.filter((agent) =>
    isAgentPresenceOnlineWithReconnectGrace(
      agentPresences[agent.pubkey],
      presenceNow,
      presenceReconnectGrace[agent.pubkey],
    ),
  ).length;
  // One flat liveness verdict per agent pubkey for the transcript's byline
  // rings. renderItem previously read the three raw inputs directly, so every
  // heartbeat and every streamed batch recreated the callback and rebuilt
  // every visible ledger row; a boolean record only changes identity through
  // `useStable` when a verdict genuinely flips.
  const speakerPresenceKeys = useMemo(
    () => [
      ...new Set([
        ...roomAgents.map((agent) => agent.pubkey),
        ...Object.keys(agentPresences),
        ...Object.keys(presenceReconnectGrace),
        ...agentByPubkey.keys(),
      ]),
    ],
    [agentByPubkey, agentPresences, presenceReconnectGrace, roomAgents],
  );
  const rawSpeakerOnline = useMemo(
    () => onlineVerdicts(agentPresences, speakerPresenceKeys, presenceNow, presenceReconnectGrace),
    [agentPresences, presenceNow, presenceReconnectGrace, speakerPresenceKeys],
  );
  const speakerOnline = useStable(rawSpeakerOnline, shallowEqualRecord);
  const knownAgentPresenceCount = roomAgents.filter((agent) => agentPresences[agent.pubkey]).length;
  const agentsOffline = isAgentOfflineAfterPresenceResolved(
    presenceResolved,
    roomAgents.length,
    knownAgentPresenceCount,
    onlineAgentCount,
  );
  const roomMemberByPubkey = useMemo(
    () =>
      new Map<string, (typeof roomMembers)[number]>(
        roomMembers.map((member) => [member.pubkey, member]),
      ),
    [roomMembers],
  );
  const viewerRoomRole = normalizedRoomRole(roomMemberByPubkey.get(userPubkey));
  const lifecycleAction = roomLifecycleAction(viewerRoomRole);
  const mentionableAgents = useMemo(
    () =>
      activeMentionCandidates(
        roomParticipants
          .filter((participant) => participant.kind === 'agent')
          .map((participant) => ({
            pubkey: participant.pubkey,
            name: participant.name,
            handle: participant.handle,
          })),
        agentPresences,
        presenceNow,
      ),
    [roomParticipants, agentPresences, presenceNow],
  );
  const activeMention = useMemo(
    () =>
      !parentChannelId && inputSelection.start === inputSelection.end
        ? activeMentionAtCursor(inputText, inputSelection.start)
        : null,
    [inputSelection.end, inputSelection.start, inputText, parentChannelId],
  );
  const mentionMenuKey = activeMention
    ? `${inputText}:${activeMention.start}:${activeMention.end}`
    : null;
  const mentionSuggestions = useMemo(
    () =>
      activeMention
        ? filterMentionCandidates(
            activeMentionCandidates(roomParticipants, agentPresences, presenceNow),
            activeMention.query,
          )
        : { matches: [], overflow: 0 },
    [activeMention, roomParticipants, agentPresences, presenceNow],
  );
  const mentionMenuVisible = Boolean(
    composerFocused &&
    mentionMenuKey &&
    mentionMenuKey !== dismissedMentionKey &&
    mentionSuggestions.matches.length > 0,
  );
  // The latest signed lifecycle receipt is server-indexed. Draft/thought
  // overlays carry content only and can neither start nor extend a turn.
  const agentTurnMarkers = useMemo(
    () => roomSurface?.latestAgentTurns ?? [],
    [roomSurface?.latestAgentTurns],
  );
  const activeAgentTurn = useMemo(
    () =>
      agentTurnMarkers.find((turn) =>
        isAgentTurnActive(
          turn,
          agentPresences[turn.agentPubkey],
          presenceNow,
          presenceReconnectGrace[turn.agentPubkey],
        ),
      ),
    [agentTurnMarkers, agentPresences, presenceNow, presenceReconnectGrace],
  );
  const messages = unprojectedMessages;
  const isDirectMessage = Boolean(directMessage);
  const currentSlashQuery = useMemo(() => slashVerbQuery(inputText), [inputText]);
  // Mention-scoped palette: `@agent /query` addresses THAT agent's advertised
  // commands. Mutually exclusive with `currentSlashQuery` by shape — the plain
  // path requires the WHOLE composer to be one slash token.
  const mentionSlash = useMemo(() => agentMentionSlashQuery(inputText), [inputText]);
  const mentionSlashAgentPubkey = useMemo(() => {
    if (!mentionSlash) return null;
    const needle = mentionSlash.mention.toLowerCase();
    const match = mentionableAgents.find(
      (agent) => agent.handle?.toLowerCase() === needle || agent.name.toLowerCase() === needle,
    );
    return match?.pubkey ?? null;
  }, [mentionSlash, mentionableAgents]);
  const mentionAgentCommandScope = mentionSlashAgentPubkey
    ? `${decodedId}:${mentionSlashAgentPubkey}`
    : null;
  const mentionAgentCommands = useMemo(() => {
    if (!mentionSlash || !mentionAgentCommandScope) return [];
    const published = agentCommandsByScope[mentionAgentCommandScope];
    return (published?.commands ?? []).filter((command) =>
      matchesAgentCommand(command, mentionSlash.query),
    );
  }, [agentCommandsByScope, mentionAgentCommandScope, mentionSlash]);
  // True only once the read RESOLVED (absent or empty list): an in-flight or
  // failed read is unknown, never "does not advertise".
  const mentionAgentLacksCommands = Boolean(
    mentionSlash &&
    mentionSlashAgentPubkey &&
    mentionAgentCommandScope &&
    agentCommandsByScope[mentionAgentCommandScope] !== undefined &&
    (agentCommandsByScope[mentionAgentCommandScope]?.commands.length ?? 0) === 0,
  );
  const pendingCornerRequest = useMemo(() => {
    for (let index = combinedMessages.length - 1; index >= 0; index -= 1) {
      const message = combinedMessages[index];
      if (
        message.writePermission?.status === 'pending' &&
        message.writePermission.repository &&
        message.writePermission.purpose !== 'squire-spending'
      ) {
        return message;
      }
    }
    return undefined;
  }, [combinedMessages]);
  const pendingTargetBranchProposal = useMemo(() => {
    for (let index = combinedMessages.length - 1; index >= 0; index -= 1) {
      const message = combinedMessages[index];
      if (
        message.targetBranchProposal &&
        roomRepository?.targetBranch !== message.targetBranchProposal.to
      ) {
        return message;
      }
    }
    return undefined;
  }, [combinedMessages, roomRepository?.targetBranch]);
  const slashVerbs = useMemo(
    () =>
      availableSlashVerbs(
        {
          canOpenCorner: Boolean(!isCorner && !viewerIsAgent && pendingCornerRequest),
          canCloseCorner: isCorner && !viewerIsAgent,
          canApprove: Boolean(
            isCorner && !viewerIsAgent && mergeTarget && approvalState === 'none',
          ),
          canChangeTargetBranch: Boolean(
            !isCorner &&
            !viewerIsAgent &&
            canManageRoomRepository(viewerChannelRole) &&
            pendingTargetBranchProposal &&
            !targetBranchActionId,
          ),
          canAddAgent: Boolean(!isCorner && !isDirectMessage && !viewerIsAgent),
          canInvitePerson: Boolean(!isCorner && !isDirectMessage && !viewerIsAgent),
        },
        currentSlashQuery ?? '',
      ),
    [
      approvalState,
      currentSlashQuery,
      isCorner,
      isDirectMessage,
      mergeTarget,
      pendingCornerRequest,
      pendingTargetBranchProposal,
      targetBranchActionId,
      viewerChannelRole,
      viewerIsAgent,
    ],
  );
  const slashMenuVisible = Boolean(
    composerFocused &&
    (currentSlashQuery !== null || (mentionSlash !== null && mentionSlashAgentPubkey !== null)) &&
    dismissedSlashText !== inputText,
  );
  const paletteItemCount = mentionAgentCommands.length + slashVerbs.length;
  useEffect(() => {
    setHighlightedSlashVerbIndex(0);
  }, [currentSlashQuery, mentionSlash?.query, paletteItemCount]);
  // Load the addressed agent's published command list on demand — the palette
  // renders ONLY from this published record, never a hardcoded inventory. A
  // failed read stays unknown and never blocks typing.
  useEffect(() => {
    const pubkey = mentionSlashAgentPubkey;
    const scope = mentionAgentCommandScope;
    if (!pubkey || !scope || !transport) return;
    if (agentCommandsByScope[scope] !== undefined) return;
    let cancelled = false;
    transport
      .agentCommandsRead(decodedId, pubkey, activeCommunityId ?? undefined)
      .then((list) => {
        if (!cancelled) {
          setAgentCommandsByScope((current) => ({ ...current, [scope]: list }));
        }
      })
      .catch(() => {
        // A transport failure is not evidence that no record exists. Keep the
        // scope unresolved so the palette never makes a false absence claim.
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeCommunityId,
    agentCommandsByScope,
    decodedId,
    mentionAgentCommandScope,
    mentionSlashAgentPubkey,
    transport,
  ]);
  // `null` means "show a skeleton": the channel kind or its name is still
  // resolving and no honest word exists yet. A corner never renders the Room
  // label as a stand-in for its own slug.
  // The parent Room's STORED name, for a corner's `#<room>/<corner>` header.
  // Read from the same Room-list cache the reference resolver uses — never a
  // second index. `undefined` = not a corner; `null` = corner whose parent
  // name has not landed yet (the header degrades to `#<corner>`, it does not
  // block on another read).
  const parentRoomName = useMemo(() => {
    if (!parentChannelId) return undefined;
    const parent = roomSurface?.parent;
    return parent?.name?.trim() ? parent.name : null;
  }, [parentChannelId, roomSurface?.parent]);
  const headerTitle = channelHeaderTitle(
    resolvedChannelName,
    isCorner ? 'corner' : channelKind,
    decodedId,
    {
      directMessage: isDirectMessage,
      parentRoomName,
    },
  );
  // Room-lifecycle copy ("Delete <name>?"), rename drafts, and cache writes
  // use the STORED name — the `#` mark is display-only and must never leak
  // into a mutation path. The header renders through `headerTitle` instead.
  const roomName = headerTitle ?? ROOM_LABEL;
  const storedRoomName = resolvedChannelName?.trim() || ROOM_LABEL;
  // A DM's title is its peer's identity. Derived from cached state rather
  // than resolved inside the enter-room fetch chain, so it is right on the
  // first painted frame of a warm cache instead of several relay reads later.
  // Deliberately not `directMessagePeer`, which throws when the viewer is not
  // a participant — a throw here would be a render-time crash, not a bad title.
  const dmPeerPubkey = userPubkey
    ? directMessage?.participants.find((pubkey) => pubkey !== userPubkey)
    : undefined;
  const dmPeerProfile = dmPeerPubkey ? personProfileByPubkey.get(dmPeerPubkey) : undefined;
  const dmPeerNip05Status = useVerifiedNip05Status(
    dmPeerPubkey ?? '',
    dmPeerProfile ? { nip05: undefined } : undefined,
  );
  const displayRoomName = useMemo(() => {
    if (!dmPeerPubkey) return roomName;
    const peerAgent = agentByPubkey.get(dmPeerPubkey);
    if (peerAgent) return resolveAgentDisplayIdentity(dmPeerPubkey, peerAgent).name;
    return personIdentityLabel(dmPeerProfile, dmPeerPubkey, dmPeerNip05Status);
  }, [agentByPubkey, dmPeerNip05Status, dmPeerProfile, dmPeerPubkey, roomName]);
  // The header's own title still distinguishes "not resolved yet" (`null` —
  // render the skeleton) from a resolved name. A DM is resolved as soon as its
  // peer is known, which the cached roster usually already answers.
  const displayHeaderTitle = dmPeerPubkey ? displayRoomName : headerTitle;
  const emptyLedgerVariant: EmptyLedgerVariant = isCorner
    ? 'corner'
    : isDirectMessage
      ? 'dm'
      : 'room';
  const composerPlaceholder = isCorner
    ? `Steer this ${CORNER_LABEL}…`
    : isDirectMessage
      ? `Message ${displayRoomName}…`
      : `Start this ${ROOM_LABEL}…`;
  const focusComposer = useCallback(() => {
    requestAnimationFrame(() => composerRef.current?.focus());
  }, []);
  const canonicalCorner = isCorner
    ? cornerLifecycle.find((corner) => corner.id === decodedId)
    : undefined;
  const canonicalCornerStatus = canonicalCorner
    ? currentCornerStatus(canonicalCorner, cornerStateNow)
    : cornerLifecycleStatus;
  const sessionState = !isCorner
    ? 'idle'
    : canonicalCorner?.machineState === 'working' && canonicalCornerStatus === 'live'
      ? 'working'
      : canonicalCorner?.machineState === 'concluded' || canonicalCorner?.machineState === 'closed'
        ? 'done'
        : 'idle';

  // A notification may outlive the corner it names. Once relay truth says the
  // target disappeared or finished, replace it with the parent Room carried by
  // the push instead of stranding the reader on an empty/read-only transcript.
  useEffect(() => {
    const fallbackId = notificationFallbackChannelId?.trim();
    if (
      !notificationResponseId ||
      !fallbackId ||
      fallbackId === decodedId ||
      handledNotificationFallbackRef.current === notificationResponseId
    ) {
      return;
    }
    const targetFinished =
      canonicalCornerStatus === 'merged' ||
      canonicalCornerStatus === 'archived' ||
      (isCorner && isArchived);
    const targetMissing =
      isCorner && roomSurface?.room.id === decodedId && roomSurface.parent === undefined;
    if (!targetMissing && !targetFinished) return;
    handledNotificationFallbackRef.current = notificationResponseId;
    router.replace({
      pathname: '/buzz/chat/[channelId]',
      params: { channelId: fallbackId, notificationResponseId },
    });
  }, [
    canonicalCornerStatus,
    decodedId,
    isArchived,
    isCorner,
    notificationFallbackChannelId,
    notificationResponseId,
    roomSurface,
  ]);

  const cornerAgentPubkey = useMemo(
    () => resolveCornerViewAgentPubkey(messages, (pubkey) => agentByPubkey.has(pubkey)),
    [agentByPubkey, messages],
  );
  const cornerAgentDisplay = cornerAgentPubkey
    ? resolvePendingAgentDisplay(
        cornerAgentPubkey,
        agentByPubkey.get(cornerAgentPubkey),
        participantsHydrated,
      )
    : undefined;
  const cornerAgentOnline = Boolean(
    cornerAgentPubkey &&
    isAgentPresenceOnlineWithReconnectGrace(
      agentPresences[cornerAgentPubkey],
      presenceNow,
      presenceReconnectGrace[cornerAgentPubkey],
    ),
  );
  const visibleMessages = messages;
  // Attribution is per run, not per entry: only the first entry of a voice's
  // run carries its mark and name (see `buzz/ledger-attribution.ts`). Corners
  // attribute exactly like Rooms — several people can sit in one corner, so
  // bare turns are indistinguishable there too.
  const rawContinuedAttributionIds = useMemo(
    () =>
      new Set(
        continuedSpeakerIds(
          visibleMessages.map((message) => ({
            id: message.id,
            speaker: ledgerSpeakerKey(message, knownAgentPubkeysFor(agentByPubkey)),
            // A collapsed tool/thought run is mechanism, not prose: it may fold
            // into the voice above it, but the prose below it must re-announce
            // (its byline was never allowed to be spent on the tool block).
            isMachine: message.isAgentActivity,
          })),
        ),
      ),
    [agentByPubkey, visibleMessages],
  );
  // renderItem consumes this set; preserve its identity across commits that
  // did not change any run boundary so rows are not rebuilt for nothing.
  const continuedAttributionIds = useStable(rawContinuedAttributionIds, sameStringSet);
  // Newest-first for the inverted FlatList; chronological visibleMessages
  // above stays the source of truth for everything else that reads order.
  const invertedMessages = useMemo(() => [...visibleMessages].reverse(), [visibleMessages]);
  // Reveal the exact fact that caused the alert. Fresh messages usually land
  // in the cached tail; if the target is already resident outside the initial
  // window, widen the window first and scroll on the next render. An approval
  // targets the corner's review footer at inverted-list offset zero.
  useEffect(() => {
    if (!notificationResponseId) return;
    const anchorKey = `${notificationResponseId}:${notificationMessageId ?? notificationApprovalId ?? notificationTarget ?? ''}`;
    if (handledNotificationAnchorRef.current === anchorKey) return;

    if (notificationTarget === 'approval') {
      if (!isCorner || !mergeTarget) return;
      requestAnimationFrame(() =>
        flatListRef.current?.scrollToOffset({ offset: 0, animated: false }),
      );
      handledNotificationAnchorRef.current = anchorKey;
      return;
    }

    const messageId = notificationMessageId?.trim();
    if (!messageId) return;
    const visibleIndex = invertedMessages.findIndex(
      (message) => message.id === messageId || message.relayId === messageId,
    );
    if (visibleIndex >= 0) {
      requestAnimationFrame(() =>
        flatListRef.current?.scrollToIndex({
          index: visibleIndex,
          viewPosition: 0.5,
          animated: false,
        }),
      );
      handledNotificationAnchorRef.current = anchorKey;
      return;
    }
    const residentIndex = combinedMessages.findIndex(
      (message) => message.id === messageId || message.relayId === messageId,
    );
    if (residentIndex >= 0) {
      const rowsFromNewest = combinedMessages.length - residentIndex;
      setVisibleMessageCount((count) => Math.max(count, rowsFromNewest));
    }
  }, [
    combinedMessages,
    invertedMessages,
    isCorner,
    mergeTarget,
    notificationApprovalId,
    notificationMessageId,
    notificationResponseId,
    notificationTarget,
  ]);
  // A reconciled draft/final bubble keeps a stable display `id` across the
  // turn, so it also needs to resolve by its real relay event id — the id
  // any NIP-10 reply on another client actually references.
  const rawVisibleMessageById = useMemo(() => {
    const map = new Map<string, ChatDisplayMessage>();
    for (const message of visibleMessages) {
      map.set(message.id, message);
      if (message.relayId) map.set(message.relayId, message);
    }
    return map;
  }, [visibleMessages]);
  const visibleMessageById = useStable(rawVisibleMessageById, sameMessageRefMap);
  const rawImmediatelyPrecedingVisibleMessageById = useMemo(() => {
    const map = new Map<string, ChatDisplayMessage>();
    for (let index = 1; index < visibleMessages.length; index += 1) {
      map.set(visibleMessages[index].id, visibleMessages[index - 1]);
    }
    return map;
  }, [visibleMessages]);
  const immediatelyPrecedingVisibleMessageById = useStable(
    rawImmediatelyPrecedingVisibleMessageById,
    sameMessageRefMap,
  );
  // The one corner the pinned line may name: open, not terminal in *any*
  // source, and chosen by how much it is being worked on. `null` for a Room
  // with no live corner, however busy its agent is right now.
  const pinnedCorner = useMemo(() => {
    return selectPinnedCorner({ lifecycle: cornerLifecycle, now: cornerStateNow });
  }, [cornerLifecycle, cornerStateNow]);
  const pinnedCornerCard = useMemo(
    () =>
      pinnedCorner
        ? [...messages]
            .reverse()
            .find((message) => message.corner?.subchannelId === pinnedCorner.cornerId)
        : undefined,
    [messages, pinnedCorner],
  );
  // displayedCornerStatus is a one-time snapshot fetched at mount; isArchived
  // is kept live by several independent update paths (live archive signal,
  // revalidated cache, fresh isChannelArchived check). A confirmed archive
  // that resolves after mount must never leave this badge showing a stale
  // non-terminal status.
  const displayedCornerStatus = useMemo(
    () => resolveCornerLifecycleStatus(canonicalCornerStatus, isArchived),
    [canonicalCornerStatus, isArchived],
  );
  // The corner action area's card, from the SAME verdict the deck golds. One
  // derivation (`corner-attention.ts`); the screen renders the answer and
  // never re-reads raw status tags. This screen IS the corner when isCorner,
  // so only the review branch may render here — the attention card is scoped
  // to non-corner summary surfaces (the deck row and pinned bar already route
  // needs-you INTO this screen via their canonical affordances); inside
  // the corner the state is an accessible-only circle and the ask itself lives
  // in the transcript.
  const cornerAction = useMemo(
    () =>
      cornerActionSurface({
        status: displayedCornerStatus,
        hasMergeTarget: Boolean(mergeTarget),
        archived: isArchived,
        messages,
        mergeNotReadyReason,
      }),
    [displayedCornerStatus, isArchived, mergeTarget, mergeNotReadyReason, messages],
  );
  /**
   * The pinned corner line's whole state, resolved in one place so the words it
   * shows and the corner a tap on it opens can never disagree.
   *
   * One line, and it names the two facts that matter: who owns the corner, and
   * what state it's in — `beebee active: feat/ux-fix-now` while working,
   * `beebee ready for review: feat/ux-fix-now` once there's a change to
   * approve. Both surfaces get one, because both have the same question to
   * answer: a Room asks "is there an open corner, and what does it need," a
   * Corner asks "is this session still moving."
   *
   * Its input is corner state and nothing else. A Room turn in progress is a
   * different fact about a different object and drives `turnProgressLabel`
   * below — see `buzz/room-indicators.ts` for why the two are kept apart by
   * construction rather than by care.
   */
  const cornerLiveBar = useMemo((): { label: string; live: boolean; cornerId?: string } | null => {
    const named = (subject: string, verb: string, target?: string) =>
      target ? `${subject} ${verb}: ${target}` : `${subject} ${verb}`;

    if (isCorner) {
      const subject = cornerAgentDisplay?.name ?? 'agent';
      // The branch is the truest name for what a corner is doing; the corner's
      // own slug is the fallback, and both beat an opaque id.
      const target = mergeTarget?.branch ?? headerTitle ?? undefined;
      // This corner's own canonical WORKING lease, not an ACP turn/draft or
      // some other corner's history. The lease expires at the shared horizon.
      if (sessionState === 'working')
        return { label: named(subject, 'active', target), live: true };
      if (displayedCornerStatus === 'open') {
        return { label: named(subject, 'ready for review', target), live: false };
      }
      if (displayedCornerStatus === 'needs-attention' || displayedCornerStatus === 'failed') {
        return { label: named(subject, 'needs attention', target), live: false };
      }
      return null;
    }

    // selectPinnedCorner names any open corner — working, waiting on a
    // human, or review-ready — and excludes only a terminal one. The line's
    // mere presence means "open," not "live"; gold and the breathing pulse
    // are reserved for a fresh canonical WORKING lease. Presence is displayed
    // separately and cannot rewrite this lifecycle.
    if (!pinnedCorner) return null;
    const agentPubkey = resolveCornerCardAgentPubkey(
      pinnedCornerCard?.corner?.agentPubkey,
      pinnedCornerCard?.pubkey,
      (pubkey) => agentByPubkey.has(pubkey),
    );
    const subject = agentPubkey
      ? resolveAgentDisplayIdentity(agentPubkey, agentByPubkey.get(agentPubkey)).name
      : 'agent';
    // The channel-mark convention: a corner names itself `#<room>/<corner>`,
    // composed from stored names at render time. Before this Room's own name
    // has resolved the line still marks the corner alone rather than blocking.
    const lifecycleCorner = cornerLifecycle.find((corner) => corner.id === pinnedCorner.cornerId);
    const target = displayCornerTitle(
      resolvedChannelName?.trim() || undefined,
      lifecycleCorner?.name,
      pinnedCorner.cornerId,
    );
    const live = isPinnedCornerLive(pinnedCorner.status);
    const verb = isPinnedCornerReadyForReview(pinnedCorner.status)
      ? 'ready for review'
      : live
        ? 'active'
        : 'needs attention';
    return {
      label: named(subject, verb, target),
      live,
      cornerId: pinnedCorner.cornerId,
    };
  }, [
    agentByPubkey,
    cornerAgentDisplay,
    cornerLifecycle,
    displayedCornerStatus,
    headerTitle,
    isCorner,
    mergeTarget,
    pinnedCorner,
    pinnedCornerCard,
    resolvedChannelName,
    sessionState,
  ]);

  /**
   * The ordinary turn indicator, and the only thing a plain question in a Room
   * ever lights: "beebee thinking…" while the reply is being composed, gone
   * when it lands. Its input is the Room's own `#t=agent-turn` lifecycle and
   * nothing else — no corner reaches it, exactly as no turn reaches the corner
   * line above.
   *
   * A Corner uses the same signed turn proof as a Room. Its separate
   * canonical Corner lease still owns the pinned Corner bar, but cannot hide a
   * channel-local reply that is visibly streaming now.
   */
  const turnProgressLabel = useMemo(() => {
    const pubkey = selectTurnProgressAgentPubkey({
      isCorner,
      agentsOffline,
      ...(activeAgentTurn?.agentPubkey ? { activeTurnPubkey: activeAgentTurn.agentPubkey } : {}),
    });
    if (!pubkey) return null;
    const subject = resolveAgentDisplayIdentity(pubkey, agentByPubkey.get(pubkey)).name;
    return `${subject} thinking…`;
  }, [activeAgentTurn, agentByPubkey, agentsOffline, isCorner]);

  const activeActivityId = useMemo(() => {
    const latest = [...visibleMessages].reverse().find((message) => message.isAgentLiveTurn);
    return !isArchived && latest ? latest.id : undefined;
  }, [isArchived, visibleMessages]);

  useEffect(() => {
    setApprovalError(null);
    setApprovalState('none');
    setApprovalAcked(false);
  }, [mergeTarget?.tip]);

  useEffect(() => {
    if (canonicalCorner?.machineState !== 'working' || canonicalCorner.stateAt === undefined)
      return;
    const deadline = canonicalCorner.stateAt * 1_000 + CORNER_ACTIVITY_FRESHNESS_MS;
    const delay = deadline - Date.now() + 1;
    if (delay <= 0) {
      setCornerStateNow(Date.now());
      return;
    }
    const timer = setTimeout(() => setCornerStateNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [canonicalCorner?.machineState, canonicalCorner?.stateAt]);

  useEffect(() => {
    // Presence only changes at a lease/dormancy deadline. A five-second clock here
    // recreated FlatList's renderItem (and every visible message) while someone
    // was typing, which made the foreground intermittently unresponsive.
    const now = Date.now();
    const presenceDeadline = nextAgentPresenceTransitionAt(agentPresences, now);
    const turnDeadline = nextAgentTurnExpiryAt(agentTurnMarkers, now);
    const deadline =
      presenceDeadline === undefined
        ? turnDeadline
        : turnDeadline === undefined
          ? presenceDeadline
          : Math.min(presenceDeadline, turnDeadline);
    if (deadline === undefined) return;
    const delay = Math.max(1, deadline - now + 1);
    const timer = setTimeout(() => setPresenceNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [agentPresences, agentTurnMarkers, presenceNow]);

  const applyAgentPresence = useCallback((presence: RoomAgentPresence | undefined) => {
    if (!presence) return;
    setAgentPresences((current) => {
      const next = mergeAgentPresence(current, presence);
      agentPresencesRef.current = next;
      return next;
    });
    setPresenceReconnectGrace((current) => {
      if (current[presence.agentPubkey] === undefined) return current;
      const next = { ...current };
      delete next[presence.agentPubkey];
      presenceReconnectGraceRef.current = next;
      return next;
    });
    setPresenceNow(Date.now());
  }, []);

  useEffect(() => {
    setHighlightedMentionIndex(0);
  }, [mentionMenuKey]);

  useEffect(() => {
    if (!decodedId) return;

    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    let appStateSubscription: ReturnType<typeof AppState.addEventListener> | undefined;
    let scheduler: SurfaceRefreshScheduler<RoomView> | undefined;
    let decoder: LiveOverlayDecoder | undefined;
    let pendingOverlayEvents: Parameters<LiveOverlayDecoder['decode']>[0][] = [];
    let watchGeneration = 0;
    let watchKey = '';
    let hasPainted = false;

    agentPresencesRef.current = {};
    presenceReconnectGraceRef.current = {};
    setAgentPresences({});
    setPresenceReconnectGrace({});
    setPresenceResolved(false);
    setLiveOverlays([]);
    reconciledRoomViewRef.current = null;
    roomMessageProjector.reset();
    hasMoreHistoryRef.current = true;
    setOlderPages([]);
    clearOptimistic();
    setFailedOutboxIds(new Set());
    setVisibleMessageCount(INITIAL_MESSAGE_WINDOW);
    setTranscriptHydrationFailed(false);
    setTranscriptHydrationError(null);

    const applyDecodedOverlay = (overlay: LiveOverlay) => {
      setLiveOverlays((current) => applyLiveOverlay(current, overlay));
      if (overlay.kind === 'presence') {
        applyAgentPresence({
          agentPubkey: overlay.agentPubkey,
          status: overlay.status,
          observedAt: overlay.createdAt * 1_000,
        });
      }
    };

    const applyView = (
      view: RoomView,
      identityPubkey: string,
      relayUrl: string,
      fresh: boolean,
    ) => {
      if (cancelled) return;
      const stableView = reconcileRoomView(reconciledRoomViewRef.current, view);
      reconciledRoomViewRef.current = stableView;
      hasPainted = true;
      setRoomSurface(stableView);
      setTranscriptHydrationFailed(false);
      setTranscriptHydrationError(null);
      void Promise.all([
        saveActiveCommunityId(identityPubkey, stableView.room.workspaceId),
        saveLastViewedChannel(identityPubkey, stableView.room.workspaceId, decodedId),
      ]).catch(() => undefined);

      const presences = Object.fromEntries(
        stableView.members.flatMap((member) =>
          member.presence
            ? [
                [
                  member.identity.pubkey,
                  {
                    agentPubkey: member.identity.pubkey,
                    status: member.presence.status,
                    observedAt: member.presence.observedAt * 1_000,
                  },
                ],
              ]
            : [],
        ),
      );
      // The HTTP response and the live overlay are two observations of the
      // same replaceable record. A refetch must not erase a newer heartbeat
      // that arrived while the request was in flight.
      const mergedPresences = mergeAgentPresenceBatch(
        agentPresencesRef.current,
        Object.values(presences),
      );
      agentPresencesRef.current = mergedPresences;
      setAgentPresences(mergedPresences);
      setPresenceResolved(true);
      setPresenceNow(Date.now());

      setCornerStateNow(Date.now());
      mergeTargetTipRef.current =
        stableView.review?.status === 'ready' ? (stableView.review.artifact?.tip ?? null) : null;

      decoder = new LiveOverlayDecoder(
        decodedId,
        new Set(
          stableView.members
            .filter((member) => member.identity.kind === 'agent')
            .map((member) => member.identity.pubkey),
        ),
        new Set([
          decodedId,
          ...(stableView.parent ? [stableView.parent.id] : []),
          ...stableView.corners.map((corner) => corner.corner.id),
        ]),
      );
      const replayedOverlays = pendingOverlayEvents;
      pendingOverlayEvents = [];
      for (const event of replayedOverlays) {
        const overlay = decoder.decode(event);
        if (overlay) applyDecodedOverlay(overlay);
      }
      const authoritativeIds = new Set(stableView.messages.map((message) => message.id));
      void outboxRef.current?.reconcile(authoritativeIds);
      setFailedOutboxIds((current) => {
        const next = new Set([...current].filter((id) => !authoritativeIds.has(id)));
        return next.size === current.size ? current : next;
      });
      for (const id of authoritativeIds) {
        const timer = outboxConfirmationTimersRef.current.get(id);
        if (timer) clearTimeout(timer);
        outboxConfirmationTimersRef.current.delete(id);
      }

      if (fresh) {
        void mobileSurfaceCache.write(
          surfaceAddress(relayUrl, identityPubkey, `/room/${decodedId}`),
          stableView,
          isRoomView,
        );
      }

      const nextWatchKey = JSON.stringify(stableView.watchFilters);
      if (fresh && nextWatchKey !== watchKey) {
        void installWatch(stableView.watchFilters);
      }
    };

    const installWatch = async (filters: RoomView['watchFilters']): Promise<void> => {
      const generation = ++watchGeneration;
      watchKey = JSON.stringify(filters);
      const currentTransport = transportForEffect;
      if (!currentTransport) return;
      const client = await currentTransport.ensureClient();
      let replaying = true;
      const stop = await client.surfaceSubscribe(filters, (event) => {
        if (cancelled || generation !== watchGeneration) return;
        if (!decoder && event.kind === KIND_AGENT_DRAFT) {
          // The initial replay can contain the currently replaceable draft
          // before the Room response supplies its authorized agent roster.
          // Keep only this bounded live-lane input, then verify/decode it once
          // the response arrives; durable events still only mark dirty.
          pendingOverlayEvents = [...pendingOverlayEvents.slice(-63), event];
          return;
        }
        const overlay = decoder?.decode(event);
        if (overlay) {
          applyDecodedOverlay(overlay);
          return;
        }
        // Stored rows delivered before EOSE are covered by the closing GET.
        // Treating that initial replay as fresh invalidation creates a second
        // physical cold-open request for no new state.
        if (replaying) return;
        // Durable relay records carry no client truth. A match does exactly
        // one thing: mark this surface dirty for a whole-response refresh.
        scheduler?.signal();
      });
      replaying = false;
      if (cancelled || generation !== watchGeneration) {
        stop();
        return;
      }
      unsubscribe?.();
      unsubscribe = stop;
    };

    let transportForEffect: BuzzRigTransport | undefined;
    void (async () => {
      try {
        const identity = await loadBuzzIdentity();
        if (!identity) {
          router.replace('/buzz/onboarding');
          return;
        }
        if (cancelled) return;
        setUserPubkey(identity.publicKey);

        const relayUrl = await getEffectiveRelayUrl();
        if (cancelled) return;
        const nextTransport = new BuzzRigTransport(identity, relayUrl);
        const nextRoomClient = new RoomViewClient({
          baseUrl: relayUrl,
          identity,
          onPhysicalRequest: ({ method, path }) => {
            console.warn(`[room-surface] physical-request ${method} ${path}`);
          },
        });
        transportForEffect = nextTransport;
        setTransport(nextTransport);
        setRoomClient(nextRoomClient);

        const outbox = createRoomOutbox(identity, decodedId);
        outboxRef.current = outbox;
        await outbox.restore();
        if (cancelled) return;
        const restored = outbox
          .list()
          .map((record) => displayRoomMessages([record.row], identity.publicKey)[0]!);
        if (restored.length) addMessages(restored);
        setFailedOutboxIds(
          new Set(
            outbox
              .list()
              .filter((record) => record.status === 'failed')
              .map((record) => record.event.id),
          ),
        );
        for (const record of outbox.list().filter((record) => record.status === 'pending')) {
          await outbox.attempted(record.event.id);
          void nextTransport.publishPreparedMessage(record.event).then(
            () => {
              roomSchedulerRef.current?.signal();
              const timer = setTimeout(() => {
                const active = outboxRef.current?.get(record.event.id);
                if (!active || active.status !== 'pending') return;
                void outboxRef.current?.fail(record.event.id);
                setFailedOutboxIds((current) => new Set(current).add(record.event.id));
              }, OUTBOX_CONFIRMATION_TIMEOUT_MS);
              outboxConfirmationTimersRef.current.set(record.event.id, timer);
            },
            () => {
              void outbox.fail(record.event.id);
              setFailedOutboxIds((current) => new Set(current).add(record.event.id));
            },
          );
        }

        const address = surfaceAddress(relayUrl, identity.publicKey, `/room/${decodedId}`);
        const cached = await mobileSurfaceCache.read(address, isRoomView);
        if (cached && !cancelled) applyView(cached, identity.publicKey, relayUrl, false);

        scheduler = new SurfaceRefreshScheduler({
          fetch: () => nextRoomClient.room(decodedId),
          apply: (view) => applyView(view, identity.publicKey, relayUrl, true),
          onError: (error) => {
            if (cancelled) return;
            const terminal =
              error instanceof RoomViewHttpError &&
              (error.status === 401 ||
                error.status === 403 ||
                error.status === 404 ||
                error.status === 502);
            if (terminal) {
              setRoomSurface(null);
              setLiveOverlays([]);
              unsubscribe?.();
              unsubscribe = undefined;
              void mobileSurfaceCache.remove(address);
            }
            if (terminal || !hasPainted) {
              setTranscriptHydrationFailed(true);
              setTranscriptHydrationError(
                error instanceof RoomViewHttpError && error.code === 'invalid_surface_response'
                  ? 'The server returned an invalid Room response.'
                  : `Could not load this conversation. ${String(error)}`,
              );
            } else {
              setTranscriptHydrationError(
                `Offline — showing the last saved response. ${String(error)}`,
              );
            }
          },
        });
        roomSchedulerRef.current = scheduler;

        const initialFilters = cached?.watchFilters ?? [{ '#h': [decodedId] }];
        await scheduler.startAfter(installWatch(initialFilters));

        appStateSubscription = AppState.addEventListener('change', (state) => {
          if (state === 'active') scheduler?.force();
        });
      } catch (error) {
        if (cancelled) return;
        setTranscriptHydrationFailed(true);
        setTranscriptHydrationError(`Could not open this ${ROOM_LABEL}. ${String(error)}`);
      }
    })();

    return () => {
      cancelled = true;
      watchGeneration += 1;
      scheduler?.dispose();
      appStateSubscription?.remove();
      unsubscribe?.();
      for (const timer of outboxConfirmationTimersRef.current.values()) clearTimeout(timer);
      outboxConfirmationTimersRef.current.clear();
      outboxRef.current = null;
      roomSchedulerRef.current = null;
      reconciledRoomViewRef.current = null;
    };
  }, [
    addMessages,
    applyAgentPresence,
    clearOptimistic,
    decodedId,
    notificationResponseId,
    roomMessageProjector,
    transcriptHydrationAttempt,
  ]);
  /**
   * Who said an inherited Room line. Room context is quoted *from a Room*, so
   * it keeps its attribution even though the corner around it never shows
   * handles — a corner's zero-handle rule is about its own single agent, and
   * these lines are neither the corner's agent nor this reader.
   */
  const roomContextSpeakerLabel = useCallback(
    (pubkey: string | undefined, isAgent: boolean): string | undefined => {
      if (!pubkey) return undefined;
      const knownAgent = agentByPubkey.get(pubkey);
      if (isAgent || knownAgent || BODY_PUBKEYS.has(pubkey)) {
        return resolvePendingAgentDisplay(pubkey, knownAgent, participantsHydrated)?.name;
      }
      return personProfileByPubkey.get(pubkey)?.name ?? shortMemberNpub(pubkey);
    },
    [agentByPubkey, participantsHydrated, personProfileByPubkey],
  );

  const replyTargetForMessage = useCallback(
    (message: ChatDisplayMessage): MessageReplyDisplayTarget => {
      const knownAgent = message.pubkey ? agentByPubkey.get(message.pubkey) : undefined;
      const isAgent = Boolean(
        message.pubkey &&
        (message.isAgentAuthor ||
          message.isAgentActivity ||
          BODY_PUBKEYS.has(message.pubkey) ||
          knownAgent),
      );
      const agentDisplay = isAgent
        ? resolveAgentDisplayIdentity(message.pubkey ?? 'unknown-agent', knownAgent)
        : undefined;
      const personName = message.pubkey
        ? personProfileByPubkey.get(message.pubkey)?.name
        : undefined;
      const attachmentPreview = message.attachments?.[0]?.name;
      return {
        // A reconciled draft/final bubble's display `id` is a synthetic
        // per-turn key. The composer separately obtains the opaque threading
        // proof from the snapshot using this real relay id.
        messageId: message.relayId ?? message.id,
        authorName: message.isUser
          ? 'You'
          : (agentDisplay?.name ?? personName ?? shortMemberNpub(message.pubkey ?? '')),
        ...(message.pubkey ? { authorPubkey: message.pubkey } : {}),
        isAgent,
        preview: message.text.trim() || attachmentPreview || 'Attachment',
      };
    },
    [agentByPubkey, personProfileByPubkey],
  );

  const beginReply = useCallback(
    (message: ChatDisplayMessage) => {
      const install = (reference: KnownMessageReference) => {
        setReplyTarget({ ...replyTargetForMessage(message), reference });
        setDismissedMentionKey(null);
        void Haptics.selectionAsync();
        requestAnimationFrame(() => composerRef.current?.focus());
      };
      if (message.reference?.channelId === decodedId) install(message.reference);
    },
    [decodedId, replyTargetForMessage],
  );

  const markOutboxFailed = useCallback(async (eventId: string) => {
    await outboxRef.current?.fail(eventId);
    setFailedOutboxIds((current) => new Set(current).add(eventId));
  }, []);

  const scheduleOutboxConfirmation = useCallback(
    (eventId: string) => {
      const previous = outboxConfirmationTimersRef.current.get(eventId);
      if (previous) clearTimeout(previous);
      const timer = setTimeout(() => {
        const record = outboxRef.current?.get(eventId);
        if (!record || record.status !== 'pending') return;
        void markOutboxFailed(eventId);
      }, OUTBOX_CONFIRMATION_TIMEOUT_MS);
      outboxConfirmationTimersRef.current.set(eventId, timer);
    },
    [markOutboxFailed],
  );

  const retryOutboxMessage = useCallback(
    (eventId: string, retryTransport: BuzzRigTransport | null = transport) => {
      const outbox = outboxRef.current;
      const record = outbox?.get(eventId);
      if (!outbox || !record || !retryTransport) return;
      void (async () => {
        await outbox.retry(eventId);
        setFailedOutboxIds((current) => {
          const next = new Set(current);
          next.delete(eventId);
          return next;
        });
        try {
          await retryTransport.publishPreparedMessage(record.event);
          roomSchedulerRef.current?.signal();
          scheduleOutboxConfirmation(eventId);
        } catch {
          await markOutboxFailed(eventId);
        }
      })();
    },
    [markOutboxFailed, scheduleOutboxConfirmation, transport],
  );

  const dismissOutboxMessage = useCallback(
    (eventId: string) => {
      const timer = outboxConfirmationTimersRef.current.get(eventId);
      if (timer) clearTimeout(timer);
      outboxConfirmationTimersRef.current.delete(eventId);
      void outboxRef.current?.remove(eventId);
      setFailedOutboxIds((current) => {
        const next = new Set(current);
        next.delete(eventId);
        return next;
      });
      removeOptimistic(eventId);
    },
    [removeOptimistic],
  );

  const handleSend = useCallback(async () => {
    const rawText = inputTextRef.current.trim();
    // State updates are committed asynchronously. A ref closes the short
    // double-tap window before `sending` can disable the native control.
    if (sendInFlightRef.current || (!rawText && !pendingAttachment) || isArchived) return;
    // The daemon already refuses corner-open on a repo-less Room; this is the
    // friendly client-side path — catch the common phrasing before the
    // message is sent (and the composer text lost) rather than after a
    // doomed round-trip.
    if (
      !isCorner &&
      ((!roomRepository && roomRepositoryResolved) || roomRepoAccessIssue) &&
      looksLikeCornerOpenIntent(rawText)
    ) {
      setCornerOpenRepoPrompt(true);
      if (activeCommunityId && roomRepoCandidates.length === 0 && transport) {
        void transport
          .workspaceGitHubAccess({ refresh: true })
          .then((access) => {
            setRoomRepoCandidates(access.candidates);
            setGitHubInstallations(access.installations);
          })
          .catch(() => undefined);
      }
      return;
    }
    const text = replyTarget ? replyMessageText(rawText, replyTarget) : rawText;
    const mentionedPubkeys = resolveComposerMentions(
      text,
      roomParticipants,
      selectedMentionsRef.current,
    ).pubkeys;

    sendInFlightRef.current = true;
    setSending(true);
    let preparedEvent: Awaited<ReturnType<BuzzRigTransport['composeMessage']>> | undefined;
    let preparedTransport: BuzzRigTransport | undefined;
    try {
      // A warm/partial snapshot can paint before the hydration effect has
      // published its transport state. Sending is still a valid operation:
      // construct the shared authenticated transport on demand rather than
      // leaving the enabled send control as a silent no-op.
      let sendTransport = transport;
      if (!sendTransport) {
        const identity = await loadBuzzIdentity();
        if (!identity) throw new Error('Beeline identity is unavailable');
        sendTransport = new BuzzRigTransport(identity, await getEffectiveRelayUrl());
      }
      if (!transport) setTransport(sendTransport);
      preparedTransport = sendTransport;
      const attachments = pendingAttachment
        ? [await uploadChatAttachment(await sendTransport.ensureClient(), pendingAttachment)]
        : [];
      const selectedMentionedAgent = selectedMentionAgentPubkey(
        text,
        selectedAgentMentionsRef.current,
      );
      const mentionedAgent = replyTarget?.isAgent
        ? replyTarget.authorPubkey
        : parentChannelId
          ? undefined
          : (selectedMentionedAgent ?? mentionedAgentPubkey(text, mentionableAgents));
      // Sign before append. The authoritative event id is the optimistic row
      // identity and the durable outbox key from its first frame onward.
      preparedEvent = replyTarget
        ? await sendTransport.composeReplyMessage(
            text,
            replyTarget.reference,
            mentionedAgent,
            attachments,
            mentionedPubkeys,
          )
        : await sendTransport.composeMessage(
            { sessionId: decodedId, text, attachments },
            mentionedAgent || mentionedPubkeys.length
              ? {
                  ...(mentionedAgent ? { mentionAgent: mentionedAgent } : {}),
                  ...(mentionedPubkeys.length ? { mentionPubkeys: mentionedPubkeys } : {}),
                }
              : undefined,
          );
      const optimistic = {
        id: preparedEvent.id,
        text,
        isUser: true,
        timestamp: preparedEvent.created_at,
        pubkey: userPubkey,
        reference: undefined,
        ...(mentionedPubkeys.length ? { mentionPubkeys: mentionedPubkeys } : {}),
        ...(replyTarget ? { replyToId: replyTarget.reference.eventId } : {}),
        ...(attachments.length ? { attachments } : {}),
      } satisfies ChatDisplayMessage;
      const outbox = outboxRef.current;
      if (!outbox) throw new Error('Message outbox is unavailable');
      await outbox.enqueue(preparedEvent, {
        id: preparedEvent.id,
        text,
        createdAt: preparedEvent.created_at,
        author: roomSurface?.viewer.identity ?? {
          pubkey: userPubkey,
          kind: 'human',
          name: 'You',
        },
        presentation: 'message',
        ...(mentionedPubkeys.length ? { mentionPubkeys: mentionedPubkeys } : {}),
        ...(attachments.length ? { attachments } : {}),
      });
      addMessages([optimistic]);
      inputTextRef.current = '';
      setInputText('');
      setComposerHeight(COMPOSER_MIN_HEIGHT);
      setInputSelection({ start: 0, end: 0 });
      setPendingAttachment(null);
      setReplyTarget(null);
      await outbox.attempted(preparedEvent.id);
      await sendTransport.publishPreparedMessage(preparedEvent);
      roomSchedulerRef.current?.signal();
      scheduleOutboxConfirmation(preparedEvent.id);
    } catch (err) {
      console.warn('Send failed:', err);
      if (preparedEvent) await markOutboxFailed(preparedEvent.id);
      const failure = publishFailurePresentation(err);
      Modal.alert(
        'Message not sent',
        failure.message,
        failure.retryable
          ? [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Retry',
                onPress: () => {
                  if (!preparedEvent || !preparedTransport) return;
                  retryOutboxMessage(preparedEvent.id, preparedTransport);
                },
              },
            ]
          : [{ text: 'OK' }],
      );
    } finally {
      sendInFlightRef.current = false;
      setSending(false);
    }
  }, [
    activeCommunityId,
    pendingAttachment,
    transport,
    decodedId,
    addMessages,
    isArchived,
    isCorner,
    userPubkey,
    parentChannelId,
    mentionableAgents,
    roomParticipants,
    cacheViewerPubkey,
    replyTarget,
    agentsOffline,
    roomRepoCandidates.length,
    roomRepository,
    cornerAgentPubkey,
    agentPresences,
    presenceNow,
    presenceResolved,
    presenceReconnectGrace,
    agentByPubkey,
    roomRepositoryResolved,
    roomRepoAccessIssue,
    roomSurface,
  ]);

  const pickPhoto = useCallback(async () => {
    if (Platform.OS === 'ios') {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (permission.status !== 'granted') {
        Modal.alert('Photo access needed', 'Allow photo access to attach an image.');
        return;
      }
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: false,
      quality: 1,
      exif: false,
    });
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset) return;
    setPendingAttachment({
      uri: asset.uri,
      name: asset.fileName?.trim() || `photo-${Date.now()}.jpg`,
      mimeType: asset.mimeType ?? 'image/jpeg',
      size: asset.fileSize ?? 0,
      width: asset.width,
      height: asset.height,
    });
  }, []);

  const pickDocument = useCallback(async () => {
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: false,
      type: '*/*',
    });
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset) return;
    setPendingAttachment({
      uri: asset.uri,
      name: asset.name?.trim() || `file-${Date.now()}`,
      mimeType: asset.mimeType ?? 'application/octet-stream',
      size: asset.size ?? 0,
    });
  }, []);

  const chooseAttachment = useCallback(() => {
    setAttachmentPickerVisible(true);
  }, []);

  const selectMention = useCallback(
    (participant: RoomMemberOption) => {
      if (!activeMention) return;
      const inserted = replaceActiveMention(
        inputTextRef.current,
        activeMention,
        participant.handle,
      );
      if (participant.kind === 'agent') {
        selectedAgentMentionsRef.current.set(participant.handle, participant.pubkey);
      }
      selectedMentionsRef.current.set(participant.handle, participant.pubkey);
      const nextSelection = { start: inserted.cursor, end: inserted.cursor };
      const completedMention = activeMentionAtCursor(inserted.text, inserted.cursor);
      inputTextRef.current = inserted.text;
      setInputText(inserted.text);
      setInputSelection((current) =>
        current.start === nextSelection.start && current.end === nextSelection.end
          ? current
          : nextSelection,
      );
      setDismissedMentionKey(
        completedMention
          ? `${inserted.text}:${completedMention.start}:${completedMention.end}`
          : null,
      );
      setHighlightedMentionIndex(0);
      requestAnimationFrame(() => {
        composerRef.current?.focus();
        // Normal Android typing owns its cursor. Set selection only for this
        // explicit replacement, after React has applied the new text.
        composerRef.current?.setNativeProps({ selection: nextSelection });
      });
      void Haptics.selectionAsync();
    },
    [activeMention],
  );

  const handleWritePermission = useCallback(
    async (message: ChatDisplayMessage, decision: 'allow' | 'deny') => {
      const permission = message.writePermission;
      if (
        !transport ||
        !permission ||
        !permission.repository ||
        permission.status !== 'pending' ||
        viewerIsAgent ||
        (permission.purpose === 'squire-spending' && viewerChannelRole !== 'owner')
      )
        return;
      setPermissionActionId(permission.permissionId);
      try {
        await transport.respondToWritePermission(
          decodedId,
          permission.permissionId,
          permission.requestId,
          permission.agentPubkey,
          decision,
          permission.repository,
        );
        void Haptics.notificationAsync(
          decision === 'allow'
            ? Haptics.NotificationFeedbackType.Success
            : Haptics.NotificationFeedbackType.Warning,
        );
      } catch (err) {
        console.warn('Write permission response failed:', err);
      } finally {
        setPermissionActionId(null);
      }
    },
    [cacheViewerPubkey, decodedId, transport, viewerChannelRole, viewerIsAgent],
  );

  /**
   * Confirm a proposed target-branch change.
   *
   * The republished Room→repository event is signed by THIS viewer, so a
   * non-admin is refused here with a plain sentence rather than being allowed
   * to publish an event every reader would silently ignore. The SDK
   * (`setRoomTargetBranch`) and every reader re-check the role independently —
   * this guard is the clear answer, not the boundary.
   */
  const handleConfirmTargetBranch = useCallback(
    async (message: ChatDisplayMessage) => {
      const proposal = message.targetBranchProposal;
      if (!transport || !proposal || targetBranchActionId) return;
      if (viewerIsAgent || viewerChannelRole !== 'owner') {
        setTargetBranchNotice({
          proposalId: proposal.proposalId,
          text: `Only the ${ROOM_LABEL} owner can change the target branch.`,
        });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        return;
      }
      setTargetBranchActionId(proposal.proposalId);
      setTargetBranchNotice(null);
      try {
        await transport.roomTargetBranchSet(decodedId, proposal.to);
        roomSchedulerRef.current?.force();
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (err) {
        setTargetBranchNotice({
          proposalId: proposal.proposalId,
          text: err instanceof Error ? err.message : String(err),
        });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      } finally {
        setTargetBranchActionId(null);
      }
    },
    [decodedId, targetBranchActionId, transport, viewerChannelRole, viewerIsAgent],
  );

  const handleAddRoomMember = useCallback(
    async (option: RoomMemberOption) => {
      if (
        !transport ||
        !activeCommunityId ||
        roomMemberPubkeys.has(option.pubkey) ||
        addingMemberPubkey
      )
        return;
      setAddingMemberPubkey(option.pubkey);
      setMembershipError(null);
      try {
        if (option.kind === 'agent') {
          await transport.inviteAgentToChannel(decodedId, option.pubkey, activeCommunityId);
        } else {
          await transport.inviteWorkspaceMemberToChannel(
            decodedId,
            option.pubkey,
            activeCommunityId,
          );
        }
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (err) {
        setMembershipError(`Could not add @${option.name}: ${String(err)}`);
      } finally {
        setAddingMemberPubkey(null);
      }
    },
    [activeCommunityId, addingMemberPubkey, decodedId, roomMemberPubkeys, transport],
  );

  const handleRemoveRoomMember = useCallback(
    async (participant: RoomMemberOption) => {
      const targetRole = normalizedRoomRole(roomMemberByPubkey.get(participant.pubkey));
      if (
        !transport ||
        !canRemoveRoomParticipant(viewerRoomRole, targetRole, participant.pubkey === userPubkey)
      )
        return;
      const confirmed = await Modal.confirm(
        `Remove ${participant.name}?`,
        `Their membership will be removed and this ${ROOM_LABEL} will disappear from their workspace list.`,
        { cancelText: 'Cancel', confirmText: 'Remove', destructive: true },
      );
      if (!confirmed) return;
      setMembershipActionPubkey(participant.pubkey);
      setMembershipError(null);
      void transport
        .removeRoomMember(decodedId, participant.pubkey)
        .then(() => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        })
        .catch((err) => {
          setMembershipError(`Could not remove ${participant.name}: ${String(err)}`);
        })
        .finally(() => setMembershipActionPubkey(null));
    },
    [decodedId, roomMemberByPubkey, transport, userPubkey, viewerRoomRole],
  );

  const returnToRoomList = useCallback(() => {
    setRosterVisible(false);
    setRoomActionsVisible(false);
    router.replace({
      pathname: '/buzz/channels',
      ...(activeCommunityId ? { params: { communityId: activeCommunityId } } : {}),
    });
  }, [activeCommunityId]);

  const handleRoomLifecycle = useCallback(async () => {
    if (!transport || !lifecycleAction || roomLifecycleBusy) return;
    const deleting = lifecycleAction === 'delete';
    const confirmed = await Modal.confirm(
      deleting ? `Delete ${displayRoomName}?` : `Leave ${displayRoomName}?`,
      deleting
        ? `This ${ROOM_LABEL} and its workspace data will be permanently deleted.`
        : `You will lose access to this ${ROOM_LABEL}. Other members will keep their access.`,
      {
        cancelText: 'Cancel',
        confirmText: deleting ? `Delete ${ROOM_LABEL}` : `Leave ${ROOM_LABEL}`,
        destructive: true,
      },
    );
    if (!confirmed) return;
    setRoomLifecycleBusy(true);
    setMembershipError(null);
    const operation = deleting ? transport.deleteRoom(decodedId) : transport.leaveRoom(decodedId);
    void operation
      .then(() => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        returnToRoomList();
      })
      .catch((err) => {
        setMembershipError(
          `Could not ${deleting ? 'delete' : 'leave'} ${ROOM_LABEL}: ${String(err)}`,
        );
      })
      .finally(() => setRoomLifecycleBusy(false));
  }, [
    decodedId,
    displayRoomName,
    lifecycleAction,
    returnToRoomList,
    roomLifecycleBusy,
    transport,
    userPubkey,
  ]);

  const handleRenameRoom = useCallback(async () => {
    const name = renameDraft.trim();
    if (!name) {
      setRenameError(`${ROOM_LABEL} name cannot be empty.`);
      return;
    }
    if (!transport || !canRenameRoom(viewerChannelRole) || renameBusy) return;

    setRenameBusy(true);
    setRenameError(null);
    try {
      const client = await transport.ensureClient();
      await client.renameChannel(decodedId, name);
      roomSchedulerRef.current?.force();
      setRenameEditing(false);
      setRoomActionsVisible(false);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      setRenameError(`Could not rename ${ROOM_LABEL}: ${String(err)}`);
    } finally {
      setRenameBusy(false);
    }
  }, [decodedId, renameBusy, renameDraft, transport, viewerChannelRole]);

  const loadRoomRepoPicker = useCallback(
    async (refresh = false) => {
      if (!transport || !activeCommunityId) return;
      try {
        const access = await transport.workspaceGitHubAccess({ refresh });
        setRoomRepoCandidates(access.candidates);
        setGitHubInstallations(access.installations);
      } catch (error) {
        if (refresh) throw error;
        setRoomRepoCandidates(await transport.workspaceRoomRepositoryCandidates(activeCommunityId));
        setGitHubInstallations([]);
      }
    },
    [activeCommunityId, transport],
  );

  const handleRepositoryRefreshPhase = useCallback(
    (phase: Parameters<typeof githubRepositoryRefreshFeedback>[0]) => {
      const feedback = githubRepositoryRefreshFeedback(phase);
      setRoomRepoNotice(feedback.notice);
      setRoomRepoError(feedback.error);
    },
    [],
  );

  const handleToggleRoomRepoPicker = useCallback(async () => {
    setShowRoomRepoPicker((value) => !value);
    if (showRoomRepoPicker || !transport || !activeCommunityId) return;
    setRoomRepoError(null);
    try {
      await loadRoomRepoPicker(true);
    } catch (err) {
      setRoomRepoError(`Could not load repos: ${String(err)}`);
    }
  }, [activeCommunityId, loadRoomRepoPicker, showRoomRepoPicker, transport]);

  const handleAddGitHubAccount = useCallback(async () => {
    if (!transport) return;
    setRoomRepoError(null);
    setRoomRepoNotice(null);
    try {
      await runGitHubInstallationSession({
        returnPath: `/buzz/chat/${encodeURIComponent(decodedId)}`,
        startInstallation: () => transport.githubInstallationStart(githubInstallationRedirectUri()),
        openAuthSession: (installationUrl, redirectUri) =>
          WebBrowser.openAuthSessionAsync(
            installationUrl,
            redirectUri,
            authSessionOptions(Platform.OS, redirectUri),
          ),
        subscribeToUrls: (listener) => Linking.addEventListener('url', ({ url }) => listener(url)),
        subscribeToAppState: (listener) => AppState.addEventListener('change', listener),
        refreshRepositories: () => loadRoomRepoPicker(true),
        onRefreshPhase: handleRepositoryRefreshPhase,
      });
    } catch (err) {
      setRoomRepoError(`Could not connect GitHub: ${String(err)}`);
    }
  }, [decodedId, handleRepositoryRefreshPhase, loadRoomRepoPicker, transport]);

  const handleManageGitHubInstallation = useCallback(
    async (installation: GitHubInstallationAccess) => {
      if (!transport) return;
      setRoomRepoError(null);
      setRoomRepoNotice(null);
      try {
        await runGitHubInstallationSession({
          returnPath: `/buzz/chat/${encodeURIComponent(decodedId)}`,
          startInstallation: () =>
            transport.githubInstallationStart(
              githubInstallationRedirectUri(),
              installation.installationId,
            ),
          openAuthSession: (installationUrl, redirectUri) =>
            WebBrowser.openAuthSessionAsync(
              installationUrl,
              redirectUri,
              authSessionOptions(Platform.OS, redirectUri),
            ),
          subscribeToUrls: (listener) =>
            Linking.addEventListener('url', ({ url }) => listener(url)),
          subscribeToAppState: (listener) => AppState.addEventListener('change', listener),
          refreshRepositories: () => loadRoomRepoPicker(true),
          onRefreshPhase: handleRepositoryRefreshPhase,
        });
      } catch (err) {
        setRoomRepoError(`Could not connect GitHub: ${String(err)}`);
      }
    },
    [decodedId, handleRepositoryRefreshPhase, loadRoomRepoPicker, transport],
  );

  useEffect(() => {
    if (!transport || !activeCommunityId) return;
    void resumeInitialGitHubInstallation(() => Linking.getInitialURL())
      .then(async (completed) => {
        if (!completed) return;
        setShowRoomRepoPicker(true);
        await loadRoomRepoPicker(true);
      })
      .catch((err) => setRoomRepoError(`Could not connect GitHub: ${String(err)}`));
  }, [activeCommunityId, loadRoomRepoPicker, transport]);

  const applyRoomRepository = useCallback(
    async (input: RepoCandidate) => {
      if (!transport || !input.remote || roomRepoBusy) return;
      setRoomRepoBusy(true);
      setRoomRepoError(null);
      try {
        // A candidate without a connected installation may be a repository the
        // App never covered (an admin binding a repo whose OWNER has not
        // granted access). Probe the typed coverage state first: binding now
        // would only dead-end the daemon's token path later.
        if (!input.githubInstallationId) {
          const access = await transport.githubRepositoryAccess(input.name).catch(() => undefined);
          if (access && access.accessible === false && access.reason !== 'revoked') {
            uncoveredOwnersRef.current.add(input.name.split('/')[0]?.toLowerCase() ?? '');
            if (access.installUrl) {
              setOwnerGrant({ repository: input.name, installUrl: access.installUrl });
              return;
            }
          }
        }
        const published = await transport.roomRepositorySet(decodedId, {
          key: input.key,
          name: input.name,
          remote: input.remote,
          ...(input.githubInstallationId
            ? { githubInstallationId: input.githubInstallationId }
            : {}),
          ...(input.defaultBranch ? { targetBranch: input.defaultBranch } : {}),
          ...(activeCommunityId ? { communityId: activeCommunityId } : {}),
        });
        if (!roomClient) {
          throw new Error('The repo link was accepted but could not be confirmed. Try again.');
        }
        const confirmed = await roomClient.room(decodedId);
        if (
          confirmed.repositoryResolution !== 'repository' ||
          confirmed.repository?.key !== published.binding.key
        ) {
          throw new Error('The repo link was accepted but the Room did not confirm it. Try again.');
        }
        roomSchedulerRef.current?.force();
        setShowRoomRepoPicker(false);
        setCornerOpenRepoPrompt(false);
        setOwnerGrant(null);
      } catch (err) {
        setRoomRepoError(`Could not link repo: ${String(err)}`);
      } finally {
        setRoomRepoBusy(false);
      }
    },
    [activeCommunityId, decodedId, roomClient, roomRepoBusy, transport],
  );

  // The pasted repository's owner is not among this viewer's installations:
  // resolve the typed coverage state and share the owner's install link
  // instead of opening a connect flow that can never grant a foreign repo.
  const handleAskOwnerGrant = useCallback(
    async (fullName: string) => {
      if (!transport) return;
      setOwnerGrant(null);
      const access = await transport.githubRepositoryAccess(fullName).catch(() => undefined);
      uncoveredOwnersRef.current.add(fullName.split('/')[0]?.toLowerCase() ?? '');
      if (access?.installUrl) {
        setOwnerGrant({ repository: fullName, installUrl: access.installUrl });
        void Share.share({
          message: ownerGrantShareMessage({ repository: fullName, installUrl: access.installUrl }),
        });
        return;
      }
      setRoomRepoNotice(
        access?.accessible
          ? `${fullName} is already available below.`
          : `Could not confirm GitHub coverage for ${fullName}. Try again once the owner has installed the app.`,
      );
    },
    [transport],
  );

  const handleCreateGitHubRepository = useCallback(
    async (installationId: number, name: string) => {
      if (!transport) return;
      setRoomRepoError(null);
      try {
        const candidate = await transport.githubRepositoryCreate({
          installationId,
          name,
          private: true,
        });
        setRoomRepoCandidates((current) => [...current, candidate]);
        await applyRoomRepository(candidate);
      } catch (err) {
        setRoomRepoError(`Could not create repo: ${String(err)}`);
        throw err;
      }
    },
    [applyRoomRepository, transport],
  );

  // Changing the repo under a Room with open corners strands those corners on
  // the old repo, so re-binding is confirmed like the other destructive Room
  // actions (delete/leave) above, and skipped when there is nothing to strand.
  const handleSelectRoomRepoCandidate = useCallback(
    (candidate: RepoCandidate) => {
      const hasOpenCorners = roomListCorners(cornerLifecycle).length > 0;
      if (roomRepository && hasOpenCorners) {
        void Modal.confirm(
          `Change ${ROOM_LABEL} repo?`,
          `This ${ROOM_LABEL} has ${CORNER_LABEL}s still open on ${roomRepository.binding.name}. Changing the repo will not move them — they stay bound to the old repo.`,
          { cancelText: 'Cancel', confirmText: 'Change anyway', destructive: true },
        ).then((confirmed) => {
          if (confirmed) void applyRoomRepository(candidate);
        });
        return;
      }
      void applyRoomRepository(candidate);
    },
    [applyRoomRepository, cornerLifecycle, roomRepository],
  );

  /** Toggle ambient GitHub repository activity (stars/issues/PRs) for this Room. */
  const handleToggleGitHubEvents = useCallback(async () => {
    if (!transport || !roomRepository || roomRepoBusy) return;
    const nextEnabled = roomRepository.githubEventsEnabled === false; // off → on
    setRoomRepoBusy(true);
    setRoomRepoError(null);
    try {
      await transport.roomGitHubEventsSet(decodedId, nextEnabled);
      roomSchedulerRef.current?.force();
    } catch {
      setRoomRepoError('Could not change repository activity settings.');
    } finally {
      setRoomRepoBusy(false);
    }
  }, [decodedId, roomRepoBusy, roomRepository, transport]);

  const handleReconnectRoomRepository = useCallback(async () => {
    if (!roomRepoAccessIssue || !transport) return;
    setRoomRepoError(null);
    setRoomRepoNotice('Refreshing repositories…');
    let candidates: RepoCandidate[];
    let installations: GitHubInstallationAccess[];
    try {
      const access = await transport.workspaceGitHubAccess({ refresh: true });
      candidates = access.candidates;
      installations = access.installations;
      setRoomRepoCandidates(candidates);
      setGitHubInstallations(installations);
      setRoomRepoNotice(null);
    } catch {
      setRoomRepoNotice(null);
      setRoomRepoError('Could not refresh repositories. Return to Beeline and try again.');
      return;
    }
    const plan = githubRepositoryLinkagePlan(
      roomRepoAccessIssue.fullName,
      candidates,
      installations,
    );
    if (plan.kind === 'available') {
      setRoomRepoAccessIssue(null);
      setCornerOpenRepoPrompt(false);
      return;
    }
    const confirmed = await Modal.confirm(
      'Choose repositories on GitHub',
      GITHUB_REPOSITORY_SELECTION_INSTRUCTION,
      { cancelText: 'Cancel', confirmText: 'Continue to GitHub' },
    );
    if (!confirmed) return;
    if (plan.kind === 'manage') void handleManageGitHubInstallation(plan.installation);
    else void handleAddGitHubAccount();
  }, [handleAddGitHubAccount, handleManageGitHubInstallation, roomRepoAccessIssue, transport]);

  const handleStartDirectMessage = useCallback(
    async (option: RoomMemberOption) => {
      if (!transport || !activeCommunityId || option.pubkey === userPubkey) return;
      setAddingMemberPubkey(option.pubkey);
      setMembershipError(null);
      try {
        const { channelId: dmChannelId } = await transport.resolveDirectMessage(
          activeCommunityId,
          option.pubkey,
        );
        setParticipantPickerVisible(false);
        router.push(`/buzz/chat/${encodeURIComponent(dmChannelId)}` as Href);
      } catch (err) {
        setMembershipError(`Could not message @${option.name}: ${String(err)}`);
      } finally {
        setAddingMemberPubkey(null);
      }
    },
    [activeCommunityId, transport, userPubkey],
  );

  /**
   * Leave this transcript. A corner returns to its explicit opening surface
   * when one was supplied; otherwise it resolves its parent Room by id. See
   * `corner-navigation.ts` for why the route directly underneath cannot always
   * be trusted. A lone transcript replaces itself with the Room list instead
   * of calling a `router.back()` that silently does nothing.
   */
  const handleBack = useCallback(() => {
    const routes = (navigation.getState()?.routes ?? []) as ChatStackRoute[];
    const action = chatBackAction(routes, parentChannelId, cornerReturnTarget);
    if (action.type === 'pop') router.dismiss(action.count);
    // The parent Room was never on this stack (for example, a notification
    // cold start or an older link without an origin hint). Open it here rather
    // than popping into whatever happens to be underneath.
    else if (action.type === 'open-room') router.replace(roomHref(action.channelId));
    else if (action.type === 'back') router.back();
    else router.replace('/buzz/channels');
  }, [cornerReturnTarget, navigation, parentChannelId]);

  const handleCloseCorner = useCallback(async () => {
    // `if (!transport) return` — the shape this replaces — made every press a
    // SILENT no-op until the screen had connected, and permanently if that
    // ever failed. The screen paints from cache, so the button is on screen
    // well before `transport` exists: pressing it did nothing, said nothing,
    // and published nothing, which is exactly what the captain saw (a corner
    // with zero `buzz-corner-close` events on the relay after many presses).
    // A control the reader can see must either act or explain itself.
    if (!transport) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Modal.alert(
        `Not connected yet`,
        `This ${CORNER_LABEL} could not be closed because the app is still connecting to the relay. Try again in a moment.`,
      );
      return;
    }
    try {
      await transport.closeCorner(decodedId);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      handleBack();
    } catch (err) {
      console.warn('Close corner failed:', err);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Modal.alert('Could not close corner', err instanceof Error ? err.message : String(err));
    }
  }, [decodedId, handleBack, transport]);

  // An approval that was accepted by the relay but never acknowledged by the
  // daemon resolves ITSELF here. The signed approval stays on the relay and a
  // reconnecting daemon will honor it — the message says exactly that, so an
  // approval can never hang silently again (the 2026-08-23 live defect).
  useEffect(() => {
    if (approvalState !== 'sent' || approvalAcked) return;
    const timer = setTimeout(() => {
      setApprovalState((current) => (current === 'sent' ? 'timeout' : current));
      setApprovalError(approvalTimeoutMessage());
    }, APPROVAL_ACK_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [approvalState, approvalAcked]);

  const handleApprove = useCallback(async () => {
    if (!transport || !mergeTarget) return;
    setApprovalState('sending');
    setApprovalError(null);
    try {
      const result = await transport.submitMergeApproval(decodedId, mergeTarget);
      if (!result.success)
        throw new Error(result.message ?? 'Approval was not accepted by the relay');
      setApprovalAcked(false);
      setApprovalState('sent');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      console.warn('Approval failed:', err);
      setApprovalState('none');
      setApprovalError(err instanceof Error ? err.message : String(err));
    }
  }, [transport, mergeTarget, decodedId]);

  const handleCommunitySelect = useCallback((communityId: string | null) => {
    if (!communityId) return;
    router.replace({
      pathname: '/buzz/channels',
      params: { communityId },
    });
  }, []);

  const openCorner = useCallback(
    (subchannelId: string) => {
      if (subchannelId === decodedId) return;
      router.push(cornerHref(subchannelId, decodedId));
    },
    [decodedId],
  );

  const clearSlashComposer = useCallback(() => {
    inputTextRef.current = '';
    setInputText('');
    setInputSelection({ start: 0, end: 0 });
    setComposerHeight(COMPOSER_MIN_HEIGHT);
    setDismissedSlashText(null);
    setHighlightedSlashVerbIndex(0);
    requestAnimationFrame(() => composerRef.current?.focus());
  }, []);

  const dismissSlashMenu = useCallback(() => {
    clearSlashComposer();
    void Haptics.selectionAsync();
  }, [clearSlashComposer]);

  /**
   * Insert a selected agent command in place of the typed `/query` token,
   * KEEPING the @mention that scoped the palette. The trailing space closes
   * the palette and leaves the composer ready for the command's arguments.
   */
  const insertAgentCommand = useCallback(
    (name: string) => {
      const next = inputText.replace(/\/[a-z0-9-]*$/i, `/${name} `);
      inputTextRef.current = next;
      setInputText(next);
      setInputSelection({ start: next.length, end: next.length });
      setComposerHeight(COMPOSER_MIN_HEIGHT);
      void Haptics.selectionAsync();
    },
    [inputText],
  );

  const runSlashVerb = useCallback(
    (verb: BuiltInSlashVerbId) => {
      clearSlashComposer();
      void Haptics.selectionAsync();
      switch (verb) {
        case 'open-corner':
          if (pendingCornerRequest) void handleWritePermission(pendingCornerRequest, 'allow');
          return;
        case 'close-corner':
          void handleCloseCorner();
          return;
        case 'approve':
          void handleApprove();
          return;
        case 'change-target-branch':
          if (pendingTargetBranchProposal) {
            void handleConfirmTargetBranch(pendingTargetBranchProposal);
          }
          return;
        case 'add-agent':
          setMembershipError(null);
          setParticipantPickerKind('agent');
          setParticipantPickerVisible(true);
          return;
        case 'invite':
          setMembershipError(null);
          setParticipantPickerKind('person');
          setParticipantPickerVisible(true);
      }
    },
    [
      clearSlashComposer,
      handleApprove,
      handleCloseCorner,
      handleConfirmTargetBranch,
      handleWritePermission,
      pendingCornerRequest,
      pendingTargetBranchProposal,
    ],
  );

  /** Select whatever the highlight points at across commands-then-verbs. */
  const selectHighlightedPaletteItem = useCallback(() => {
    const commandIndex = highlightedSlashVerbIndex - mentionAgentCommands.length;
    if (commandIndex < 0) {
      const command = mentionAgentCommands[highlightedSlashVerbIndex];
      if (command) {
        insertAgentCommand(command.name);
        return;
      }
    } else {
      const verb = slashVerbs[commandIndex];
      if (verb) {
        runSlashVerb(verb.id);
        return;
      }
    }
    // No match at all: Enter/the send button passes the text through as an
    // ordinary message instead of dying as a dead end. The daemon visibly
    // marks such text on the other side.
    handleSend();
  }, [
    handleSend,
    highlightedSlashVerbIndex,
    insertAgentCommand,
    inputText,
    mentionAgentCommands,
    runSlashVerb,
    slashVerbs,
  ]);

  const renderMessage = useCallback(
    (
      item: ChatDisplayMessage,
      {
        continued: attributionContinued,
        immediatelyPrecedingMessage,
        referencedMessage,
      }: {
        continued: boolean;
        immediatelyPrecedingMessage?: ChatDisplayMessage;
        referencedMessage?: ChatDisplayMessage;
      },
    ) => {
      if (item.roomUpdate) {
        return (
          <LedgerRoomUpdate
            id={item.id}
            line={item.text}
            stamp={ledgerStamp(item.timestamp)}
            digest={item.roomUpdate.digest}
          />
        );
      }

      if (item.writePermission) {
        const permission = item.writePermission;
        const squireSpending = permission.purpose === 'squire-spending';
        const permissionAgent = agentByPubkey.get(permission.agentPubkey);
        const display = resolveAgentDisplayIdentity(permission.agentPubkey, permissionAgent);
        const pending = permission.status === 'pending';
        const busy = permissionActionId === permission.permissionId;
        // An ALLOW that opened a corner is the same live state the pinned bar
        // above the composer now reports, so it prints nothing here — the
        // request card that preceded it is already the durable record of the
        // decision, and repeating it as a scroll note gave the reader two
        // places to look for one fact.
        if (permission.status === 'allowed' && permission.subchannelId) return null;
        return (
          <HullSurface
            strength="raised"
            style={styles.writePermissionCard}
            testID={`write-permission-${permission.status}`}
          >
            <View style={styles.writePermissionHeading}>
              <IdentityMark
                kind="agent"
                seed={display.avatarSeed ?? permission.agentPubkey}
                avatarUrl={display.avatarUrl}
                name={display.name}
                size={30}
              />
              <View style={styles.writePermissionCopy}>
                <Text style={styles.writePermissionTitle}>
                  {squireSpending
                    ? `${display.name} requests owner confirmation`
                    : permission.repository
                      ? `${display.name} requests a new edit corner`
                      : `${display.name} needs to change repository files`}
                </Text>
                <Text style={styles.writePermissionIntent} numberOfLines={2}>
                  {describeWriteRequest(permission.tool)}
                </Text>
              </View>
            </View>
            {permission.repository && !squireSpending && (
              <Text style={styles.writePermissionRepository} testID="write-permission-repository">
                EDIT CORNER ON {permission.repository}
              </Text>
            )}
            <Text style={styles.writePermissionBoundary}>
              {squireSpending
                ? 'Trusty Squire stays in its vault-backed process. Only the Room owner can confirm this spending or checkout-capable action.'
                : permission.repository
                  ? `The write is refused here. Allowing grants isolated edit access to exactly ${permission.repository}; merge authority stays human-only.`
                  : 'This write request is missing its repository target and cannot be allowed.'}
            </Text>
            {permission.status === 'failed' && (
              <Text style={styles.writePermissionFailure}>
                The requested edit could not start. This Room remains read-only.
              </Text>
            )}
            {pending &&
            !viewerIsAgent &&
            permission.repository &&
            (!squireSpending || viewerChannelRole === 'owner') ? (
              <View style={styles.writePermissionActions}>
                <MonoButton
                  label="Deny"
                  variant="secondary"
                  disabled={busy}
                  onPress={() => void handleWritePermission(item, 'deny')}
                  style={styles.writePermissionButton}
                />
                <MonoButton
                  label={squireSpending ? 'Confirm Squire action' : 'Open edit corner'}
                  loading={busy}
                  onPress={() => void handleWritePermission(item, 'allow')}
                  style={styles.writePermissionButton}
                />
              </View>
            ) : pending && !viewerIsAgent && squireSpending ? (
              <Text style={styles.writePermissionStatus}>ROOM OWNER CONFIRMATION REQUIRED</Text>
            ) : pending && !viewerIsAgent ? (
              <Text style={styles.writePermissionStatus}>MISSING TARGET · CANNOT APPROVE</Text>
            ) : (
              <WritePermissionOutcome
                status={permission.status}
                subchannelId={permission.subchannelId}
                awaitingPerson={viewerIsAgent && pending}
              />
            )}
          </HullSurface>
        );
      }

      if (item.targetBranchProposal) {
        const proposal = item.targetBranchProposal;
        const applied = roomRepository?.targetBranch === proposal.to;
        const busy = targetBranchActionId === proposal.proposalId;
        const notice =
          targetBranchNotice?.proposalId === proposal.proposalId ? targetBranchNotice.text : null;
        const canConfirm = !viewerIsAgent && viewerChannelRole === 'owner';
        return (
          <HullSurface
            strength="raised"
            style={styles.targetBranchCard}
            testID="target-branch-proposal"
          >
            <Text style={styles.targetBranchTitle}>Change this {ROOM_LABEL}’s target branch</Text>
            <Text style={styles.targetBranchChange} testID="target-branch-change">
              {proposal.from} → {proposal.to}
            </Text>
            <Text style={styles.targetBranchBoundary}>
              {`Confirming republishes this ${ROOM_LABEL}'s repository binding under your key. ` +
                `${CORNER_LABEL}s already open automatically rebase onto ${proposal.to}; any conflict appears in their activity ledger for the agent to resolve.`}
            </Text>
            {applied ? (
              <Text style={styles.targetBranchStatus} testID="target-branch-applied">
                ✓ TARGET BRANCH IS NOW {proposal.to.toUpperCase()}
              </Text>
            ) : canConfirm ? (
              <View style={styles.targetBranchActions}>
                <MonoButton
                  label={`Confirm ${proposal.to}`}
                  loading={busy}
                  disabled={busy}
                  onPress={() => void handleConfirmTargetBranch(item)}
                  style={styles.targetBranchButton}
                  testID="target-branch-confirm"
                />
              </View>
            ) : (
              <Text style={styles.targetBranchStatus} testID="target-branch-denied">
                {`ONLY THE ${ROOM_LABEL.toUpperCase()} OWNER CAN CONFIRM THIS`}
              </Text>
            )}
            {notice ? (
              <Text style={styles.targetBranchStatus} testID="target-branch-notice">
                {notice}
              </Text>
            ) : null}
          </HullSurface>
        );
      }

      if (item.corner) {
        return null;
      }

      if (item.githubEvent) {
        const event = item.githubEvent;
        const title =
          event.type === 'pull-request'
            ? event.action === 'opened'
              ? `${event.actor} created a new PR: ${event.title}`
              : event.action === 'merged'
                ? `${event.actor} merged a PR: ${event.title}`
                : `${event.actor} closed a PR: ${event.title}`
            : event.action === 'opened'
              ? `${event.actor} created a new issue: ${event.title}`
              : `${event.actor} closed an issue: ${event.title}`;
        return (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={title}
            onPress={() => void Linking.openURL(event.url).catch(() => undefined)}
            style={styles.githubEventPressable}
            testID={`github-event-card-${event.type}-${event.action}`}
          >
            <HullSurface strength="raised" style={styles.githubEventCard}>
              <Text style={styles.githubEventTitle}>{title}</Text>
              <Text style={styles.githubEventLink}>VIEW ON GITHUB ↗</Text>
            </HullSurface>
          </Pressable>
        );
      }

      // ── Archived notice ──────────────────────────────────────────
      if (item.isArchivedNotice) {
        return (
          <View style={styles.archivedBubble}>
            <Text style={styles.archivedText}>□ CORNER ARCHIVED · READ-ONLY</Text>
          </View>
        );
      }

      // ── Offline notice (client-rendered only, never published) ────
      if (item.isSystemNotice) {
        return (
          <View style={styles.systemNoticeBubble} testID={`system-notice-${item.id}`}>
            <Text style={styles.systemNoticeText}>{item.text}</Text>
          </View>
        );
      }

      if (item.durableFact) {
        return (
          <LedgerRoomUpdate
            id={item.id}
            line={durableFactLine(item)}
            stamp={ledgerStamp(item.timestamp)}
            tone={item.durableFact.kind === 'failure' ? 'brass' : 'quiet'}
          />
        );
      }

      // ── Ordinary message ─────────────────────────────────────────
      const isBody = item.pubkey && BODY_PUBKEYS.has(item.pubkey);
      const isOwn = item.isUser;
      const knownAgent = item.pubkey ? agentByPubkey.get(item.pubkey) : undefined;
      const isAgent = item.isAgentAuthor || item.isAgentActivity || isBody || Boolean(knownAgent);
      const display = isAgent
        ? resolvePendingAgentDisplay(
            item.pubkey ?? 'unknown-agent',
            knownAgent,
            participantsHydrated,
          )
        : null;
      const personName = item.pubkey ? personProfileByPubkey.get(item.pubkey)?.name : undefined;

      const attachmentElements = item.attachments?.map((attachment) => (
        <AttachmentCard attachment={attachment} key={`${item.id}-${attachment.url}`} />
      ));

      // ── The ledger (§ DESIGN.md "The ledger") ────────────────────
      // One primitive, both surfaces. Corners attribute exactly like Rooms —
      // several people can sit in one corner, so every voice announces itself
      // with its identity mark and name (or 'You'), once per run.
      //
      //   · Your own turn's byline dot and name are brass, and nothing else
      //     marks it: the message text is plain body — regular weight,
      //     primary tone, one size — never bolded, never enlarged.
      // An agent viewing its own messages is both `isUser` and an agent; the
      // agent test wins, matching `ledgerSpeakerKey`'s own ordering.
      const isSelfSteer = isOwn && !isAgent;
      const speaksAsAgent = isAgent;
      const voiceName = speaksAsAgent
        ? display
          ? display.name
          : (personName ?? shortMemberNpub(item.pubkey ?? ''))
        : (personName ?? (item.pubkey ? shortMemberNpub(item.pubkey) : 'SOMEONE'));
      // Attribution on a continuation of the voice directly above is omitted;
      // otherwise every voice announces itself with its mark and name.
      //
      // The byline's leading indicator is the speaker's EXISTING identity mark
      // (buzz/identity-mark.ts), at transcript scale, so several people and
      // agents in one Room read apart at a glance — no new vocabulary. An
      // agent carries the gold ring only while its presence lease says it is
      // working; an optimistic own message keys its seed on the viewer so the
      // mark survives reconciliation unchanged.
      const markSeed =
        item.pubkey ?? (isSelfSteer ? cacheViewerPubkey || 'self' : 'unknown-person');
      const speakerAlive =
        speaksAsAgent && Boolean(item.pubkey) && Boolean(speakerOnline[item.pubkey ?? '']);
      const byline: LedgerByline | undefined = attributionContinued
        ? undefined
        : {
            name: isSelfSteer ? 'You' : voiceName,
            role: speaksAsAgent ? 'agent' : undefined,
            stamp: ledgerStamp(item.timestamp),
            isViewer: isSelfSteer,
            mark: {
              seed: markSeed,
              kind: speaksAsAgent ? 'agent' : 'human',
              ...(speaksAsAgent ? { alive: speakerAlive } : {}),
            },
          };
      // Machine noise collapses the same way on both surfaces: one ghost line,
      // expandable, never a wall of output down the slab.
      if (item.isAgentActivity) {
        // The tool run keeps its attribution on BOTH surfaces: a readout that
        // opens a new voice's run still names them.
        const activityHandle = !attributionContinued && speaksAsAgent ? voiceName : undefined;
        return (
          <LedgerActivity
            active={item.id === activeActivityId}
            handle={activityHandle}
            message={item}
            stamp={ledgerStamp(item.timestamp)}
          />
        );
      }

      // Adjacent request → agent reply pairs stay quiet. A queued agent reply can
      // land after newer visible turns, so it keeps the quote that identifies its
      // actual NIP-10 target. Human replies retain their existing quote behavior.
      const showReplyReference = shouldShowReplyReference({
        replyToId: item.replyToId,
        speaksAsAgent,
        immediatelyPrecedingMessage,
      });
      const referencedTarget = referencedMessage
        ? replyTargetForMessage(referencedMessage)
        : undefined;
      const replyReference = showReplyReference ? (
        <View style={styles.replyReference} testID={`reply-reference-${item.id}`}>
          <Text numberOfLines={2} style={styles.replyReferenceText}>
            ↳ {referencedTarget?.authorName ?? 'ORIGINAL MESSAGE'} ·{' '}
            {referencedTarget?.preview ?? 'Message not loaded'}
          </Text>
        </View>
      ) : null;

      // A pasted `git push` dump, stack trace, or npm error wall gets the same
      // treatment as tool telemetry: lifted out of the prose into one ghost
      // line. Deliberately gated on `!isSelfSteer` rather than on `isAgent` —
      // `isAgent` depends on the roster and goes false exactly when a Corner
      // needs this most, which is how a full push-rejection dump reached the
      // slab. Your own message is never touched: pasting a log is on purpose.
      const ledgerText = isSelfSteer ? undefined : splitLedgerText(item.text);
      const machineNoise = ledgerText?.machine ? (
        <LedgerGhostLine
          body={ledgerText.machine}
          label={`${ledgerText.machineLines} lines of tool output`}
          testID={`chat-machine-noise-${item.id}`}
        />
      ) : null;
      const deliveryFailure =
        item.isUser && failedOutboxIds.has(item.id) ? (
          <View style={styles.outboxFailure} testID={`outbox-delivery-failed-${item.id}`}>
            <Text style={styles.outboxFailureText}>DELIVERY FAILED</Text>
            <View style={styles.outboxFailureActions}>
              <MonoButton
                label="RETRY"
                onPress={() => retryOutboxMessage(item.id)}
                variant="secondary"
              />
              <MonoButton
                label="DISMISS"
                onPress={() => dismissOutboxMessage(item.id)}
                variant="secondary"
              />
            </View>
          </View>
        ) : null;
      const taggedMentionPubkeys = new Set(item.mentionPubkeys ?? []);
      const mentionHandles = roomParticipants
        .filter((participant) => taggedMentionPubkeys.has(participant.pubkey))
        .map((participant) => participant.handle);

      return (
        <SwipeToReply
          messageId={item.id}
          onLongPress={() => {
            // `item.text` is the durable turn body. The visible ledger can
            // fold its machine footnote or animate its prose, but a long press
            // always copies the complete committed turn, unchanged.
            void copyEntireTurn(item.text, Clipboard.setStringAsync);
          }}
          onReply={item.isAgentDraft ? () => undefined : () => beginReply(item)}
        >
          <NewMessageMaterialize enabled={Boolean(item.isNew)} messageId={item.id}>
            <View>
              {isSelfSteer ? (
                <LedgerSteer
                  itemId={item.id}
                  continued={attributionContinued}
                  byline={byline}
                  bodyText={item.text}
                  mentionHandles={mentionHandles}
                  channelIndex={channelReferenceIndex}
                  onChannelReference={handleOpenChannelReference}
                  bodyTestID={`chat-message-text-${item.id}`}
                  replyReference={replyReference}
                  attachments={attachmentElements}
                />
              ) : (
                <LedgerEntry
                  itemId={item.id}
                  byline={byline}
                  continued={attributionContinued}
                  luminous={speaksAsAgent}
                  // `item.isNew` is re-stamped by warm revalidation / WS replay
                  // on every room open; the consume-once gate (one type-out per
                  // message id per app session, shared with the entrance fade's
                  // registry) lives inside `LedgerEntry`.
                  typewriter={speaksAsAgent && Boolean(item.isNew)}
                  bodyText={ledgerText ? ledgerText.prose : item.text}
                  mentionHandles={mentionHandles}
                  channelIndex={channelReferenceIndex}
                  onChannelReference={handleOpenChannelReference}
                  bodyTestID={`chat-message-text-${item.id}`}
                  replyReference={replyReference}
                  machineNoise={machineNoise}
                  attachments={attachmentElements}
                />
              )}
              {deliveryFailure}
            </View>
          </NewMessageMaterialize>
        </SwipeToReply>
      );
    },
    [
      agentByPubkey,
      activeActivityId,
      handleWritePermission,
      handleConfirmTargetBranch,
      isCorner,
      parentChannelId,
      participantsHydrated,
      permissionActionId,
      personProfileByPubkey,
      cacheViewerPubkey,
      roomRepository,
      roomParticipants,
      targetBranchActionId,
      targetBranchNotice,
      viewerChannelRole,
      viewerIsAgent,
      speakerOnline,
      beginReply,
      dismissOutboxMessage,
      failedOutboxIds,
      replyTargetForMessage,
      retryOutboxMessage,
      channelReferenceIndex,
      handleOpenChannelReference,
    ],
  );
  const renderItem = useRoomMessageRenderItem({
    render: renderMessage,
    continuedIds: continuedAttributionIds,
    precedingMessageById: immediatelyPrecedingVisibleMessageById,
    messageById: visibleMessageById,
  });

  if (!roomSurface) {
    if (transcriptHydrationFailed) {
      return (
        <View style={[styles.container, { paddingTop: insets.top }]} testID="room-hydration-error">
          <View style={styles.hydrationErrorHeader}>
            <TouchableOpacity
              accessibilityLabel="Back to Rooms"
              onPress={handleBack}
              style={styles.backButton}
              testID="chat-back"
            >
              <Text style={styles.backText}>‹</Text>
            </TouchableOpacity>
            <View style={styles.headerCenter}>
              <Text numberOfLines={1} style={styles.channelName}>
                {displayHeaderTitle ?? routeChannelTitle ?? ROOM_LABEL}
              </Text>
              <HeaderMetaCaps>HISTORY UNAVAILABLE</HeaderMetaCaps>
            </View>
          </View>
          <View accessibilityRole="alert" style={styles.hydrationErrorBody}>
            <Text style={styles.errorLabel}>! ERROR</Text>
            <Text style={styles.hydrationErrorText}>
              {transcriptHydrationError ?? 'Could not load this conversation.'}
            </Text>
            <MonoButton
              label="RETRY"
              onPress={() => setTranscriptHydrationAttempt((attempt) => attempt + 1)}
              style={styles.hydrationErrorRetry}
              variant="secondary"
            />
          </View>
        </View>
      );
    }
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <PixelLoader />
        <Text style={styles.loadingText}>LOADING {ROOM_LABEL.toUpperCase()}</Text>
      </View>
    );
  }

  return (
    <BuzzCommunityShell
      communities={communities}
      activeCommunityId={activeCommunityId}
      onSelect={handleCommunitySelect}
      onAdd={() => router.push('/buzz/community' as Href)}
      onSettings={() => router.push('/buzz/settings' as Href)}
      onWorkspaceSettings={(communityId) =>
        router.push({
          pathname: '/buzz/settings/workspace',
          params: { communityId },
        } as unknown as Href)
      }
      canManageActiveCommunity={canManageWorkspace}
      viewerPubkey={userPubkey || undefined}
      viewerAvatarUrl={personProfileByPubkey.get(userPubkey)?.avatar}
    >
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'translate-with-padding'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        {/* Header. No surface of its own — the chrome sits on the same
            obsidian as the transcript, parted only by a hairline. */}
        <View
          style={[styles.header, { minHeight: insets.top + 60, paddingTop: insets.top + 8 }]}
          testID={isCorner ? 'corner-session-header' : undefined}
        >
          <TouchableOpacity
            accessibilityLabel={
              isCorner && cornerReturnTarget !== 'room-list'
                ? `Back to this ${CORNER_LABEL}’s ${ROOM_LABEL}`
                : 'Back to Rooms'
            }
            onPress={handleBack}
            style={styles.backButton}
            testID="chat-back"
          >
            <Text style={[styles.backText, isCorner && styles.cornerBackText]}>‹</Text>
          </TouchableOpacity>
          {/*
            A corner has exactly one administering agent, so its identity is
            stated here once and never repeated on a message. The ledger below
            renders the agent's turns as unattributed flowing text precisely
            because this mark and name are always on screen above them.
          */}
          {isCorner && cornerAgentPubkey && (
            <HeaderIdentitySlot testID="corner-header-agent">
              <IdentityMark
                kind="agent"
                seed={cornerAgentDisplay?.avatarSeed ?? cornerAgentPubkey}
                avatarUrl={cornerAgentDisplay?.avatarUrl}
                name={cornerAgentDisplay?.name ?? 'Agent'}
                size={26}
                alive={sessionState === 'working'}
              />
            </HeaderIdentitySlot>
          )}
          <TouchableOpacity
            accessibilityLabel={
              isCorner
                ? `${cornerAgentDisplay?.name ?? 'Agent'}’s ${CORNER_LABEL}. View ${formatRoomParticipantTotal(roomParticipantTotal)}`
                : `View ${formatRoomParticipantTotal(roomParticipantTotal)}`
            }
            accessibilityRole="button"
            disabled={!participantsHydrated}
            onPress={() => setRosterVisible(true)}
            style={styles.headerCenter}
            testID="room-participant-roster-trigger"
          >
            {displayHeaderTitle === null ? (
              // The channel's own name has not landed yet. Neither "Room" nor
              // a corner slug would be true, so show neither.
              <View
                accessibilityLabel="Loading name"
                style={[styles.channelNameSkeleton, isCorner && styles.cornerChannelNameSkeleton]}
                testID="chat-title-skeleton"
              />
            ) : (
              <Text
                style={[styles.channelName, isCorner && styles.cornerChannelName]}
                numberOfLines={1}
              >
                {displayHeaderTitle}
              </Text>
            )}
            {!isCorner && roomRepository && (
              <TouchableOpacity
                accessibilityLabel={`Repo ${roomRepoChipLabel(roomRepository)}. ${
                  canManageRoomRepository(viewerChannelRole) ? 'View or change it' : 'View it'
                }`}
                accessibilityRole="button"
                onPress={() => setRoomActionsVisible(true)}
                style={styles.repoChip}
                testID="room-repo-chip"
              >
                <HeaderMetaCaps testID="room-repo-chip-text">
                  {roomRepoChipLabel(roomRepository)}
                </HeaderMetaCaps>
              </TouchableOpacity>
            )}
            {isCorner ? (
              <HeaderMetaRow>
                <Text numberOfLines={1} style={styles.cornerHeaderAgent}>
                  {(cornerAgentDisplay?.name ?? 'AGENT').toUpperCase()}
                </Text>
                {cornerAgentPubkey && (
                  <AgentPresenceLight online={cornerAgentOnline} testID="corner-header-presence" />
                )}
                <CornerGlyph
                  status={displayedCornerStatus}
                  style={styles.cornerHeaderState}
                  testID="corner-view-status"
                />
                <HeaderMetaCaps>
                  {participantsHydrated ? formatRoomParticipantTotal(roomParticipantTotal) : ''}
                </HeaderMetaCaps>
              </HeaderMetaRow>
            ) : (
              <HeaderMetaCaps testID="room-header-meta">
                {participantsHydrated
                  ? `${formatRoomParticipantTotal(roomParticipantTotal)}  ›`
                  : 'LOADING MEMBERS'}
              </HeaderMetaCaps>
            )}
          </TouchableOpacity>
          {!parentChannelId && !isDirectMessage && !viewerIsAgent && !isArchived && (
            <TouchableOpacity
              accessibilityLabel={`Add people or Agents to this ${ROOM_LABEL}`}
              onPress={() => {
                setMembershipError(null);
                setParticipantPickerKind(null);
                setParticipantPickerVisible(true);
              }}
              style={styles.addMembersButton}
              testID="room-member-picker"
            >
              <Text style={styles.addMembersGlyph}>＋</Text>
            </TouchableOpacity>
          )}
          {/* One overflow vocabulary: the same ••• the Room header carries,
              holding whatever destructive/rare actions the surface has. A
              corner's "close" belongs here, not as a permanent button sitting
              under the composer where the reader's thumb lives. */}
          {isCorner && !viewerIsAgent && !isArchived && (
            <TouchableOpacity
              accessibilityLabel={`${CORNER_LABEL} actions`}
              accessibilityRole="button"
              onPress={() => setCornerActionsVisible(true)}
              style={styles.roomActionsButton}
              testID="corner-actions-menu"
            >
              <Text style={styles.roomActionsGlyph}>•••</Text>
            </TouchableOpacity>
          )}
          {!parentChannelId &&
            !isDirectMessage &&
            !viewerIsAgent &&
            !isArchived &&
            lifecycleAction && (
              <TouchableOpacity
                accessibilityLabel={`${ROOM_LABEL} actions`}
                accessibilityRole="button"
                onPress={() => {
                  setMembershipError(null);
                  setRenameEditing(false);
                  setRenameError(null);
                  setRoomActionsVisible(true);
                }}
                style={styles.roomActionsButton}
                testID="room-actions-menu"
              >
                <Text style={styles.roomActionsGlyph}>•••</Text>
              </TouchableOpacity>
            )}
          {isArchived && (
            <View style={styles.archivedBadge}>
              <Text style={styles.archivedBadgeText}>□ ARCHIVED</Text>
            </View>
          )}
        </View>

        {/* Pinned to the top, under the header: the plan changes far less
            often than the composer-adjacent live status below, so it earns
            the stable position where it never fights the composer for
            space. Hidden entirely when the agent has published no plan. */}
        {isCorner && !isArchived && (
          <CornerPlanPin
            {...(cornerObjective ? { objective: cornerObjective } : {})}
            {...(cornerPlan ? { plan: cornerPlan } : {})}
            testID="corner-plan-pin"
          />
        )}

        <FlatList
          testID="chat-messages"
          ref={flatListRef}
          inverted={invertedMessages.length > 0}
          data={invertedMessages}
          keyExtractor={(item: ChatDisplayMessage) => item.id}
          style={styles.messageList}
          contentContainerStyle={[
            styles.messageListContent,
            invertedMessages.length === 0 && styles.messageListContentEmpty,
          ]}
          maintainVisibleContentPosition={{
            // Anchor on the second-newest row (index 1), not the newest.
            // The newest slot gets replaced on every send (optimistic id ->
            // real event id) and on every agent stream token, which would
            // otherwise destabilize the anchor. Mirrors sources/components/ChatList.tsx.
            //
            // autoscrollToTopThreshold: for an INVERTED list this is the
            // auto-stick-to-visual-bottom threshold — contentOffset 0 is the
            // visual bottom here, and this prop sticks the viewport to
            // offset 0 (revealing new content, including a taller multi-line
            // send) whenever the user is already within N units of it. Do
            // NOT pair this with a JS-side scrollToOffset call — the two
            // fight and drag the viewport while reading older messages.
            minIndexForVisible: 1,
            autoscrollToTopThreshold: 50,
          }}
          keyboardShouldPersistTaps="handled"
          renderItem={renderItem}
          onScrollToIndexFailed={({ averageItemLength, index }) => {
            // Variable-height ledger rows cannot provide getItemLayout. Jump
            // near the target, let the list measure that window, then retry.
            flatListRef.current?.scrollToOffset({
              offset: averageItemLength * index,
              animated: false,
            });
            setTimeout(() => {
              flatListRef.current?.scrollToIndex({
                index,
                viewPosition: 0.5,
                animated: false,
              });
            }, 50);
          }}
          onEndReached={loadOlderTranscriptMessages}
          onEndReachedThreshold={0.5}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <EmptyLedgerState
                variant={emptyLedgerVariant}
                name={isDirectMessage ? displayRoomName : undefined}
                objective={isCorner ? cornerObjective : undefined}
                onPress={focusComposer}
              />
            </View>
          }
          ListFooterComponent={
            // Inverted list: the footer is the visual TOP. The Room discussion
            // a corner was opened out of belongs above the corner's own first
            // line, and this is the slot that puts it there.
            loadingOlderMessages || (isCorner && roomContext.length) ? (
              <>
                {isCorner && roomContext.length ? (
                  <RoomContextPreamble
                    entries={roomContext}
                    speakerLabel={roomContextSpeakerLabel}
                  />
                ) : null}
                {loadingOlderMessages ? (
                  <View style={styles.olderMessagesLoading} testID="older-messages-loading">
                    <PixelLoader compact />
                  </View>
                ) : null}
              </>
            ) : null
          }
          ListHeaderComponent={
            isCorner && !isArchived && sessionState === 'done' ? (
              <View style={styles.cornerReviewFooter}>
                {cornerAction.kind === 'review' ? (
                  <HullSurface strength="raised" style={styles.approvalBar}>
                    <View style={styles.approvalInfo}>
                      <Text style={styles.prChip}>CHANGE READY FOR REVIEW</Text>
                      {/* What CHANGED, never what the agent said — the
                          transcript above already carries the turn's prose in
                          full, and echoing its summary here printed the same
                          sentences a third time. */}
                      <Text
                        style={styles.approvalBarText}
                        numberOfLines={2}
                        testID="change-review-summary"
                      >
                        {changeReviewSummary(reviewFiles) ??
                          `${cornerAgentDisplay?.name ?? 'The agent'} committed work for review.`}
                      </Text>
                      <Text style={styles.approvalStateText}>
                        {reviewFiles === null
                          ? 'PREPARING YOUR REVIEW'
                          : `${reviewFiles.length} ${reviewFiles.length === 1 ? 'FILE' : 'FILES'} READY TO REVIEW`}
                      </Text>
                      {/* One compact row, and only when the repo's host
                          actually published a preview deployment for this
                          exact tip — no statuses means no row at all. */}
                      {previewUrl ? (
                        <TouchableOpacity
                          accessibilityRole="link"
                          accessibilityLabel={`Open the branch preview at ${previewUrl}`}
                          onPress={() => {
                            void Linking.openURL(previewUrl).catch((err) =>
                              console.warn('Preview link failed to open:', err),
                            );
                          }}
                          style={styles.previewLinkRow}
                          testID="change-review-preview"
                        >
                          <Text style={styles.previewLinkLabel}>PREVIEW ↗</Text>
                          <Text style={styles.previewLinkUrl} numberOfLines={1}>
                            {previewUrl.replace(/^https:\/\//, '')}
                          </Text>
                        </TouchableOpacity>
                      ) : null}
                    </View>
                    {transport && (
                      <ChangeReviewPanel
                        transport={transport}
                        sessionId={decodedId}
                        tip={mergeTarget!.tip}
                      />
                    )}
                    {viewerIsAgent ? (
                      <View style={styles.approvalSent}>
                        <Text style={styles.approvalSentText}>NOT ALLOWED</Text>
                      </View>
                    ) : approvalState === 'none' ? (
                      <TouchableOpacity
                        accessibilityRole="button"
                        onPress={handleApprove}
                        style={styles.approveButton}
                        testID="approve-corner"
                      >
                        <Text style={styles.approveButtonText}>APPROVE THIS CORNER’S MERGE</Text>
                        <Text style={styles.approveButtonSupport}>
                          COVERS ITS ONGOING WORK UNTIL IT LANDS
                        </Text>
                      </TouchableOpacity>
                    ) : approvalState === 'sending' ? (
                      <View style={styles.approvalPending}>
                        <PixelLoader compact />
                        <Text style={styles.approvalStateText}>SENDING APPROVAL</Text>
                      </View>
                    ) : approvalState === 'sent' ? (
                      <View style={styles.approvalSent} testID="approve-corner-sent">
                        <Text style={styles.approvalSentText}>APPROVAL SENT ✓</Text>
                        <Text style={styles.approvalStateText}>
                          WAITING FOR THE AGENT TO PICK IT UP
                        </Text>
                      </View>
                    ) : approvalState === 'landing' ? (
                      <View style={styles.approvalPending} testID="approve-corner-landing">
                        <PixelLoader compact />
                        <Text style={styles.approvalStateText}>APPROVAL RECEIVED — LANDING…</Text>
                      </View>
                    ) : approvalState === 'realigning' ? (
                      <View style={styles.approvalPending} testID="approve-corner-realigned">
                        <PixelLoader compact />
                        <Text style={styles.approvalStateText}>
                          REALIGNED — LANDING WITH YOUR EXISTING APPROVAL…
                        </Text>
                      </View>
                    ) : approvalState === 'timeout' ? (
                      <View style={styles.approvalSent} testID="approve-corner-timeout">
                        <Text style={styles.approvalStateText}>
                          THE AGENT HASN’T PICKED IT UP YET · OFFLINE?
                        </Text>
                      </View>
                    ) : approvalState === 'failed' ? (
                      // Only ever claim what the daemon actually told us it is
                      // doing — see `deliveryRetry`. A land the daemon has
                      // stopped re-attempting must never read as "retrying".
                      <View style={styles.approvalSent} testID="approve-corner-delivery-failed">
                        <Text style={styles.approvalStateText}>
                          {deliveryRetry === 'auto'
                            ? '⚠ DELIVERY FAILED · RETRYING AUTOMATICALLY'
                            : deliveryRetry === 'realigning'
                              ? '⚠ TARGET MOVED ON · UPDATING THIS CHANGE FOR A NEW REVIEW'
                              : deliveryRetry === 'blocked'
                                ? '⚠ COULDN’T LAND · WAITING ON YOU'
                                : '⚠ DELIVERY FAILED · SEE THE CORNER FOR DETAILS'}
                        </Text>
                      </View>
                    ) : (
                      <View style={styles.approvalSent}>
                        <Text style={styles.approvalSentText} testID="approve-corner-landed">
                          LANDED AT {(landedApprovalTip ?? mergeTarget?.tip ?? '').slice(0, 12)} ✓
                        </Text>
                      </View>
                    )}
                    {approvalError ? (
                      <Text style={styles.approvalStateText} testID="approve-corner-error">
                        {approvalError}
                      </Text>
                    ) : null}
                  </HullSurface>
                ) : (
                  <HullSurface
                    strength="quiet"
                    style={styles.nothingReady}
                    testID="nothing-ready-panel"
                  >
                    <Text style={styles.nothingReadyTitle}>NOTHING READY TO MERGE YET</Text>
                    <Text style={styles.nothingReadyText} testID="nothing-ready-reason">
                      {mergeNotReadyReason ??
                        `A change appears here only after ${cornerAgentDisplay?.name ?? 'the agent'} commits real work for review.`}
                    </Text>
                  </HullSurface>
                )}
              </View>
            ) : null
          }
        />

        {/* The Room's only active-corner affordance: one pinned line naming
            who is working and what on, gold and breathing while the work is
            live. Never a scroll element — see CornerLiveBar. */}
        {!isArchived && cornerLiveBar && (
          <CornerLiveBar
            label={cornerLiveBar.label}
            live={cornerLiveBar.live}
            onPress={
              // A truthy READY id can still be unroutable when it names the
              // current route. openCorner rejects that self-target; do not
              // advertise the downstream no-op as `view →` in the first place.
              cornerLiveBar.cornerId && cornerLiveBar.cornerId !== decodedId
                ? () => openCorner(cornerLiveBar.cornerId!)
                : undefined
            }
          />
        )}
        {/* The ordinary per-turn indicator, independent of the line above: a
            Room can be thinking with no corner open, or hold an open corner
            with nothing being asked of it. Both may show at once; neither
            implies the other. */}
        {!isArchived && agentsOffline && (
          <View style={styles.agentOfflineHint} testID="agent-offline-hint">
            <Text style={styles.agentOfflineHintTitle}>□ AGENT OFFLINE</Text>
            <Text style={styles.agentOfflineHintText}>
              Messages stay in this Room and will be answered when the Agent is back.
            </Text>
          </View>
        )}

        {/* P2: Archived channels are read-only */}
        {isArchived ? (
          <View style={[styles.archivedInputBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
            <Text style={[styles.archivedInputText, isCorner && styles.cornerArchivedInputText]}>
              {parentChannelId ? 'Corner' : ROOM_LABEL} archived (read-only)
            </Text>
          </View>
        ) : (
          <View style={[styles.inputBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
            {slashMenuVisible &&
              (() => {
                const mentionAgent = mentionSlashAgentPubkey
                  ? agentByPubkey.get(mentionSlashAgentPubkey)
                  : undefined;
                const mentionAgentName = mentionSlashAgentPubkey
                  ? resolveAgentDisplayIdentity(mentionSlashAgentPubkey, mentionAgent).name
                  : undefined;
                return (
                  <SlashVerbPicker
                    verbs={slashVerbs}
                    query={currentSlashQuery ?? mentionSlash?.query ?? ''}
                    highlightedIndex={highlightedSlashVerbIndex}
                    onDismiss={dismissSlashMenu}
                    onSelect={runSlashVerb}
                    commands={mentionAgentCommands}
                    agentName={mentionAgentName}
                    agentLacksCommands={mentionAgentLacksCommands}
                    onSelectCommand={insertAgentCommand}
                  />
                );
              })()}
            {mentionMenuVisible && (
              <View
                accessibilityLabel="Mention a Room participant"
                style={styles.mentionMenu}
                testID="mention-suggestions"
              >
                <Text style={styles.mentionMenuLabel}>MENTION</Text>
                {mentionSuggestions.matches.map((participant, index) => {
                  const selected = index === highlightedMentionIndex;
                  const display = participant.agent
                    ? resolveAgentDisplayIdentity(participant.pubkey, participant.agent)
                    : undefined;
                  return (
                    <TouchableOpacity
                      accessibilityLabel={`${participant.name}, @${participant.handle}, ${participant.kind}`}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      key={participant.pubkey}
                      onPress={() => selectMention(participant)}
                      style={[styles.mentionRow, selected && styles.mentionRowSelected]}
                      testID={`mention-suggestion-${participant.handle}`}
                    >
                      {display ? (
                        <IdentityMark
                          kind="agent"
                          seed={display.avatarSeed ?? participant.pubkey}
                          avatarUrl={display.avatarUrl}
                          name={display.name}
                          size={28}
                        />
                      ) : (
                        <IdentityMark
                          kind="human"
                          seed={participant.pubkey}
                          avatarUrl={personProfileByPubkey.get(participant.pubkey)?.avatar}
                          name={participant.name}
                          size={28}
                        />
                      )}
                      <View style={styles.mentionIdentity}>
                        <Text numberOfLines={1} style={styles.mentionName}>
                          {participant.name}
                        </Text>
                        <Text numberOfLines={1} style={styles.mentionHandle}>
                          @{participant.handle}
                        </Text>
                      </View>
                      <Text style={styles.mentionKind}>
                        {participant.kind === 'agent' ? 'AGENT' : 'PERSON'}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
                {mentionSuggestions.overflow > 0 && (
                  <Text style={styles.mentionOverflow} testID="mention-suggestion-overflow">
                    AND {mentionSuggestions.overflow} OTHERS
                  </Text>
                )}
              </View>
            )}
            {cornerOpenRepoPrompt && (
              <View style={styles.repoPromptBanner} testID="corner-open-repo-prompt">
                <Text style={styles.repoPromptTitle}>
                  {roomRepoAccessIssue
                    ? roomRepoAccessIssue.reason === 'revoked'
                      ? 'ACCESS TO THIS REPO WAS REVOKED'
                      : 'THIS REPO ISN’T IN THE BEELINE INSTALLATION'
                    : `THIS ${ROOM_LABEL.toUpperCase()} ISN’T LINKED TO A REPO`}
                </Text>
                <Text style={styles.repoPromptHint}>
                  {roomRepoAccessIssue
                    ? `${roomRepoAccessIssue.fullName} must be reconnected before a ${CORNER_LABEL} can open.`
                    : `Pick one to open a ${CORNER_LABEL}.`}
                </Text>
                {roomRepoAccessIssue && (
                  <TouchableOpacity
                    accessibilityRole="button"
                    onPress={() => void handleReconnectRoomRepository()}
                    style={styles.repoPromptConnect}
                    testID="corner-open-repo-connect"
                  >
                    <Text style={styles.repoPromptConnectText}>
                      {roomRepoAccessIssue.reason === 'not_granted'
                        ? 'Add this repo to the Beeline installation →'
                        : `Connect ${roomRepoAccessIssue.fullName.split('/')[0]} →`}
                    </Text>
                  </TouchableOpacity>
                )}
                {canManageRoomRepository(viewerChannelRole) ? (
                  <RepoPicker
                    busy={roomRepoBusy}
                    candidates={roomRepoCandidates}
                    installations={githubInstallations}
                    currentKey={null}
                    error={roomRepoError}
                    notice={roomRepoNotice}
                    ownerGrant={ownerGrant}
                    onAddAccount={() => void handleAddGitHubAccount()}
                    onAskOwnerGrant={(fullName) => void handleAskOwnerGrant(fullName)}
                    onCreateRepository={handleCreateGitHubRepository}
                    onManageInstallation={(installation) =>
                      void handleManageGitHubInstallation(installation)
                    }
                    onSelect={handleSelectRoomRepoCandidate}
                    testIDPrefix="corner-open-repo-picker"
                  />
                ) : (
                  <Text style={styles.repoPromptHint}>Ask a {ROOM_LABEL} admin to link one.</Text>
                )}
                <TouchableOpacity
                  accessibilityLabel="Dismiss"
                  accessibilityRole="button"
                  onPress={() => setCornerOpenRepoPrompt(false)}
                  style={styles.repoPromptDismiss}
                  testID="corner-open-repo-prompt-dismiss"
                >
                  <Text style={styles.repoPromptDismissText}>DISMISS</Text>
                </TouchableOpacity>
              </View>
            )}
            {replyTarget && (
              <View style={styles.replyComposerBanner} testID="reply-composer-banner">
                <View style={styles.replyComposerCopy}>
                  <Text numberOfLines={1} style={styles.replyComposerLabel}>
                    ↩ REPLYING TO {replyTarget.authorName.toUpperCase()}
                  </Text>
                  <Text numberOfLines={2} style={styles.replyComposerPreview}>
                    {replyTarget.preview}
                  </Text>
                </View>
                <TouchableOpacity
                  accessibilityLabel="Cancel reply"
                  accessibilityRole="button"
                  onPress={() => setReplyTarget(null)}
                  style={styles.replyComposerCancel}
                  testID="reply-composer-cancel"
                >
                  <Text style={styles.replyComposerCancelText}>×</Text>
                </TouchableOpacity>
              </View>
            )}
            {pendingAttachment && (
              <View style={styles.pendingAttachment} testID="pending-chat-attachment">
                <View style={styles.pendingAttachmentCopy}>
                  <Text numberOfLines={1} style={styles.pendingAttachmentName}>
                    {pendingAttachment.name}
                  </Text>
                  <Text style={styles.pendingAttachmentMeta}>
                    {sending ? 'UPLOADING' : formatAttachmentSize(pendingAttachment.size)}
                  </Text>
                </View>
                <TouchableOpacity
                  accessibilityLabel={`Remove ${pendingAttachment.name}`}
                  disabled={sending}
                  onPress={() => setPendingAttachment(null)}
                  style={styles.pendingAttachmentRemove}
                >
                  <Text style={styles.pendingAttachmentRemoveText}>×</Text>
                </TouchableOpacity>
              </View>
            )}
            {/* Keep this in the composer stack, directly above the field. A
                growing multiline field then takes room from the transcript,
                never from the only live progress signal. */}
            {!isArchived && turnProgressLabel && (
              <TurnProgressLine label={turnProgressLabel} testID="turn-progress-line" />
            )}
            <View style={[styles.composer, composerFocused && styles.composerFocused]}>
              <TouchableOpacity
                accessibilityLabel="Attach photo or document"
                accessibilityRole="button"
                disabled={sending}
                onPress={chooseAttachment}
                style={styles.attachButton}
                testID="chat-attach-button"
              >
                <Text style={styles.attachButtonText}>＋</Text>
              </TouchableOpacity>
              <TextInput
                ref={composerRef}
                style={[styles.input, { height: composerHeight }]}
                value={inputText}
                onChangeText={(value) => {
                  inputTextRef.current = value;
                  setInputText(value);
                }}
                onContentSizeChange={(event) => {
                  const contentHeight = Math.ceil(event.nativeEvent.contentSize.height);
                  setComposerHeight(
                    Math.min(COMPOSER_MAX_HEIGHT, Math.max(COMPOSER_MIN_HEIGHT, contentHeight)),
                  );
                }}
                onFocus={() => setComposerFocused(true)}
                onBlur={() => setComposerFocused(false)}
                onKeyPress={(event) => {
                  const action = mentionKeyboardAction(event.nativeEvent.key);
                  // Printable keys must never be prevented by the mention
                  // picker. In particular, `>` is ordinary composer text.
                  if (slashMenuVisible) {
                    if (!action) return;
                    if (action === 'select') {
                      event.preventDefault();
                      selectHighlightedPaletteItem();
                    } else if ((action === 'next' || action === 'previous') && paletteItemCount) {
                      event.preventDefault();
                      const direction = action === 'next' ? 1 : -1;
                      setHighlightedSlashVerbIndex(
                        (current) => (current + direction + paletteItemCount) % paletteItemCount,
                      );
                    } else {
                      event.preventDefault();
                      dismissSlashMenu();
                    }
                    return;
                  }
                  if (!mentionMenuVisible || !action) return;
                  if (action === 'select') {
                    event.preventDefault();
                    const selected = mentionSuggestions.matches[highlightedMentionIndex];
                    if (selected) selectMention(selected);
                  } else if (action === 'next' || action === 'previous') {
                    event.preventDefault();
                    const direction = action === 'next' ? 1 : -1;
                    setHighlightedMentionIndex((current) => {
                      const count = mentionSuggestions.matches.length;
                      return (current + direction + count) % count;
                    });
                  } else {
                    event.preventDefault();
                    setDismissedMentionKey(mentionMenuKey);
                  }
                }}
                onSelectionChange={(event) => {
                  const nextSelection = event.nativeEvent.selection;
                  setInputSelection((current) =>
                    current.start === nextSelection.start && current.end === nextSelection.end
                      ? current
                      : nextSelection,
                  );
                }}
                placeholder={composerPlaceholder}
                placeholderTextColor={theme.buzz.dim}
                multiline
                numberOfLines={1}
                returnKeyType="default"
                scrollEnabled={composerHeight >= COMPOSER_MAX_HEIGHT}
                submitBehavior="newline"
                testID="chat-input"
              />
              <TouchableOpacity
                style={[
                  styles.sendButton,
                  (slashMenuVisible
                    ? !inputText.trim()
                    : (!inputText.trim() && !pendingAttachment) || sending) &&
                    styles.sendButtonDisabled,
                ]}
                onPress={
                  slashMenuVisible
                    ? () => {
                        selectHighlightedPaletteItem();
                      }
                    : handleSend
                }
                disabled={
                  slashMenuVisible
                    ? !inputText.trim()
                    : (!inputText.trim() && !pendingAttachment) || sending
                }
                testID="chat-send"
              >
                <Text style={[styles.sendButtonText, mergeTarget && styles.sendButtonTextQuiet]}>
                  ⏎
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </KeyboardAvoidingView>

      <AttachmentPickerSheet
        visible={attachmentPickerVisible}
        onClose={() => setAttachmentPickerVisible(false)}
        onPickDocument={() => void pickDocument()}
        onPickPhoto={() => void pickPhoto()}
      />

      <RoomRosterSheet
        bottomInset={insets.bottom}
        isDirectMessage={isDirectMessage}
        memberByPubkey={roomMemberByPubkey}
        membershipActionPubkey={membershipActionPubkey}
        membershipError={membershipError}
        onClose={closeRoster}
        onRemove={handleRemoveRoomMember}
        onlineByPubkey={speakerOnline}
        parentChannelId={parentChannelId ?? null}
        personProfileByPubkey={personProfileByPubkey}
        rosterSections={visibleRosterSections}
        total={roomParticipantTotal}
        userPubkey={userPubkey}
        viewerRole={viewerRoomRole}
        visible={rosterVisible}
      />

      <HullModal
        accessibilityLabel={`Close ${ROOM_LABEL} actions`}
        contentStyle={{ paddingHorizontal: 16, paddingBottom: Math.max(insets.bottom, 18) }}
        dismissOnBackdrop={!renameBusy}
        onRequestClose={() => {
          if (renameBusy) return;
          setRenameEditing(false);
          setRenameError(null);
          setRoomActionsVisible(false);
        }}
        placement="bottom"
        visible={roomActionsVisible}
      >
        <HullFloatingSurface style={styles.roomActionsModal}>
          <View style={styles.roomActionsModalHeading}>
            <View style={styles.roomActionsModalCopy}>
              <Text style={styles.roomActionsModalEyebrow}>{ROOM_LABEL.toUpperCase()}</Text>
              <Text numberOfLines={1} style={styles.roomActionsModalTitle}>
                {displayRoomName}
              </Text>
            </View>
            <TouchableOpacity
              accessibilityLabel={`Close ${ROOM_LABEL} actions`}
              disabled={renameBusy}
              onPress={() => {
                setRenameEditing(false);
                setRenameError(null);
                setRoomActionsVisible(false);
              }}
              style={styles.roomActionsModalClose}
            >
              <Text style={styles.roomActionsModalCloseText}>×</Text>
            </TouchableOpacity>
          </View>
          {canRenameRoom(viewerChannelRole) &&
            (renameEditing ? (
              <View style={styles.roomRenameEditor} testID="rename-room-editor">
                <Text style={styles.roomRenameLabel}>NEW {ROOM_LABEL.toUpperCase()} NAME</Text>
                <TextInput
                  accessibilityLabel={`New ${ROOM_LABEL} name`}
                  autoCapitalize="sentences"
                  autoCorrect
                  editable={!renameBusy}
                  onChangeText={(value) => {
                    setRenameDraft(value);
                    if (value.trim()) setRenameError(null);
                  }}
                  onSubmitEditing={() => void handleRenameRoom()}
                  returnKeyType="done"
                  selectTextOnFocus
                  style={styles.roomRenameInput}
                  testID="rename-room-input"
                  value={renameDraft}
                />
                <View style={styles.roomRenameControls}>
                  <TouchableOpacity
                    accessibilityRole="button"
                    disabled={renameBusy}
                    onPress={() => {
                      setRenameEditing(false);
                      setRenameError(null);
                    }}
                    style={styles.roomRenameCancel}
                  >
                    <Text style={styles.roomRenameCancelText}>CANCEL</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    accessibilityRole="button"
                    disabled={renameBusy || !renameDraft.trim()}
                    onPress={() => void handleRenameRoom()}
                    style={[
                      styles.roomRenameApply,
                      (renameBusy || !renameDraft.trim()) && styles.roomRenameApplyDisabled,
                    ]}
                    testID="apply-room-rename"
                  >
                    <Text style={styles.roomRenameApplyText}>
                      {renameBusy ? 'RENAMING…' : 'APPLY'}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <TouchableOpacity
                accessibilityLabel={`Rename ${ROOM_LABEL}`}
                accessibilityRole="button"
                disabled={renameBusy}
                onPress={() => {
                  // The rename draft is the STORED name; the header's `#`
                  // mark is display-only and must never be saved back.
                  setRenameDraft(storedRoomName);
                  setRenameError(null);
                  setRenameEditing(true);
                }}
                style={styles.roomRenameAction}
                testID="rename-room-action"
              >
                <View style={styles.roomLifecycleCopy}>
                  <Text style={styles.roomLifecycleTitle}>RENAME {ROOM_LABEL.toUpperCase()}</Text>
                  <Text style={styles.roomLifecycleHint}>Change its display name.</Text>
                </View>
                <Text style={styles.roomLifecycleGlyph}>✎</Text>
              </TouchableOpacity>
            ))}
          {canManageRoomRepository(viewerChannelRole) ? (
            <>
              <TouchableOpacity
                accessibilityLabel={
                  roomRepository
                    ? `Change repo, currently ${roomRepository.binding.name}`
                    : 'Link a repo'
                }
                accessibilityRole="button"
                disabled={roomRepoBusy}
                onPress={() => void handleToggleRoomRepoPicker()}
                style={styles.roomRenameAction}
                testID="room-repo-action"
              >
                <View style={styles.roomLifecycleCopy}>
                  <Text style={styles.roomLifecycleTitle}>
                    REPO{' '}
                    {roomRepository ? `· ${roomRepository.binding.name} · CHANGE` : '· NONE · LINK'}
                  </Text>
                  <Text style={styles.roomLifecycleHint}>
                    {roomRepository
                      ? `${CORNER_LABEL}s in this ${ROOM_LABEL} tree off this repo.`
                      : `A ${ROOM_LABEL} needs a repo before a ${CORNER_LABEL} can open.`}
                  </Text>
                </View>
                <Text style={styles.roomLifecycleGlyph}>{showRoomRepoPicker ? '⌄' : '▢'}</Text>
              </TouchableOpacity>
              {showRoomRepoPicker && (
                <RepoPicker
                  busy={roomRepoBusy}
                  candidates={roomRepoCandidates}
                  installations={githubInstallations}
                  currentKey={roomRepository?.binding.key ?? null}
                  error={roomRepoError}
                  notice={roomRepoNotice}
                  ownerGrant={ownerGrant}
                  uncoveredOwners={uncoveredOwnersRef.current}
                  onAddAccount={() => void handleAddGitHubAccount()}
                  onAskOwnerGrant={(fullName) => void handleAskOwnerGrant(fullName)}
                  onCreateRepository={handleCreateGitHubRepository}
                  onManageInstallation={(installation) =>
                    void handleManageGitHubInstallation(installation)
                  }
                  onSelect={handleSelectRoomRepoCandidate}
                  testIDPrefix="room-repo-picker"
                />
              )}
              {roomRepository && (
                <TouchableOpacity
                  accessibilityLabel={
                    roomRepository.githubEventsEnabled === false
                      ? 'Turn repository activity notices on'
                      : 'Turn repository activity notices off'
                  }
                  accessibilityRole="button"
                  disabled={roomRepoBusy}
                  onPress={() => void handleToggleGitHubEvents()}
                  style={styles.roomRenameAction}
                  testID="room-github-events-toggle"
                >
                  <View style={styles.roomLifecycleCopy}>
                    <Text style={styles.roomLifecycleTitle}>
                      REPO ACTIVITY{'\u00b7'}
                      {roomRepository.githubEventsEnabled === false ? ' OFF' : ' ON'}
                    </Text>
                    <Text style={styles.roomLifecycleHint}>
                      Pushes, pull requests, issues, CI, and reviews posted here.
                    </Text>
                  </View>
                  <Text style={styles.roomLifecycleGlyph}>
                    {roomRepository.githubEventsEnabled === false ? '○' : '●'}
                  </Text>
                </TouchableOpacity>
              )}
            </>
          ) : (
            <View style={styles.roomRenameAction} testID="room-repo-readonly">
              <View style={styles.roomLifecycleCopy}>
                <Text style={styles.roomLifecycleTitle}>
                  REPO {roomRepository ? `· ${roomRepository.binding.name}` : '· NONE'}
                </Text>
              </View>
            </View>
          )}
          {lifecycleAction === 'delete' ? (
            <TouchableOpacity
              accessibilityLabel={`Delete ${ROOM_LABEL}`}
              accessibilityRole="button"
              disabled={roomLifecycleBusy}
              onPress={handleRoomLifecycle}
              style={styles.roomLifecycleAction}
              testID="delete-room-action"
            >
              <View style={styles.roomLifecycleCopy}>
                <Text style={[styles.roomLifecycleTitle, styles.roomLifecycleDanger]}>
                  {roomLifecycleBusy ? 'DELETING…' : `DELETE ${ROOM_LABEL.toUpperCase()}`}
                </Text>
                <Text style={styles.roomLifecycleHint}>Permanently remove this Room.</Text>
              </View>
              <Text style={[styles.roomLifecycleGlyph, styles.roomLifecycleDanger]}>□</Text>
            </TouchableOpacity>
          ) : lifecycleAction === 'leave' ? (
            <TouchableOpacity
              accessibilityLabel={`Leave ${ROOM_LABEL}`}
              accessibilityRole="button"
              disabled={roomLifecycleBusy}
              onPress={handleRoomLifecycle}
              style={styles.roomLifecycleAction}
              testID="leave-room-action"
            >
              <View style={styles.roomLifecycleCopy}>
                <Text style={[styles.roomLifecycleTitle, styles.roomLifecycleDanger]}>
                  {roomLifecycleBusy ? 'LEAVING…' : `LEAVE ${ROOM_LABEL.toUpperCase()}`}
                </Text>
                <Text style={styles.roomLifecycleHint}>Other members keep their access.</Text>
              </View>
              <Text style={[styles.roomLifecycleGlyph, styles.roomLifecycleDanger]}>↗</Text>
            </TouchableOpacity>
          ) : null}
          {(renameError || membershipError) && (
            <View accessibilityRole="alert" style={styles.membershipError}>
              <Text style={styles.membershipErrorText}>! {renameError ?? membershipError}</Text>
            </View>
          )}
        </HullFloatingSurface>
      </HullModal>

      <HullModal
        accessibilityLabel={`Close ${CORNER_LABEL} actions`}
        contentStyle={{ paddingHorizontal: 16, paddingBottom: Math.max(insets.bottom, 18) }}
        onRequestClose={() => setCornerActionsVisible(false)}
        placement="bottom"
        visible={cornerActionsVisible}
      >
        <HullFloatingSurface style={styles.roomActionsModal} testID="corner-actions-sheet">
          <View style={styles.roomActionsModalHeading}>
            <View style={styles.roomActionsModalCopy}>
              <Text style={styles.roomActionsModalEyebrow}>{CORNER_LABEL.toUpperCase()}</Text>
              <Text numberOfLines={1} style={styles.roomActionsModalTitle}>
                {headerTitle ?? cornerAgentDisplay?.name ?? CORNER_LABEL}
              </Text>
            </View>
            <TouchableOpacity
              accessibilityLabel={`Close ${CORNER_LABEL} actions`}
              onPress={() => setCornerActionsVisible(false)}
              style={styles.roomActionsModalClose}
            >
              <Text style={styles.roomActionsModalCloseText}>×</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            accessibilityLabel={`Close ${CORNER_LABEL}`}
            accessibilityRole="button"
            onPress={() => {
              setCornerActionsVisible(false);
              void handleCloseCorner();
            }}
            style={styles.roomLifecycleAction}
            testID="close-corner-action"
          >
            <View style={styles.roomLifecycleCopy}>
              <Text style={[styles.roomLifecycleTitle, styles.roomLifecycleDanger]}>
                CLOSE {CORNER_LABEL.toUpperCase()}
              </Text>
              <Text style={styles.roomLifecycleHint}>
                Ends the edit session and archives this {CORNER_LABEL}. Unmerged work is lost.
              </Text>
            </View>
            <Text style={[styles.roomLifecycleGlyph, styles.roomLifecycleDanger]}>■</Text>
          </TouchableOpacity>
        </HullFloatingSurface>
      </HullModal>

      <HullModal
        accessibilityLabel="Close Room member picker"
        onRequestClose={() => setParticipantPickerVisible(false)}
        placement="center"
        visible={participantPickerVisible}
      >
        <HullFloatingSurface style={styles.memberModal}>
          <View style={styles.memberModalHeading}>
            <View style={styles.memberModalHeadingCopy}>
              <Text style={styles.memberModalTitle}>
                {participantPickerKind === 'agent'
                  ? 'Add an Agent'
                  : participantPickerKind === 'person'
                    ? 'Invite a person'
                    : 'Add people or Agents'}
              </Text>
            </View>
            <TouchableOpacity
              accessibilityLabel="Close Room member picker"
              onPress={() => setParticipantPickerVisible(false)}
              style={styles.memberModalClose}
            >
              <Text style={styles.memberModalCloseText}>×</Text>
            </TouchableOpacity>
          </View>

          <ScrollView
            contentContainerStyle={styles.memberPickerContent}
            showsVerticalScrollIndicator={false}
          >
            {[
              { key: 'in-room', label: 'IN ROOM', options: participantPickerSections.inRoom },
              {
                key: 'addable',
                label: 'ADD',
                options: participantPickerSections.addable,
              },
            ].map((section, sectionIndex) =>
              section.options.length > 0 ? (
                <View key={section.key}>
                  <Text
                    style={[
                      styles.memberSectionLabel,
                      sectionIndex > 0 && styles.memberSectionLabelSpaced,
                    ]}
                  >
                    {section.label}
                  </Text>
                  {section.options.map((option) => {
                    const inRoom = section.key === 'in-room';
                    const adding = addingMemberPubkey === option.pubkey;
                    const isSelf = option.pubkey === userPubkey;
                    const display = option.agent
                      ? resolveAgentDisplayIdentity(option.pubkey, option.agent)
                      : undefined;
                    return (
                      <View
                        key={option.pubkey}
                        style={[styles.memberPickerRow, inRoom && styles.memberPickerRowPlaced]}
                        testID={`add-room-member-${option.pubkey}`}
                      >
                        <View style={styles.memberPickerIdentity}>
                          {display ? (
                            <IdentityMark
                              kind="agent"
                              seed={display.avatarSeed ?? option.pubkey}
                              avatarUrl={display.avatarUrl}
                              name={display.name}
                              size={28}
                            />
                          ) : (
                            <IdentityMark
                              kind="human"
                              seed={option.pubkey}
                              avatarUrl={personProfileByPubkey.get(option.pubkey)?.avatar}
                              name={option.name}
                              size={28}
                            />
                          )}
                          <View style={styles.memberPickerCopy}>
                            <Text numberOfLines={1} style={styles.memberPickerName}>
                              @{option.name}
                            </Text>
                            <Text style={styles.memberPickerNpub}>
                              {option.kind === 'agent' ? 'AGENT' : 'PERSON'}
                            </Text>
                          </View>
                        </View>
                        <View style={styles.memberPickerActions}>
                          {!isSelf && (
                            <TouchableOpacity
                              accessibilityLabel={`Message ${option.name}`}
                              disabled={Boolean(addingMemberPubkey)}
                              onPress={() => void handleStartDirectMessage(option)}
                              style={styles.memberPickerActionButton}
                              testID={`message-room-member-${option.pubkey}`}
                            >
                              <Text style={styles.memberPickerAction}>MESSAGE</Text>
                            </TouchableOpacity>
                          )}
                          {!inRoom && (
                            <TouchableOpacity
                              accessibilityLabel={`Add ${option.name}`}
                              disabled={Boolean(addingMemberPubkey)}
                              onPress={() => void handleAddRoomMember(option)}
                              style={styles.memberPickerActionButton}
                            >
                              <Text style={styles.memberPickerAction}>
                                {adding ? 'ADDING…' : '＋ ADD'}
                              </Text>
                            </TouchableOpacity>
                          )}
                          {isSelf && <Text style={styles.memberPickerAction}>YOU</Text>}
                        </View>
                      </View>
                    );
                  })}
                </View>
              ) : null,
            )}
            {participantPickerOptions.length === 0 && (
              <Text style={styles.memberPickerEmpty}>Workspace roster is empty</Text>
            )}
          </ScrollView>

          {membershipError && (
            <View accessibilityRole="alert" style={styles.membershipError}>
              <Text style={styles.membershipErrorText}>! {membershipError}</Text>
            </View>
          )}
        </HullFloatingSurface>
      </HullModal>
    </BuzzCommunityShell>
  );
}

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
    container: {
      flex: 1,
      backgroundColor: groknight.bgTerminal,
    },
    center: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    hydrationErrorHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: 60,
      paddingHorizontal: 12,
      paddingBottom: 8,
      borderBottomWidth: 1,
      borderBottomColor: groknight.border,
      backgroundColor: groknight.bgBase,
    },
    hydrationErrorBody: {
      flex: 1,
      alignItems: 'flex-start',
      justifyContent: 'center',
      paddingHorizontal: 28,
    },
    errorLabel: {
      ...Typography.mono('semiBold'),
      color: groknight.accent,
      fontSize: 10,
      lineHeight: 14,
      letterSpacing: 0.8,
    },
    hydrationErrorText: {
      ...Typography.default(),
      marginTop: 10,
      color: groknight.textSecondary,
      fontSize: 16,
      lineHeight: 23,
    },
    hydrationErrorRetry: { marginTop: 20 },
    loadingText: {
      ...Typography.mono('semiBold'),
      marginTop: 12,
      fontSize: 11,
      lineHeight: 15,
      letterSpacing: 0.8,
      color: groknight.textMuted,
    },

    // ── Header ──────────────────────────────────────────────────────
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingBottom: 8,
      borderBottomWidth: 1,
      borderBottomColor: groknight.border,
      backgroundColor: groknight.bgBase,
    },
    backButton: {
      width: 44,
      height: 44,
      marginRight: 8,
      alignItems: 'center',
      justifyContent: 'center',
    },
    backText: {
      ...Typography.default(),
      fontSize: 22,
      color: groknight.muted,
    },
    cornerBackText: { ...Typography.mono(), color: groknight.textMuted },
    // The single agent's faceted mark, stated once for the whole corner — the
    // slot itself is the shared HeaderIdentitySlot primitive.
    headerCenter: {
      flex: 1,
      minHeight: 44,
      minWidth: 0,
      justifyContent: 'center',
    },
    channelName: {
      ...Typography.default('semiBold'),
      fontSize: 20,
      lineHeight: 24,
      color: groknight.textPrimary,
    },
    // A corner's name is a slug, not a title — set it at label scale so it
    // reads as an identifier beside the agent's mark rather than a headline.
    cornerChannelName: {
      ...Typography.mono('semiBold'),
      fontSize: 15,
      lineHeight: 19,
      letterSpacing: 0.2,
      color: groknight.textPrimary,
    },
    // Stands in for the name until the channel's own read lands, so the header
    // never has to guess between "Room" and a corner slug.
    channelNameSkeleton: {
      width: 132,
      height: 13,
      marginVertical: 5,
      backgroundColor: groknight.bgHover,
      borderRadius: groknight.radius,
    },
    cornerChannelNameSkeleton: { width: 108 },
    repoChip: { alignSelf: 'flex-start', marginTop: 2, maxWidth: '100%' },
    cornerHeaderAgent: {
      ...Typography.mono('semiBold'),
      flexShrink: 0,
      color: groknight.textSecondary,
      fontSize: 10,
      lineHeight: 14,
      letterSpacing: 0.7,
    },
    cornerHeaderState: { width: 14, height: 14, marginHorizontal: 4 },
    addMembersButton: {
      width: 44,
      minHeight: 44,
      marginLeft: 8,
      alignItems: 'center',
      justifyContent: 'center',
    },
    addMembersGlyph: {
      ...Typography.default('semiBold'),
      color: groknight.chrome,
      fontSize: 24,
      lineHeight: 28,
    },
    roomActionsButton: {
      minWidth: 44,
      minHeight: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    roomActionsGlyph: {
      ...Typography.default('semiBold'),
      color: groknight.steel,
      fontSize: 12,
      lineHeight: 16,
      letterSpacing: 1.2,
    },
    archivedBadge: {
      backgroundColor: groknight.bgHighlight,
      borderRadius: groknight.radius,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    archivedBadgeText: {
      ...Typography.mono('semiBold'),
      color: groknight.textMuted,
      fontSize: 11,
      lineHeight: 15,
    },
    // ── Room lifecycle menu ─────────────────────────────────────────
    roomActionsModal: {
      width: '100%',
      maxWidth: 460,
      padding: 16,
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      backgroundColor: groknight.bgRaised,
    },
    roomActionsModalHeading: {
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 12,
    },
    roomActionsModalCopy: { flex: 1, minWidth: 0 },
    roomActionsModalEyebrow: {
      ...Typography.mono('semiBold'),
      color: groknight.textMuted,
      fontSize: 9,
      lineHeight: 12,
      letterSpacing: 0.8,
    },
    roomActionsModalTitle: {
      ...Typography.default('semiBold'),
      marginTop: 4,
      color: groknight.textPrimary,
      fontSize: 19,
      lineHeight: 24,
    },
    roomActionsModalClose: {
      width: 44,
      height: 44,
      marginTop: -10,
      marginRight: -10,
      alignItems: 'center',
      justifyContent: 'center',
    },
    roomActionsModalCloseText: {
      ...Typography.default(),
      color: groknight.steel,
      fontSize: 24,
    },
    roomRenameAction: {
      minHeight: 66,
      marginTop: 18,
      paddingHorizontal: 12,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      backgroundColor: groknight.bgBase,
    },
    roomRenameEditor: {
      marginTop: 18,
      padding: 12,
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      backgroundColor: groknight.bgBase,
    },
    roomRenameLabel: {
      ...Typography.mono('semiBold'),
      color: groknight.textMuted,
      fontSize: 9,
      lineHeight: 12,
      letterSpacing: 0.7,
    },
    roomRenameInput: {
      ...Typography.default('semiBold'),
      minHeight: 44,
      marginTop: 8,
      paddingHorizontal: 0,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: groknight.borderStrong,
      color: groknight.textPrimary,
      fontSize: 16,
    },
    roomRenameControls: {
      marginTop: 10,
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 8,
    },
    roomRenameCancel: {
      minHeight: 40,
      paddingHorizontal: 14,
      alignItems: 'center',
      justifyContent: 'center',
    },
    roomRenameCancelText: {
      ...Typography.mono('semiBold'),
      color: groknight.textMuted,
      fontSize: 10,
      letterSpacing: 0.6,
    },
    roomRenameApply: {
      minHeight: 40,
      paddingHorizontal: 18,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: groknight.accent,
      backgroundColor: groknight.accent,
    },
    roomRenameApplyDisabled: { opacity: 0.45 },
    roomRenameApplyText: {
      ...Typography.mono('semiBold'),
      color: groknight.textInverted,
      fontSize: 10,
      letterSpacing: 0.6,
    },
    roomLifecycleAction: {
      minHeight: 66,
      marginTop: 18,
      paddingHorizontal: 12,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      backgroundColor: groknight.bgBase,
    },
    roomLifecycleCopy: { flex: 1, minWidth: 0 },
    roomLifecycleTitle: {
      ...Typography.mono('semiBold'),
      color: groknight.textPrimary,
      fontSize: 10,
      lineHeight: 14,
      letterSpacing: 0.6,
    },
    roomLifecycleHint: {
      ...Typography.default(),
      marginTop: 3,
      color: groknight.textMuted,
      fontSize: 11,
      lineHeight: 15,
    },
    roomLifecycleGlyph: {
      ...Typography.default(),
      color: groknight.steel,
      fontSize: 17,
      lineHeight: 22,
    },
    roomLifecycleDanger: { color: groknight.dialogDanger },
    // ── Room membership picker ─────────────────────────────────────
    memberModal: {
      width: '100%',
      maxWidth: 460,
      maxHeight: '78%',
      padding: 16,
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      backgroundColor: groknight.bgRaised,
    },
    memberModalHeading: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
    memberModalHeadingCopy: { flex: 1, minWidth: 0 },
    memberModalTitle: {
      ...Typography.default('semiBold'),
      color: groknight.textPrimary,
      fontSize: 17,
      lineHeight: 22,
    },
    memberModalClose: {
      width: 44,
      height: 44,
      marginTop: -10,
      marginRight: -10,
      alignItems: 'center',
      justifyContent: 'center',
    },
    memberModalCloseText: { ...Typography.default(), color: groknight.steel, fontSize: 24 },
    memberPickerContent: { paddingTop: 18, paddingBottom: 4 },
    memberSectionLabel: {
      ...Typography.mono('semiBold'),
      marginBottom: 7,
      color: groknight.textMuted,
      fontSize: 9,
      lineHeight: 12,
      letterSpacing: 0.7,
    },
    memberSectionLabelSpaced: { marginTop: 18 },
    memberPickerRow: {
      minHeight: 58,
      paddingHorizontal: 10,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      borderTopWidth: 1,
      borderColor: groknight.border,
      backgroundColor: groknight.bgBase,
    },
    memberPickerRowPlaced: { opacity: 0.58 },
    memberPickerIdentity: {
      flex: 1,
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    memberPickerCopy: { flex: 1, minWidth: 0 },
    memberPickerName: {
      ...Typography.default('semiBold'),
      color: groknight.textSecondary,
      fontSize: 12,
    },
    memberPickerNpub: {
      ...Typography.mono(),
      marginTop: 2,
      color: groknight.textMuted,
      fontSize: 9,
    },
    memberPickerActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    memberPickerActionButton: {
      minHeight: 44,
      paddingHorizontal: 8,
      alignItems: 'center',
      justifyContent: 'center',
    },
    memberPickerAction: {
      ...Typography.mono('semiBold'),
      color: groknight.chrome,
      fontSize: 9,
      letterSpacing: 0.3,
    },
    memberPickerEmpty: {
      ...Typography.default(),
      paddingVertical: 24,
      color: groknight.textMuted,
      fontSize: 12,
      textAlign: 'center',
    },
    membershipError: {
      marginTop: 10,
      padding: 10,
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      backgroundColor: groknight.bgHighlight,
    },
    membershipErrorText: {
      ...Typography.default('semiBold'),
      color: groknight.textSecondary,
      fontSize: 11,
      lineHeight: 16,
    },

    // ── Message blocks ──────────────────────────────────────────────
    messageList: {
      flex: 1,
    },
    messageListContent: {
      paddingHorizontal: 12,
      paddingVertical: 12,
    },
    messageListContentEmpty: {
      flexGrow: 1,
    },
    outboxFailure: {
      marginTop: 4,
      marginHorizontal: 8,
      padding: 8,
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      backgroundColor: groknight.bgHighlight,
    },
    outboxFailureText: {
      ...Typography.mono('semiBold'),
      color: groknight.textPrimary,
      fontSize: 9,
      letterSpacing: 0.5,
    },
    outboxFailureActions: {
      flexDirection: 'row',
      gap: 8,
      marginTop: 6,
    },
    replySwipeAction: {
      width: 78,
      marginBottom: 8,
      alignItems: 'center',
      justifyContent: 'center',
      borderLeftWidth: 1,
      borderLeftColor: groknight.borderStrong,
      backgroundColor: groknight.bgHighlight,
    },
    replySwipeGlyph: {
      ...Typography.default('semiBold'),
      color: groknight.textPrimary,
      fontSize: 17,
      lineHeight: 20,
    },
    replySwipeLabel: {
      ...Typography.mono('semiBold'),
      marginTop: 2,
      color: groknight.textMuted,
      fontSize: 8,
      lineHeight: 11,
      letterSpacing: 0.6,
    },
    /* A person reaching back up the transcript quotes what they reached for, on
     * one dim line and with no rule beside it — the ledger has no delimiters. */
    replyReference: {
      minWidth: 0,
      marginBottom: 5,
    },
    replyReferenceText: {
      ...Typography.mono(),
      color: groknight.ledgerGhost,
      fontSize: 11,
      lineHeight: 17,
    },
    /* An attachment hangs off the message that carries it: a row, not a card. */
    attachmentCard: {
      minWidth: 0,
      width: '100%',
      minHeight: 58,
      marginTop: 8,
      paddingVertical: 6,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 9,
    },
    attachmentThumbnail: {
      width: 46,
      height: 46,
      backgroundColor: groknight.bgHighlight,
    },
    attachmentFileGlyph: {
      width: 46,
      height: 46,
      alignItems: 'center',
      justifyContent: 'center',
    },
    attachmentFileGlyphText: {
      ...Typography.default(),
      color: groknight.steel,
      fontSize: 20,
    },
    attachmentCopy: { flex: 1, minWidth: 0 },
    attachmentName: {
      ...Typography.default('semiBold'),
      color: groknight.textPrimary,
      fontSize: 12,
      lineHeight: 16,
    },
    attachmentMeta: {
      ...Typography.mono(),
      marginTop: 3,
      color: groknight.textMuted,
      fontSize: 8,
      lineHeight: 11,
    },
    attachmentOpenGlyph: {
      ...Typography.default(),
      width: 22,
      color: groknight.steel,
      fontSize: 14,
      textAlign: 'center',
    },

    // ── The ledger ─────────────────────────────────────────────────
    // A turn's whole tool run folds into one line here; the group itself is
    // pure rhythm, with no rule or fill separating it from the prose around it.
    // Every other transcript shape lives in components/buzz/Ledger.tsx, which
    // Rooms and Corners share.
    activityGroup: {
      width: '100%',
      minWidth: 0,
      marginBottom: 20,
    },

    agentPresenceLight: {
      width: 9,
      height: 9,
      borderRadius: groknight.radius,
      borderWidth: 1,
      borderColor: groknight.textSecondary,
    },
    agentPresenceOnline: { backgroundColor: groknight.textSecondary },
    agentPresenceOffline: { backgroundColor: 'transparent' },
    // ── Archived notice ─────────────────────────────────────────────
    archivedBubble: {
      paddingVertical: 8,
      marginBottom: 20,
      alignSelf: 'center',
      maxWidth: '90%',
    },
    archivedText: {
      ...Typography.mono(),
      fontSize: 11,
      lineHeight: 16,
      letterSpacing: 0.8,
      color: groknight.ledgerQuiet,
      textAlign: 'center',
    },

    // ── Offline notice (client-rendered only) ─────────────────────────
    systemNoticeBubble: {
      paddingVertical: 8,
      marginBottom: 20,
      alignSelf: 'center',
      maxWidth: '90%',
    },
    systemNoticeText: {
      ...Typography.ledger(),
      color: groknight.ledgerQuiet,
      textAlign: 'center',
    },

    // ── Approval bar ────────────────────────────────────────────────
    approvalBar: {
      paddingHorizontal: 16,
      paddingVertical: 14,
      backgroundColor: groknight.bgTerminal,
      borderBottomWidth: 1,
      borderBottomColor: groknight.border,
      gap: 8,
    },
    approvalInfo: {
      gap: 4,
    },
    prChip: {
      ...Typography.mono(),
      fontSize: 12,
      color: groknight.textPrimary,
    },
    approvalBarText: {
      ...Typography.mono(),
      fontSize: 11,
      lineHeight: 16,
      color: groknight.textSecondary,
    },
    approveButton: {
      minHeight: 64,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 3,
      paddingHorizontal: 14,
      borderWidth: 2,
      borderColor: MERGE_APPROVAL_ACCENT,
      borderRadius: groknight.radius,
      backgroundColor: MERGE_APPROVAL_ACCENT,
    },
    approveButtonText: {
      ...Typography.mono('semiBold'),
      color: groknight.textInverted,
      fontSize: 13,
      lineHeight: 18,
      letterSpacing: 0.3,
      textAlign: 'center',
    },
    approveButtonSupport: {
      ...Typography.default('semiBold'),
      color: groknight.textInverted,
      fontSize: 8,
      lineHeight: 12,
      letterSpacing: 0.45,
      textAlign: 'center',
    },
    approvalPending: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: 10,
    },
    approvalStateText: {
      ...Typography.mono(),
      fontSize: 11,
      color: groknight.textMuted,
    },
    approvalSent: {
      paddingVertical: 10,
      alignItems: 'center',
    },
    approvalSentText: {
      ...Typography.mono(),
      color: groknight.textPrimary,
      fontSize: 12,
    },
    cornerReviewFooter: {
      paddingTop: 12,
    },
    nothingReady: {
      marginHorizontal: 16,
      padding: 14,
      gap: 4,
    },
    nothingReadyTitle: {
      ...Typography.default('semiBold'),
      color: groknight.textSecondary,
      fontSize: 11,
      lineHeight: 15,
    },
    nothingReadyText: {
      ...Typography.default(),
      color: groknight.textMuted,
      fontSize: 11,
      lineHeight: 16,
    },
    // ── Composer ────────────────────────────────────────────────────
    emptyState: {
      flexGrow: 1,
    },
    olderMessagesLoading: {
      paddingVertical: 12,
      alignItems: 'center',
    },
    inputBar: {
      paddingHorizontal: 8,
      paddingTop: 8,
      borderTopWidth: 1,
      borderTopColor: groknight.border,
      backgroundColor: groknight.bgTerminal,
    },
    agentOfflineHint: {
      minWidth: 0,
      marginBottom: 7,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      backgroundColor: groknight.bgBase,
    },
    agentOfflineHintTitle: {
      ...Typography.mono('semiBold'),
      color: groknight.textPrimary,
      fontSize: 10,
      lineHeight: 14,
      letterSpacing: 0.55,
    },
    agentOfflineHintText: {
      ...Typography.default(),
      marginTop: 3,
      color: groknight.textMuted,
      fontSize: 11,
      lineHeight: 15,
    },
    previewLinkRow: {
      marginTop: 6,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      minWidth: 0,
    },
    previewLinkLabel: {
      ...Typography.mono('semiBold'),
      color: groknight.textPrimary,
      fontSize: 9,
      lineHeight: 14,
      letterSpacing: 0.5,
      flexShrink: 0,
    },
    previewLinkUrl: {
      ...Typography.mono(),
      color: groknight.textMuted,
      fontSize: 9,
      lineHeight: 14,
      flexShrink: 1,
      minWidth: 0,
    },
    targetBranchCard: {
      minWidth: 0,
      marginBottom: 8,
      paddingHorizontal: 14,
      paddingVertical: 14,
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      gap: 8,
    },
    targetBranchTitle: {
      ...Typography.default('semiBold'),
      color: groknight.textPrimary,
      fontSize: 13,
      lineHeight: 18,
    },
    targetBranchChange: {
      ...Typography.mono('semiBold'),
      color: groknight.textPrimary,
      fontSize: 12,
      lineHeight: 17,
      letterSpacing: 0.35,
    },
    targetBranchBoundary: {
      ...Typography.default(),
      color: groknight.textSecondary,
      fontSize: 12,
      lineHeight: 17,
    },
    targetBranchActions: { flexDirection: 'row', gap: 8 },
    targetBranchButton: { flex: 1, minWidth: 0 },
    targetBranchStatus: {
      ...Typography.mono('semiBold'),
      color: groknight.textSecondary,
      fontSize: 9,
      lineHeight: 14,
      letterSpacing: 0.5,
    },
    writePermissionCard: {
      minWidth: 0,
      marginBottom: 8,
      paddingHorizontal: 14,
      paddingVertical: 14,
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      gap: 10,
    },
    githubEventPressable: { marginBottom: 8 },
    githubEventCard: {
      minWidth: 0,
      paddingHorizontal: 14,
      paddingVertical: 13,
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      gap: 6,
    },
    githubEventTitle: {
      ...Typography.default('semiBold'),
      color: groknight.textPrimary,
      fontSize: 13,
      lineHeight: 19,
    },
    githubEventLink: {
      ...Typography.mono('semiBold'),
      color: groknight.textSecondary,
      fontSize: 10,
      lineHeight: 14,
      letterSpacing: 0.45,
    },
    writePermissionHeading: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    writePermissionCopy: { flex: 1, minWidth: 0 },
    writePermissionTitle: {
      ...Typography.default('semiBold'),
      color: groknight.textPrimary,
      fontSize: 13,
      lineHeight: 18,
    },
    writePermissionIntent: {
      ...Typography.default(),
      color: groknight.textMuted,
      fontSize: 11,
      lineHeight: 15,
      marginTop: 2,
    },
    writePermissionRepository: {
      ...Typography.mono('semiBold'),
      color: groknight.textPrimary,
      fontSize: 11,
      lineHeight: 16,
      letterSpacing: 0.35,
    },
    writePermissionBoundary: {
      ...Typography.default(),
      color: groknight.textSecondary,
      fontSize: 12,
      lineHeight: 17,
    },
    writePermissionFailure: {
      ...Typography.mono(),
      color: groknight.textSecondary,
      fontSize: 10,
      lineHeight: 15,
    },
    writePermissionActions: { flexDirection: 'row', gap: 8 },
    writePermissionButton: { flex: 1, minWidth: 0 },
    writePermissionStatus: {
      ...Typography.mono('semiBold'),
      color: groknight.textSecondary,
      fontSize: 9,
      lineHeight: 14,
      letterSpacing: 0.5,
    },
    mentionMenu: {
      marginBottom: 6,
      overflow: 'hidden',
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      borderRadius: groknight.radius,
      backgroundColor: groknight.bgBase,
    },
    mentionMenuLabel: {
      ...Typography.mono('semiBold'),
      paddingHorizontal: 10,
      paddingVertical: 5,
      color: groknight.textMuted,
      fontSize: 9,
      lineHeight: 12,
      letterSpacing: 0.7,
    },
    mentionRow: {
      minHeight: 46,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 9,
      paddingHorizontal: 9,
      paddingVertical: 6,
      borderTopWidth: 1,
      borderTopColor: groknight.border,
    },
    mentionRowSelected: {
      backgroundColor: groknight.selection,
    },
    mentionIdentity: {
      flex: 1,
      minWidth: 0,
    },
    mentionName: {
      ...Typography.default('semiBold'),
      color: groknight.textPrimary,
      fontSize: 12,
      lineHeight: 15,
    },
    mentionHandle: {
      ...Typography.mono(),
      color: groknight.textMuted,
      fontSize: 10,
      lineHeight: 13,
    },
    mentionKind: {
      ...Typography.mono('semiBold'),
      color: groknight.faint,
      fontSize: 8,
      letterSpacing: 0.5,
    },
    mentionOverflow: {
      ...Typography.mono('semiBold'),
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderTopWidth: 1,
      borderTopColor: groknight.border,
      color: groknight.textMuted,
      fontSize: 9,
      lineHeight: 12,
      letterSpacing: 0.4,
    },
    replyComposerBanner: {
      minWidth: 0,
      minHeight: 48,
      marginBottom: 6,
      paddingLeft: 10,
      flexDirection: 'row',
      alignItems: 'center',
      borderLeftWidth: 3,
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      backgroundColor: groknight.bgHighlight,
    },
    replyComposerCopy: { flex: 1, minWidth: 0, paddingVertical: 7 },
    replyComposerLabel: {
      ...Typography.mono('semiBold'),
      color: groknight.textPrimary,
      fontSize: 9,
      lineHeight: 13,
      letterSpacing: 0.35,
    },
    replyComposerPreview: {
      ...Typography.default(),
      marginTop: 2,
      color: groknight.textMuted,
      fontSize: 11,
      lineHeight: 15,
    },
    replyComposerCancel: {
      width: 44,
      minHeight: 46,
      alignItems: 'center',
      justifyContent: 'center',
    },
    replyComposerCancelText: {
      ...Typography.default(),
      color: groknight.textSecondary,
      fontSize: 20,
    },
    repoPromptBanner: {
      minWidth: 0,
      marginBottom: 6,
      padding: 10,
      borderLeftWidth: 3,
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      backgroundColor: groknight.bgHighlight,
    },
    repoPromptTitle: {
      ...Typography.mono('semiBold'),
      color: groknight.textPrimary,
      fontSize: 11,
      letterSpacing: 0.35,
    },
    repoPromptHint: {
      ...Typography.default(),
      marginTop: 2,
      color: groknight.textMuted,
      fontSize: 12,
    },
    repoPromptConnect: { minHeight: 40, justifyContent: 'center', marginTop: 6 },
    repoPromptConnectText: {
      ...Typography.default('semiBold'),
      color: groknight.accent,
      fontSize: 12,
    },
    repoPromptDismiss: { alignSelf: 'flex-end', minHeight: 32, justifyContent: 'center' },
    repoPromptDismissText: {
      ...Typography.mono(),
      color: groknight.textSecondary,
      fontSize: 11,
    },
    pendingAttachment: {
      minWidth: 0,
      minHeight: 44,
      marginBottom: 6,
      paddingLeft: 10,
      flexDirection: 'row',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      backgroundColor: groknight.bgHighlight,
    },
    pendingAttachmentCopy: { flex: 1, minWidth: 0 },
    pendingAttachmentName: {
      ...Typography.default('semiBold'),
      color: groknight.textPrimary,
      fontSize: 11,
      lineHeight: 15,
    },
    pendingAttachmentMeta: {
      ...Typography.mono(),
      color: groknight.textMuted,
      fontSize: 8,
      lineHeight: 11,
    },
    pendingAttachmentRemove: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pendingAttachmentRemoveText: {
      ...Typography.default(),
      color: groknight.textSecondary,
      fontSize: 20,
    },
    composer: {
      minHeight: 46,
      maxHeight: 126,
      flexDirection: 'row',
      alignItems: 'flex-end',
      paddingVertical: 3,
      paddingHorizontal: 10,
      borderRadius: groknight.radius,
      borderWidth: 1,
      borderColor: groknight.border,
      backgroundColor: groknight.bgBase,
    },
    composerFocused: { borderWidth: 2, borderColor: groknight.focus, paddingHorizontal: 9 },
    attachButton: {
      width: 40,
      height: 40,
      marginLeft: -6,
      marginRight: 2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    attachButtonText: {
      ...Typography.default(),
      color: groknight.textMuted,
      fontSize: 18,
      lineHeight: 22,
    },
    input: {
      ...Typography.default(),
      flex: 1,
      fontSize: 14,
      lineHeight: 20,
      color: groknight.textSecondary,
      minHeight: 40,
      maxHeight: 120,
      paddingVertical: 10,
      textAlignVertical: 'top',
    },
    sendButton: {
      width: 40,
      height: 40,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sendButtonDisabled: {
      backgroundColor: groknight.bgBase,
    },
    sendButtonText: {
      ...Typography.default(),
      color: groknight.textPrimary,
      fontSize: 16,
    },
    sendButtonTextQuiet: { color: groknight.textDisabled },
    archivedInputBar: {
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 8,
      borderTopWidth: 1,
      borderTopColor: groknight.border,
      backgroundColor: groknight.bgBase,
      alignItems: 'center',
    },
    archivedInputText: {
      ...Typography.default('italic'),
      fontSize: 11,
      color: groknight.muted,
      fontStyle: 'italic',
    },
    cornerArchivedInputText: { ...Typography.mono('italic'), color: groknight.textMuted },
  };
});
