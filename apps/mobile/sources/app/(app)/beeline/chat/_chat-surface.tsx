/** Room and corner conversation surface. */
import React, {
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  useCallback,
  useMemo,
  type MutableRefObject,
} from 'react';
import { transcriptBylineOpeners } from '@/buzz/message-dates';
import {
  View,
  Text,
  FlatList,
  Keyboard,
  Pressable,
  ScrollView,
  Share,
  TextInput,
  TouchableOpacity,
  Platform,
  AppState,
  useWindowDimensions,
  AccessibilityInfo,
  type ViewToken,
} from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as Notifications from 'expo-notifications';
import {
  KeyboardAvoidingView,
  useKeyboardState,
  useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  useFocusEffect,
  useLocalSearchParams,
  useNavigation,
  router,
  type Href,
} from 'expo-router';
import { loadBuzzIdentity, getEffectiveRelayUrl } from '@/auth/buzz-identity-storage';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { githubInstallationRedirectUri } from '@/auth/github-auth-session';
import { useGitHubInstallationSession } from '@/auth/github-installation-host';
import { Modal } from '@/modal';
import { BuzzRigTransport } from '@/sync/transport';
import {
  type ChannelRole,
  type RoomRepository,
  type RoomView,
  type GitHubInstallationAccess,
  type MessageReactionEmoji,
  type ChatListItem,
  AGENT_PRESENCE_STALE_MS,
  isChatListView,
} from '@beeline/buzz-client';
import type { AgentComposerCommand } from '@beeline/api-contract/phone';
import {
  createRoomMessageProjector,
  conversationIdentityByPubkey,
  displayRoomMessages,
  mergeDisplayPages,
  foldSettledActivityRuns,
  roomViewTranscriptMessages,
  type ChatDisplayMessage,
  memberAgent,
  workspaceRailItem,
} from '@/buzz/room-view-presentation';
import {
  buildChannelReferenceIndex,
  isUnavailableChannelReferenceError,
  resolveCornerFromList,
  type ChannelReferenceIndex,
  type ChannelReferenceTarget,
} from '@/buzz/channel-reference';
import { pushOpenBuzzChannelId, releaseOpenBuzzChannelId } from '@/buzz/open-room-tracker';
import { dismissPresentedNotificationsForChannel } from '@/push/presented-notifications';
import { afterInteractions } from '@/buzz/defer-interaction';
import { scheduleAnimationFrame } from '@/buzz/host-scheduler';
import { buildTurnActivity } from '@/buzz/activity-timeline';
import { cornerObjectiveItems } from '@/buzz/corner-context';
import { continuedSpeakerIds, ledgerSpeakerKey } from '@/buzz/ledger-attribution';
import { publishFailurePresentation } from '@/buzz/publish-failure';
import { ledgerStamp } from '@/buzz/relative-time';
import { anchorRelayReports, foldSystemLines } from '@/buzz/system-lines';
import { CHANGES_LABEL, CORNER_LABEL, ROOM_LABEL } from '@/buzz/vocabulary';
import {
  COMPOSER_ACK_BOUND_MS,
  STEER_RECEIVED_VISIBLE_MS,
  hasComposerAckReceipt,
  selectComposerAckPresentation,
  type ComposerAckPresentation,
} from '@/buzz/room-indicators';
import { formatTerminalTurnOverlay, type TurnVerb } from '@/buzz/turn-clock';
import { TurnBandSlot, TurnSettledLine } from '@/components/buzz/TurnProgressLine';
import { DesktopRoomInspector } from '@/components/DesktopRoomInspector';
import { DesktopWorkPaneHandle } from '@/components/DesktopWorkPaneHandle';
import { openExternalUrl } from '@/utils/open-external-url';
import { openArtifactInBrowserOrExplain } from '@/buzz/artifact-link';
import {
  subscribeDesktopArtifact,
  type DesktopArtifactSelection,
} from '@/buzz/desktop-artifact-pane';
import { RoomRepositorySubtitle } from '@/components/buzz/RoomRepositorySubtitle';
import {
  desktopComposerKeyAction,
  desktopWorkPaneMode,
  desktopWorkPaneWindowClass,
  initialDesktopWorkPaneState,
  isDesktopWorkPaneCommand,
  loadDesktopDraft,
  loadDesktopWorkPanePreference,
  saveDesktopDraft,
  saveDesktopWorkPanePreference,
  desktopWorkPaneEventApplies,
  transitionDesktopWorkPane,
  type DesktopWorkPaneEvent,
  type DesktopWorkPaneTransition,
} from '@/buzz/desktop-workbench-state';
import { useRoomSendFrame } from '@/buzz/room-send-frame';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { liveDraftMessages, projectActiveTurnStream } from '@/buzz/live-turn-stream';
import {
  activeMentionAtCursor,
  CHANNEL_MENTION_HANDLE,
  CHANNEL_MENTION_PUBKEY,
  filterMentionCandidates,
  formatRoomParticipantTotal,
  isChannelMentionHandle,
  mentionedAgentPubkey,
  orderRoomRoster,
  replaceActiveMention,
  resolveComposerMentions,
  selectedMentionAgentPubkey,
  shouldReadWorkspaceRoster,
} from '@/buzz/room-participants';
import { resolveAgentDisplayIdentity, resolvePendingAgentDisplay } from '@/buzz/agent-display';
import {
  cornerDisplayFromRoomView,
  cornerDisplayState,
  cornerHeaderAgent,
  roomViewParentId,
} from '@/buzz/corner-display-state';
import {
  directMessageHeaderName,
  fallbackMemberHandle,
  fallbackMemberName,
  personIdentityLabel,
} from '@/buzz/member-display';
import { directMessageHeaderPresence } from '@/buzz/direct-message-header-presence';
import {
  createCommunityInviteUrl,
  resolveCommunityInvitePublicOrigin,
} from '@/buzz/community-invite';
import {
  MemberPickerSheet,
  type MemberPickerCandidate,
} from '@/components/buzz/MemberPickerSheet';
import { useVerifiedNip05Status } from '@/buzz/nip05-verification';
import { confirmRoomRepositoryLink } from '@/buzz/room-management';
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
import { selectWorkingAgents } from '@/buzz/room-indicators';
import {
  roomBottomChromeStyles,
  TURN_LINE_BAR_MARGIN_BOTTOM,
  TURN_LINE_BOX_HEIGHT,
  TURN_LINE_ROW_MIN_HEIGHT,
} from '@/buzz/room-bottom-chrome';
import {
  historyAnchorKey,
  phoneTranscriptTailPadding,
  roomOpenLandsOnTail,
  shouldFollowDesktopTail,
  transcriptLandingAnchor,
  useScrollFollowOnArrival,
  useScrollFollowOnLayoutChange,
} from '@/buzz/room-scroll-follow';
import {
  loadActiveCommunityId,
  saveActiveCommunityId,
  saveLastViewedChannel,
} from '@/buzz/community-storage';
import {
  formatAttachmentSize,
  MAX_MESSAGE_ATTACHMENTS,
  pastedImageAttachment,
  pickedPhotoAttachments,
  type PickedChatAttachment,
  uploadChatAttachments,
} from '@/buzz/chat-attachment';
import {
  availableSlashVerbs,
  availableCornerAppCommands,
  slashVerbQuery,
  agentMentionSlashQuery,
  insertAgentSlashCommand,
  matchesAgentCommand,
  type BuiltInSlashVerbId,
} from '@/buzz/slash-verbs';
import {
  cachedChannelKind,
  channelHeaderTitle,
  resolveCornerViewAgentPubkey,
  type ChannelKind,
} from '@/buzz/corner-session';
import {
  chatBackAction,
  cornerOpenAction,
  cornerHref,
  resolveMentionDirectMessageAction,
  roomCornersHref,
  roomHref,
  type ChatStackRoute,
} from '@/buzz/corner-navigation';
import { isNearChatBottom } from '@/buzz/chat-scroll';
import {
  activityMessageReplyTarget,
  agentActivityReplyExcerpt,
  prepareMessageReply,
  type MessageReplyDisplayTarget,
  type MessageReplyTarget,
} from '@/buzz/message-reply';
import {
  composerBottomPadding,
  mentionKeyboardAction,
  transcriptKeyboardDismissMode,
} from '@/buzz/composer-keyboard';
import { copyEntireTurn } from '@/buzz/message-copy';
import { storeTempText } from '@/sync/persistence';
import { useRoomMessageRenderItem } from '@/buzz/room-message-cell';
import { arrivalFlashTiming, landingFlashesArrival } from '@/buzz/room-arrival-flash';
import { useRoomTranscriptHistory } from '@/buzz/use-room-transcript-history';
import {
  markRoomOpen,
  useRoomSurfaceSession,
  type RoomSurfaceSessionBindings,
  type UseRoomSurfaceSessionResult,
} from './useRoomSurfaceSession';
import {
  GitHubEventCard,
  DaemonFactCard,
  NotificationLifecycleCard,
  GrantRequestCard,
  ConnectorOfferCard,
  ChoiceCard,
  WalletCards,
  OrdinaryLedgerMessage,
  RelayHandOff,
  TargetBranchProposalCard,
  WritePermissionCard,
} from './RoomMessageVariants';
import {
  monolithPhoneOperation,
  phoneOperationFailureReason,
} from '@/sync/transport/monolith-operation';
import { publishBookmarkChange } from '@/buzz/bookmark-events';
import { isWorkspaceManagerRole } from '@/buzz/workspace-role';
import {
  forwardMessageToRoom,
  forwardTargets,
  resolveForwardTargetRoom,
  type ForwardTarget,
} from '@/buzz/message-forward';
import { visibleTranscriptWindow } from '@/buzz/transcript-presentation';
import { useArtifactReturn } from '@/buzz/use-artifact-return';
import {
  EMPTY_TRANSCRIPT_ARRIVAL_STATE,
  observeTranscriptArrivals,
} from '@/buzz/transcript-motion';
import {
  boundaryRowIndex,
  countsAsUnread,
  messageContainsBoundary,
  messageBoundaryIds,
  newestTranscriptRowId,
} from '@/buzz/room-new-message-boundary';
import { useNewMessageControl } from '@/buzz/use-new-message-control';
import { RoomCatchUpControls } from '@/components/buzz/RoomCatchUpControls';
import { RoomCatchUpSheet } from '@/components/buzz/RoomCatchUpSheet';
import { buildCatchUpReport } from '@/buzz/room-catch-up-report';
import { createTranscriptCardMotionStore } from '@/components/buzz/transcript-card-motion-context';
import {
  isAgentPresenceOnlineWithReconnectGrace,
  isAgentOfflineAfterPresenceResolved,
  isAgentTurnActive,
  nextAgentPresenceTransitionAt,
  nextAgentTurnExpiryAt,
  onlineVerdicts,
  activeMentionCandidates,
  AGENT_PRESENCE_BACKGROUND_GRACE_MS,
} from '@/buzz/agent-presence';
import {
  sameElementRefs,
  sameMessageRefMap,
  sameSelectedMembers,
  sameStringSet,
  shallowEqualRecord,
  useStable,
} from '@/buzz/use-stable';
import { BuzzCommunityShell } from '@/components/buzz/CommunityRail';
import { Typography } from '@/constants/Typography';
import { AgentOfflineHint } from '@/components/buzz/AgentOfflineHint';
import { CornerObjectiveLine } from '@/components/buzz/CornerObjectiveLine';
import { CornerStatusLine } from '@/components/buzz/CornerStatusLine';
import { TurnProgressLine } from '@/components/buzz/TurnProgressLine';
import { AttachmentPickerSheet } from '@/components/buzz/AttachmentPickerSheet';
import { ForwardMessagePickerSheet } from '@/components/buzz/ForwardMessagePickerSheet';
import { MessageReactionStrip } from '@/components/buzz/MessageReactionStrip';
import {
  HULL_SHEET_INSET,
  HullActionSheetCancel,
  HullActionSheetModal,
  HullActionSheetRow,
} from '@/components/buzz/HullActionSheet';
import { RoomRepositoryActions } from '@/components/buzz/RoomRepositoryActions';
import { CHEVRON_BACK_SIZE, ChevronGlyph } from '@/components/buzz/ChevronGlyph';
import { CornerGlyph } from '@/components/buzz/CornerGlyph';
import { OverflowGlyph } from '@/components/buzz/OverflowGlyph';
import { RoomReviewerActions } from '@/components/buzz/RoomReviewerActions';
import { EmptyLedgerState, type EmptyLedgerVariant } from '@/components/buzz/EmptyLedgerState';
import { HeaderIdentitySlot, HeaderMetaCaps, HeaderMetaRow } from '@/components/buzz/HeaderLadder';
import { ChannelHeaderTitle } from '@/components/buzz/ChannelHeaderTitle';
import type { ChannelHeaderKind } from '@/buzz/channel-header-title';
import { roomMemberManagementState } from '@/buzz/room-member-management';
import { connectorOfferCeremonyRoute } from '@/buzz/connector-offer-ceremony';
import { useIsDesktop } from '@/utils/responsive';
import { isDesktopShell } from '@/utils/isDesktopShell';
import {
  LEDGER_MARGINALIA_WIDTH,
  LedgerHistoryLine,
  LedgerRoomUpdate,
  LedgerSystemLine,
} from '@/components/buzz/Ledger';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { RoomRosterSheet, type RoomRosterParticipant } from '@/components/buzz/RoomRosterSheet';
import { RepoPicker } from '@/components/buzz/RepoPicker';
import { SlashVerbPicker } from '@/components/buzz/SlashVerbPicker';
import { CornerAppRow } from '@/components/buzz/CornerAppScreen';
import { MonoButton } from '@/components/buzz/MonoHull';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import {
  COMPOSER_MAX_INPUT_HEIGHT,
  COMPOSER_SINGLE_LINE_INPUT_HEIGHT,
  ConversationComposer,
} from '@/components/buzz/ConversationComposer';
import { subscribeDesktopWorkCorner } from '@/buzz/desktop-work-pane';

type RoomMemberOption = RoomRosterParticipant;
type MessageShortcut = { text: string; replyTarget: MessageReplyTarget };
const NO_SELECTED_MENTIONS: ReadonlyMap<string, string> = new Map();

/**
 * The reserved `@channel` autocomplete row: tags every human in the Room (the
 * parent Room, for a corner) except the author, never an agent. It is not a
 * roster member — `CHANNEL_MENTION_PUBKEY` is a sentinel, never a real
 * identity — so it rides alongside `roomParticipants` only inside the
 * mention menu's own candidate list.
 */
const CHANNEL_MENTION_OPTION: RoomMemberOption = {
  pubkey: CHANNEL_MENTION_PUBKEY,
  name: 'channel',
  handle: CHANNEL_MENTION_HANDLE,
  kind: 'person',
};

const COMPOSER_MIN_HEIGHT = COMPOSER_SINGLE_LINE_INPUT_HEIGHT;
const COMPOSER_MAX_HEIGHT = COMPOSER_MAX_INPUT_HEIGHT;
// How close to the visual bottom counts as "already reading the newest end"
// for the layout-change tail snap (C97): offset 0 when native is inverted,
// or content height minus viewport height on the ordinary desktop list.
const TAIL_PIN_THRESHOLD = 50;
// Open on the tail of a long transcript instead of the full history, then
// page older messages in as the reader scrolls up.
const INITIAL_MESSAGE_WINDOW = 30;
// A corner's opening/progress prose is its audit trail. The cold tail already
// reads this many records; reveal that complete bounded page when its parent
// relation resolves instead of silently starting a reader 30 rows mid-story.
const INITIAL_CORNER_MESSAGE_WINDOW = 200;
/**
 * Every header control draws its mark in a 44 box; the extra 4 all round
 * carries the touch area over Material's 48dp floor without moving a pixel of
 * chrome. One slop for all of them: the trailing pair used to take a 14 slop
 * that grew a 44 box into a 72 one, so two controls parted by a spacing step
 * of bare slab overlapped each other in the hit layer. The Room pair's boxes
 * now touch (same as the Room-list pair); 4 of slop each way overlaps 8 in
 * the hit layer, which a 14 slop would have doubled.
 */
const HEADER_EDGE_HIT_SLOP = { top: 4, bottom: 4, left: 4, right: 4 } as const;
/**
 * Every trailing header mark is DRAWN at this size inside its own 44pt box.
 * One size for the pair is what makes the corners door and the overflow
 * control read as siblings, and a shape centred on its own box needs no
 * hand-tuned vertical correction to sit level with the mark beside it.
 * 28 matches the Room-list pair so the two screens share one chrome.
 */
const HEADER_MARK_SIZE = 28;

/**
 * The voice a transcript entry belongs to, or `null` for anything that is not
 * one, is decided by THE shared projection helper (`buzz/ledger-attribution.ts`
 * — Rooms and corners alike). This screen only supplies its roster union:
 * registered agents from the server-indexed roster.
 */
const knownAgentPubkeysFor = (agentByPubkey: Map<string, unknown>): Set<string> =>
  new Set(agentByPubkey.keys());

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

export function BuzzChatSurface({
  session,
  bindingsRef,
}: {
  session: UseRoomSurfaceSessionResult;
  bindingsRef: MutableRefObject<RoomSurfaceSessionBindings>;
}) {
  const { theme } = useUnistyles();
  const isDesktop = useIsDesktop();
  // `parent`/`title` are hints, not authority: every surface that opens a
  // corner already knows both, so passing them makes the header correct on the
  // first frame instead of one server round trip later. The screen's own reads
  // still run and still win.
  const {
    channelId,
    notificationResponseId,
    notificationTarget,
    notificationMessageId,
    communityId,
    parent,
    title,
    returnTo,
  } = useLocalSearchParams<{
    channelId: string;
    notificationResponseId?: string;
    notificationTarget?: string;
    notificationMessageId?: string;
    communityId?: string;
    parent?: string;
    title?: string;
    returnTo?: string;
  }>();
  const decodedId = channelId ? decodeURIComponent(channelId) : '';
  const messageAnchorId = (notificationMessageId ?? notificationTarget ?? '').trim();
  const allowOlderHistoryRef = useRef(false);
  useEffect(() => {
    allowOlderHistoryRef.current = Boolean(messageAnchorId);
  }, [decodedId, messageAnchorId]);
  const { width: windowWidth } = useWindowDimensions();
  // Desktop chrome and the work pane follow the live window, not the
  // monitor. `isDesktopPlatform()` is true for every browser, and
  // `screen.availWidth` is the display — either one sizes a phone tab as a
  // desktop shell and a narrowed desktop window as a 3-column wide layout.
  // A packaged Tauri window keeps the desktop experience at every width.
  const desktopExperience = isDesktop || isDesktopShell();
  const workPaneWindowClass = desktopWorkPaneWindowClass(windowWidth);
  const routeParentChannelId = parent?.trim() || undefined;
  const routeCommunityId = communityId?.trim() || undefined;
  const routeChannelTitle = title?.trim() || undefined;
  const cornerReturnTarget = returnTo === 'room-list' || returnTo === 'corners' ? returnTo : undefined;
  const insets = useSafeAreaInsets();
  const readOnlyFooterInset =
    Platform.OS === 'android'
      ? { marginBottom: insets.bottom }
      : { paddingBottom: Math.max(insets.bottom, 8) };
  const navigation = useNavigation();
  const flatListRef = useRef<FlatList<ChatDisplayMessage>>(null);
  // Updated on every scroll; declared before transcript-arrival projection so
  // arrivals can decide whether to follow or queue against the pre-append view.
  const isPinnedToTailRef = useRef(true);
  const handledNotificationAnchorRef = useRef<string | null>(null);
  const composerRef = useRef<TextInput>(null);
  // React state can lag the final Android native text event when the user
  // immediately taps send. Keep the authoritative in-flight draft beside the
  // native TextInput so an @mention never drops trailing text.
  const inputTextRef = useRef('');
  // A successful send replaces the native input. Advance this ref before any
  // asynchronous React update so an event already queued by the consumed
  // native field cannot put its text back into the next draft.
  const composerInputRevisionRef = useRef(0);
  // The picker knows the exact agent key, whereas text-only lookup is a
  // fallback for manually typed mentions. Keep that identity through trailing
  // typing so an async roster refresh cannot turn a selected agent into an
  // unaddressed plain Room message.
  const selectedAgentMentionsRef = useRef(new Map<string, string>());
  const selectedMentionsRef = useRef(new Map<string, string>());
  // When each agent was last told about, so a standing offline condition is
  const sendInFlightRef = useRef(false);
  const roomMessageProjectorRef = useRef<ReturnType<typeof createRoomMessageProjector> | null>(
    null,
  );
  const roomMessageProjector =
    roomMessageProjectorRef.current ??
    (roomMessageProjectorRef.current = createRoomMessageProjector());

  // Publish the open conversation to the foreground notification policy. The
  // root notification handler runs outside the React tree, so it reads this
  // tracker instead of route state. Synchronous, no relay work.
  const isFocused = useIsFocused();
  useFocusEffect(
    useCallback(() => {
      pushOpenBuzzChannelId(decodedId || null);
      const dismiss = () => {
        if (AppState.currentState !== 'active') return;
        void dismissPresentedNotificationsForChannel(
          decodedId,
          Notifications,
          Platform.OS,
          routeParentChannelId,
        ).catch((error) => {
          console.log('Failed to dismiss notifications for opened conversation:', error);
        });
      };
      dismiss();
      const appState = AppState.addEventListener('change', dismiss);
      const received = Notifications.addNotificationReceivedListener(dismiss);
      return () => {
        releaseOpenBuzzChannelId(decodedId || null);
        appState.remove();
        received.remove();
      };
    }, [decodedId, routeParentChannelId]),
  );

  const {
    transport,
    adoptTransport: setSessionTransport,
    roomClient,
    roomSurface,
    firstUnreadMessageId,
    openingUnreadCounts,
    advanceReadCursor,
    markUnreadFrom,
    liveOverlays,
    liveDraftStore,
    userPubkey,
    heartbeatPresences,
    presenceResolved,
    presenceReconnectGrace,
    presenceNow,
    setPresenceNow,
    hydrationFailed: transcriptHydrationFailed,
    hydrationError: transcriptHydrationError,
    retryHydration,
    refreshSignal,
    outbox,
  } = session;
  useEffect(() => {
    return navigation.addListener('beforeRemove', () => {
      liveDraftStore.setActive(false);
    });
  }, [liveDraftStore, navigation]);
  useLayoutEffect(() => {
    if (!roomSurface) return;
    markRoomOpen('layout-chrome', roomSurface.messages.at(-1)?.id);
  }, [roomSurface]);
  const [inputText, setInputText] = useState('');
  const [composerInputRevision, setComposerInputRevision] = useState(0);
  const loadedDraftForRef = useRef<string | null>(null);
  const workPaneHandleRef = useRef<React.ElementRef<typeof Pressable>>(null);
  const initialWorkPaneStateRef = useRef(initialDesktopWorkPaneState(windowWidth));
  const [desktopWorkPane, setDesktopWorkPane] = useState(initialWorkPaneStateRef.current);
  const desktopWorkPaneRef = useRef(desktopWorkPane);
  const workPaneMode = desktopWorkPaneMode(desktopWorkPane);
  const observedCornerCountRef = useRef<{ roomId: string; count: number } | null>(null);
  const [workPaneArrived, setWorkPaneArrived] = useState(false);
  const [desktopDeliveryState, setDesktopDeliveryState] = useState<
    'sending' | 'delivered' | 'failed' | null
  >(null);
  const [replyTarget, setReplyTarget] = useState<MessageReplyTarget | null>(null);
  const [composerHeight, setComposerHeight] = useState(COMPOSER_MIN_HEIGHT);
  const [inputSelection, setInputSelection] = useState({ start: 0, end: 0 });
  const [highlightedMentionIndex, setHighlightedMentionIndex] = useState(0);
  const [dismissedMentionKey, setDismissedMentionKey] = useState<string | null>(null);
  const [highlightedSlashVerbIndex, setHighlightedSlashVerbIndex] = useState(0);
  const [dismissedSlashText, setDismissedSlashText] = useState<string | null>(null);
  /** Per-Room+agent command lists (undefined = unresolved, empty = advertises none). */
  const [agentCommandsByScope, setAgentCommandsByScope] = useState<
    Record<string, readonly AgentComposerCommand[]>
  >({});
  const [sending, setSending] = useState(false);
  const [cornerProposalAction, setCornerProposalAction] = useState<{
    messageId: string;
    decision: 'open' | 'cancel';
  } | null>(null);
  const failedOutboxIds = outbox.failedIds;
  const [pendingAttachments, setPendingAttachments] = useState<PickedChatAttachment[]>([]);
  // Paste/drop and Enter can land in one browser event batch. Keep the staged
  // files current synchronously so dispatch does not read the previous render
  // and then clear a screenshot it never uploaded.
  const pendingAttachmentsRef = useRef<PickedChatAttachment[]>([]);
  const replacePendingAttachments = useCallback(
    (
      update:
        | PickedChatAttachment[]
        | ((current: PickedChatAttachment[]) => PickedChatAttachment[]),
    ) => {
      const next =
        typeof update === 'function' ? update(pendingAttachmentsRef.current) : update;
      pendingAttachmentsRef.current = next;
      setPendingAttachments(next);
    },
    [],
  );
  const [attachmentPickerVisible, setAttachmentPickerVisible] = useState(false);
  const [messageActionsTarget, setMessageActionsTarget] = useState<ChatDisplayMessage | null>(null);
  const [optimisticBookmarks, setOptimisticBookmarks] = useState<Record<string, boolean>>({});
  const [forwardTarget, setForwardTarget] = useState<ChatDisplayMessage | null>(null);
  const [forwardRooms, setForwardRooms] = useState<readonly ForwardTarget[] | null>(
    null,
  );
  const [forwardBusyRoomId, setForwardBusyRoomId] = useState<string | null>(null);
  const [forwardError, setForwardError] = useState<string | null>(null);
  // What this corner inherited from the Room it was opened out of: the task
  // the daemon recorded on its create event, and the bounded window of Room
  // conversation that preceded it. Corner-only; a Room never reads it.
  const [addingMembers, setAddingMembers] = useState(false);
  /** The Workspace roster behind member and mention pickers; null until the first scoped read. */
  const [workspaceRoster, setWorkspaceRoster] = useState<Awaited<
    ReturnType<NonNullable<typeof roomClient>['workspace']>
  > | null>(null);
  const workspaceRosterScopeRef = useRef<string | null>(null);
  // The repo this Room owns, or `null` for a chat-only Room. Corners never
  // read this — a corner has no room-repository binding of its own; the
  // daemon resolves its working repo from its parent Room instead.
  const [showRoomRepoPicker, setShowRoomRepoPicker] = useState(false);
  const [roomRepoCandidates, setRoomRepoCandidates] = useState<RepoCandidate[]>([]);
  const [githubInstallations, setGitHubInstallations] = useState<GitHubInstallationAccess[]>([]);
  const [roomRepoBusy, setRoomRepoBusy] = useState(false);
  const [roomRepoListLoading, setRoomRepoListLoading] = useState(false);
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
  const [memberInviteBusy, setMemberInviteBusy] = useState(false);
  const [membershipActionPubkey, setMembershipActionPubkey] = useState<string | null>(null);
  const [roomLifecycleBusy, setRoomLifecycleBusy] = useState(false);
  const directMessage = roomSurface?.directMessage ?? null;
  // Hoisted above the pane handlers that need it in their dependency arrays.
  const isDirectMessage = Boolean(directMessage);
  const [workspaceChats, setWorkspaceChats] = useState<readonly ChatListItem[]>([]);
  const [composerFocused, setComposerFocused] = useState(false);
  const [permissionActionId, setPermissionActionId] = useState<string | null>(null);
  const [grantActionId, setGrantActionId] = useState<string | null>(null);
  const [connectorOfferActionId, setConnectorOfferActionId] = useState<string | null>(null);
  const [choiceActionId, setChoiceActionId] = useState<string | null>(null);
  /** Proposal currently being confirmed, and the last refusal/failure text. */
  const [targetBranchActionId, setTargetBranchActionId] = useState<string | null>(null);
  const [targetBranchNotice, setTargetBranchNotice] = useState<{
    proposalId: string;
    text: string;
  } | null>(null);
  // Armed the instant a message this client believes addresses an agent is
  // sent, so the composer never shows dead air waiting on the real WORKING
  // receipt (API write + pickup + receipt + refetch). See
  // `selectComposerAckState`.
  const [pendingAck, setPendingAck] = useState<{ sentAt: number; requestId?: string } | null>(null);
  const [receivedSteer, setReceivedSteer] = useState<{
    agentPubkey: string;
    turnRequestId: string;
    receivedAt: number;
  } | null>(null);

  useEffect(() => {
    if (!desktopExperience || !decodedId) return;
    let cancelled = false;
    loadedDraftForRef.current = null;
    inputTextRef.current = '';
    setInputText('');
    setDesktopDeliveryState(null);
    void loadDesktopDraft(decodedId).then((draft) => {
      if (cancelled) return;
      loadedDraftForRef.current = decodedId;
      inputTextRef.current = draft;
      setInputText(draft);
    });
    return () => {
      cancelled = true;
    };
  }, [decodedId, desktopExperience]);

  useEffect(() => {
    if (!desktopExperience || loadedDraftForRef.current !== decodedId) return;
    const timer = setTimeout(() => {
      void saveDesktopDraft(decodedId, inputText);
    }, 120);
    return () => clearTimeout(timer);
  }, [decodedId, desktopExperience, inputText]);

  const commitDesktopWorkPane = useCallback(
    (event: DesktopWorkPaneEvent) => {
      // A direct message renders no work pane at all, so its pane events are
      // no-ops (see `desktopWorkPaneEventApplies`): the pane cannot be opened,
      // toggled or dismissed there, and the person's persisted preference is
      // never overwritten by a channel that has nothing to show.
      if (!desktopWorkPaneEventApplies(event, isDirectMessage)) {
        const held: DesktopWorkPaneTransition = { state: desktopWorkPaneRef.current };
        return held;
      }
      const transition = transitionDesktopWorkPane(desktopWorkPaneRef.current, event);
      desktopWorkPaneRef.current = transition.state;
      setDesktopWorkPane(transition.state);
      if (desktopWorkPaneMode(transition.state) === 'present') setWorkPaneArrived(false);
      return transition;
    },
    [isDirectMessage],
  );

  useEffect(() => {
    if (!desktopExperience) return;
    let cancelled = false;
    void loadDesktopWorkPanePreference(workPaneWindowClass).then((preference) => {
      if (!cancelled) commitDesktopWorkPane({ type: 'hydrate', preference });
    });
    return () => {
      cancelled = true;
    };
  }, [commitDesktopWorkPane, desktopExperience, workPaneWindowClass]);

  useEffect(() => {
    if (!desktopExperience) return;
    commitDesktopWorkPane({ type: 'resize', width: windowWidth });
  }, [commitDesktopWorkPane, desktopExperience, windowWidth]);

  const cacheViewerPubkey = userPubkey;
  const isArchived = roomSurface ? roomSurface.room.archived !== false : false;
  const surfaceParentId = roomSurface ? roomViewParentId(roomSurface) : undefined;
  const parentChannelId = surfaceParentId ?? routeParentChannelId;
  const desktopWorkRoomId = parentChannelId ?? decodedId;
  const [desktopParentRoom, setDesktopParentRoom] = useState<typeof roomSurface>(null);
  useEffect(() => {
    let cancelled = false;
    if (!desktopExperience || !parentChannelId || !roomClient) {
      setDesktopParentRoom(null);
      return;
    }
    void roomClient
      .room(parentChannelId)
      .then((parentRoom) => {
        if (!cancelled) setDesktopParentRoom(parentRoom);
      })
      .catch(() => {
        if (!cancelled) setDesktopParentRoom(null);
      });
    return () => {
      cancelled = true;
    };
  }, [desktopExperience, parentChannelId, roomClient]);
  const desktopWorkRoom = parentChannelId ? desktopParentRoom : roomSurface;
  const liveDesktopCornerCount =
    workspaceChats.find((item) => item.room.id === desktopWorkRoomId)?.cornerCount ?? 0;
  const hasLiveDesktopCorners = liveDesktopCornerCount > 0;

  useEffect(() => {
    if (!desktopExperience || isDirectMessage || !desktopWorkRoomId) return;
    // The chat-list count is the live-corner authority for this handle. Wait
    // until that list has painted so the first 0→N transition is not treated
    // as a newly opened corner.
    if (workspaceChats.length === 0) return;
    const observed = observedCornerCountRef.current;
    if (!observed || observed.roomId !== desktopWorkRoomId) {
      observedCornerCountRef.current = { roomId: desktopWorkRoomId, count: liveDesktopCornerCount };
      setWorkPaneArrived(false);
      return;
    }
    if (liveDesktopCornerCount > observed.count && workPaneMode !== 'present') {
      setWorkPaneArrived(true);
    }
    observedCornerCountRef.current = { roomId: desktopWorkRoomId, count: liveDesktopCornerCount };
  }, [
    desktopExperience,
    desktopWorkRoomId,
    isDirectMessage,
    liveDesktopCornerCount,
    workPaneMode,
    workspaceChats.length,
  ]);
  // A direct message renders no second pane at all (see the pane-event gate in
  // `commitDesktopWorkPane`): the transcript takes the space it occupied, and
  // neither the inspector nor its reopen handle ever mounts over a DM.
  // Zero live corners: no handle (toggle is a no-op too). The pane still
  // mounts when already present — an artifact tap can re-present it.
  const desktopWorkPaneMounted =
    desktopExperience && !isDirectMessage && workPaneMode === 'present'
      ? desktopWorkRoom
      : null;
  const desktopWorkHandleMounted =
    desktopExperience &&
    !isDirectMessage &&
    workPaneMode === 'dismissed' &&
    hasLiveDesktopCorners;
  const channelKind: ChannelKind = roomSurface
    ? surfaceParentId
      ? 'corner'
      : 'room'
    : routeParentChannelId
      ? 'corner'
      : 'unknown';
  const isCorner = Boolean(parentChannelId);
  useEffect(() => {
    if (!isCorner && firstUnreadMessageId) allowOlderHistoryRef.current = true;
  }, [firstUnreadMessageId, isCorner]);
  const resolvedChannelName = roomSurface?.room.name ?? routeChannelTitle ?? null;
  const activeCommunityId = roomSurface?.room.workspaceId ?? routeCommunityId ?? null;
  const viewerIsAgent = roomSurface?.viewer.identity.kind === 'agent';
  // The SERVER's statement of who is reading, so the phone's requester test and
  // the server's own are the same comparison over the same namespace.
  const viewerPubkey = roomSurface?.viewer.identity.pubkey;
  const viewerChannelRole = roomSurface?.viewer.role ?? null;
  const canManageWorkspace = roomSurface?.viewer.permissions.manage ?? false;
  const communities = useMemo(
    () =>
      roomSurface && activeCommunityId
        ? [
            workspaceRailItem({
              id: activeCommunityId,
              name: roomSurface.parent?.name ?? roomSurface.room.name,
              visibility: 'invite-only',
              role: roomSurface.viewer.role,
              updatedAt: roomSurface.room.updatedAt ?? 0,
            }),
          ]
        : [],
    [activeCommunityId, roomSurface?.parent, roomSurface?.room, roomSurface?.viewer.role],
  );
  const openCornerCount =
    workspaceChats.find((item) => item.room.id === (parentChannelId ?? decodedId))?.cornerCount ??
    0;
  const cornerTask = surfaceParentId ? roomSurface?.room.about : undefined;
  const roomRepository = useMemo<RoomRepository | null>(() => {
    if (isCorner || !roomSurface?.repository || !activeCommunityId) return null;
    const repository = roomSurface.repository;
    return {
      channelId: decodedId,
      communityId: activeCommunityId,
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
  }, [activeCommunityId, decodedId, isCorner, roomSurface?.repository]);
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
  const cachedMessages = useMemo(
    () =>
      roomSurface && cacheViewerPubkey
        ? roomMessageProjector.project(roomViewTranscriptMessages(roomSurface), cacheViewerPubkey)
        : [],
    [cacheViewerPubkey, roomMessageProjector, roomSurface?.messages, roomSurface?.toolRows],
  );
  // Resolve references only within the Room family returned by this surface.
  const channelReferenceIndex = useMemo<ChannelReferenceIndex>(() => {
    return buildChannelReferenceIndex(
      [
        ...workspaceChats
          .filter((item) => !item.directMessage)
          .map((item) => ({ channelId: item.room.id, name: item.room.name })),
        ...(roomSurface?.parent
          ? [{ channelId: roomSurface.parent.id, name: roomSurface.parent.name }]
          : []),
        ...(parentChannelId
          ? []
          : [{ channelId: decodedId, name: resolvedChannelName || routeChannelTitle || '' }]),
      ].filter((room): room is { channelId: string; name: string } => room !== null),
      [
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
    decodedId,
    parentChannelId,
    resolvedChannelName,
    roomSurface?.parent,
    routeChannelTitle,
    workspaceChats,
  ]);
  const openDesktopCorner = useCallback(
    (roomId: string, cornerId: string) => {
      const transition = commitDesktopWorkPane({ type: 'open-corner', cornerId });
      void saveDesktopWorkPanePreference(workPaneWindowClass, transition.state.preference);
      if (transition.placement === 'main') router.push(cornerHref(cornerId, roomId));
    },
    [commitDesktopWorkPane, workPaneWindowClass],
  );
  useEffect(() => {
    if (!desktopExperience) return;
    return subscribeDesktopWorkCorner(({ roomId, cornerId }) => {
      if (roomId !== desktopWorkRoomId) return;
      openDesktopCorner(roomId, cornerId);
    });
  }, [desktopExperience, desktopWorkRoomId, openDesktopCorner]);
  // The work pane and the Room route are siblings, so an artifact Open press
  // arrives as a module event. A dismissed pane re-presents around it; the
  // pane then shows the artifact from its own module read. A suppressed pane
  // cannot host the artifact at all, so the press hands off to the browser —
  // the same boundary the pane uses for formats it cannot sandbox.
  const openDesktopArtifact = useCallback(
    (selection: DesktopArtifactSelection) => {
      // A direct message has no work pane to host the artifact, so the press
      // always hands off to the browser, exactly like a suppressed pane.
      if (isDirectMessage) {
        void openArtifactInBrowserOrExplain(selection.attachment);
        return;
      }
      const transition = commitDesktopWorkPane({ type: 'open-artifact' });
      void saveDesktopWorkPanePreference(workPaneWindowClass, transition.state.preference);
      if (transition.placement === 'main')
        void openArtifactInBrowserOrExplain(selection.attachment);
    },
    [commitDesktopWorkPane, isDirectMessage, workPaneWindowClass],
  );
  useEffect(() => {
    if (!desktopExperience) return;
    return subscribeDesktopArtifact((selection) => {
      if (selection) openDesktopArtifact(selection);
    });
  }, [desktopExperience, openDesktopArtifact]);
  /** Navigate to exactly the referenced Room/Corner through the existing
   * conventions; a reference to the transcript you are already in is a no-op. */
  const openingChannelReferenceRef = useRef<string | null>(null);
  const handleOpenChannelReference = useCallback(
    async (target: ChannelReferenceTarget, text?: string) => {
      if (target.kind === 'room' && (!target.channelId || target.channelId === decodedId)) return;
      if (target.kind === 'corner' && target.channelId === decodedId) return;
      if (openingChannelReferenceRef.current) return;
      const referenceLabel = text ?? 'this destination';
      if (!roomClient) {
        Modal.alert(
          'Destination unavailable',
          `Beeline is still connecting. Try ${referenceLabel} again in a moment.`,
        );
        return;
      }
      const lock =
        target.kind === 'corner'
          ? (target.channelId ?? `pending:${target.parentChannelId}:${target.name ?? text ?? ''}`)
          : target.channelId;
      openingChannelReferenceRef.current = lock;
      try {
        let resolved = target;
        if (resolved.kind === 'corner' && !resolved.channelId) {
          const list = await roomClient.corners(resolved.parentChannelId);
          const found = resolveCornerFromList(
            text ?? '',
            { id: list.room.id, name: list.room.name },
            list.corners.map((item) => ({ id: item.corner.id, name: item.corner.name })),
          );
          if (!found) {
            Modal.alert(
              'Access denied',
              `${referenceLabel} is unavailable or you no longer have access.`,
            );
            return;
          }
          resolved = found;
        }
        if (!resolved.channelId || resolved.channelId === decodedId) return;
        // The list that made this token linkable can be stale after a leave,
        // removal, or deletion. The Room read is the current authorization
        // verdict; only a successful read earns navigation.
        await roomClient.room(resolved.channelId);
        if (resolved.kind === 'corner') openDesktopCorner(resolved.parentChannelId, resolved.channelId);
        else router.push(roomHref(resolved.channelId));
      } catch (error) {
        if (isUnavailableChannelReferenceError(error)) {
          Modal.alert(
            'Access denied',
            `${referenceLabel} is unavailable or you no longer have access.`,
          );
        } else {
          Modal.alert(
            'Could not open destination',
            `Beeline could not verify access to ${referenceLabel}. Check your connection and try again.`,
          );
        }
      } finally {
        openingChannelReferenceRef.current = null;
      }
    },
    [decodedId, openDesktopCorner, roomClient],
  );
  const openingMentionRef = useRef<string | null>(null);
  const handleOpenMention = useCallback(
    async (participantId: string) => {
      if (participantId === cacheViewerPubkey || openingMentionRef.current) return;
      if (!transport || !activeCommunityId) {
        Modal.alert(
          'Could not open direct message',
          'Beeline is still connecting. Try the mention again in a moment.',
        );
        return;
      }
      openingMentionRef.current = participantId;
      try {
        const action = await resolveMentionDirectMessageAction(
          (workspaceId, memberId) => transport.resolveDirectMessage(workspaceId, memberId),
          activeCommunityId,
          participantId,
          decodedId,
        );
        if (action.type === 'open-room') router.push(roomHref(action.channelId));
      } catch (reason) {
        Modal.alert(
          'Could not open direct message',
          reason instanceof Error ? reason.message : String(reason),
        );
      } finally {
        openingMentionRef.current = null;
      }
    },
    [activeCommunityId, cacheViewerPubkey, decodedId, transport],
  );
  // The cold-open deadline bounds the single authenticated Room request.
  // A rejected request surfaces through `onStepFailed('transcript')` below.
  // Older pages loaded on demand via "scroll up" pagination. Kept out of the
  // shared cache (which bounds to the recent tail) and merged in only here.
  // History stays as verbatim server rows in page-lifetime partitions. It is
  // converted to render props only below, never persisted as a derived
  // transcript or folded into the current Room response.
  const {
    olderPages,
    visibleMessageCount,
    status: transcriptHistoryStatus,
    loadOlder: loadOlderHistory,
    retry: retryOlderHistory,
    revealThrough: revealTranscriptThrough,
    reset: resetTranscriptHistory,
  } = useRoomTranscriptHistory({
    roomId: decodedId,
    tailMessages: roomSurface?.room.id === decodedId ? roomSurface.messages : undefined,
    roomClient,
    enabled: Boolean(cacheViewerPubkey),
    initialVisibleCount: isCorner ? INITIAL_CORNER_MESSAGE_WINDOW : INITIAL_MESSAGE_WINDOW,
  });
  const committedMessageIds = useMemo(
    () => new Set(cachedMessages.map((message) => message.id)),
    [cachedMessages],
  );
  const liveMessages = useMemo<ChatDisplayMessage[]>(
    () =>
      roomSurface
        ? liveDraftMessages(liveOverlays, roomSurface.messages, roomSurface.latestAgentTurns)
        : [],
    [liveOverlays, roomSurface],
  );
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
  } = useRoomSendFrame(durableMessages, committedMessageIds);
  bindingsRef.current = {
    resetTranscript: () => {
      roomMessageProjector.reset();
      resetTranscriptHistory();
      clearOptimistic();
    },
    restoreOutboxMessages: addMessages,
    dismissOptimisticMessage: removeOptimistic,
    // A newly indexed working lease can be newer than the screen's prior
    // clock. Re-evaluate it at RoomView application time, as this screen did
    // before the surface lifecycle moved into useRoomSurfaceSession.
    observeRoomSurface: () => undefined,
  };
  useLayoutEffect(() => {
    const records = outbox.current()?.list() ?? [];
    if (records.length === 0 || !userPubkey) return;
    addMessages(records.map((record) => displayRoomMessages([record.row], userPubkey)[0]!));
  }, [addMessages, outbox, userPubkey]);
  // All four display partitions share the same chronological merge. A durable
  // outbox row may be older than the current server tail after an interrupted
  // publish, so it must never claim the inverted list's newest slot.
  const combinedMessages = useMemo(
    () => mergeDisplayPages(durableMessages, roomSendFrame.optimistic),
    [durableMessages, roomSendFrame.optimistic],
  );
  // Current server message authors refresh the same membership roster that
  // drives Room and corner bylines, mention suggestions, and mention glossing.
  const conversationIdentities = useMemo(
    () => conversationIdentityByPubkey(roomSurface?.members ?? [], combinedMessages),
    [combinedMessages, roomSurface?.members],
  );
  // Open on the tail; older history reveals from what's already resident here
  // first, then pages in from the server once that's exhausted.
  // A corner turn's per-call activity rows read back as one collapsed group
  // per turn; the window and paging count those groups, not the raw rows.
  // Same-verb system lines and adjacent GitHub lifecycle rows fold into one.
  const foldedMessages = useMemo(() => {
    const anchored = anchorRelayReports(combinedMessages);
    const boundary = boundaryRowIndex(anchored, isCorner ? null : firstUnreadMessageId);
    if (boundary < 0) return foldSystemLines(foldSettledActivityRuns(anchored));
    // Folding cannot swallow the one exact server-owned unread boundary.
    return [
      ...foldSystemLines(foldSettledActivityRuns(anchored.slice(0, boundary))),
      ...foldSystemLines(foldSettledActivityRuns(anchored.slice(boundary))),
    ];
  }, [combinedMessages, firstUnreadMessageId, isCorner]);
  const transcriptArrivalStateRef = useRef(EMPTY_TRANSCRIPT_ARRIVAL_STATE);
  const transcriptCardMotionStore = useMemo(createTranscriptCardMotionStore, [decodedId]);
  const transcriptArrivalObservation = useMemo(() => {
    return observeTranscriptArrivals(transcriptArrivalStateRef.current, {
      surfaceId: decodedId,
      hydrated: Boolean(roomSurface),
      // A fold can gain a new durable fact without changing its host row id.
      // Observe every represented id so that arrival still joins the queue.
      ids: foldedMessages.flatMap(messageBoundaryIds),
    });
  }, [decodedId, foldedMessages, roomSurface]);
  useEffect(() => {
    // Keep the comparison anchored to the last committed transcript. Mutating
    // this ref during render makes React's development double-render consume a
    // live arrival before the card ever reaches the screen.
    transcriptArrivalStateRef.current = transcriptArrivalObservation.state;
  }, [transcriptArrivalObservation.state]);
  const unprojectedMessages = useMemo(
    () => visibleTranscriptWindow(foldedMessages, visibleMessageCount),
    [foldedMessages, visibleMessageCount],
  );
  // The immutable summary stored on the corner Room is the objective for its
  // entire lifecycle; it names the empty transcript. Mutable plans never rewrite it.
  const cornerObjective = useMemo(
    () =>
      cornerObjectiveItems({
        ...(cornerTask ? { task: cornerTask } : {}),
        ...(resolvedChannelName ? { cornerName: resolvedChannelName } : {}),
      }),
    [cornerTask, resolvedChannelName],
  );
  // The same objective as one line, for the inscription under the header and
  // for the empty state's steering copy — derived once so the two never drift.
  const cornerObjectiveText = useMemo(() => cornerObjective.join(' '), [cornerObjective]);

  const loadOlderTranscriptMessages = useCallback(() => {
    const visibleRowCount = visibleTranscriptWindow(foldedMessages, Number.MAX_SAFE_INTEGER).length;
    loadOlderHistory(visibleRowCount);
  }, [foldedMessages, loadOlderHistory]);
  const loadOlderTranscriptIfReaderAsked = useCallback(() => {
    if (!allowOlderHistoryRef.current) return;
    loadOlderTranscriptMessages();
  }, [loadOlderTranscriptMessages]);
  const retryOlderTranscriptMessages = useCallback(() => {
    retryOlderHistory(visibleTranscriptWindow(foldedMessages, Number.MAX_SAFE_INTEGER).length);
  }, [foldedMessages, retryOlderHistory]);
  const transcriptHistoryLine =
    transcriptHistoryStatus === 'loading' ? (
      <LedgerHistoryLine text="Loading earlier messages…" />
    ) : transcriptHistoryStatus === 'error' ? (
      <LedgerHistoryLine
        text="Couldn't load earlier messages · tap to retry"
        onPress={retryOlderTranscriptMessages}
      />
    ) : transcriptHistoryStatus === 'complete' ? (
      <LedgerHistoryLine text={isCorner ? 'Beginning of corner' : `Beginning of ${ROOM_LABEL}`} />
    ) : null;
  const availableAgents = useMemo(
    () =>
      (roomSurface?.members ?? [])
        .filter((member) => member.identity.kind === 'agent')
        .map((member) =>
          memberAgent(
            {
              ...member,
              identity: conversationIdentities.get(member.identity.pubkey) ?? member.identity,
            },
            roomSurface?.room.workspaceId ?? '',
          ),
        ),
    [conversationIdentities, roomSurface?.members, roomSurface?.room.workspaceId],
  );
  const availablePeople = useMemo(
    () =>
      (roomSurface?.members ?? [])
        .filter((member) => member.identity.kind === 'human')
        .map((member) => ({
          pubkey: member.identity.pubkey,
          role: member.role,
          identity: conversationIdentities.get(member.identity.pubkey) ?? member.identity,
        })),
    [conversationIdentities, roomSurface?.members],
  );
  const selectedMembersRaw = useMemo(
    () =>
      (roomSurface?.members ?? []).map((member) => {
        const identity = conversationIdentities.get(member.identity.pubkey) ?? member.identity;
        return {
          pubkey: identity.pubkey,
          role: member.role,
          kind: identity.kind,
          identity: {
            kind: identity.kind,
            displayName: identity.name,
            handle: identity.handle,
          },
        };
      }),
    [conversationIdentities, roomSurface?.members],
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
        .map((member) => {
          const identity = conversationIdentities.get(member.identity.pubkey) ?? member.identity;
          return {
            pubkey: identity.pubkey,
            name: identity.name,
            ...(identity.handle ? { handle: identity.handle } : {}),
            ...(identity.avatar ? { avatar: identity.avatar } : {}),
            ...(identity.face ? { face: identity.face } : {}),
          };
        }),
    [conversationIdentities, roomSurface?.members],
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
      const selfProfile = personProfileByPubkey.get(userPubkey);
      options.set(userPubkey, {
        pubkey: userPubkey,
        // The viewer is named like every other speaker; brass on the name is
        // the one thing that marks them (DESIGN.md).
        name: selfProfile?.name ?? fallbackMemberName(userPubkey),
        handle: selfProfile?.handle ?? fallbackMemberHandle(userPubkey),
        kind: 'person',
      });
    }
    for (const person of availablePeople) {
      const fallbackName = fallbackMemberName(person.pubkey);
      const profile = personProfileByPubkey.get(person.pubkey);
      options.set(person.pubkey, {
        pubkey: person.pubkey,
        name: profile?.name ?? fallbackName,
        handle: person.identity.handle ?? profile?.handle ?? fallbackMemberHandle(person.pubkey),
        kind: 'person',
        ...(person.identity.face ? { face: person.identity.face } : {}),
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
    for (const member of selectedMembers) {
      if (options.has(member.pubkey)) continue;
      const fallbackName = fallbackMemberName(member.pubkey);
      const profile = personProfileByPubkey.get(member.pubkey);
      options.set(member.pubkey, {
        pubkey: member.pubkey,
        name: profile?.name ?? fallbackName,
        handle: member.identity?.handle ?? profile?.handle ?? fallbackMemberHandle(member.pubkey),
        kind: 'person',
      });
    }
    return [...options.values()].sort((a, b) => {
      if (a.pubkey === userPubkey) return -1;
      if (b.pubkey === userPubkey) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [
    availableAgents,
    availablePeople,
    personProfileByPubkey,
    roomMembers,
    selectedMembers,
    userPubkey,
  ]);
  const roomParticipants = useMemo(
    () =>
      selectedMembers.map((member) => {
        const known = memberOptions.find((option) => option.pubkey === member.pubkey);
        if (known) return known;
        const name = member.identity?.displayName ?? member.identity?.handle;
        return {
          pubkey: member.pubkey,
          name: name ?? fallbackMemberName(member.pubkey),
          handle: member.identity?.handle ?? fallbackMemberHandle(member.pubkey),
          kind: member.kind === 'agent' ? 'agent' : 'person',
          ...(member.kind === 'agent' && agentByPubkey.get(member.pubkey)
            ? { agent: agentByPubkey.get(member.pubkey) }
            : {}),
        } satisfies RoomMemberOption;
      }),
    [agentByPubkey, memberOptions, selectedMembers, userPubkey],
  );
  // The picker's candidates are the WORKSPACE roster minus this Room's
  // members. The old picker filtered this Room's own member list, so its
  // "add" section was always empty and the only visible path led to the
  // pairing command (captain report C74). The transcript reads the Workspace
  // roster once on entry so every agent byline can name its model. Later sheet
  // refreshes keep the last roster visible until the fresh response lands.
  useEffect(() => {
    workspaceRosterScopeRef.current = null;
    setWorkspaceRoster(null);
  }, [activeCommunityId]);
  useEffect(() => {
    const rosterSurfaceVisible = participantPickerVisible || rosterVisible;
    if (!roomClient || !activeCommunityId) return;
    if (
      !shouldReadWorkspaceRoster({
        activeWorkspaceId: activeCommunityId,
        cachedWorkspaceId: workspaceRosterScopeRef.current,
        rosterSurfaceVisible,
      })
    )
      return;
    let cancelled = false;
    roomClient
      .workspace(activeCommunityId)
      .then((view) => {
        if (!cancelled) {
          workspaceRosterScopeRef.current = activeCommunityId;
          setWorkspaceRoster(view);
        }
      })
      .catch((err) => {
        if (!cancelled && rosterSurfaceVisible)
          setMembershipError(`Could not read the Workspace roster: ${String(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [activeCommunityId, participantPickerVisible, roomClient, rosterVisible]);
  const participantPickerCandidates = useMemo<MemberPickerCandidate[] | null>(() => {
    if (!workspaceRoster) return null;
    return [...workspaceRoster.members, ...workspaceRoster.agents]
      .filter((member) => !roomMemberPubkeys.has(member.identity.pubkey))
      .map((member) => {
        const identity = member.identity;
        if (identity.kind === 'agent') {
          const display = resolveAgentDisplayIdentity(
            identity.pubkey,
            memberAgent(member, workspaceRoster.workspace.id),
          );
          return {
            pubkey: identity.pubkey,
            name: display.name,
            handle: display.handle,
            kind: 'agent' as const,
            ...(display.avatarUrl ? { avatarUrl: display.avatarUrl } : {}),
            ...(display.face ? { face: display.face } : {}),
          };
        }
        return {
          pubkey: identity.pubkey,
          name: identity.name,
          handle: identity.handle ?? fallbackMemberHandle(identity.pubkey),
          kind: 'person' as const,
          ...(identity.face ? { face: identity.face } : {}),
          ...(identity.avatar ? { avatarUrl: identity.avatar } : {}),
        };
      });
  }, [roomMemberPubkeys, workspaceRoster]);
  // Everyone of the listed kind in the Workspace besides the viewer, whether
  // or not they are already in this Room. An empty candidate list means two
  // different things — a Room that already holds them all, or a Workspace
  // with nobody else in it — and this count is what tells the sheet which
  // one to say (captain report C83).
  const participantPickerWorkspacePeers = useMemo(() => {
    if (!workspaceRoster) return 0;
    return [...workspaceRoster.members, ...workspaceRoster.agents].filter((member) => {
      if (member.identity.pubkey === userPubkey) return false;
      if (!participantPickerKind) return true;
      const kind = member.identity.kind === 'agent' ? 'agent' : 'person';
      return kind === participantPickerKind;
    }).length;
  }, [participantPickerKind, userPubkey, workspaceRoster]);
  const visibleRosterMembers = useMemo(() => {
    const workspaceAgents = new Map(
      (workspaceRoster?.agents ?? []).map((agent) => [agent.identity.pubkey, agent]),
    );
    return orderRoomRoster(
      roomParticipants.map((participant) => {
        if (participant.kind !== 'agent') return participant;
        const workspaceAgent = workspaceAgents.get(participant.pubkey);
        const ownerHandle = workspaceAgent?.owner?.handle;
        return {
          ...participant,
          ...(workspaceAgent?.model ? { model: workspaceAgent.model } : {}),
          ...(ownerHandle ? { ownerHandle } : {}),
        };
      }),
    );
  }, [roomParticipants, workspaceRoster]);
  const roomParticipantTotal = roomParticipants.length;
  const roomAgents = useMemo(
    () => roomParticipants.filter((participant) => participant.kind === 'agent'),
    [roomParticipants],
  );
  // kind:30078 is the sole delivery-availability truth. Transcript/activity
  // events can describe work, but they never mint or renew availability.
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
  // presence update and every streamed batch recreated the callback and rebuilt
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
  const lifecycleAction = canManageWorkspace ? ('delete' as const) : null;
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
      inputSelection.start === inputSelection.end
        ? activeMentionAtCursor(inputText, inputSelection.start)
        : null,
    [inputSelection.end, inputSelection.start, inputText],
  );
  const mentionMenuKey = activeMention
    ? `${inputText}:${activeMention.start}:${activeMention.end}`
    : null;
  const mentionCandidateRoster = useMemo(
    () => [CHANNEL_MENTION_OPTION, ...roomParticipants],
    [roomParticipants],
  );
  const mentionSuggestions = useMemo(
    () =>
      activeMention
        ? filterMentionCandidates(
            activeMentionCandidates(mentionCandidateRoster, agentPresences, presenceNow),
            activeMention.query,
          )
        : { matches: [], overflow: 0 },
    [activeMention, mentionCandidateRoster, agentPresences, presenceNow],
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
  // Every agent answering right now, not just the first: two agents asked in
  // one message run two concurrent turns and each owns its own live lane.
  const rawActiveAgentTurns = useMemo(
    () =>
      agentTurnMarkers.filter((turn) =>
        isAgentTurnActive(
          turn,
          agentPresences[turn.agentPubkey],
          presenceNow,
          presenceReconnectGrace[turn.agentPubkey],
        ),
      ),
    [agentTurnMarkers, agentPresences, presenceNow, presenceReconnectGrace],
  );
  // A filter rebuilds its array on every presence tick even when it selected
  // the same receipts, and this feeds the transcript projection.
  const activeAgentTurns = useStable(rawActiveAgentTurns, sameElementRefs);
  // The composer's thinking line and its settled summary are ONE line, so they
  // read the first of them; the transcript and the gold ring take them all.
  const activeAgentTurn = activeAgentTurns[0];
  const messages = unprojectedMessages;
  useEffect(() => {
    if (!roomClient || !activeCommunityId || !userPubkey) {
      setWorkspaceChats([]);
      return;
    }
    let cancelled = false;
    let painted = false;
    void (async () => {
      const address = surfaceAddress(
        await getEffectiveRelayUrl(),
        userPubkey,
        '/workspace/:id/chats',
        { workspaceId: activeCommunityId },
      );
      const apply = (view: { readonly chats: readonly ChatListItem[] }) => {
        if (cancelled) return;
        painted = true;
        setWorkspaceChats(view.chats);
      };
      const cached = await mobileSurfaceCache.read(address, isChatListView);
      if (cached) apply(cached);
      const fresh = await roomClient.chats(activeCommunityId);
      apply(fresh);
      void mobileSurfaceCache.write(address, fresh, isChatListView);
    })().catch(() => {
      if (!cancelled && !painted) setWorkspaceChats([]);
    });
    return () => {
      cancelled = true;
    };
  }, [activeCommunityId, roomClient, userPubkey]);
  const directMessageListItem = useMemo(
    () => workspaceChats.find((item) => item.room.id === decodedId && item.directMessage) ?? null,
    [decodedId, workspaceChats],
  );
  const memberManagement = roomMemberManagementState({
    isDirectMessage,
    participantsHydrated,
    rosterRequested: rosterVisible,
    pickerRequested: participantPickerVisible,
  });
  // An @system notification DM (release or Workspace lifecycle): the server
  // never lets anyone but @system post into it (viewer.permissions.send is
  // false there and only there for a direct message, since a DM can never be
  // archived).
  const isReadOnlyDirectMessage = isDirectMessage && roomSurface?.viewer.permissions.send === false;
  useEffect(() => {
    const humanUi = roomSurface?.boundApp?.manifest.humanUi;
    if (!isFocused || !isCorner || !humanUi) return;
    router.replace({
      pathname: '/beeline/corner-app/[slug]',
      params: { slug: roomSurface.boundApp!.manifest.slug, roomId: decodedId },
    } as Href);
  }, [decodedId, isCorner, isFocused, roomSurface?.boundApp]);
  const currentSlashQuery = useMemo(() => slashVerbQuery(inputText), [inputText]);
  // Mention-scoped palette: `@agent /query` addresses THAT agent's advertised
  // commands. Mutually exclusive with `currentSlashQuery` by shape — the plain
  // path requires the WHOLE composer to be one slash token.
  const mentionSlash = useMemo(() => agentMentionSlashQuery(inputText), [inputText]);
  const mentionSlashAgentPubkey = useMemo(() => {
    if (!mentionSlash) return null;
    return mentionedAgentPubkey(`@${mentionSlash.mention}`, mentionableAgents) ?? null;
  }, [mentionSlash, mentionableAgents]);
  const mentionAgentCommandScope = mentionSlashAgentPubkey
    ? `${decodedId}:${mentionSlashAgentPubkey}`
    : null;
  const mentionAgentCommands = useMemo(() => {
    if (!mentionSlash || !mentionAgentCommandScope) return [];
    const published = agentCommandsByScope[mentionAgentCommandScope];
    return (published ?? []).filter((command) =>
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
    (agentCommandsByScope[mentionAgentCommandScope]?.length ?? 0) === 0,
  );
  const cornerAppCommands = useMemo(() => {
    if (currentSlashQuery === null) return [];
    return availableCornerAppCommands(roomSurface?.cornerApps ?? [], currentSlashQuery);
  }, [currentSlashQuery, roomSurface?.cornerApps]);
  const latestOpenPoll = useMemo(() => {
    for (let index = combinedMessages.length - 1; index >= 0; index -= 1) {
      const message = combinedMessages[index];
      if (
        message.choice?.mode === 'poll' &&
        message.choice.status === 'open' &&
        message.choice.electorate.includes(userPubkey)
      ) {
        return message;
      }
    }
    return undefined;
  }, [combinedMessages, userPubkey]);
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
  // Load the addressed agent's published command list on demand — the palette
  // renders ONLY from this published record, never a hardcoded inventory. A
  // failed read stays unknown and never blocks typing.
  useEffect(() => {
    const pubkey = mentionSlashAgentPubkey;
    const scope = mentionAgentCommandScope;
    if (!pubkey || !scope || !roomClient || !activeCommunityId) return;
    if (agentCommandsByScope[scope] !== undefined) return;
    let cancelled = false;
    roomClient
      .agent(activeCommunityId, pubkey)
      .then((detail) => {
        if (!cancelled) {
          setAgentCommandsByScope((current) => ({
            ...current,
            [scope]: detail.commands ?? [],
          }));
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
    roomClient,
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
  // first painted frame of a warm cache instead of several server reads later.
  // Deliberately not `directMessagePeer`, which throws when the viewer is not
  // a participant — a throw here would be a render-time crash, not a bad title.
  const dmPeerPubkey = userPubkey
    ? directMessage?.participants.find((pubkey) => pubkey !== userPubkey)
    : undefined;
  const dmPeerProfile = dmPeerPubkey ? personProfileByPubkey.get(dmPeerPubkey) : undefined;
  const dmPeerIdentity = dmPeerPubkey
    ? roomSurface?.members.find((member) => member.identity.pubkey === dmPeerPubkey)?.identity
    : undefined;
  const dmPeerAgent = dmPeerPubkey ? agentByPubkey.get(dmPeerPubkey) : undefined;
  const dmPeerAgentDisplay =
    dmPeerPubkey && dmPeerAgent
      ? resolveAgentDisplayIdentity(dmPeerPubkey, dmPeerAgent)
      : undefined;
  const dmHeaderPresence = directMessageHeaderPresence(
    directMessageListItem?.room.id === decodedId ? directMessageListItem : null,
    presenceNow,
  );
  const dmAnnouncementAuthor = dmPeerPubkey
    ? roomSurface?.messages.find((message) => message.author.pubkey === dmPeerPubkey)?.author
    : undefined;
  const dmPeerNip05Status = useVerifiedNip05Status(
    dmPeerPubkey ?? '',
    dmPeerProfile ? { nip05: undefined } : undefined,
  );
  const displayRoomName = useMemo(() => {
    if (!dmPeerPubkey) return roomName;
    if (dmPeerAgentDisplay) return dmPeerAgentDisplay.name;
    return directMessageHeaderName(
      dmPeerIdentity,
      dmPeerProfile,
      dmPeerPubkey,
      dmPeerNip05Status,
      isReadOnlyDirectMessage,
      dmAnnouncementAuthor,
    );
  }, [
    dmAnnouncementAuthor,
    dmPeerAgentDisplay,
    dmPeerIdentity,
    dmPeerNip05Status,
    dmPeerProfile,
    dmPeerPubkey,
    isReadOnlyDirectMessage,
    roomName,
  ]);
  // The header's own title still distinguishes "not resolved yet" (`null` —
  // render the skeleton) from a resolved name. A DM is resolved as soon as its
  // peer is known, which the cached roster usually already answers.
  const displayHeaderTitle = dmPeerPubkey ? displayRoomName : headerTitle;
  const headerTitleKind: ChannelHeaderKind = isCorner ? 'corner' : dmPeerPubkey ? 'dm' : 'room';
  const emptyLedgerVariant: EmptyLedgerVariant = isCorner
    ? 'corner'
    : isDirectMessage
      ? 'dm'
      : 'room';
  const focusComposer = useCallback(() => {
    scheduleAnimationFrame(() => composerRef.current?.focus());
  }, []);
  // The transcript is the composer's "outside": a tap on it puts the keyboard
  // away, the same as a drag (keyboardDismissMode on the list below). Kept
  // dependency-free so it never re-creates renderItem — see the memo note on
  // renderMessage.
  const dismissComposerKeyboard = useCallback(() => {
    Keyboard.dismiss();
  }, []);
  const canonicalCornerItem = isCorner && roomSurface
    ? cornerDisplayFromRoomView({ ...roomSurface, latestAgentTurns: activeAgentTurns })
    : undefined;
  const sessionState = !isCorner
    ? 'idle'
    : canonicalCornerItem?.state === 'working'
      ? 'working'
      : canonicalCornerItem?.state === 'archived'
        ? 'done'
        : 'idle';
  const cornerHeaderDisplay = cornerDisplayState(
    canonicalCornerItem ?? {
      state: isArchived ? 'archived' : 'waiting',
      lifecycle: { lifecycle: 'unknown', checks: 'unknown' },
    },
  );
  const cornerAgentPubkey = useMemo(
    () => resolveCornerViewAgentPubkey(messages, (pubkey) => agentByPubkey.has(pubkey)),
    [agentByPubkey, messages],
  );
  const rawSpeakerWorking = useMemo(
    () =>
      selectWorkingAgents({
        activeTurnPubkeys: activeAgentTurns.map((turn) => turn.agentPubkey),
        workingCornerAgentPubkey: sessionState === 'working' ? cornerAgentPubkey : null,
      }),
    [activeAgentTurns, cornerAgentPubkey, sessionState],
  );
  const speakerWorking = useStable(rawSpeakerWorking, shallowEqualRecord);
  // The corner header names the corner's OWN agent — the server projection's
  // `agent` (`corners.created_by`, the agent the corner belongs to), never
  // whichever agent currently holds a live turn. While a reviewer works in
  // the corner the transcript attribution is the reviewer's and stays there;
  // the corner does not change hands. The transcript-derived identity fills
  // in only before the server projection has landed. The gold ring on a
  // byline still names the actual worker (C77).
  const cornerHeaderAgentView = cornerHeaderAgent({
    ownerPubkey: cornerAgentPubkey,
    status: cornerHeaderDisplay.status,
    ...(cornerHeaderDisplay.headerSuffix ? { headerSuffix: cornerHeaderDisplay.headerSuffix } : {}),
    activeTurnPubkeys: activeAgentTurns.map((turn) => turn.agentPubkey),
  });
  const cornerOwnerPubkey = cornerHeaderAgentView.pubkey;
  const cornerOwnerDisplay = cornerOwnerPubkey
    ? resolvePendingAgentDisplay(
        cornerOwnerPubkey,
        agentByPubkey.get(cornerOwnerPubkey),
        participantsHydrated,
      )
    : undefined;
  const cornerHeaderWord = cornerHeaderAgentView.stateWord;
  const cornerOwnerWorking = cornerHeaderAgentView.ownerWorking;
  const visibleMessages = useMemo(
    () => projectActiveTurnStream(messages, activeAgentTurns, isArchived),
    [activeAgentTurns, isArchived, messages],
  );
  // Run boundaries still control compact continuation spacing and machine-row
  // folding. Ordinary prose always renders its own byline, even inside a run,
  // so every message remains independently attributable.
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
            // A reply always re-announces its own speaker; see
            // `continuedSpeakerIds`'s `hasReplyReference` doc.
            hasReplyReference: Boolean(message.replyToId),
          })),
        ),
      ),
    [agentByPubkey, visibleMessages],
  );
  // renderItem consumes this set; preserve its identity across commits that
  // did not change any run boundary so rows are not rebuilt for nothing.
  const continuedAttributionIds = useStable(rawContinuedAttributionIds, sameStringSet);
  // Native keeps the established inverted list. React Native Web implements
  // `inverted` with scale transforms, which can leave variable-height rows at
  // stale coordinates after a send. Every desktop-platform transcript uses
  // ordinary chronological flow, including a packaged Windows window resized
  // below the persistent-sidebar breakpoint.
  const desktopTranscript = desktopExperience;
  const invertedMessages = useMemo(() => [...visibleMessages].reverse(), [visibleMessages]);
  const transcriptMessages = desktopTranscript ? visibleMessages : invertedMessages;
  // Landing retries can outlive the render that scheduled them. Read the
  // current inverted order so arrivals during measurement cannot shift the
  // durable boundary away from the numeric index we retry.
  const transcriptMessagesRef = useRef(transcriptMessages);
  transcriptMessagesRef.current = transcriptMessages;
  // The read cursor ranks rows by index to decide which is newest, so it reads
  // the chronological order for the same reason the jump control does: on the
  // phone `transcriptMessages` IS the reversed list, and ranking that array
  // picks the oldest visible row and reads a scroll back up as progress.
  const chronologicalMessagesRef = useRef(visibleMessages);
  chronologicalMessagesRef.current = visibleMessages;
  // The row the jump control exists to reach. Read from the chronological
  // order so the inverted phone list and the desktop list name the same row.
  const newestTranscriptMessageId = newestTranscriptRowId(visibleMessages);
  // Rooms use the unread divider and queue; corners use only the viewport-
  // driven jump control (`buzz/use-new-message-control.ts`).
  // The divider answers one question: where the reader's unread run began when
  // they opened this Room. The server's cursor owns that line until the newest
  // row is visible; a message arriving while the reader is in history belongs
  // to the control, not to that line. Binding the divider to the live queue
  // instead dragged it off the unread run and pinned it to whichever row had
  // just landed, which is the divider readers watched appear at the newest
  // message out of nowhere.
  const {
    dividerMessageId: firstNewMessageId,
    queue: newMessageQueue,
    discVisible: newestJumpDiscShown,
    badgeCount: newMessageBadgeCount,
    catchUpVisible: catchUpEligible,
    observeVisibleMessages,
    observeTailPinned,
    settleQueueAtBoundary,
  } = useNewMessageControl({
    roomId: decodedId,
    queueableMessages: foldedMessages,
    arrivingIds: transcriptArrivalObservation.arrivingIds,
    newestMessageId: newestTranscriptMessageId,
    firstUnreadMessageId: isCorner ? null : firstUnreadMessageId,
    openingUnreadCounts: isCorner ? null : openingUnreadCounts,
    isPinnedToTail: () => isPinnedToTailRef.current,
    enabled: !isCorner,
  });
  // The catch-up sheet, reached from the strip and from a long-press on the
  // badge. Both doors carry the same unread range — the boundary the reader
  // fell behind at (the live queue's, or the server's opening cursor before
  // anything has queued) through the newest row — into the one seam that
  // builds the sheet's two blocks (`buzz/room-catch-up-report.ts`).
  const [catchUpSheetVisible, setCatchUpSheetVisible] = useState(false);
  // The server's cursor first: it is the one boundary that knows where the
  // reader fell behind BEFORE this visit. The live queue only answers for a
  // Room that opened read and gained arrivals while they sat in history.
  const catchUpBoundaryId = isCorner
    ? null
    : (firstUnreadMessageId ?? newMessageQueue.boundaryId);
  const catchUpReport = useMemo(
    () =>
      !isCorner && catchUpSheetVisible
        ? buildCatchUpReport({
            messages: foldedMessages,
            boundaryId: catchUpBoundaryId,
            newestId: newestTranscriptMessageId,
            viewerPubkey: userPubkey ?? null,
            // The roster the bylines already resolve against, so an ask whose
            // requester is not the row's author is still named correctly.
            identities: conversationIdentities,
          })
        : null,
    [
      catchUpBoundaryId,
      catchUpSheetVisible,
      conversationIdentities,
      foldedMessages,
      isCorner,
      newestTranscriptMessageId,
      userPubkey,
    ],
  );
  const openCatchUpSheet = useCallback(() => {
    if (!isCorner) setCatchUpSheetVisible(true);
  }, [isCorner]);
  const closeCatchUpSheet = useCallback(() => setCatchUpSheetVisible(false), []);
  const catchUpAgents = useMemo(
    () => roomParticipants.filter((participant) => participant.kind === 'agent'),
    [roomParticipants],
  );
  const draftCatchUpRequest = useCallback((agent: Pick<RoomMemberOption, 'pubkey' | 'name' | 'handle'>) => {
    if (
      isCorner ||
      !catchUpBoundaryId ||
      inputTextRef.current.trim() ||
      pendingAttachments.length > 0 ||
      !roomSurface?.viewer.permissions.send
    ) return;
    const handle = agent.handle.replace(/^@/, '');
    const prompt = `@${handle} Please catch me up on this Room from message ${catchUpBoundaryId} through the latest message. Summarize key changes, decisions, and anything I need to answer. If part of that history is unavailable, say which part you can see.`;
    selectedAgentMentionsRef.current.set(handle, agent.pubkey);
    selectedMentionsRef.current.set(handle, agent.pubkey);
    inputTextRef.current = prompt;
    setInputText(prompt);
    setInputSelection({ start: prompt.length, end: prompt.length });
    setCatchUpSheetVisible(false);
    scheduleAnimationFrame(() => composerRef.current?.focus());
  }, [catchUpBoundaryId, isCorner, pendingAttachments.length, roomSurface?.viewer.permissions.send]);
  const catchUpOfferVisible = !isCorner && catchUpEligible && catchUpAgents.length > 0 &&
    !viewerIsAgent && Boolean(roomSurface?.viewer.permissions.send);
  const slashVerbs = useMemo(
    () =>
      availableSlashVerbs(
        {
          canBuild: Boolean(
            !isCorner &&
              !isDirectMessage &&
              !viewerIsAgent &&
              roomSurface?.viewer.permissions.send,
          ),
          canAnswerPoll: Boolean(!viewerIsAgent && latestOpenPoll),
          // The verb is the line's door under another name: one gate, so
          // neither can offer a catch-up the other has withdrawn.
          canCatchUp: catchUpOfferVisible,
          canManageSchedules: Boolean(
            !isCorner &&
              !isDirectMessage &&
              !viewerIsAgent &&
              canManageWorkspace &&
              getBuzzRuntimeConfig().monolithEnabled,
          ),
          canRunWorkflows: Boolean(
            !isCorner &&
              !isDirectMessage &&
              !viewerIsAgent &&
              canManageWorkspace &&
              roomSurface?.repositoryResolution === 'repository',
          ),
          canOpenCorner: Boolean(!isCorner && !viewerIsAgent && pendingCornerRequest),
          canRename: Boolean(!isCorner && !isDirectMessage && !viewerIsAgent && canManageWorkspace),
          canCloseCorner: isCorner && !viewerIsAgent,
          canChangeTargetBranch: Boolean(
            !isCorner &&
            !viewerIsAgent &&
            canManageWorkspace &&
            pendingTargetBranchProposal &&
            !targetBranchActionId,
          ),
          canAddAgent: Boolean(!isCorner && !isDirectMessage && !viewerIsAgent),
          canInvitePerson: Boolean(
            !isCorner && !isDirectMessage && !viewerIsAgent && canManageWorkspace,
          ),
        },
        currentSlashQuery ?? '',
      ),
    [
      catchUpOfferVisible,
      currentSlashQuery,
      canManageWorkspace,
      isCorner,
      isDirectMessage,
      latestOpenPoll,
      pendingCornerRequest,
      pendingTargetBranchProposal,
      targetBranchActionId,
      viewerChannelRole,
      viewerIsAgent,
      roomSurface?.repositoryResolution,
      roomSurface?.viewer.permissions.send,
    ],
  );
  const slashMenuVisible = Boolean(
    composerFocused &&
    (currentSlashQuery !== null || (mentionSlash !== null && mentionSlashAgentPubkey !== null)) &&
    dismissedSlashText !== inputText,
  );
  const paletteItemCount =
    mentionAgentCommands.length + cornerAppCommands.length + slashVerbs.length;
  useEffect(() => {
    setHighlightedSlashVerbIndex(0);
  }, [currentSlashQuery, mentionSlash?.query, paletteItemCount]);
  useEffect(() => setCatchUpSheetVisible(false), [decodedId]);
  // A send releases whatever history anchor is holding the landing; the pair
  // it released is remembered so a *later* anchor still owns its own landing.
  const [releasedHistoryAnchorKey, setReleasedHistoryAnchorKey] = useState<string | null>(null);
  useEffect(() => setReleasedHistoryAnchorKey(null), [decodedId]);
  const transcriptLandingAnchorId = transcriptLandingAnchor({
    messageAnchorId,
    firstUnreadMessageId: isCorner ? null : firstUnreadMessageId,
    releasedAnchorKey: releasedHistoryAnchorKey,
  });
  // A live message/card change follows to the newest end. The decision is one
  // pure call (`buzz/room-scroll-follow.ts`); the actual tail scroll runs at
  // most once per arrival, off the render path.
  const userDraggingRef = useRef(false);
  // The desktop transcript's real scroll container and content node — a
  // plain scrollable View over real DOM (`shouldFollowDesktopTail` in
  // `buzz/room-scroll-follow.ts`), not React Native Web's FlatList/
  // VirtualizedList, whose own provisional layout accounting is the root
  // cause proof/desktop-append-overlap/NOTES.md traces eight prior scroll-
  // timing patches back to.
  const desktopScrollNodeRef = useRef<HTMLElement | null>(null);
  const desktopContentNodeRef = useRef<HTMLElement | null>(null);
  const desktopContentObserverRef = useRef<ResizeObserver | null>(null);
  // Row DOM nodes by message id, for id-based jumps (notification anchor,
  // unread boundary, artifact origin) and viewability — no index math, no
  // scrollToIndex failure/retry.
  const desktopRowNodesRef = useRef<Map<string, HTMLElement>>(new Map());
  const desktopVisibilityObserverRef = useRef<IntersectionObserver | null>(null);
  const desktopIntersectingIdsRef = useRef<Set<string>>(new Set());
  // A message anchor (notification, unread boundary) owns the next landing;
  // read inside the observer callback below, which outlives the render that
  // armed the anchor.
  const transcriptLandingAnchorIdRef = useRef(transcriptLandingAnchorId);
  transcriptLandingAnchorIdRef.current = transcriptLandingAnchorId;
  // The oldest row id and real scrollHeight the previous commit left, so a
  // prepend (older history paging in above the reader) can hold the
  // reader's place by the real measured growth at the top — what
  // `maintainVisibleContentPosition` does on native.
  const desktopPrependOldestIdRef = useRef<string | null>(null);
  const desktopPrependScrollHeightRef = useRef<number | null>(null);
  const pendingNewMessageLandingRef = useRef<{
    boundaryId: string;
    acknowledgeQueue: boolean;
  } | null>(null);
  const visibleTranscriptMessagesRef = useRef<ChatDisplayMessage[]>([]);
  const dragEndSequenceRef = useRef(0);
  const completedUnreadLandingRef = useRef<string | null>(null);
  // The row a completed notification landing is pointing at, for as long as
  // the pointer plays. Cleared on its own timer, so the next landing on the
  // same row is a fresh false→true edge and a re-render is not.
  const [arrivalFlashMessageId, setArrivalFlashMessageId] = useState<string | null>(null);
  const arrivalFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageAnchorIdRef = useRef(messageAnchorId);
  messageAnchorIdRef.current = messageAnchorId;
  const raiseArrivalFlash = useCallback((messageId: string) => {
    if (arrivalFlashTimerRef.current !== null) clearTimeout(arrivalFlashTimerRef.current);
    setArrivalFlashMessageId(messageId);
    arrivalFlashTimerRef.current = setTimeout(() => {
      arrivalFlashTimerRef.current = null;
      setArrivalFlashMessageId(null);
      // The cell reads the system setting itself; this timer only has to
      // outlast the longer of the two shapes it can take.
    }, arrivalFlashTiming(false).totalMs);
  }, []);
  useEffect(
    () => () => {
      if (arrivalFlashTimerRef.current !== null) clearTimeout(arrivalFlashTimerRef.current);
    },
    [],
  );
  useEffect(() => {
    dragEndSequenceRef.current += 1;
    pendingNewMessageLandingRef.current = null;
    visibleTranscriptMessagesRef.current = [];
    completedUnreadLandingRef.current = null;
    desktopRowNodesRef.current.clear();
    desktopRowRefCallbacksRef.current.clear();
    desktopIntersectingIdsRef.current.clear();
    desktopPrependOldestIdRef.current = null;
    desktopPrependScrollHeightRef.current = null;
  }, [decodedId]);
  const completePendingNewMessageLanding = useCallback(() => {
    const pending = pendingNewMessageLandingRef.current;
    if (
      !pending ||
      userDraggingRef.current ||
      !visibleTranscriptMessagesRef.current.some((message) =>
        messageContainsBoundary(message, pending.boundaryId),
      )
    ) {
      return false;
    }

    pendingNewMessageLandingRef.current = null;
    if (pending.acknowledgeQueue) {
      settleQueueAtBoundary(pending.boundaryId);
    } else {
      completedUnreadLandingRef.current = pending.boundaryId;
    }
    // The landing is COMPLETE here — the row is on screen, which is the same
    // rule the badge runs on. A flash fired at row mount would burn off
    // behind the fold while backward paging was still measuring, and the
    // reader who followed the notification would arrive to nothing.
    if (
      landingFlashesArrival({
        landedBoundaryId: pending.boundaryId,
        messageAnchorId: messageAnchorIdRef.current,
      })
    ) {
      raiseArrivalFlash(pending.boundaryId);
    }
    return true;
  }, [raiseArrivalFlash, settleQueueAtBoundary]);
  const observeVisibleTranscriptMessages = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken<ChatDisplayMessage>[] }) => {
      visibleTranscriptMessagesRef.current = viewableItems
        .filter((token) => token.isViewable)
        .map((token) => token.item);
      // The list recomputes viewability on scroll AND on every committed
      // update, so an arrival that lands below the fold reports itself unseen
      // without the reader touching anything.
      observeVisibleMessages(visibleTranscriptMessagesRef.current);
      // The same report is what moves the read mark. A row that never entered
      // the viewport is never read, however far below it the transcript runs.
      // Chronological order, never `transcriptMessagesRef` — that one is
      // reversed on the phone, and the cursor ranks by index.
      advanceReadCursor(chronologicalMessagesRef.current, visibleTranscriptMessagesRef.current);
      completePendingNewMessageLanding();
    },
    [advanceReadCursor, completePendingNewMessageLanding, observeVisibleMessages],
  );
  // Follow a new row only from the tail. A reader in history keeps the same
  // position while the arrival joins the compact queue above the composer.
  const scrollToArtifactOrigin = useCallback(
    (index: number, viewPosition: number) => {
      scheduleAnimationFrame(() => {
        if (desktopTranscript) {
          desktopRowNodesRef.current
            .get(transcriptMessagesRef.current[index]?.id ?? '')
            ?.scrollIntoView({ block: 'center' });
          return;
        }
        flatListRef.current?.scrollToIndex({ index, viewPosition, animated: false });
      });
    },
    [desktopTranscript],
  );
  const handleOpenCode = useArtifactReturn({
    transcriptMessages,
    residentMessages: combinedMessages,
    onReveal: revealTranscriptThrough,
    onScroll: scrollToArtifactOrigin,
  });
  // Re-land on every REAL layout change of the desktop content — an
  // appended row, streaming text growing the newest row, a late-loading
  // image — while the reader is already pinned to the tail. One measured
  // comparison, no retry budget: `scrollTop`/`scrollHeight` are native
  // browser state, so a reader who scrolled away is simply no longer
  // pinned; there is nothing left to disarm.
  //
  // Pin state itself is read from `isPinnedToTailRef`, not recomputed here:
  // a cold open has no scroll event yet (scrollTop is still 0 against the
  // full, taller-than-viewport content), so a fresh scrollTop/scrollHeight
  // read at that instant says "not pinned" and would never take the first
  // landing. `isPinnedToTailRef` starts true and is corrected only by a real
  // scroll, which is the same invariant the native list already relies on.
  const setDesktopContentNode = useCallback((node: HTMLElement | null) => {
    desktopContentObserverRef.current?.disconnect();
    desktopContentObserverRef.current = null;
    desktopContentNodeRef.current = node;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const scrollNode = desktopScrollNodeRef.current;
      if (!scrollNode) return;
      if (
        shouldFollowDesktopTail({
          isPinnedToTail: isPinnedToTailRef.current,
          isUserDragging: userDraggingRef.current,
          hasLandingAnchor: Boolean(transcriptLandingAnchorIdRef.current),
        })
      ) {
        scrollNode.scrollTop = scrollNode.scrollHeight;
      }
    });
    observer.observe(node);
    desktopContentObserverRef.current = observer;
  }, []);
  const setDesktopScrollNode = useCallback(
    (node: HTMLElement | null) => {
      desktopScrollNodeRef.current = node;
      desktopVisibilityObserverRef.current?.disconnect();
      desktopVisibilityObserverRef.current = null;
      if (!node || typeof IntersectionObserver === 'undefined') return;
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const id = (entry.target as HTMLElement).dataset?.rowId;
            if (!id) continue;
            if (entry.isIntersecting) desktopIntersectingIdsRef.current.add(id);
            else desktopIntersectingIdsRef.current.delete(id);
          }
          observeVisibleTranscriptMessages({
            viewableItems: transcriptMessagesRef.current
              .filter((item) => desktopIntersectingIdsRef.current.has(item.id))
              .map((item) => ({ item, isViewable: true }) as ViewToken<ChatDisplayMessage>),
          });
        },
        { root: node, threshold: 0 },
      );
      desktopVisibilityObserverRef.current = observer;
      for (const rowNode of desktopRowNodesRef.current.values()) observer.observe(rowNode);
    },
    [observeVisibleTranscriptMessages],
  );
  const registerDesktopRowNode = useCallback((id: string, node: HTMLElement | null) => {
    const previous = desktopRowNodesRef.current.get(id);
    if (previous && previous !== node) desktopVisibilityObserverRef.current?.unobserve(previous);
    if (node) {
      desktopRowNodesRef.current.set(id, node);
      desktopVisibilityObserverRef.current?.observe(node);
    } else {
      desktopRowNodesRef.current.delete(id);
      desktopIntersectingIdsRef.current.delete(id);
    }
  }, []);
  // A stable ref callback per row id, so a re-render that leaves a row's id
  // unchanged does not toggle its DOM node out of and back into the
  // observers above (a fresh inline `ref` closure does that on every commit).
  const desktopRowRefCallbacksRef = useRef<Map<string, (node: HTMLElement | null) => void>>(
    new Map(),
  );
  const getDesktopRowRefCallback = useCallback(
    (id: string) => {
      let callback = desktopRowRefCallbacksRef.current.get(id);
      if (!callback) {
        callback = (node) => registerDesktopRowNode(id, node);
        desktopRowRefCallbacksRef.current.set(id, callback);
      }
      return callback;
    },
    [registerDesktopRowNode],
  );
  useEffect(
    () => () => {
      desktopContentObserverRef.current?.disconnect();
      desktopVisibilityObserverRef.current?.disconnect();
    },
    [],
  );
  // Pinned? Real scrollHeight/scrollTop/clientHeight, not RN Web's
  // contentOffset/contentSize estimates — the same formula the follow above
  // reads off the live scroll node.
  const handleDesktopScroll = useCallback(
    (event: { currentTarget: HTMLElement }) => {
      const node = event.currentTarget;
      isPinnedToTailRef.current =
        node.scrollHeight - node.scrollTop - node.clientHeight <= TAIL_PIN_THRESHOLD;
      observeTailPinned(isPinnedToTailRef.current);
      if (
        (!isPinnedToTailRef.current ||
          node.scrollHeight <= node.clientHeight + TAIL_PIN_THRESHOLD) &&
        node.scrollTop <= TAIL_PIN_THRESHOLD
      ) {
        loadOlderTranscriptMessages();
      }
    },
    [loadOlderTranscriptMessages, observeTailPinned],
  );
  // Older history paging in above the reader grows the content from the
  // top, not the bottom — hold the reader's place by the real measured
  // growth instead of letting it silently shift what they were reading.
  useLayoutEffect(() => {
    if (!desktopTranscript) return;
    const node = desktopScrollNodeRef.current;
    const oldestId = transcriptMessages[0]?.id ?? null;
    const previousOldestId = desktopPrependOldestIdRef.current;
    const previousScrollHeight = desktopPrependScrollHeightRef.current;
    if (
      node &&
      oldestId !== null &&
      previousOldestId !== null &&
      oldestId !== previousOldestId &&
      previousScrollHeight !== null
    ) {
      node.scrollTop += node.scrollHeight - previousScrollHeight;
    }
    desktopPrependOldestIdRef.current = oldestId;
    desktopPrependScrollHeightRef.current = node?.scrollHeight ?? null;
  }, [desktopTranscript, transcriptMessages]);
  const landAtNewMessageBoundary = useCallback(
    (boundaryId: string, acknowledgeQueue: boolean) => {
      pendingNewMessageLandingRef.current = { boundaryId, acknowledgeQueue };
      if (userDraggingRef.current) return;

      // A visible boundary is already a completed landing. This also covers
      // a tap whose target remained on screen while the compact count grew.
      if (completePendingNewMessageLanding()) return;

      const visibleIndex = boundaryRowIndex(transcriptMessagesRef.current, boundaryId);
      if (visibleIndex >= 0) {
        scheduleAnimationFrame(() => {
          const pending = pendingNewMessageLandingRef.current;
          if (userDraggingRef.current || pending?.boundaryId !== boundaryId) return;
          const currentIndex = boundaryRowIndex(
            transcriptMessagesRef.current,
            boundaryId,
          );
          if (currentIndex < 0) return;
          if (desktopTranscript) {
            desktopRowNodesRef.current
              .get(transcriptMessagesRef.current[currentIndex]?.id ?? '')
              ?.scrollIntoView({ block: 'center' });
          } else {
            flatListRef.current?.scrollToIndex({
              index: currentIndex,
              viewPosition: 0.5,
              animated: false,
            });
          }
          // Keep the durable boundary armed. Viewability is the success
          // signal; onScrollToIndexFailed may still need to measure and retry.
          completePendingNewMessageLanding();
        });
        return;
      }

      const residentIndex = boundaryRowIndex(foldedMessages, boundaryId);
      if (residentIndex >= 0) {
        revealTranscriptThrough(foldedMessages.length - residentIndex);
      } else if (transcriptHistoryStatus === 'idle') {
        loadOlderTranscriptMessages();
      }
    },
    [
      completePendingNewMessageLanding,
      desktopTranscript,
      foldedMessages,
      loadOlderTranscriptMessages,
      revealTranscriptThrough,
      transcriptHistoryStatus,
    ],
  );
  const resumePendingNewMessageLanding = useCallback(() => {
    const pending = pendingNewMessageLandingRef.current;
    if (pending) {
      landAtNewMessageBoundary(pending.boundaryId, pending.acknowledgeQueue);
    }
  }, [landAtNewMessageBoundary]);
  useEffect(() => {
    if (
      isCorner ||
      !firstUnreadMessageId ||
      messageAnchorId ||
      completedUnreadLandingRef.current === firstUnreadMessageId
    ) {
      return;
    }
    landAtNewMessageBoundary(firstUnreadMessageId, false);
  }, [firstUnreadMessageId, isCorner, landAtNewMessageBoundary, messageAnchorId]);
  const scrollToNewestMessage = useCallback(() => {
    scheduleAnimationFrame(() => {
      if (desktopTranscript) {
        const node = desktopScrollNodeRef.current;
        if (node) node.scrollTop = node.scrollHeight;
        return;
      }
      flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
    });
  }, [desktopTranscript]);
  // The disc's one job. It lands on the tail itself rather than on a queued
  // boundary row, so a reader who is merely re-reading history — no queue at
  // all — gets back to the live end in one tap, and a reader with unread mail
  // arrives where the next message will land. Any queue behind it is settled
  // here: the tap is the reader saying they are done being behind.
  const landAtNewestMessage = useCallback(() => {
    pendingNewMessageLandingRef.current = null;
    scrollToNewestMessage();
    // The badge is NOT cleared here. A press is not visibility: this scroll
    // can be clamped, interrupted by a drag, or land short while the extent
    // is still measuring, and clearing on the press alone would tell the
    // reader they had seen rows they never reached. The viewability pass
    // clears it when the newest row is actually on screen — the same rule
    // that clears it when they scroll there under their own finger.
  }, [scrollToNewestMessage]);
  // The viewer sending is the viewer saying they are speaking at the live end
  // of the log, so the transcript lands there and shows them their own
  // message. Everything holding the viewport in history is released here: the
  // route/unread landing anchor (`transcriptLandingAnchor`), any armed
  // boundary landing, the unread-boundary effect below, and the pin itself,
  // which the arrival rule reads to decide whether the appended row follows.
  const releaseHistoryAnchorForSend = useCallback(() => {
    pendingNewMessageLandingRef.current = null;
    if (firstUnreadMessageId) completedUnreadLandingRef.current = firstUnreadMessageId;
    setReleasedHistoryAnchorKey(historyAnchorKey({ messageAnchorId, firstUnreadMessageId }));
    isPinnedToTailRef.current = true;
    scrollToNewestMessage();
  }, [firstUnreadMessageId, messageAnchorId, scrollToNewestMessage]);
  useEffect(
    () =>
      liveDraftStore.subscribeCommit(() => {
        if (!isPinnedToTailRef.current || userDraggingRef.current) return;
        scrollToNewestMessage();
      }),
    [liveDraftStore, scrollToNewestMessage],
  );
  // Only a different tail row is an arrival. Lifecycle updates repaint the
  // existing row and must not pull a reader out of history.
  const newestMessageId = foldedMessages.at(-1)?.id ?? null;
  const arrivalFollow = useScrollFollowOnArrival({
    newestId: newestMessageId,
    isPinnedToTail: isPinnedToTailRef.current,
    isUserDragging: userDraggingRef.current,
    openLandsOnTail: roomOpenLandsOnTail({
      desktopTranscript,
      messageAnchorId: transcriptLandingAnchorId,
    }),
  });
  useLayoutEffect(() => {
    if (transcriptLandingAnchorId) return;
    if (arrivalFollow === 'hold') return;
    // Desktop's own ResizeObserver (`setDesktopContentNode` above) already
    // re-lands on the real DOM as the appended row's layout commits; this
    // call is a harmless, idempotent second landing for the same content —
    // native has no such observer and depends on it entirely.
    scrollToNewestMessage();
  }, [newestMessageId, scrollToNewestMessage, transcriptLandingAnchorId]);
  // Reveal the exact fact that caused the alert. Fresh messages usually land
  // in the cached tail; if the target is already resident outside the initial
  // window, widen the window first and scroll on the next render.
  useEffect(() => {
    if (!notificationResponseId) return;
    const anchorKey = `${notificationResponseId}:${notificationMessageId ?? notificationTarget ?? ''}`;
    if (handledNotificationAnchorRef.current === anchorKey) return;

    const messageId = notificationMessageId?.trim();
    if (!messageId) return;
    const visibleIndex = transcriptMessages.findIndex(
      (message) => message.id === messageId || message.relayId === messageId,
    );
    if (visibleIndex >= 0) {
      scheduleAnimationFrame(() => {
        if (desktopTranscript) {
          desktopRowNodesRef.current
            .get(transcriptMessages[visibleIndex]?.id ?? '')
            ?.scrollIntoView({ block: 'center' });
          return;
        }
        flatListRef.current?.scrollToIndex({
          index: visibleIndex,
          viewPosition: 0.5,
          animated: false,
        });
      });
      handledNotificationAnchorRef.current = anchorKey;
      return;
    }
    const residentIndex = combinedMessages.findIndex(
      (message) => message.id === messageId || message.relayId === messageId,
    );
    if (residentIndex >= 0) {
      const rowsFromNewest = combinedMessages.length - residentIndex;
      revealTranscriptThrough(rowsFromNewest);
      return;
    }
    // Bookmark links may target any durable message, not only the cached
    // tail. Walk bounded history pages until the exact id arrives or the
    // server reports the beginning of the Room.
    if (transcriptHistoryStatus === 'idle') loadOlderTranscriptMessages();
  }, [
    combinedMessages,
    transcriptMessages,
    notificationMessageId,
    notificationResponseId,
    notificationTarget,
    desktopTranscript,
    revealTranscriptThrough,
    loadOlderTranscriptMessages,
    transcriptHistoryStatus,
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
  const answeredMessageIds = useMemo(
    () =>
      new Set(
        visibleMessages
          .filter(
            (message) => message.authorIdentity?.kind === 'human' && Boolean(message.replyToId),
          )
          .map((message) => message.replyToId!),
      ),
    [visibleMessages],
  );
  const bylineOpeners = useMemo(() => transcriptBylineOpeners(visibleMessages), [visibleMessages]);
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
  // Once the matching server-indexed receipt lands there is nothing left for
  // the local ack to guess at. A terminal receipt is still confirmation: the
  // old active-only check missed the case where WORKING had already become
  // COMPLETE before this screen observed it.
  useEffect(() => {
    if (pendingAck && hasComposerAckReceipt(pendingAck.requestId, agentTurnMarkers)) {
      setPendingAck(null);
    }
  }, [agentTurnMarkers, pendingAck]);

  // A single deadline-scheduled timer (never a ticking interval — see the
  // presence clock above) clears the purely local acknowledgement. If no
  // receipt arrives, silence is not evidence that an agent is waiting; a
  // later server-indexed WORKING receipt can independently light `thinking`.
  useEffect(() => {
    if (!pendingAck) return;
    const deadline = pendingAck.sentAt + COMPOSER_ACK_BOUND_MS;
    const delay = Math.max(1, deadline - Date.now() + 1);
    const timer = setTimeout(() => setPendingAck(null), delay);
    return () => clearTimeout(timer);
  }, [pendingAck]);

  // A committed steer is a brief confirmation, not a new lifecycle. It stays
  // on the exact running turn the server accepted it into and then clears.
  useEffect(() => {
    if (!receivedSteer) return;
    if (
      !activeAgentTurn ||
      activeAgentTurn.agentPubkey !== receivedSteer.agentPubkey ||
      activeAgentTurn.requestId !== receivedSteer.turnRequestId
    ) {
      setReceivedSteer(null);
      return;
    }
    const delay = Math.max(
      1,
      receivedSteer.receivedAt + STEER_RECEIVED_VISIBLE_MS - Date.now() + 1,
    );
    const timer = setTimeout(() => setReceivedSteer(null), delay);
    return () => clearTimeout(timer);
  }, [activeAgentTurn, receivedSteer]);

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
   *
   * `pendingAck` (armed the instant a message addressed to an agent is sent —
   * see `handleSend`) bridges ONLY the send round trip: the moment the server
   * accepts the write, the moment a failure surfaces, or at
   * `COMPOSER_ACK_BOUND_MS` — whichever comes first — it retires, because the
   * honest state between "stored" and "claimed" is silence. Only a genuine
   * server-indexed WORKING receipt may show that an agent is thinking, and it
   * does so from the CLAIM, long before the model's first token streams.
   */
  const composerAck = useMemo((): ComposerAckPresentation | null => {
    return selectComposerAckPresentation({
      isCorner,
      viewerRole: roomSurface?.viewer.role,
      ...(activeAgentTurn?.agentPubkey ? { activeTurnPubkey: activeAgentTurn.agentPubkey } : {}),
      ...(activeAgentTurn
        ? {
            activeTurnStartedAt: activeAgentTurn.startedAt ?? activeAgentTurn.createdAt,
            activeTurnRequestId: activeAgentTurn.requestId,
            activeTurnAgentPubkey: activeAgentTurn.agentPubkey,
            ...(activeAgentTurn.requestedBy
              ? { activeTurnRequestedBy: activeAgentTurn.requestedBy }
              : {}),
          }
        : {}),
      ...(viewerPubkey ? { viewerPubkey } : {}),
      ...(pendingAck ? { pendingAckSentAt: pendingAck.sentAt } : {}),
      ...(receivedSteer ? { receivedSteer } : {}),
      now: pendingAck?.sentAt ?? Date.now(),
      conversationIdentities,
      agentsByPubkey: agentByPubkey,
    });
  }, [
    activeAgentTurn,
    roomSurface?.viewer.role,
    agentByPubkey,
    conversationIdentities,
    isCorner,
    pendingAck,
    receivedSteer,
    viewerPubkey,
  ]);

  // C97: the fixed chrome below the inverted list changes independently of
  // transcript rows. A send resets the composer's height while retaining the
  // keyboard and an offline helper mounts its hint; native layout can update
  // the pinned ref before an effect runs, preserving the old offset as an
  // empty gap. Capture the verdict in render.
  //
  // The phone turn line is NOT part of that chrome any more. It is absolute,
  // anchored to the composer's top edge (`room-bottom-chrome`), so it takes
  // no height out of the list whether or not an agent is working and the
  // newest row never moves when it comes or goes.
  // `bottomChromeLayoutKey` still carries turn/no-turn, but that half is now
  // a no-op re-pin; the follow it drives is the real thing only for the
  // offline hint, which still mounts in flow.
  const keyboardHeight = useKeyboardState((state) => state.height);
  const { progress: keyboardProgress } = useReanimatedKeyboardAnimation();
  const composerBottomInsetStyle = useAnimatedStyle(
    () => ({
      paddingBottom: composerBottomPadding(Platform.OS, insets.bottom, keyboardProgress.value),
    }),
    [insets.bottom],
  );
  const composerFootprint = composerHeight + keyboardHeight;
  const bottomChromeLayoutKey = [
    composerAck ? 'turn' : 'no-turn',
    agentsOffline ? 'offline' : 'online',
  ].join(':');
  const composerLayoutFollow = useScrollFollowOnLayoutChange({
    footprint: composerFootprint,
    layoutKey: bottomChromeLayoutKey,
    isPinnedToTail: isPinnedToTailRef.current,
    isUserDragging: userDraggingRef.current,
  });
  useLayoutEffect(() => {
    if (composerLayoutFollow === 'hold') return;
    scrollToNewestMessage();
  }, [bottomChromeLayoutKey, composerFootprint, composerLayoutFollow, scrollToNewestMessage]);

  /**
   * Withdraw the question this turn is answering.
   *
   * The control is offered to the requester or Room manager (`viewerMayStopTurn`), and the
   * server refuses anyone else, so the two agree on one rule rather than the
   * phone guessing at it. The press is acknowledged on this line immediately
   * (`stoppingTurn`); the cancelled receipt is still what settles the durable
   * "stopped" line and retires the control.
   */
  const [stoppingTurn, setStoppingTurn] = useState<{
    agentPubkey: string;
    requestId: string;
  } | null>(null);
  const handleStopTurn = useCallback(
    async (stop: { agentPubkey: string; requestId: string }) => {
      setStoppingTurn(stop);
      try {
        await monolithPhoneOperation('cancelAgentTurn', {
          roomId: decodedId,
          requestId: stop.requestId,
          agentId: stop.agentPubkey,
        });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        return true;
      } catch (err) {
        setStoppingTurn((current) =>
          current?.requestId === stop.requestId && current.agentPubkey === stop.agentPubkey
            ? null
            : current,
        );
        // A turn that settled while the press was in the air is the ordinary
        // race, not a failure worth a dialog: the line is already gone.
        console.warn('Stopping the turn failed:', err);
        return false;
      }
    },
    [decodedId],
  );
  useEffect(() => {
    if (!stoppingTurn) return;
    if (
      !activeAgentTurn ||
      activeAgentTurn.requestId !== stoppingTurn.requestId ||
      activeAgentTurn.agentPubkey !== stoppingTurn.agentPubkey
    ) {
      setStoppingTurn(null);
    }
  }, [activeAgentTurn, stoppingTurn]);
  const stoppingThisTurn = Boolean(
    stoppingTurn &&
    composerAck?.stop &&
    stoppingTurn.requestId === composerAck.stop.requestId &&
    stoppingTurn.agentPubkey === composerAck.stop.agentPubkey,
  );

  /** The settled "<Past> for Ns · done h:MM" line a finished turn leaves briefly. */
  const [settledTurn, setSettledTurn] = useState<{
    line: string;
  } | null>(null);
  const lastActiveTurnRef = useRef<{
    requestId: string;
    agentPubkey: string;
    startedAt: number;
    verb: TurnVerb;
  } | null>(null);
  useEffect(() => {
    if (activeAgentTurn) {
      const verb = composerAck?.verb;
      if (verb) {
        lastActiveTurnRef.current = {
          requestId: activeAgentTurn.requestId,
          agentPubkey: activeAgentTurn.agentPubkey,
          startedAt: (activeAgentTurn.startedAt ?? activeAgentTurn.createdAt) * 1_000,
          verb,
        };
      }
      setSettledTurn(null);
      return;
    }
    const last = lastActiveTurnRef.current;
    if (!last) return;
    const terminal = agentTurnMarkers.find(
      (turn) =>
        turn.requestId === last.requestId &&
        turn.agentPubkey === last.agentPubkey &&
        turn.status !== 'working',
    );
    if (!terminal) return;
    const status = terminal.status;
    if (status === 'working') return;
    lastActiveTurnRef.current = null;
    const line = formatTerminalTurnOverlay(
      status,
      last.verb,
      last.startedAt,
      terminal.createdAt * 1_000,
    );
    if (!line) return;
    setSettledTurn({ line });
  }, [activeAgentTurn, agentTurnMarkers, composerAck]);
  useEffect(() => {
    if (!settledTurn) return;
    const timer = setTimeout(() => setSettledTurn(null), 6_000);
    return () => clearTimeout(timer);
  }, [settledTurn]);
  useEffect(() => {
    if (!desktopExperience || (!composerAck && !settledTurn)) return;
    setDesktopDeliveryState((state) => (state === 'delivered' ? null : state));
  }, [composerAck, desktopExperience, settledTurn]);

  useEffect(() => {
    // Only an explicit offline fact can age into dormancy. A five-second clock
    // here recreated FlatList's renderItem (and every visible message) while
    // someone was typing, which made the foreground intermittently unresponsive.
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

  const replyTargetForMessage = useCallback(
    (message: ChatDisplayMessage): MessageReplyDisplayTarget => {
      const knownAgent = message.pubkey ? agentByPubkey.get(message.pubkey) : undefined;
      const isAgent = Boolean(
        message.pubkey && (message.isAgentAuthor || message.isAgentActivity || knownAgent),
      );
      const agentDisplay = isAgent
        ? resolveAgentDisplayIdentity(message.pubkey ?? 'unknown-agent', knownAgent)
        : undefined;
      const personProfile = message.pubkey ? personProfileByPubkey.get(message.pubkey) : undefined;
      const canonicalAuthorHandle =
        message.authorIdentity?.handle ??
        (isAgent
          ? knownAgent?.handle
          : (personProfile?.handle ??
            (message.pubkey ? fallbackMemberHandle(message.pubkey) : undefined)));
      const personName = personProfile?.name;
      const attachmentPreview = message.attachments?.[0]?.name;
      return {
        // A reconciled draft/final bubble's display `id` is a synthetic
        // per-turn key. The composer separately obtains the opaque threading
        // proof from the snapshot using this real message id.
        messageId: message.relayId ?? message.id,
        authorName:
          message.authorIdentity?.name ??
          agentDisplay?.name ??
          personName ??
          fallbackMemberName(message.pubkey ?? ''),
        ...(canonicalAuthorHandle ? { authorHandle: canonicalAuthorHandle } : {}),
        ...(message.pubkey ? { authorPubkey: message.pubkey } : {}),
        isAgent,
        preview: message.text.trim() || attachmentPreview || 'Attachment',
      };
    },
    [agentByPubkey, personProfileByPubkey],
  );

  const beginReply = useCallback(
    (message: ChatDisplayMessage) => {
      const target = message.isAgentActivity
        ? activityMessageReplyTarget(message, visibleMessages, replyTargetForMessage(message))
        : {
            ...replyTargetForMessage(message),
            ...(message.reference ? { reference: message.reference } : {}),
          };
      const install = () => {
        setReplyTarget(target);
        setDismissedMentionKey(null);
        void Haptics.selectionAsync();
        // A reply started from a message the reader scrolled up to read keeps
        // that same scroll offset by default while the keyboard/reply banner
        // shrink the viewport, which reads as the transcript jumping to
        // center the replied-to message. The reply reference in the composer
        // is enough context, so land back on the end of the log instead.
        scrollToNewestMessage();
        scheduleAnimationFrame(() => composerRef.current?.focus());
      };
      if (message.isAgentActivity || target.reference?.channelId === decodedId) install();
    },
    [decodedId, replyTargetForMessage, scrollToNewestMessage, visibleMessages],
  );

  const handleReactToMessage = useCallback(
    async (message: ChatDisplayMessage, emoji: MessageReactionEmoji) => {
      if (message.isAgentDraft) return;
      try {
        await monolithPhoneOperation('reactToMessage', {
          roomId: decodedId,
          messageId: message.relayId ?? message.id,
          emoji,
        });
        refreshSignal.force();
      } catch (error) {
        Modal.alert('Could not react', error instanceof Error ? error.message : String(error));
      }
    },
    [decodedId, refreshSignal],
  );

  const messageIsBookmarked = useCallback(
    (message: ChatDisplayMessage) =>
      optimisticBookmarks[message.relayId ?? message.id] ?? Boolean(message.bookmarked),
    [optimisticBookmarks],
  );

  const handleBookmarkMessage = useCallback(
    async (message: ChatDisplayMessage) => {
      if (message.isAgentActivity || message.isAgentDraft) return;
      const messageId = message.relayId ?? message.id;
      const previous = messageIsBookmarked(message);
      const bookmarked = !previous;
      setOptimisticBookmarks((current) => ({ ...current, [messageId]: bookmarked }));
      AccessibilityInfo.announceForAccessibility(
        bookmarked ? 'Message bookmarked' : 'Bookmark removed',
      );
      try {
        await monolithPhoneOperation('setMessageBookmark', {
          roomId: decodedId,
          messageId,
          bookmarked,
        });
        if (activeCommunityId)
          publishBookmarkChange({ workspaceId: activeCommunityId, bookmarked });
        refreshSignal.force();
      } catch (error) {
        setOptimisticBookmarks((current) => ({ ...current, [messageId]: previous }));
        AccessibilityInfo.announceForAccessibility('Bookmark change failed');
        Modal.alert(
          bookmarked ? 'Could not bookmark message' : 'Could not remove bookmark',
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [activeCommunityId, decodedId, messageIsBookmarked, refreshSignal],
  );

  const handleMarkUnread = useCallback(
    async (message: ChatDisplayMessage) => {
      // The boundary may only be placed on a row the one definition of unread
      // admits. Placed on the viewer's own message it drew a NEW MESSAGES
      // divider and announced success while the server — which never counts
      // viewer-authored rows — reported nothing unread and left the deck read.
      if (!countsAsUnread(message)) return;
      const messageId = message.relayId ?? message.id;
      try {
        await markUnreadFrom(messageId);
        AccessibilityInfo.announceForAccessibility('Marked unread from this message');
        refreshSignal.force();
      } catch (error) {
        AccessibilityInfo.announceForAccessibility('Mark unread failed');
        Modal.alert(
          'Could not mark unread',
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [markUnreadFrom, refreshSignal],
  );
  const openMessageActions = useCallback((message: ChatDisplayMessage) => {
    // A live draft is the turn still writing — it settles into the reply the
    // actions would target, so it offers none.
    if (message.isAgentDraft) return;
    void Haptics.selectionAsync();
    setMessageActionsTarget(message);
  }, []);

  const beginForward = useCallback(
    async (message: ChatDisplayMessage) => {
      // Forward works wherever a transcript renders — the picker sheet and
      // the send operation are not desktop-bound; the guard is only the
      // message itself and the Room client.
      if (message.isAgentDraft || !roomClient || !activeCommunityId) return;
      setForwardTarget(message);
      setForwardRooms(null);
      setForwardError(null);
      try {
        const [list, workspace] = await Promise.all([
          roomClient.chats(activeCommunityId),
          roomClient.workspace(activeCommunityId),
        ]);
        setForwardRooms(forwardTargets(list.chats, workspace, decodedId));
      } catch (error) {
        setForwardError(error instanceof Error ? error.message : String(error));
        setForwardRooms([]);
      }
    },
    [activeCommunityId, decodedId, roomClient],
  );

  const forwardToRoom = useCallback(
    async (target: ForwardTarget) => {
      if (!forwardTarget || forwardBusyRoomId) return;
      setForwardBusyRoomId(target.id);
      setForwardError(null);
      try {
        if (!transport || !activeCommunityId) throw new Error('Beeline is still connecting.');
        const roomId = await resolveForwardTargetRoom(
          target,
          activeCommunityId,
          (workspaceId, memberId) => transport.resolveDirectMessage(workspaceId, memberId),
        );
        await forwardMessageToRoom(
          (input) => monolithPhoneOperation('sendRoomMessage', input),
          roomId,
          {
            text: forwardTarget.text,
            author: forwardTarget.authorIdentity ?? {
              name: forwardTarget.pubkey
                ? fallbackMemberName(forwardTarget.pubkey)
                : 'SOMEONE',
              ...(forwardTarget.pubkey
                ? { handle: fallbackMemberHandle(forwardTarget.pubkey) }
                : {}),
            },
            attachments: forwardTarget.attachments,
          },
          displayRoomName,
        );
        setForwardTarget(null);
        setForwardRooms(null);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (error) {
        setForwardError(error instanceof Error ? error.message : String(error));
      } finally {
        setForwardBusyRoomId(null);
      }
    },
    [activeCommunityId, displayRoomName, forwardBusyRoomId, forwardTarget, transport],
  );

  const markOutboxFailed = outbox.markFailed;
  const scheduleOutboxConfirmation = outbox.scheduleConfirmation;
  const retryOutboxMessage = outbox.retry;
  const dismissOutboxMessage = outbox.dismiss;
  const handleSend = useCallback(async (shortcut?: MessageShortcut) => {
    // A leaked responder event must never read as a shortcut (#1340's
    // `onPress={onSend}` handed the PressEvent straight in; `!shortcut` then
    // skipped the composer-clear block and the field kept its text after
    // every send). Only a real shortcut — it always carries text — qualifies.
    const sendShortcut = shortcut && typeof shortcut.text === 'string' ? shortcut : undefined;
    const rawText = (sendShortcut?.text ?? inputTextRef.current).trim();
    const activeReplyTarget = sendShortcut?.replyTarget ?? replyTarget;
    const activePendingAttachments = sendShortcut ? [] : pendingAttachmentsRef.current;
    // State updates are committed asynchronously. A ref closes the short
    // double-tap window before `sending` can disable the native control.
    if (sendInFlightRef.current || (!rawText && activePendingAttachments.length === 0) || isArchived)
      return;
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
    const preparedReply = activeReplyTarget
      ? prepareMessageReply(rawText, activeReplyTarget)
      : undefined;
    const text = preparedReply?.text ?? rawText;
    const mentionedPubkeys = resolveComposerMentions(
      text,
      roomParticipants,
      sendShortcut ? NO_SELECTED_MENTIONS : selectedMentionsRef.current,
    ).pubkeys;
    const selectedMentionedAgent = sendShortcut
      ? undefined
      : selectedMentionAgentPubkey(text, selectedAgentMentionsRef.current);
    const mentionedAgent =
      selectedMentionedAgent ??
      preparedReply?.agentPubkey ??
      mentionedPubkeys.find((pubkey) => roomAgents.some((agent) => agent.pubkey === pubkey)) ??
      mentionedAgentPubkey(text, roomAgents);
    // Resolve before attachment upload or cold transport creation so the ack
    // cannot wait on either. A corner (one agent, always addressed) or a
    // two-party Room (the sole other participant may speak naturally, per the
    // addressing rule) counts too.
    const addressesAgent =
      isCorner ||
      Boolean(mentionedAgent) ||
      (roomAgents.length === 1 && roomParticipants.length <= 2);
    setReceivedSteer(null);
    setPendingAck(addressesAgent ? { sentAt: Date.now() } : null);

    sendInFlightRef.current = true;
    setSending(true);
    if (desktopExperience) setDesktopDeliveryState('sending');
    let preparedEvent: Awaited<ReturnType<BuzzRigTransport['composeMessage']>> | undefined;
    let preparedTransport: BuzzRigTransport | undefined;
    try {
      // A warm/partial snapshot can paint before the hydration effect has
      // published its transport state. Sending is still a valid operation:
      // construct the monolith transport on demand rather than
      // leaving the enabled send control as a silent no-op.
      let sendTransport = transport;
      if (!sendTransport) {
        const identity = await loadBuzzIdentity();
        if (!identity) throw new Error('Beeline identity is unavailable');
        sendTransport = new BuzzRigTransport(identity);
      }
      if (!transport) setSessionTransport(sendTransport);
      preparedTransport = sendTransport;
      const attachments = await uploadChatAttachments(
        await sendTransport.ensureClient(),
        activePendingAttachments,
      );
      // Sign before append. The authoritative event id is the optimistic row
      // identity and the durable outbox key from its first frame onward.
      preparedEvent = preparedReply?.reference
        ? await sendTransport.composeReplyMessage(
            text,
            preparedReply.reference,
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
      if (addressesAgent) {
        setPendingAck((current) =>
          current ? { ...current, requestId: preparedEvent!.id } : current,
        );
      }
      const optimistic = {
        id: preparedEvent.id,
        text,
        isUser: true,
        timestamp: preparedEvent.created_at,
        authorIdentity: roomSurface?.viewer.identity ?? {
          pubkey: userPubkey,
          kind: 'human',
            name: fallbackMemberName(userPubkey),
        },
        pubkey: userPubkey,
        reference: undefined,
        ...(mentionedPubkeys.length ? { mentionPubkeys: mentionedPubkeys } : {}),
        ...(preparedReply?.reference ? { replyToId: preparedReply.reference.eventId } : {}),
        ...(attachments.length ? { attachments } : {}),
      } satisfies ChatDisplayMessage;
      const activeOutbox = outbox.current();
      if (!activeOutbox) throw new Error('Message outbox is unavailable');
      await activeOutbox.enqueue(preparedEvent, {
        id: preparedEvent.id,
        text,
        createdAt: preparedEvent.created_at,
        author: roomSurface?.viewer.identity ?? {
          pubkey: userPubkey,
          kind: 'human',
            name: fallbackMemberName(userPubkey),
        },
        presentation: 'message',
        ...(mentionedPubkeys.length ? { mentionPubkeys: mentionedPubkeys } : {}),
        ...(attachments.length ? { attachments } : {}),
      });
      addMessages([optimistic]);
      releaseHistoryAnchorForSend();
      if (!sendShortcut) {
        const nextInputRevision = composerInputRevisionRef.current + 1;
        composerInputRevisionRef.current = nextInputRevision;
        // Clear both owners of the controlled field. `clear()` removes the
        // platform value immediately; the revision remount below guarantees
        // the replacement starts empty even if native reconciliation lags.
        composerRef.current?.clear();
        inputTextRef.current = '';
        setInputText('');
        setComposerInputRevision(nextInputRevision);
        setComposerHeight(COMPOSER_MIN_HEIGHT);
        setInputSelection({ start: 0, end: 0 });
        replacePendingAttachments((current) =>
          current.filter((attachment) => !activePendingAttachments.includes(attachment)),
        );
        setReplyTarget(null);
        if (desktopExperience) void saveDesktopDraft(decodedId, '');
      }
      await activeOutbox.attempted(preparedEvent.id);
      const writeResult = await sendTransport.publishPreparedMessage(preparedEvent);
      if (
        isCorner &&
        activeAgentTurn &&
        writeResult.activeSteerAgentIds?.includes(activeAgentTurn.agentPubkey)
      ) {
        setReceivedSteer({
          agentPubkey: activeAgentTurn.agentPubkey,
          turnRequestId: activeAgentTurn.requestId,
          receivedAt: Date.now(),
        });
      }
      if (desktopExperience) setDesktopDeliveryState('delivered');
      // The write ack retires the local bridge: the server has STORED the
      // message, so "sending…" has nothing left to bridge. It used to outlive
      // the write by up to the whole first-token wait (tens of seconds) or
      // its own 15s bound, whichever was longer. The claimed turn's WORKING
      // receipt lights `thinking` on its own, and this ack must not sit
      // between them.
      const ackedRequestId = preparedEvent.id;
      setPendingAck((current) =>
        current && (current.requestId === undefined || current.requestId === ackedRequestId)
          ? null
          : current,
      );
      // Advance the read mark to our own message immediately: a message we
      // wrote must never gold the Room list while the deck's working
      // indicator carries the live turn (room-list-row.ts: a working agent never lights the attention square).
      void roomClient?.markRead(decodedId, preparedEvent.id).catch(() => undefined);
      refreshSignal.signal();
      scheduleOutboxConfirmation(preparedEvent.id);
    } catch (err) {
      console.warn('Send failed:', err);
      if (desktopExperience) setDesktopDeliveryState('failed');
      // A publish failure already gets its own explicit modal below; the
      // local ack has nothing left to guess at and must not keep buzzing.
      setPendingAck(null);
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
    replacePendingAttachments,
    transport,
    decodedId,
    addMessages,
    isArchived,
    isCorner,
    activeAgentTurn,
    userPubkey,
    parentChannelId,
    roomParticipants,
    roomAgents,
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
    desktopExperience,
    releaseHistoryAnchorForSend,
  ]);

  const handleCornerProposalDecision = useCallback(
    (message: ChatDisplayMessage, decision: 'open' | 'cancel') => {
      if (sendInFlightRef.current) return;
      const proposalReplyTarget = {
        ...replyTargetForMessage(message),
        ...(message.reference ? { reference: message.reference } : {}),
      };
      setCornerProposalAction({ messageId: message.id, decision });
      void handleSend({
        text: decision === 'open' ? 'go' : 'cancel',
        replyTarget: proposalReplyTarget,
      }).finally(() =>
        setCornerProposalAction((current) =>
          current?.messageId === message.id && current.decision === decision ? null : current,
        ),
      );
    },
    [handleSend, replyTargetForMessage],
  );

  const pickPhoto = useCallback(async () => {
    const remaining = MAX_MESSAGE_ATTACHMENTS - pendingAttachments.length;
    if (remaining <= 0) {
      Modal.alert(
        'Attachment limit reached',
        `A message can include up to ${MAX_MESSAGE_ATTACHMENTS} attachments.`,
      );
      return;
    }
    if (Platform.OS === 'ios') {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (permission.status !== 'granted') {
        Modal.alert('Photo access needed', 'Allow photo access to attach an image.');
        return;
      }
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: remaining,
      quality: 1,
      exif: false,
    });
    if (result.canceled || result.assets.length === 0) return;
    replacePendingAttachments((current) => [
      ...current,
      ...pickedPhotoAttachments(result.assets).slice(0, MAX_MESSAGE_ATTACHMENTS - current.length),
    ]);
  }, [pendingAttachments.length, replacePendingAttachments]);

  const pickDocument = useCallback(async () => {
    if (pendingAttachments.length >= MAX_MESSAGE_ATTACHMENTS) {
      Modal.alert(
        'Attachment limit reached',
        `A message can include up to ${MAX_MESSAGE_ATTACHMENTS} attachments.`,
      );
      return;
    }
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: false,
      type: '*/*',
    });
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset) return;
    replacePendingAttachments((current) => [
      ...current,
      {
        uri: asset.uri,
        name: asset.name?.trim() || `file-${Date.now()}`,
        mimeType: asset.mimeType ?? 'application/octet-stream',
        size: asset.size ?? 0,
        source: 'file',
      },
    ]);
  }, [pendingAttachments.length, replacePendingAttachments]);

  const pasteImage = useCallback(async () => {
    if (pendingAttachments.length >= MAX_MESSAGE_ATTACHMENTS) {
      Modal.alert(
        'Attachment limit reached',
        `A message can include up to ${MAX_MESSAGE_ATTACHMENTS} attachments.`,
      );
      return;
    }
    if (!(await Clipboard.hasImageAsync())) {
      Modal.alert('Nothing to paste', 'Copy an image first, then try again.');
      return;
    }
    const image = await Clipboard.getImageAsync({ format: 'png' });
    if (!image) return;
    const attachment = await pastedImageAttachment(image);
    replacePendingAttachments((current) => [...current, attachment]);
  }, [pendingAttachments.length, replacePendingAttachments]);

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
      // `@channel` is a broadcast token, never a resolvable identity — it
      // must not earn a picker→pubkey binding.
      if (!isChannelMentionHandle(participant.handle)) {
        selectedMentionsRef.current.set(participant.handle, participant.pubkey);
      }
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
      scheduleAnimationFrame(() => {
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
   * Answer a grant card. The server holds the authority (agent owner or a
   * Workspace manager, and the owner alone for a host MCP route) and refuses
   * anyone else; the card re-reads from the indexed Room, so nothing is
   * decided on the phone. A refusal leaves the card pending, so its reason is
   * shown: a visible control must act or explain itself.
   */
  const handleGrantDecision = useCallback(
    async (grantId: string, decision: 'always' | 'once' | 'deny') => {
      if (viewerIsAgent || grantActionId) return;
      setGrantActionId(grantId);
      try {
        await monolithPhoneOperation('decideAgentGrant', { grantId, decision });
        void Haptics.notificationAsync(
          decision === 'deny'
            ? Haptics.NotificationFeedbackType.Warning
            : Haptics.NotificationFeedbackType.Success,
        );
      } catch (err) {
        Modal.alert('Could not answer', phoneOperationFailureReason(err));
      } finally {
        setGrantActionId(null);
      }
    },
    [grantActionId, viewerIsAgent],
  );

  const handleChoiceAnswer = useCallback(
    async (choiceId: string, optionId: string) => {
      if (viewerIsAgent || choiceActionId) return;
      setChoiceActionId(choiceId);
      try {
        await monolithPhoneOperation('answerChoice', { choiceId, optionId });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (err) {
        console.warn('Choice answer failed:', err);
      } finally {
        setChoiceActionId(null);
      }
    },
    [choiceActionId, viewerIsAgent],
  );

  const handleChoiceSkip = useCallback(
    async (choiceId: string) => {
      if (viewerIsAgent || choiceActionId) return;
      setChoiceActionId(choiceId);
      try {
        await monolithPhoneOperation('skipChoice', { choiceId });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      } catch (err) {
        console.warn('Choice skip failed:', err);
      } finally {
        setChoiceActionId(null);
      }
    },
    [choiceActionId, viewerIsAgent],
  );

  const openConnectorOfferCeremony = useCallback(
    (offerId: string, connectorType: string, pairedConnectorId: string, roomId = decodedId) => {
      router.push(
        connectorOfferCeremonyRoute({
          workspaceId: activeCommunityId ?? '',
          viewerId: cacheViewerPubkey,
          roomId,
          offerId,
          connectorType,
          pairedConnectorId,
        }) as Href,
      );
    },
    [activeCommunityId, cacheViewerPubkey, decodedId],
  );

  /**
   * Start a connector-offer ceremony. The server holds the authority, pairs
   * the offering helper, and returns its row; the phone immediately routes
   * that row through the existing Workbench install + sign-in screens. The
   * card and paused agent settle only when the helper reports connected.
   */
  const handleAcceptConnectorOffer = useCallback(
    async (offerId: string, connectorType: string) => {
      if (viewerIsAgent || connectorOfferActionId) return;
      setConnectorOfferActionId(offerId);
      try {
        const accepted = await monolithPhoneOperation('acceptConnectorOffer', { offerId });
        openConnectorOfferCeremony(offerId, connectorType, accepted.connectorId, accepted.roomId);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (err) {
        console.warn('Connector offer acceptance failed:', err);
      } finally {
        setConnectorOfferActionId(null);
      }
    },
    [connectorOfferActionId, openConnectorOfferCeremony, viewerIsAgent],
  );

  /** The settled offer card's door to the Workbench page (Q3: one of its three remaining paths). */
  const openWorkbench = useCallback(() => {
    router.push({
      pathname: '/beeline/settings/workbench',
      params: {
        ...(activeCommunityId ? { workspaceId: activeCommunityId } : {}),
        ...(cacheViewerPubkey ? { viewerId: cacheViewerPubkey } : {}),
      },
    } as Href);
  }, [activeCommunityId, cacheViewerPubkey]);

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
      if (viewerIsAgent || !canManageWorkspace) {
        setTargetBranchNotice({
          proposalId: proposal.proposalId,
          text: 'Only a workspace manager can change the target branch.',
        });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        return;
      }
      setTargetBranchActionId(proposal.proposalId);
      setTargetBranchNotice(null);
      try {
        await transport.roomTargetBranchSet(decodedId, proposal.to);
        refreshSignal.force();
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
    [canManageWorkspace, decodedId, targetBranchActionId, transport, viewerIsAgent],
  );

  const handleAddRoomMembers = useCallback(
    async (pubkeys: string[]) => {
      if (!transport || !activeCommunityId || !canManageWorkspace || addingMembers) return;
      const chosen = (participantPickerCandidates ?? []).filter(
        (candidate) =>
          pubkeys.includes(candidate.pubkey) && !roomMemberPubkeys.has(candidate.pubkey),
      );
      if (chosen.length === 0) return;
      setAddingMembers(true);
      setMembershipError(null);
      let current = chosen[0]!;
      try {
        for (const candidate of chosen) {
          current = candidate;
          if (candidate.kind === 'agent') {
            await transport.inviteAgentToChannel(decodedId, candidate.pubkey);
          } else {
            await transport.inviteWorkspaceMemberToChannel(decodedId, candidate.pubkey);
          }
        }
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setParticipantPickerVisible(false);
      } catch (err) {
        setMembershipError(`Could not add @${current.name}: ${String(err)}`);
      } finally {
        setAddingMembers(false);
      }
    },
    [
      activeCommunityId,
      addingMembers,
      canManageWorkspace,
      decodedId,
      participantPickerCandidates,
      roomMemberPubkeys,
      transport,
    ],
  );

  const handleRemoveRoomMember = useCallback(
    async (participant: RoomMemberOption) => {
      if (!transport || !canManageWorkspace || participant.pubkey === userPubkey) return;
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
    [canManageWorkspace, decodedId, transport, userPubkey],
  );

  // The picker's workspace-level rows. A one-person workspace has nobody to
  // add from the roster, so the same invite flows the Room-list "+" menu
  // reaches through the members screen live here too.
  const handleInvitePerson = useCallback(async () => {
    if (!activeCommunityId || !canManageWorkspace || memberInviteBusy) return;
    setMemberInviteBusy(true);
    setMembershipError(null);
    try {
      let inviteTransport = transport;
      if (!inviteTransport) {
        const identity = await loadBuzzIdentity();
        if (!identity) throw new Error('Beeline identity is unavailable');
        inviteTransport = new BuzzRigTransport(identity);
        setSessionTransport(inviteTransport);
      }
      const url = await createCommunityInviteUrl(
        await inviteTransport.ensureClient(),
        activeCommunityId,
        resolveCommunityInvitePublicOrigin(await getEffectiveRelayUrl(), getBuzzRuntimeConfig()),
      );
      await Share.share({ message: url });
    } catch (reason) {
      setMembershipError(`Could not create person invite: ${String(reason)}`);
    } finally {
      setMemberInviteBusy(false);
    }
  }, [activeCommunityId, canManageWorkspace, memberInviteBusy, setSessionTransport, transport]);

  // A NEW agent: the pairing command lives on the Members page. An agent
  // already in the Workspace is a checkbox row in the picker itself.
  const handleConnectAgent = useCallback(() => {
    setParticipantPickerVisible(false);
    router.push({
      pathname: '/beeline/members',
      params: {
        ...(activeCommunityId ? { communityId: activeCommunityId } : {}),
        action: 'add-agent',
      },
    } as Href);
  }, [activeCommunityId]);

  const returnToRoomList = useCallback(() => {
    setRosterVisible(false);
    setRoomActionsVisible(false);
    router.replace({
      pathname: '/beeline/channels',
      ...(activeCommunityId ? { params: { communityId: activeCommunityId } } : {}),
    });
  }, [activeCommunityId]);

  const handleRoomLifecycle = useCallback(async () => {
    if (!transport || !canManageWorkspace || !lifecycleAction || roomLifecycleBusy) return;
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
    canManageWorkspace,
    lifecycleAction,
    returnToRoomList,
    roomLifecycleBusy,
    transport,
    userPubkey,
  ]);

  /** One dismissal for the Room actions sheet: the scrim, the Cancel row and
   *  the hardware back all land here, and a rename in flight holds it open. */
  const closeRoomActions = useCallback(() => {
    if (renameBusy) return;
    setRenameEditing(false);
    setRenameError(null);
    setRoomActionsVisible(false);
  }, [renameBusy]);

  const handleRenameRoom = useCallback(async () => {
    const name = renameDraft.trim();
    if (!name) {
      setRenameError(`${ROOM_LABEL} name cannot be empty.`);
      return;
    }
    if (!transport || !canManageWorkspace || renameBusy) return;

    setRenameBusy(true);
    setRenameError(null);
    try {
      const client = await transport.ensureClient();
      await client.renameChannel(decodedId, name);
      refreshSignal.force();
      setRenameEditing(false);
      setRoomActionsVisible(false);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      setRenameError(`Could not rename ${ROOM_LABEL}: ${String(err)}`);
    } finally {
      setRenameBusy(false);
    }
  }, [canManageWorkspace, decodedId, renameBusy, renameDraft, transport]);

  const loadRoomRepoPicker = useCallback(
    async (refresh = false) => {
      if (!transport || !activeCommunityId) return;
      setRoomRepoListLoading(true);
      try {
        const access = await transport.workspaceGitHubAccess({ refresh });
        setRoomRepoCandidates(access.candidates);
        setGitHubInstallations(access.installations);
        setRoomRepoError(
          access.githubReconnectNeeded
            ? 'GitHub sign-in expired — reconnect GitHub in Settings to see new repositories.'
            : null,
        );
      } catch (error) {
        if (refresh) throw error;
        setRoomRepoCandidates(await transport.workspaceRoomRepositoryCandidates());
        setGitHubInstallations([]);
      } finally {
        setRoomRepoListLoading(false);
      }
    },
    [activeCommunityId, transport],
  );

  const handleToggleRoomRepoPicker = useCallback(async () => {
    setShowRoomRepoPicker((value) => !value);
    if (showRoomRepoPicker || !transport || !activeCommunityId) return;
    setRoomRepoError(null);
    try {
      await loadRoomRepoPicker(true);
    } catch (err) {
      setRoomRepoError('Could not load repos. Check your connection and try again.');
    }
  }, [activeCommunityId, loadRoomRepoPicker, showRoomRepoPicker, transport]);

  const startGitHubInstallation = useCallback(
    async (installationId?: number) => {
      if (!transport) throw new Error('GitHub transport is unavailable');
      return transport.githubInstallationStart(githubInstallationRedirectUri(), installationId);
    },
    [transport],
  );
  const refreshGitHubRepositories = useCallback(
    () => loadRoomRepoPicker(true),
    [loadRoomRepoPicker],
  );
  const resumeRoomRepoPicker = useCallback(() => {
    setShowRoomRepoPicker(true);
  }, []);
  const { handleAddGitHubAccount, handleManageGitHubInstallation } = useGitHubInstallationSession({
    ready: Boolean(transport && activeCommunityId),
    returnPath: `/beeline/chat/${encodeURIComponent(decodedId)}`,
    startInstallation: startGitHubInstallation,
    refreshRepositories: refreshGitHubRepositories,
    onError: setRoomRepoError,
    onNotice: setRoomRepoNotice,
    onColdResume: resumeRoomRepoPicker,
  });

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
        const confirmation = roomClient
          ? await confirmRoomRepositoryLink(() => roomClient.room(decodedId), {
              key: published.binding.key,
              updatedAt: published.updatedAt,
            })
          : 'pending';
        if (confirmation === 'contradicted') {
          throw new Error(
            'A newer repository link replaced this selection. Refresh and try again.',
          );
        }
        if (confirmation === 'pending') {
          setRoomRepoNotice('Repo link accepted. The Room is still syncing.');
        }
        refreshSignal.force();
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
      const hasOpenCorners = openCornerCount > 0;
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
    [applyRoomRepository, openCornerCount, roomRepository],
  );

  /** Toggle ambient GitHub repository notifications (stars/issues/PRs) for this Room. */
  const handleToggleGitHubEvents = useCallback(async () => {
    if (!transport || !roomRepository || roomRepoBusy) return;
    const nextEnabled = roomRepository.githubEventsEnabled === false; // off → on
    setRoomRepoBusy(true);
    setRoomRepoError(null);
    try {
      await transport.roomGitHubEventsSet(decodedId, nextEnabled);
      refreshSignal.force();
    } catch {
      setRoomRepoError('Could not change repository notification settings.');
    } finally {
      setRoomRepoBusy(false);
    }
  }, [decodedId, roomRepoBusy, roomRepository, transport]);

  // Unassigning the repo is the inverse of linking it: the Room becomes
  // chat-only. It is confirmed like the other destructive Room actions, and
  // the confirm text carries the one room-side consequence that matters —
  // open corners keep their own repo copies, nothing else moves.
  const handleUnlinkRoomRepository = useCallback(async () => {
    if (!transport || !roomRepository || roomRepoBusy) return;
    const hasOpenCorners = openCornerCount > 0;
    const confirmed = await Modal.confirm(
      `Unlink ${roomRepository.binding.name}?`,
      hasOpenCorners
        ? `This ${ROOM_LABEL} becomes chat-only. Open ${CORNER_LABEL}s keep their copies of the repo; messages and history are untouched.`
        : `This ${ROOM_LABEL} becomes chat-only. Messages and history are untouched.`,
      { cancelText: 'Cancel', confirmText: 'Unlink repo', destructive: true },
    );
    if (!confirmed) return;
    setRoomRepoBusy(true);
    setRoomRepoError(null);
    try {
      await transport.roomRepositoryRemove(decodedId);
      refreshSignal.force();
      setShowRoomRepoPicker(false);
    } catch {
      setRoomRepoError('Could not unlink the repository.');
    } finally {
      setRoomRepoBusy(false);
    }
  }, [decodedId, openCornerCount, roomRepoBusy, roomRepository, transport]);

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

  /**
   * Leave this transcript. A corner returns to its explicit opening surface
   * when one was supplied; otherwise it resolves its parent Room by id. See
   * `corner-navigation.ts` for why the route directly underneath cannot always
   * be trusted. A lone transcript replaces itself with the Room list instead
   * of calling a `router.back()` that silently does nothing.
   */
  const handleBack = useCallback(() => {
    // Stop the live-draft drain before the stack moves. The scheduler otherwise
    // keeps ticking on a still-mounted Room (native-stack does not unmount on
    // blur) and a back press waits until the turn's text is ready to paint.
    liveDraftStore.setActive(false);
    const routes = (navigation.getState()?.routes ?? []) as ChatStackRoute[];
    const action = chatBackAction(routes, parentChannelId, cornerReturnTarget);
    if (action.type === 'pop') router.dismiss(action.count);
    // The parent Room was never on this stack (for example, a notification
    // cold start or an older link without an origin hint). Open it here rather
    // than popping into whatever happens to be underneath.
    else if (action.type === 'open-room') router.replace(roomHref(action.channelId));
    // A corner opened from a Room's corners screen lands back on that screen
    // even when the list is not on the stack — never the parent Room.
    else if (action.type === 'open-corners') router.replace(roomCornersHref(action.roomId));
    else if (action.type === 'back') router.back();
    else router.replace('/beeline/channels');
  }, [cornerReturnTarget, liveDraftStore, navigation, parentChannelId]);

  const handleCloseCorner = useCallback(async () => {
    // `if (!transport) return` — the shape this replaces — made every press a
    // SILENT no-op until the screen had connected, and permanently if that
    // ever failed. The screen paints from cache, so the button is on screen
    // well before `transport` exists: pressing it did nothing, said nothing,
    // and published nothing, which is exactly what the captain saw (a corner
    // with zero close requests accepted by the server after many presses).
    // A control the reader can see must either act or explain itself.
    if (!transport) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Modal.alert(
        `Not connected yet`,
        `This ${CORNER_LABEL} could not be closed because the app is still connecting to the server. Try again in a moment.`,
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

  const handleCommunitySelect = useCallback((communityId: string | null) => {
    if (!communityId) return;
    router.replace({
      pathname: '/beeline/channels',
      params: { communityId },
    });
  }, []);

  const openCorner = useCallback(
    (subchannelId: string | undefined) => {
      const action = cornerOpenAction(subchannelId, decodedId);
      if (action.type === 'explain') {
        Modal.alert('Corner unavailable', action.message);
        return;
      }
      if (desktopExperience) openDesktopCorner(decodedId, action.cornerId);
      else router.push(cornerHref(action.cornerId, decodedId));
    },
    [decodedId, desktopExperience, openDesktopCorner],
  );

  const closeDesktopWorkPane = useCallback(() => {
    const transition = commitDesktopWorkPane({ type: 'dismiss' });
    void saveDesktopWorkPanePreference(workPaneWindowClass, transition.state.preference);
    scheduleAnimationFrame(() => workPaneHandleRef.current?.focus());
  }, [commitDesktopWorkPane, workPaneWindowClass]);

  const openDesktopWorkOverview = useCallback(() => {
    const transition = commitDesktopWorkPane({ type: 'open-overview' });
    void saveDesktopWorkPanePreference(workPaneWindowClass, transition.state.preference);
  }, [commitDesktopWorkPane, workPaneWindowClass]);

  const dropCornerInDesktopWorkPane = useCallback(
    (cornerId: string) => {
      const transition = commitDesktopWorkPane({ type: 'drop-corner', cornerId });
      void saveDesktopWorkPanePreference(workPaneWindowClass, transition.state.preference);
    },
    [commitDesktopWorkPane, workPaneWindowClass],
  );

  const openDesktopCornerInMain = useCallback(
    (cornerId: string) => {
      commitDesktopWorkPane({ type: 'open-corner-in-main' });
      router.push(cornerHref(cornerId, desktopWorkRoomId));
    },
    [commitDesktopWorkPane, desktopWorkRoomId],
  );

  const toggleDesktopWorkPane = useCallback(() => {
    if (
      desktopWorkPaneRef.current.preference !== 'present' &&
      !hasLiveDesktopCorners
    ) {
      return;
    }
    const transition = commitDesktopWorkPane({ type: 'toggle' });
    void saveDesktopWorkPanePreference(workPaneWindowClass, transition.state.preference);
    if (transition.state.preference === 'dismissed')
      scheduleAnimationFrame(() => workPaneHandleRef.current?.focus());
  }, [commitDesktopWorkPane, hasLiveDesktopCorners, workPaneWindowClass]);

  useEffect(() => {
    if (!desktopExperience || typeof window === 'undefined') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isDesktopWorkPaneCommand(event)) {
        event.preventDefault();
        toggleDesktopWorkPane();
      } else if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === 'm'
      ) {
        event.preventDefault();
        focusComposer();
      } else if (event.key === 'Escape' && workPaneMode === 'present') {
        event.preventDefault();
        closeDesktopWorkPane();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeDesktopWorkPane, desktopExperience, focusComposer, toggleDesktopWorkPane, workPaneMode]);

  const handleDesktopDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!desktopExperience || sending) return;
      event.preventDefault();
      const files = Array.from(event.dataTransfer.files).slice(
        0,
        MAX_MESSAGE_ATTACHMENTS - pendingAttachments.length,
      );
      if (!files.length) return;
      replacePendingAttachments((current) => [
        ...current,
        ...files.map((file) => ({
          uri: URL.createObjectURL(file),
          name: file.name || `file-${Date.now()}`,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          source: 'file' as const,
        })),
      ]);
    },
    [desktopExperience, pendingAttachments.length, replacePendingAttachments, sending],
  );

  const handleDesktopPaste = useCallback(
    (event: ClipboardEvent) => {
      if (!desktopExperience || sending) return;
      const files = Array.from(event.clipboardData?.files ?? []).slice(
        0,
        MAX_MESSAGE_ATTACHMENTS - pendingAttachments.length,
      );
      if (!files.length) return;
      event.preventDefault();
      replacePendingAttachments((current) => [
        ...current,
        ...files.map((file) => ({
          uri: URL.createObjectURL(file),
          name: file.name || `clipboard-${Date.now()}`,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          source: 'file' as const,
        })),
      ]);
    },
    [desktopExperience, pendingAttachments.length, replacePendingAttachments, sending],
  );

  const clearSlashComposer = useCallback(() => {
    inputTextRef.current = '';
    setInputText('');
    setInputSelection({ start: 0, end: 0 });
    setComposerHeight(COMPOSER_MIN_HEIGHT);
    setDismissedSlashText(null);
    setHighlightedSlashVerbIndex(0);
    scheduleAnimationFrame(() => composerRef.current?.focus());
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
      const next = insertAgentSlashCommand(inputText, name);
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
        case 'build':
          router.push({
            pathname: '/beeline/corners/[roomId]',
            params: { roomId: decodedId },
          } as Href);
          return;
        case 'poll':
          if (latestOpenPoll) landAtNewMessageBoundary(latestOpenPoll.id, false);
          return;
        // The third door into catch-up, and the same one: the verb opens the
        // report over the same unread range the strip and the badge open it
        // over, so the composer cannot say something different about a Room
        // than the two controls sitting in it.
        case 'catch-up':
          if (!isCorner) openCatchUpSheet();
          return;
        case 'schedule':
          if (!canManageWorkspace || !activeCommunityId) return;
          router.push({
            pathname: '/beeline/settings/schedules',
            params: { roomId: decodedId, workspaceId: activeCommunityId },
          } as unknown as Href);
          return;
        case 'workflow':
          if (!canManageWorkspace) return;
          router.push({
            pathname: '/beeline/settings/workflows',
            params: { roomId: decodedId },
          } as unknown as Href);
          return;
        case 'open-corner':
          if (pendingCornerRequest) void handleWritePermission(pendingCornerRequest, 'allow');
          return;
        case 'rename':
          if (!canManageWorkspace) return;
          setRenameDraft(storedRoomName);
          setRenameError(null);
          setRenameEditing(true);
          setRoomActionsVisible(true);
          return;
        case 'close-corner':
          void handleCloseCorner();
          return;
        case 'change-target-branch':
          if (pendingTargetBranchProposal) {
            void handleConfirmTargetBranch(pendingTargetBranchProposal);
          }
          return;
        case 'add-agent':
          if (!canManageWorkspace) {
            handleConnectAgent();
            return;
          }
          setMembershipError(null);
          setParticipantPickerKind('agent');
          setParticipantPickerVisible(true);
          return;
        case 'invite':
          if (!canManageWorkspace) return;
          setMembershipError(null);
          setParticipantPickerKind('person');
          setParticipantPickerVisible(true);
      }
    },
    [
      clearSlashComposer,
      activeCommunityId,
      canManageWorkspace,
      decodedId,
      handleCloseCorner,
      handleConnectAgent,
      handleConfirmTargetBranch,
      handleWritePermission,
      landAtNewMessageBoundary,
      latestOpenPoll,
      openCatchUpSheet,
      pendingCornerRequest,
      pendingTargetBranchProposal,
      storedRoomName,
    ],
  );

  const openCornerApp = useCallback(
    (slug: string) => {
      clearSlashComposer();
      void Haptics.selectionAsync();
      router.push({
        pathname: '/beeline/corner-app/[slug]',
        params: { slug, roomId: decodedId },
      } as Href);
    },
    [clearSlashComposer, decodedId],
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
    } else if (commandIndex < cornerAppCommands.length) {
      const app = cornerAppCommands[commandIndex];
      if (app) {
        openCornerApp(app.slug);
        return;
      }
    } else {
      const verb = slashVerbs[commandIndex - cornerAppCommands.length];
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
    cornerAppCommands,
    mentionAgentCommands,
    openCornerApp,
    runSlashVerb,
    slashVerbs,
  ]);

  const handleOpenGitHubEvent = useCallback((url: string) => {
    void openExternalUrl(url).catch(() => undefined);
  }, []);
  // A name in a system line opens the roster, where that identity lives.
  const handleOpenSystemIdentity = useCallback(() => {
    router.push({
      pathname: '/beeline/members',
      params: activeCommunityId ? { communityId: activeCommunityId } : {},
    } as Href);
  }, [activeCommunityId]);
  const handleCopyLedgerMessage = useCallback((text: string) => {
    void copyEntireTurn(text, Clipboard.setStringAsync);
  }, []);
  const handleSelectLedgerMessage = useCallback((text: string) => {
    const textId = storeTempText(text);
    router.push({ pathname: '/text-selection', params: { textId } } as Href);
  }, []);
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
        return (
          <WritePermissionCard
            message={item}
            agent={agentByPubkey.get(item.writePermission.agentPubkey)}
            viewerIsAgent={viewerIsAgent}
            viewerPubkey={cacheViewerPubkey}
            viewerRole={viewerChannelRole}
            actionId={permissionActionId}
            targetBranch={roomRepository?.targetBranch}
            onDecision={handleWritePermission}
            onOpenCorner={openCorner}
          />
        );
      }

      if (item.grantRequest) {
        return (
          <GrantRequestCard
            message={item}
            agent={agentByPubkey.get(item.grantRequest.agent.pubkey)}
            viewerIsAgent={viewerIsAgent}
            viewerPubkey={cacheViewerPubkey}
            viewerRole={viewerChannelRole}
            actionId={grantActionId}
            onDecision={handleGrantDecision}
            onOpenSource={(roomId, messageId) =>
              router.navigate({
                pathname: '/beeline/chat/[channelId]',
                params: {
                  channelId: roomId,
                  notificationMessageId: messageId,
                  notificationResponseId: `squire-grant:${item.id}`,
                },
              })
            }
          />
        );
      }
      if (item.choice) {
        return (
          <ChoiceCard
            message={item}
            agent={agentByPubkey.get(item.choice.agent.pubkey)}
            viewerIsAgent={viewerIsAgent}
            viewerPubkey={cacheViewerPubkey}
            actionId={choiceActionId}
            onAnswer={handleChoiceAnswer}
            onSkip={handleChoiceSkip}
          />
        );
      }

      if (item.connectorOffer) {
        return (
          <ConnectorOfferCard
            message={item}
            agent={agentByPubkey.get(item.connectorOffer.agent.pubkey)}
            viewerIsAgent={viewerIsAgent}
            viewerPubkey={cacheViewerPubkey}
            viewerRole={viewerChannelRole}
            actionId={connectorOfferActionId}
            onAccept={handleAcceptConnectorOffer}
            onContinue={openConnectorOfferCeremony}
            onOpenWorkbench={openWorkbench}
          />
        );
      }

      if (item.walletTx || item.walletInsufficient || item.walletDelegation) {
        return <WalletCards message={item} stamp={ledgerStamp(item.timestamp)} />;
      }

      if (item.targetBranchProposal) {
        const notice =
          targetBranchNotice?.proposalId === item.targetBranchProposal.proposalId
            ? targetBranchNotice.text
            : null;
        return (
          <TargetBranchProposalCard
            message={item}
            agent={
              item.targetBranchProposal.agentPubkey
                ? agentByPubkey.get(item.targetBranchProposal.agentPubkey)
                : undefined
            }
            currentTargetBranch={roomRepository?.targetBranch}
            canManageWorkspace={canManageWorkspace}
            viewerIsAgent={viewerIsAgent}
            actionId={targetBranchActionId}
            notice={notice}
            onConfirm={handleConfirmTargetBranch}
          />
        );
      }
      if (item.relay) return <RelayHandOff message={item} />;
      if (item.cornerApp) {
        return (
          <CornerAppRow
            title={item.cornerApp.title}
            onOpen={() => openCornerApp(item.cornerApp!.slug)}
          />
        );
      }
      if (item.corner) {
        return null;
      }

      if (item.notificationLifecycleRun) {
        return (
          <NotificationLifecycleCard
            message={item}
            onOpenCorner={openCorner}
            onOpenUrl={handleOpenGitHubEvent}
          />
        );
      }

      if (item.githubEvent) {
        return <GitHubEventCard message={item} onOpenUrl={handleOpenGitHubEvent} />;
      }

      if (item.daemonFact) {
        return (
          <View>
            <DaemonFactCard
              message={item}
              onOpenCorner={openCorner}
              onOpenUrl={handleOpenGitHubEvent}
            />
            {item.relayReports?.map((report) => (
              <RelayHandOff key={report.id} message={report} />
            ))}
          </View>
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

      // ── System line: one renderer for every server-phrased notification ──
      if (item.isSystemNotice) {
        return (
          <LedgerSystemLine
            id={item.id}
            text={item.text}
            {...(item.systemEvent ? { event: item.systemEvent } : {})}
            {...(item.systemSubjects ? { subjects: item.systemSubjects } : {})}
            stamp={ledgerStamp(item.timestamp)}
            onOpenIdentity={handleOpenSystemIdentity}
            onOpenUrl={handleOpenGitHubEvent}
          />
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

      const knownAgent = item.pubkey ? agentByPubkey.get(item.pubkey) : undefined;
      const renderedItem =
        messageIsBookmarked(item) === Boolean(item.bookmarked)
          ? item
          : { ...item, bookmarked: messageIsBookmarked(item) };
      const personName = item.pubkey ? personProfileByPubkey.get(item.pubkey)?.name : undefined;
      const referencedTarget = referencedMessage
        ? replyTargetForMessage(referencedMessage)
        : undefined;
      return (
        <OrdinaryLedgerMessage
          message={renderedItem}
          firstBylineOfDay={bylineOpeners.has(item.id)}
          // The byline carries the model stamped on the message at
          // generation time (server-side from the producing turn); an agent
          // row with no stamp keeps the plain `AGENT` word — never a live
          // roster lookup retro-labeling old messages with today's setting.
          agentModel={item.agentModel}
          desktopLayout={isDesktop}
          announcementFeed={isReadOnlyDirectMessage}
          {...(knownAgent ? { agent: knownAgent } : {})}
          participantsHydrated={participantsHydrated}
          {...(personName ? { personName } : {})}
          viewerPubkey={cacheViewerPubkey}
          speakerWorking={Boolean(item.pubkey && speakerWorking[item.pubkey])}
          continued={attributionContinued}
          {...(immediatelyPrecedingMessage ? { immediatelyPrecedingMessage } : {})}
          {...(referencedTarget ? { referencedTarget } : {})}
          participantHandles={roomParticipants}
          channelIndex={channelReferenceIndex}
          deliveryFailed={failedOutboxIds.has(item.id)}
          onChannelReference={handleOpenChannelReference}
          codeRoomId={decodedId}
          onOpenCode={handleOpenCode}
          onMention={handleOpenMention}
          onTapOutsideComposer={dismissComposerKeyboard}
          onReply={beginReply}
          onCopy={handleCopyLedgerMessage}
          onMessageActions={openMessageActions}
          onReact={handleReactToMessage}
          onForward={beginForward}
          onBookmark={handleBookmarkMessage}
          {...(!isCorner &&
          !isArchived &&
          !viewerIsAgent &&
          !isReadOnlyDirectMessage &&
          !answeredMessageIds.has(item.relayId ?? item.id)
            ? { onCornerProposalDecision: handleCornerProposalDecision }
            : {})}
          cornerProposalAction={
            cornerProposalAction?.messageId === item.id ? cornerProposalAction.decision : null
          }
          onRetry={retryOutboxMessage}
          onDismiss={dismissOutboxMessage}
        />
      );
    },
    [
      bylineOpeners,
      agentByPubkey,
      answeredMessageIds,
      isDesktop,
      handleWritePermission,
      handleGrantDecision,
      handleChoiceAnswer,
      handleChoiceSkip,
      handleOpenSystemIdentity,
      handleOpenCode,
      handleReactToMessage,
      handleBookmarkMessage,
      messageIsBookmarked,
      handleCornerProposalDecision,
      cornerProposalAction,
      beginForward,
      grantActionId,
      connectorOfferActionId,
      handleAcceptConnectorOffer,
      openConnectorOfferCeremony,
      openWorkbench,
      choiceActionId,
      handleConfirmTargetBranch,
      openCorner,
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
      speakerWorking,
      beginReply,
      dismissOutboxMessage,
      failedOutboxIds,
      replyTargetForMessage,
      retryOutboxMessage,
      channelReferenceIndex,
      dismissComposerKeyboard,
      handleOpenChannelReference,
      handleOpenMention,
      handleOpenGitHubEvent,
      handleCopyLedgerMessage,
      openMessageActions,
      isReadOnlyDirectMessage,
      isArchived,
      isCorner,
      decodedId,
    ],
  );
  const renderItem = useRoomMessageRenderItem({
    render: renderMessage,
    continuedIds: continuedAttributionIds,
    precedingMessageById: immediatelyPrecedingVisibleMessageById,
    messageById: visibleMessageById,
    arrivingCardIds: transcriptArrivalObservation.arrivingIds,
    cardMotionStore: transcriptCardMotionStore,
    firstNewMessageId,
    arrivalFlashMessageId,
    // The catch-up door rides the unread line, where the run it summarizes
    // begins, rather than in chrome floating over the transcript.
    catchUpOffered: catchUpOfferVisible,
    onOpenCatchUp: openCatchUpSheet,
  });

  if (!roomSurface) {
    if (transcriptHydrationFailed) {
      return (
        <View style={[styles.container, { paddingTop: insets.top }]} testID="room-hydration-error">
          <View style={styles.hydrationErrorHeader}>
            {(!isDesktop || isCorner) && (
              <TouchableOpacity
                accessibilityLabel="Back to Rooms"
                onPress={handleBack}
                style={styles.backButton}
                testID="chat-back"
              >
                <ChevronGlyph
                  color={styles.backText.color}
                  direction="left"
                  size={CHEVRON_BACK_SIZE}
                  testID="chat-back-glyph"
                />
              </TouchableOpacity>
            )}
            <View style={styles.headerCenter}>
              <ChannelHeaderTitle
                kind={headerTitleKind}
                title={displayHeaderTitle ?? routeChannelTitle ?? ROOM_LABEL}
              />
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
              onPress={retryHydration}
              style={styles.hydrationErrorRetry}
              variant="secondary"
            />
          </View>
        </View>
      );
    }
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <SurfaceGlyphLoader testID="room-surface-loader" />
        <Text style={styles.loadingText}>
          LOADING {(isCorner ? CORNER_LABEL : ROOM_LABEL).toUpperCase()}
        </Text>
      </View>
    );
  }

  return (
    <BuzzCommunityShell
      communities={communities}
      activeCommunityId={activeCommunityId}
      onSelect={handleCommunitySelect}
      onAdd={() => router.push('/beeline/community' as Href)}
      onSettings={() => router.push('/beeline/settings' as Href)}
      onWorkspaceSettings={(communityId) =>
        router.push({
          pathname: '/beeline/settings/workspace',
          params: { communityId },
        } as unknown as Href)
      }
      canManageActiveCommunity={canManageWorkspace}
      viewerPubkey={userPubkey || undefined}
      viewerAvatarUrl={personProfileByPubkey.get(userPubkey)?.avatar}
    >
      <View style={styles.desktopConversationFrame}>
        <View style={styles.container}>
          {/* Header. No surface of its own — the chrome sits on the same
            obsidian as the transcript, parted only by a hairline. */}
          <View
            style={[styles.header, { minHeight: insets.top + 60, paddingTop: insets.top + 8 }]}
            testID={isCorner ? 'corner-session-header' : undefined}
          >
            {(!isDesktop || isCorner) && (
              <TouchableOpacity
                accessibilityLabel={
                  isCorner && cornerReturnTarget === 'corners'
                    ? `Back to this ${ROOM_LABEL}’s ${CHANGES_LABEL}`
                    : isCorner && cornerReturnTarget !== 'room-list'
                      ? `Back to this ${CORNER_LABEL}’s ${ROOM_LABEL}`
                      : 'Back to Rooms'
                }
                accessibilityRole="button"
                hitSlop={HEADER_EDGE_HIT_SLOP}
                onPress={handleBack}
                style={styles.backButton}
                testID="chat-back"
              >
                <ChevronGlyph
                  color={isCorner ? styles.cornerBackText.color : styles.backText.color}
                  direction="left"
                  size={CHEVRON_BACK_SIZE}
                  testID="chat-back-glyph"
                />
              </TouchableOpacity>
            )}
            {/*
            The corner's OWN agent — the server projection's `agent`
            (`corners.created_by`), stated here once and never repeated on a
            message. A reviewer or helper holding a live turn in the corner
            never swaps this mark or the name under it: their work is
            attributed in the transcript, and the state word reads
            `reviewing` while it runs.
          */}
            {isCorner && cornerOwnerPubkey && (
              <HeaderIdentitySlot testID="corner-header-agent">
                <IdentityMark
                  kind="agent"
                  seed={cornerOwnerDisplay?.avatarSeed ?? cornerOwnerPubkey}
                  avatarUrl={cornerOwnerDisplay?.avatarUrl}
                  face={cornerOwnerDisplay?.face}
                  name={cornerOwnerDisplay?.name ?? 'Agent'}
                  size={26}
                  alive={cornerOwnerWorking}
                />
              </HeaderIdentitySlot>
            )}
            {isDirectMessage && !isReadOnlyDirectMessage && dmPeerPubkey && (
              <HeaderIdentitySlot testID="direct-message-header-identity">
                <IdentityMark
                  kind={dmPeerAgentDisplay || dmPeerIdentity?.kind === 'agent' ? 'agent' : 'human'}
                  seed={dmPeerAgentDisplay?.avatarSeed ?? dmPeerPubkey}
                  avatarUrl={
                    dmPeerAgentDisplay?.avatarUrl ?? dmPeerIdentity?.avatar ?? dmPeerProfile?.avatar
                  }
                  face={dmPeerAgentDisplay?.face ?? dmPeerIdentity?.face ?? dmPeerProfile?.face}
                  name={displayRoomName}
                  size={26}
                />
              </HeaderIdentitySlot>
            )}
            <View style={styles.headerCenter}>
              {displayHeaderTitle === null ? (
                // The channel's own name has not landed yet. Neither "Room" nor
                // a corner slug would be true, so show neither.
                <View
                  accessibilityLabel="Loading name"
                  style={[styles.channelNameSkeleton, isCorner && styles.cornerChannelNameSkeleton]}
                  testID="chat-title-skeleton"
                />
              ) : (
                <ChannelHeaderTitle
                  kind={headerTitleKind}
                  // A corner's name is its objective verbatim; let it wrap once
                  // rather than truncate to a slug fragment.
                  numberOfLines={isCorner ? 2 : 1}
                  onPress={
                    !isCorner && !isDirectMessage ? () => setRoomActionsVisible(true) : undefined
                  }
                  title={displayHeaderTitle}
                />
              )}
              {!isCorner && (
                <RoomRepositorySubtitle
                  onOpenUrl={handleOpenGitHubEvent}
                  repositoryName={roomRepoChipLabel(roomRepository)}
                />
              )}
              {isCorner ? (
                <HeaderMetaRow>
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.cornerHeaderAgent,
                      cornerHeaderDisplay.status === 'working'
                        ? styles.cornerHeaderWorking
                        : cornerHeaderDisplay.status === 'review'
                          ? styles.cornerHeaderReview
                          : cornerHeaderDisplay.status === 'archived'
                            ? styles.cornerHeaderArchived
                            : styles.cornerHeaderWaiting,
                    ]}
                  >
                    {(cornerOwnerDisplay?.name ?? 'AGENT').toUpperCase()} · {cornerHeaderWord}
                  </Text>
                </HeaderMetaRow>
              ) : isDirectMessage ? (
                <HeaderMetaCaps testID="room-header-meta">{dmHeaderPresence}</HeaderMetaCaps>
              ) : null}
            </View>
            {/* Membership still consumes no header width: the Members row lives
              in the Room and corner overflow sheets. The desktop work pane
              does not carry it. The trailing slot is the Room's corners door —
              now the ONE active-corner affordance, since the pinned line above
              the composer is gone. A lone brass `◇` a few pixels from the
              overflow dots read as decoration on the menu rather than as a
              destination of its own, so the door is NAMED, the way every rail
              command is: the mark states the kind, the word states where it
              goes, and the pair's boxes touch like the Room-list chrome. */}
            {!parentChannelId && !isDirectMessage && (
              <TouchableOpacity
                accessibilityLabel={`${ROOM_LABEL} ${CHANGES_LABEL}`}
                accessibilityRole="button"
                hitSlop={HEADER_EDGE_HIT_SLOP}
                onPress={() => router.push(roomCornersHref(decodedId))}
                style={styles.roomCornersButton}
                testID="room-corners-menu"
              >
                <CornerGlyph
                  color={styles.roomCornersGlyph.color}
                  size={HEADER_MARK_SIZE}
                  testID="room-corners-glyph"
                />
              </TouchableOpacity>
            )}
            {isCorner && !viewerIsAgent && !isArchived && (
              <TouchableOpacity
                accessibilityLabel={`${CORNER_LABEL} actions`}
                accessibilityRole="button"
                hitSlop={HEADER_EDGE_HIT_SLOP}
                onPress={() => setCornerActionsVisible(true)}
                style={styles.roomActionsButton}
                testID="corner-actions-menu"
              >
                <OverflowGlyph
                  color={styles.roomActionsGlyph.color}
                  size={HEADER_MARK_SIZE}
                  testID="corner-actions-glyph"
                />
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
                  hitSlop={HEADER_EDGE_HIT_SLOP}
                  onPress={() => {
                    setMembershipError(null);
                    setRenameEditing(false);
                    setRenameError(null);
                    setRoomActionsVisible(true);
                  }}
                  style={styles.roomClusteredActionsButton}
                  testID="room-actions-menu"
                >
                  <OverflowGlyph
                    color={styles.roomActionsGlyph.color}
                    size={HEADER_MARK_SIZE}
                    testID="room-actions-glyph"
                  />
                </TouchableOpacity>
              )}
            {isArchived && (
              <View style={styles.archivedBadge}>
                <Text style={styles.archivedBadgeText}>archived</Text>
              </View>
            )}
          </View>

          <KeyboardAvoidingView
            style={styles.keyboardBody}
            behavior={Platform.OS === 'ios' ? 'padding' : 'translate-with-padding'}
          >
          {/* What the corner is for, held under the header for its whole life:
            the human's own request, inscribed rather than framed. The header
            carries a short corner name, so without this the objective survives
            only until the first message lands. */}
          {isCorner && <CornerObjectiveLine objective={cornerObjectiveText} />}

          {/* The corner's PR state, inscribed above the transcript: one line
            that links to GitHub, where review and merge happen. */}
          {isCorner && (
            <CornerStatusLine
              lifecycle={roomSurface?.cornerLifecycle}
              archived={isArchived}
              onOpenPullRequest={(url) => {
                void openExternalUrl(url).catch(() => {
                  Modal.alert('Could not open pull request', 'Open the PR from GitHub instead.');
                });
              }}
            />
          )}

          <View style={styles.transcriptViewport}>
          {desktopTranscript ? (
            // A plain scrollable View over real DOM — no FlatList/
            // VirtualizedList. See `shouldFollowDesktopTail` in
            // `buzz/room-scroll-follow.ts` and proof/desktop-append-overlap/
            // NOTES.md for why RN Web's own list machinery raced the browser's
            // real layout on this surface.
            <View
              testID="chat-messages"
              ref={setDesktopScrollNode as unknown as React.Ref<View>}
              {...{ onScroll: handleDesktopScroll }}
              style={[styles.messageList, styles.desktopScroll]}
            >
              <View
                ref={setDesktopContentNode as unknown as React.Ref<View>}
                style={[
                  styles.messageListContent,
                  styles.messageListContentDesktop,
                  transcriptMessages.length === 0 && styles.messageListContentEmpty,
                ]}
              >
                {transcriptMessages.length === 0 ? (
                  <View style={styles.emptyState}>
                    <EmptyLedgerState
                      variant={emptyLedgerVariant}
                      name={isDirectMessage ? displayRoomName : undefined}
                      objective={isCorner ? cornerObjectiveText : undefined}
                      onPress={focusComposer}
                    />
                  </View>
                ) : (
                  <>
                    {transcriptHistoryLine}
                    {transcriptMessages.map((item) => (
                      <View
                        key={item.id}
                        {...{ dataSet: { rowId: item.id } }}
                        ref={getDesktopRowRefCallback(item.id) as unknown as React.Ref<View>}
                      >
                        {renderItem({ item })}
                      </View>
                    ))}
                  </>
                )}
              </View>
            </View>
          ) : (
          <FlatList
            testID="chat-messages"
            ref={flatListRef}
            inverted={transcriptMessages.length > 0}
            data={transcriptMessages}
            keyExtractor={(item: ChatDisplayMessage) => item.id}
            style={styles.messageList}
            contentContainerStyle={[
              styles.messageListContent,
              transcriptMessages.length === 0 && styles.messageListContentEmpty,
              // Inverted list: paddingTop is the visual tail. Always the
              // ordinary speaker-change margin plus the fixed composer-top
              // gap — the thinking line is absolute and paints over that
              // invariant tail rather than changing it when mounted.
              !isArchived && {
                paddingTop: phoneTranscriptTailPadding({
                  turnChromeVisible: Boolean(composerAck || settledTurn),
                  pushedChromeVisible: agentsOffline,
                }),
              },
            ]}
            maintainVisibleContentPosition={{
              // Native records the first eligible visible child's real
              // frame and compensates by its measured movement. That
              // preserves variable-height history without getItemLayout,
              // eager rendering, or an estimated offset. Index 0 is
              // excluded because optimistic settlement and streams can
              // replace it in place.
              minIndexForVisible: 1,
              // Native offset 0 is the visual bottom.
              autoscrollToTopThreshold: 50,
            }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={transcriptKeyboardDismissMode(Platform.OS)}
            onScroll={(event) => {
              const { contentOffset } = event.nativeEvent;
              isPinnedToTailRef.current = contentOffset.y <= TAIL_PIN_THRESHOLD;
              observeTailPinned(isPinnedToTailRef.current);
            }}
            scrollEventThrottle={100}
            onViewableItemsChanged={observeVisibleTranscriptMessages}
            onScrollBeginDrag={() => {
              dragEndSequenceRef.current += 1;
              userDraggingRef.current = true;
              allowOlderHistoryRef.current = true;
            }}
            onScrollEndDrag={(event) => {
              // Drag-end precedes momentum-begin. Missing optional velocity is
              // not proof that the gesture stopped: keep the guard armed for
              // the event turn, so momentum-begin can claim it before a
              // pending boundary landing resumes.
              const sequence = ++dragEndSequenceRef.current;
              const velocity = event.nativeEvent.velocity?.y;
              if (velocity !== undefined) {
                const hasMomentum = Math.abs(velocity) > 0.01;
                userDraggingRef.current = hasMomentum;
                if (!hasMomentum) resumePendingNewMessageLanding();
                return;
              }
              userDraggingRef.current = true;
              scheduleAnimationFrame(() => {
                if (dragEndSequenceRef.current !== sequence) return;
                userDraggingRef.current = false;
                resumePendingNewMessageLanding();
              });
            }}
            onMomentumScrollBegin={() => {
              dragEndSequenceRef.current += 1;
              userDraggingRef.current = true;
              allowOlderHistoryRef.current = true;
            }}
            onMomentumScrollEnd={() => {
              dragEndSequenceRef.current += 1;
              userDraggingRef.current = false;
              resumePendingNewMessageLanding();
            }}
            renderItem={renderItem}
            onScrollToIndexFailed={({ averageItemLength }) => {
              const pending = pendingNewMessageLandingRef.current;
              if (!pending || userDraggingRef.current) return;
              const currentIndex = boundaryRowIndex(
                transcriptMessagesRef.current,
                pending.boundaryId,
              );
              if (currentIndex < 0) return;
              // Variable-height ledger rows cannot provide getItemLayout.
              // Estimate near the CURRENT boundary, let that window measure,
              // then resolve the durable id again before retrying.
              flatListRef.current?.scrollToOffset({
                offset: averageItemLength * currentIndex,
                animated: false,
              });
              setTimeout(() => {
                const current = pendingNewMessageLandingRef.current;
                if (!current || userDraggingRef.current) return;
                landAtNewMessageBoundary(
                  current.boundaryId,
                  current.acknowledgeQueue,
                );
              }, 50);
            }}
            onEndReached={loadOlderTranscriptIfReaderAsked}
            onEndReachedThreshold={0.5}
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <EmptyLedgerState
                  variant={emptyLedgerVariant}
                  name={isDirectMessage ? displayRoomName : undefined}
                  objective={isCorner ? cornerObjectiveText : undefined}
                  onPress={focusComposer}
                />
              </View>
            }
            ListHeaderComponent={null}
            // Inverted native list: the footer is the visual top.
            ListFooterComponent={transcriptHistoryLine}
          />
          )}
          <RoomCatchUpControls
            corner={isCorner}
            badgeCount={newMessageBadgeCount}
            discVisible={newestJumpDiscShown}
            onJumpToNewest={landAtNewestMessage}
          />
          {!isCorner && (
            <RoomCatchUpSheet
              agents={catchUpAgents}
              canDraft={!inputText.trim() && pendingAttachments.length === 0}
              onAskAgent={draftCatchUpRequest}
              onClose={closeCatchUpSheet}
              report={catchUpReport}
              visible={catchUpSheetVisible}
            />
          )}
          </View>

          {/* P2: Archived channels are read-only */}
          {isArchived ? (
            <View style={[styles.archivedInputBar, readOnlyFooterInset]}>
              <Text style={[styles.archivedInputText, isCorner && styles.cornerArchivedInputText]}>
                {parentChannelId ? 'Corner' : ROOM_LABEL} archived (read-only)
              </Text>
            </View>
          ) : (
            <View style={styles.bottomChromeStack} testID="room-bottom-chrome">
              {/* Phone turn chrome paints over the transcript's own bottom
                margin: `TurnBandSlot` is absolute (`room-bottom-chrome`),
                anchored to this stack's top edge, so it takes no height from
                the list whether or not an agent is working and cannot cover
                the newest row — the line's box is exactly the speaker-change
                margin plus the fixed composer-top gap the transcript always
                leaves. The slot is mounted
                whether or not a line is showing; `pointerEvents="box-none"`
                lets the transcript keep every touch the line is not using.
                Desktop keeps the slot inside inputBar. */}
              {!desktopExperience && (
                <TurnBandSlot testID="hanging-turn-chrome">
                  {composerAck ? (
                    <TurnProgressLine
                      label={composerAck.label}
                      startedAt={composerAck.startedAt}
                      received={composerAck.received}
                      stopping={stoppingThisTurn}
                      onStop={
                        composerAck.stop ? () => void handleStopTurn(composerAck.stop!) : undefined
                      }
                      testID="turn-progress-line"
                    />
                  ) : settledTurn ? (
                    <TurnSettledLine line={settledTurn.line} testID="turn-settled-line" />
                  ) : null}
                </TurnBandSlot>
              )}
              {/* No pinned corner line lives here. A Room holds many corners at
                once, so one line above the composer could only ever name one of
                them, and it sat between the reader and the field they were
                typing in. The Room's corners door in the header is the one way
                in; the corner's own state is read there, in the corners list,
                and on the Room-list row. */}
              {agentsOffline && <AgentOfflineHint />}
              {isReadOnlyDirectMessage ? (
                <View style={[styles.archivedInputBar, readOnlyFooterInset]}>
                  <Text style={styles.archivedInputText}>
                    Announcements only · you can't reply here
                  </Text>
                </View>
              ) : (
            <Animated.View style={[styles.inputBar, composerBottomInsetStyle]}>
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
                      apps={cornerAppCommands}
                      agentName={mentionAgentName}
                      agentLacksCommands={mentionAgentLacksCommands}
                      onSelectCommand={insertAgentCommand}
                      onSelectApp={openCornerApp}
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
                        {participant.pubkey === CHANNEL_MENTION_PUBKEY ? (
                          <View style={styles.mentionChannelGlyph}>
                            <Text style={styles.mentionChannelGlyphText}>@</Text>
                          </View>
                        ) : display ? (
                          <IdentityMark
                            kind="agent"
                            seed={display.avatarSeed ?? participant.pubkey}
                            avatarUrl={display.avatarUrl}
                            face={display.face}
                            name={display.name}
                            size={28}
                          />
                        ) : (
                          <IdentityMark
                            kind="human"
                            seed={participant.pubkey}
                            avatarUrl={personProfileByPubkey.get(participant.pubkey)?.avatar}
                            face={participant.face}
                            name={participant.name}
                            size={28}
                          />
                        )}
                        <View style={styles.mentionIdentity}>
                          <Text numberOfLines={1} style={styles.mentionName}>
                            {participant.pubkey === CHANNEL_MENTION_PUBKEY
                              ? 'Everyone in this Room'
                              : participant.name}
                          </Text>
                          <Text numberOfLines={1} style={styles.mentionHandle}>
                            @{participant.handle}
                          </Text>
                        </View>
                        <Text style={styles.mentionKind}>
                          {participant.pubkey === CHANNEL_MENTION_PUBKEY
                            ? 'ROOM'
                            : participant.kind === 'agent'
                              ? 'AGENT'
                              : 'PERSON'}
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
                  {canManageWorkspace ? (
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
              {desktopExperience ? (
                <View
                  style={styles.desktopStatusSlot}
                  accessibilityLiveRegion="polite"
                  testID="desktop-message-status"
                >
                  {desktopDeliveryState === 'sending' ? (
                    <Text style={styles.desktopStatusText}>SENDING…</Text>
                  ) : composerAck ? (
                    <TurnProgressLine
                      label={composerAck.label}
                      startedAt={composerAck.startedAt}
                      received={composerAck.received}
                      stopping={stoppingThisTurn}
                      onStop={
                        composerAck.stop ? () => void handleStopTurn(composerAck.stop!) : undefined
                      }
                      testID="turn-progress-line"
                    />
                  ) : desktopDeliveryState ? (
                    <Text
                      style={[
                        styles.desktopStatusText,
                        desktopDeliveryState === 'failed' && styles.desktopStatusFailed,
                      ]}
                    >
                      {desktopDeliveryState === 'delivered'
                        ? 'DELIVERED'
                        : 'MESSAGE FAILED · RETRY FROM THE MESSAGE'}
                    </Text>
                  ) : settledTurn ? (
                    <TurnSettledLine line={settledTurn.line} testID="turn-settled-line" />
                  ) : null}
                </View>
              ) : null}
              <ConversationComposer
                onStop={composerAck?.stop ? () => handleStopTurn(composerAck.stop!) : undefined}
                inputRef={composerRef}
                reply={
                  replyTarget
                    ? {
                        handle: replyTarget.authorHandle ?? replyTarget.authorName,
                        preview: replyTarget.preview,
                      }
                    : undefined
                }
                onCancelReply={() => setReplyTarget(null)}
                attachments={pendingAttachments.map((attachment) => ({
                  uri: attachment.uri,
                  name: attachment.name,
                  mimeType: attachment.mimeType,
                  sizeLabel: formatAttachmentSize(attachment.size),
                }))}
                attachmentsUploading={sending}
                onRemoveAttachment={(index) =>
                  replacePendingAttachments((current) =>
                    current.filter((_, attachmentIndex) => attachmentIndex !== index),
                  )
                }
                value={inputText}
                inputRevision={composerInputRevision}
                isInputRevisionCurrent={(inputRevision) =>
                  inputRevision === composerInputRevisionRef.current
                }
                height={composerHeight}
                maxHeight={COMPOSER_MAX_HEIGHT}
                focused={composerFocused}
                disabled={sending}
                canSend={
                  slashMenuVisible
                    ? Boolean(inputText.trim())
                    : Boolean(inputText.trim() || pendingAttachments.length)
                }
                onAttach={chooseAttachment}
                attachDisabled={sending}
                containerProps={
                  desktopExperience
                    ? ({
                        onDragOver: (event: React.DragEvent<HTMLElement>) => event.preventDefault(),
                        onDrop: handleDesktopDrop,
                      } as any)
                    : undefined
                }
                onDesktopPaste={desktopExperience ? handleDesktopPaste : undefined}
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
                  if (!mentionMenuVisible) {
                    const desktopAction = desktopComposerKeyAction(
                      Platform.OS,
                      event.nativeEvent.key,
                      Boolean((event.nativeEvent as unknown as { shiftKey?: boolean }).shiftKey),
                    );
                    if (desktopAction === 'send') {
                      event.preventDefault();
                      void handleSend();
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
                onSend={
                  slashMenuVisible
                    ? () => {
                        selectHighlightedPaletteItem();
                      }
                    : handleSend
                }
              />
            </Animated.View>
              )}
            </View>
          )}
          </KeyboardAvoidingView>
        </View>
        {desktopWorkPaneMounted && (
          <DesktopRoomInspector
            room={desktopWorkPaneMounted}
            client={roomClient}
            selectedCornerId={desktopWorkPane.selectedCornerId}
            onSelectCorner={(cornerId) =>
              commitDesktopWorkPane(
                cornerId ? { type: 'open-corner', cornerId } : { type: 'open-overview' },
              )
            }
            onOpenInMain={openDesktopCornerInMain}
            onClose={closeDesktopWorkPane}
            onNewCorner={focusComposer}
          />
        )}
        {desktopWorkHandleMounted && (
          <DesktopWorkPaneHandle
            ref={workPaneHandleRef}
            roomId={desktopWorkRoomId}
            arrived={workPaneArrived}
            onOpen={openDesktopWorkOverview}
            onDropCorner={dropCornerInDesktopWorkPane}
          />
        )}
      </View>

      <AttachmentPickerSheet
        visible={attachmentPickerVisible}
        onClose={() => setAttachmentPickerVisible(false)}
        onPickDocument={() => void pickDocument()}
        onPickPhoto={() => void pickPhoto()}
        onPickPasted={desktopExperience ? undefined : () => void pasteImage()}
      />

      <HullActionSheetModal
        accessibilityLabel="Close message actions"
        onClose={() => setMessageActionsTarget(null)}
        testID="message-actions-sheet"
        title="Message"
        visible={Boolean(messageActionsTarget)}
      >
        {messageActionsTarget && !messageActionsTarget.isAgentActivity ? (
          // The reaction entry point is the emoji scroll itself — the sheet's
          // top cell, with no React row and nothing to expand above it.
          <MessageReactionStrip
            onReact={(emoji) => {
              const target = messageActionsTarget;
              setMessageActionsTarget(null);
              if (target) void handleReactToMessage(target, emoji);
            }}
          />
        ) : null}
        {messageActionsTarget && !messageActionsTarget.isAgentActivity ? (
          <HullActionSheetRow
            accessibilityLabel={
              messageIsBookmarked(messageActionsTarget) ? 'Remove bookmark' : 'Bookmark message'
            }
            label={messageIsBookmarked(messageActionsTarget) ? 'Remove bookmark' : 'Bookmark'}
            onPress={() => {
              const target = messageActionsTarget;
              setMessageActionsTarget(null);
              if (target) void handleBookmarkMessage(target);
            }}
            testID="message-bookmark-action"
          />
        ) : null}
        {messageActionsTarget ? (
          <HullActionSheetRow
            accessibilityLabel="Copy message text"
            label="Copy"
            onPress={() => {
              handleCopyLedgerMessage(
                messageActionsTarget.isAgentActivity
                  ? agentActivityReplyExcerpt(messageActionsTarget)
                  : messageActionsTarget.text,
              );
              setMessageActionsTarget(null);
            }}
            testID="message-copy-action"
          />
        ) : null}
        {messageActionsTarget ? (
          <HullActionSheetRow
            accessibilityLabel="Select message text"
            label="Select"
            onPress={() => {
              const target = messageActionsTarget;
              setMessageActionsTarget(null);
              if (target) {
                handleSelectLedgerMessage(
                  target.isAgentActivity ? agentActivityReplyExcerpt(target) : target.text,
                );
              }
            }}
            testID="message-select-action"
          />
        ) : null}
        {messageActionsTarget ? (
          <HullActionSheetRow
            accessibilityLabel="Reply to message"
            label="Reply"
            onPress={() => {
              const target = messageActionsTarget;
              setMessageActionsTarget(null);
              if (target) beginReply(target);
            }}
            testID="message-reply-action"
          />
        ) : null}
        {messageActionsTarget && !messageActionsTarget.isAgentActivity ? (
          <HullActionSheetRow
            accessibilityLabel="Forward message"
            label="Forward"
            onPress={() => {
              const target = messageActionsTarget;
              setMessageActionsTarget(null);
              if (target) void beginForward(target);
            }}
            testID="message-forward-action"
          />
        ) : null}
        {messageActionsTarget && !isCorner && countsAsUnread(messageActionsTarget) ? (
          <HullActionSheetRow
            accessibilityLabel="Mark unread from this message"
            label="Mark unread"
            onPress={() => {
              const target = messageActionsTarget;
              setMessageActionsTarget(null);
              if (target) void handleMarkUnread(target);
            }}
            testID="message-mark-unread-action"
          />
        ) : null}
        <HullActionSheetCancel
          onPress={() => setMessageActionsTarget(null)}
          testID="message-actions-close"
        />
      </HullActionSheetModal>

      <ForwardMessagePickerSheet
        busyRoomId={forwardBusyRoomId}
        error={forwardError}
        onClose={() => {
          if (forwardBusyRoomId) return;
          setForwardTarget(null);
          setForwardRooms(null);
          setForwardError(null);
        }}
        onForward={(target) => void forwardToRoom(target)}
        targets={forwardRooms}
        visible={Boolean(forwardTarget)}
      />

      <RoomRosterSheet
        bottomInset={insets.bottom}
        canManage={roomSurface?.viewer.permissions.manage ?? false}
        isDirectMessage={isDirectMessage}
        memberByPubkey={roomMemberByPubkey}
        membershipActionPubkey={membershipActionPubkey}
        membershipError={membershipError}
        members={visibleRosterMembers}
        onAddMembers={() => {
          setMembershipError(null);
          // One counted Members section owns one add control, so the picker it
          // opens lists both kinds and carries its own invite-a-person and
          // connect-an-agent rows.
          setParticipantPickerKind(null);
          setParticipantPickerVisible(true);
        }}
        onClose={closeRoster}
        onRemove={handleRemoveRoomMember}
        onlineByPubkey={speakerOnline}
        workingByPubkey={speakerWorking}
        parentChannelId={parentChannelId ?? null}
        personProfileByPubkey={personProfileByPubkey}
        userPubkey={userPubkey}
        visible={memberManagement.rosterVisible}
      />

      <HullActionSheetModal
        accessibilityLabel={`Close ${ROOM_LABEL} actions`}
        dismissOnBackdrop={!renameBusy}
        footer={<HullActionSheetCancel onPress={closeRoomActions} testID="room-actions-close" />}
        onClose={closeRoomActions}
        sticky={
          <RoomRepositoryActions
            busy={roomRepoBusy}
            canManage={canManageWorkspace}
            loading={roomRepoListLoading}
            onToggle={() => void handleToggleRoomRepoPicker()}
            picker={null}
            pickerVisible={showRoomRepoPicker}
            repositoryName={roomRepository?.binding.name ?? null}
            slot="row"
          />
        }
        testID="room-actions-sheet"
        title={displayRoomName}
        visible={roomActionsVisible}
      >
        <RoomRepositoryActions
          busy={roomRepoBusy}
          canManage={canManageWorkspace}
          loading={roomRepoListLoading}
          notifications={
            roomRepository ? (
              <HullActionSheetRow
                accessibilityLabel={
                  roomRepository.githubEventsEnabled === false
                    ? 'Turn repository notifications on'
                    : 'Turn repository notifications off'
                }
                description="Issues and pull requests posted here."
                disabled={roomRepoBusy}
                label="Repo notifications"
                onPress={() => void handleToggleGitHubEvents()}
                testID="room-github-events-toggle"
                toggle={{
                  disabled: roomRepoBusy,
                  onValueChange: () => void handleToggleGitHubEvents(),
                  value: roomRepository.githubEventsEnabled !== false,
                }}
              />
            ) : null
          }
          onToggle={() => void handleToggleRoomRepoPicker()}
          picker={
            <View style={styles.roomSheetInset}>
              <RepoPicker
                busy={roomRepoBusy || roomRepoListLoading}
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
                onUnlink={
                  canManageWorkspace && roomRepository
                    ? () => void handleUnlinkRoomRepository()
                    : undefined
                }
                testIDPrefix="room-repo-picker"
                unlinkRepositoryName={roomRepository?.binding.name}
              />
            </View>
          }
          pickerVisible={showRoomRepoPicker}
          reviewer={
            <RoomReviewerActions
              agents={(roomSurface?.members ?? [])
                .filter((member) => member.identity.kind === 'agent')
                .map((member) => member.identity)}
              canManage={canManageWorkspace}
              hasRepository={roomRepository !== null}
              onSaved={() => refreshSignal.force()}
              reviewerAgentId={roomSurface?.room.reviewerAgentId}
              roomId={decodedId}
              roomName={displayRoomName}
              updateRoom={(input) => monolithPhoneOperation('updateRoom', input)}
            />
          }
          repositoryName={roomRepository?.binding.name ?? null}
          slot="body"
        />
        <HullActionSheetRow
          accessibilityLabel={`View ${formatRoomParticipantTotal(roomParticipantTotal)}`}
          chevron="right"
          disabled={!memberManagement.canOpenRoster}
          label="Members"
          metadata={
            participantsHydrated ? formatRoomParticipantTotal(roomParticipantTotal) : 'Loading'
          }
          onPress={() => {
            setRoomActionsVisible(false);
            setRosterVisible(true);
          }}
          testID="room-participant-roster-trigger"
        />
        {canManageWorkspace &&
          (renameEditing ? (
            <View style={styles.roomRenameEditor} testID="rename-room-editor">
              <Text style={styles.roomRenameLabel}>New {ROOM_LABEL.toLowerCase()} name</Text>
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
                <MonoButton
                  disabled={renameBusy}
                  label="Cancel"
                  onPress={() => {
                    setRenameEditing(false);
                    setRenameError(null);
                  }}
                  variant="secondary"
                />
                <MonoButton
                  disabled={renameBusy || !renameDraft.trim()}
                  label={renameBusy ? 'Renaming…' : 'Apply'}
                  loading={renameBusy}
                  onPress={() => void handleRenameRoom()}
                  testID="apply-room-rename"
                />
              </View>
            </View>
          ) : (
            <HullActionSheetRow
              accessibilityLabel={`Rename ${ROOM_LABEL}`}
              chevron="right"
              description="Change its display name."
              disabled={renameBusy}
              label="Rename"
              onPress={() => {
                // The rename draft is the STORED name; the header's `#`
                // mark is display-only and must never be saved back.
                setRenameDraft(storedRoomName);
                setRenameError(null);
                setRenameEditing(true);
              }}
              testID="rename-room-action"
            />
          ))}
        {canManageWorkspace && getBuzzRuntimeConfig().monolithEnabled && (
          <HullActionSheetRow
            accessibilityLabel={`View ${ROOM_LABEL} scheduled work`}
            chevron="right"
            description="View or stop Agent-managed recurring work."
            label="Scheduled work"
            onPress={() => {
              setRoomActionsVisible(false);
              router.push({
                pathname: '/beeline/settings/schedules',
                params: { roomId: decodedId, workspaceId: activeCommunityId },
              } as unknown as Href);
            }}
            testID="room-schedules-action"
          />
        )}
        {lifecycleAction === 'delete' ? (
          <HullActionSheetRow
            accessibilityLabel={`Delete ${ROOM_LABEL}`}
            description={`Permanently remove this ${ROOM_LABEL}.`}
            destructive
            disabled={roomLifecycleBusy}
            label={roomLifecycleBusy ? 'Deleting…' : `Delete ${ROOM_LABEL}`}
            onPress={handleRoomLifecycle}
            testID="delete-room-action"
          />
        ) : lifecycleAction === 'leave' ? (
          <HullActionSheetRow
            accessibilityLabel={`Leave ${ROOM_LABEL}`}
            description="Other members keep their access."
            destructive
            disabled={roomLifecycleBusy}
            label={roomLifecycleBusy ? 'Leaving…' : `Leave ${ROOM_LABEL}`}
            onPress={handleRoomLifecycle}
            testID="leave-room-action"
          />
        ) : null}
        {(renameError || membershipError) && (
          <View accessibilityRole="alert" style={styles.membershipError}>
            <Text style={styles.membershipErrorText}>! {renameError ?? membershipError}</Text>
          </View>
        )}
      </HullActionSheetModal>

      <HullActionSheetModal
        accessibilityLabel={`Close ${CORNER_LABEL} actions`}
        onClose={() => setCornerActionsVisible(false)}
        testID="corner-actions-sheet"
        title={headerTitle ?? cornerOwnerDisplay?.name ?? CORNER_LABEL}
        visible={cornerActionsVisible}
      >
        <HullActionSheetRow
          accessibilityLabel={`View ${formatRoomParticipantTotal(roomParticipantTotal)}`}
          chevron="right"
          disabled={!memberManagement.canOpenRoster}
          label="Members"
          metadata={
            participantsHydrated ? formatRoomParticipantTotal(roomParticipantTotal) : 'Loading'
          }
          onPress={() => {
            setCornerActionsVisible(false);
            setRosterVisible(true);
          }}
          testID="room-participant-roster-trigger"
        />
        <HullActionSheetRow
          accessibilityLabel={`Close ${CORNER_LABEL}`}
          description={`Ends the edit session and archives this ${CORNER_LABEL}. Unmerged work is lost.`}
          destructive
          label={`Close ${CORNER_LABEL}`}
          onPress={() => {
            setCornerActionsVisible(false);
            void handleCloseCorner();
          }}
          testID="close-corner-action"
        />
        <HullActionSheetCancel
          onPress={() => setCornerActionsVisible(false)}
          testID="corner-actions-close"
        />
      </HullActionSheetModal>

      <MemberPickerSheet
        busy={addingMembers || memberInviteBusy}
        canManage={roomSurface?.viewer.permissions.manage ?? false}
        canConnectAgent
        candidates={participantPickerCandidates}
        error={membershipError}
        kind={participantPickerKind}
        workspacePeerCount={participantPickerWorkspacePeers}
        onAdd={(pubkeys) => void handleAddRoomMembers(pubkeys)}
        onClose={() => setParticipantPickerVisible(false)}
        onConnectAgent={handleConnectAgent}
        onInvitePerson={() => void handleInvitePerson()}
        visible={memberManagement.pickerVisible}
      />
    </BuzzCommunityShell>
  );
}

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  const bottomChrome = roomBottomChromeStyles(groknight);
  return {
    container: {
      flex: 1,
      backgroundColor: groknight.bgTerminal,
    },
    keyboardBody: {
      flex: 1,
    },
    desktopConversationFrame: {
      flex: 1,
      minWidth: 0,
      flexDirection: 'row',
      position: 'relative',
    },
    desktopStatusSlot: {
      // The shared thinking line is a 24px row plus the fixed 9px gap.
      // Holding that full box while idle keeps the desktop composer still.
      minHeight: TURN_LINE_BOX_HEIGHT,
      justifyContent: 'center',
    },
    desktopStatusText: {
      ...theme.buzz.type.machine,
      paddingHorizontal: 14,
      color: groknight.dim,
    },
    desktopStatusFailed: {
      color: groknight.danger,
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
      zIndex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingBottom: 8,
      borderBottomWidth: 1,
      borderBottomColor: groknight.border,
      backgroundColor: groknight.bgBase,
    },
    // The leading gutter is 12 (header padding) + 44 + 12, so the title starts
    // on the SAME left axis as a Room-list row's name (16 + 40 tile slot + 12,
    // `channels.tsx`) and pushing a row open never shifts the name sideways.
    backButton: {
      width: 44,
      height: 44,
      marginRight: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    backText: { color: groknight.muted },
    cornerBackText: { color: groknight.textMuted },
    // The single agent's faceted mark, stated once for the whole corner — the
    // slot itself is the shared HeaderIdentitySlot primitive.
    headerCenter: {
      flex: 1,
      minHeight: 44,
      minWidth: 0,
      justifyContent: 'center',
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
    // The one thing on the corner's meta row with unbounded length, so it is
    // the one that gives: an unshrinkable name pushed the member count off
    // the right edge.
    cornerHeaderAgent: {
      ...Typography.mono('semiBold'),
      flexShrink: 1,
      minWidth: 0,
      color: groknight.textSecondary,
      fontSize: 10,
      lineHeight: 14,
      letterSpacing: 0.7,
    },
    cornerHeaderWorking: { color: groknight.ledgerQuiet },
    cornerHeaderReview: { color: groknight.ledgerQuiet },
    cornerHeaderWaiting: { color: groknight.accent },
    cornerHeaderArchived: { color: groknight.ledgerGhost },
    // The title and its metadata keep a clear gap before the trailing action.
    // Corner overflow stays a lone 44pt edge control. The Room's pair does not
    // cluster: the corners door owns a 44pt-tall target of its own and the
    // overflow's box touches it, matching the Room-list pair.
    roomActionsButton: {
      minWidth: 44,
      minHeight: 44,
      marginLeft: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    // Captain 2026-09-20: the door is the sigil alone — no word beside it. It
    // still owns a real 44pt target of its own rather than borrowing the
    // menu's.
    roomCornersButton: {
      minWidth: 44,
      minHeight: 44,
      marginLeft: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    // Siblings, not a cluster: the same 44pt box as the corners door. The
    // boxes touch, so the 28 marks sit 16pt apart — the same ink gap the
    // Room-list pair already has.
    roomClusteredActionsButton: {
      minWidth: 44,
      minHeight: 44,
      marginLeft: 0,
      alignItems: 'center',
      justifyContent: 'center',
    },
    // Destination marks use the same theme brass as Bookmarks. Overflow stays
    // steel chrome.
    roomCornersGlyph: { color: groknight.accent },
    roomActionsGlyph: { color: groknight.steel },
    archivedBadge: {
      backgroundColor: groknight.bgHighlight,
      borderRadius: groknight.radius,
      marginLeft: 12,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    archivedBadgeText: {
      ...Typography.mono('semiBold'),
      color: groknight.textMuted,
      fontSize: 11,
      lineHeight: 15,
    },
    // ── Room / corner actions sheet ──────────────────────────────────
    // The sheet itself, its rows and its trailing vocabulary live in
    // `components/buzz/HullActionSheet.tsx`. What is left here is only what
    // hangs BETWEEN rows: the rename editor and the picker's inset.
    roomSheetInset: {
      paddingHorizontal: HULL_SHEET_INSET,
      paddingVertical: groknight.space.sm,
    },
    roomRenameEditor: {
      paddingHorizontal: HULL_SHEET_INSET,
      paddingVertical: groknight.space.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: groknight.border,
    },
    roomRenameLabel: {
      ...Typography.default(),
      ...groknight.type.meta,
      color: groknight.textMuted,
    },
    roomRenameInput: {
      ...Typography.default('semiBold'),
      ...groknight.type.body,
      minHeight: 44,
      marginTop: groknight.space.xs,
      paddingHorizontal: 0,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: groknight.borderStrong,
      color: groknight.textPrimary,
    },
    roomRenameControls: {
      marginTop: groknight.space.sm,
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: groknight.space.sm,
    },
    // The sheet's one box: a notice the reader must act on, held to the same
    // trailing axis as the rows above it (DESIGN.md → Shape).
    membershipError: {
      marginHorizontal: HULL_SHEET_INSET,
      marginTop: groknight.space.sm,
      padding: groknight.space.sm,
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      backgroundColor: groknight.bgHighlight,
    },
    membershipErrorText: {
      ...Typography.default('semiBold'),
      ...groknight.type.meta,
      color: groknight.textSecondary,
    },

    // ── Message blocks ──────────────────────────────────────────────
    transcriptViewport: {
      flex: 1,
      position: 'relative',
    },
    messageList: {
      flex: 1,
    },
    // Desktop transcript only: a plain scrollable View over real DOM (no
    // FlatList/VirtualizedList) — see `shouldFollowDesktopTail` in
    // `buzz/room-scroll-follow.ts`. Mirrors RN Web's own vertical ScrollView
    // overflow (overflowX hidden, overflowY auto).
    desktopScroll: {
      overflowX: 'hidden',
      overflowY: 'auto',
    } as any,
    messageListContent: {
      paddingHorizontal: 12,
      paddingVertical: 12,
    },
    messageListContentDesktop: {
      flexGrow: 1,
      justifyContent: 'flex-end',
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
    // ── Composer ────────────────────────────────────────────────────
    emptyState: {
      flexGrow: 1,
    },
    // The stack and the composer row are one measured column —
    // `buzz/room-bottom-chrome.ts` owns both. The turn line is an absolute
    // overlay on the stack's top edge, styled inside `TurnBandSlot`; it takes
    // no height in this column.
    bottomChromeStack: bottomChrome.stack,
    inputBar: bottomChrome.composerRow,
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
    mentionChannelGlyph: {
      width: 28,
      height: 28,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      borderRadius: groknight.radius,
    },
    mentionChannelGlyphText: {
      ...Typography.default('semiBold'),
      color: groknight.accent,
      fontSize: 13,
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
