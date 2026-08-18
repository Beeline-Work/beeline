/**
 * Buzz Chat — single channel/session chat screen (P2: subchannels + merge + provenance).
 *
 * Grok Mono Hull design: neutral metal surfaces with redundant state encoding.
 */
import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import {
  Alert,
  AppState,
  View,
  Text,
  Image,
  FlatList,
  Linking,
  Modal as RNModal,
  Pressable,
  ScrollView,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Platform,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { KeyboardAvoidingView, useKeyboardState } from 'react-native-keyboard-controller';
import { Swipeable } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useNavigation, router, type Href } from 'expo-router';
import { loadBuzzIdentity, getEffectiveRelayUrl } from '@/auth/buzz-identity-storage';
import { Modal } from '@/modal';
import { BuzzRigTransport } from '@/sync/transport';
import {
  type Agent,
  type Community,
  type ChannelRole,
  type DirectMessage,
  type MergeTarget,
  type AttachmentReference,
  AGENT_PRESENCE_STALE_MS,
  personHandle,
} from '@beeline/buzz-client';
import {
  projectChatEvent,
  transcriptMessages,
  upsertChatMessages,
  type ChatDisplayMessage,
} from '@/sync/transport/buzz-event-projection';
import {
  channelCacheKey,
  getCachedChannel,
  type ChannelCacheEntry,
  profileCacheKey,
  selectChannelList,
  setActiveBuzzCacheViewer,
  useBuzzLocalCache,
} from '@/buzz/local-cache';
import {
  cacheLiveSessionEvent,
  cacheLiveSessionEvents,
  loadOlderMessages,
  revalidateCachedMessages,
} from '@/buzz/local-cache-sync';
import { afterInteractions } from '@/buzz/defer-interaction';
import { hydrateRoomEntry } from '@/buzz/room-entry';
import { groknight } from '@/buzz/groknight';
import { continuedSpeakerIds } from '@/buzz/ledger-attribution';
import { splitLedgerText } from '@/buzz/ledger-text';
import { ledgerStamp } from '@/buzz/relative-time';
import { CORNER_LABEL, ROOM_LABEL } from '@/buzz/vocabulary';
import { reconcileOptimisticMessage } from '@/buzz/reconcileOptimisticMessage';
import {
  activeMentionAtCursor,
  filterMentionCandidates,
  formatRoomParticipantTotal,
  mentionedAgentPubkey,
  replaceActiveMention,
  roomParticipantPubkeys,
  sectionRoomParticipants,
  sectionRoomRoster,
} from '@/buzz/room-participants';
import {
  resolveAgentDisplayIdentity,
  resolveCornerCardAgentPubkey,
  resolvePendingAgentDisplay,
} from '@/buzz/agent-display';
import {
  cornerName,
  cornerStatusPresentation,
  isCornerActive,
  resolveCornerLifecycleStatus,
  selectMostRecentActiveCornerId,
  type CornerStatus,
  type CornerSummary,
} from '@/buzz/corners';
import { ledgerFingerprint, personIdentityLabel, shortMemberNpub } from '@/buzz/member-display';
import { useVerifiedNip05Status } from '@/buzz/nip05-verification';
import {
  canRenameRoom,
  canRemoveRoomParticipant,
  normalizedRoomRole,
  roomLifecycleAction,
} from '@/buzz/room-management';
import {
  loadActiveCommunityId,
  saveActiveCommunityId,
  saveLastViewedChannel,
} from '@/buzz/community-storage';
import {
  formatAttachmentSize,
  uploadChatAttachment,
  type PickedChatAttachment,
} from '@/buzz/chat-attachment';
import { describeWriteRequest } from '@/buzz/write-request-copy';
import {
  cachedChannelKind,
  channelHeaderTitle,
  cornerSessionState,
  latestCornerTurnSummary,
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
import { replyMessageText, type MessageReplyTarget } from '@/buzz/message-reply';
import { isWorkspaceManagerRole } from '@/buzz/workspace-role';
import {
  isAgentPresenceOnlineWithReconnectGrace,
  isAgentOfflineAfterPresenceResolved,
  isAgentTurnActive,
  mergeAgentPresence,
  presenceMapFromSessionEvents,
  type RoomAgentPresence,
} from '@/buzz/agent-presence';
import { BuzzCommunityShell } from '@/components/buzz/CommunityRail';
import { Typography } from '@/constants/Typography';
import { ChangeReviewPanel } from '@/components/buzz/ChangeReviewPanel';
import { CornerLiveBar } from '@/components/buzz/CornerLiveBar';
import { WritePermissionOutcome } from '@/components/buzz/WritePermissionOutcome';
import { ActivityTimeline } from '@/components/buzz/ActivityTimeline';
import {
  LEDGER_MARGINALIA_WIDTH,
  LedgerEntry,
  LedgerGhostLine,
  LedgerMarginalia,
  LedgerSteer,
} from '@/components/buzz/Ledger';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import {
  HullSurface,
  MonoButton,
  NewMessageMaterialize,
  PixelLoader,
} from '@/components/buzz/MonoHull';

type RoomMemberOption = {
  pubkey: string;
  name: string;
  handle: string;
  kind: 'person' | 'agent';
  agent?: Agent;
};

/** Known body pubkeys for provenance display (hardcoded for dev). */
const BODY_PUBKEYS = new Set<string>();
const COMPOSER_MIN_HEIGHT = 40;
const COMPOSER_MAX_HEIGHT = 120;
// Open on the tail of a long transcript instead of the full history, then
// page older messages in as the reader scrolls up.
const INITIAL_MESSAGE_WINDOW = 30;
const OLDER_MESSAGES_PAGE_SIZE = 30;
// This deliberately remains the sole color seam for the human merge decision.
// If the product ever approves a non-monochrome exception, change only this value.
const MERGE_APPROVAL_ACCENT = groknight.accent;

/**
 * The voice a transcript entry belongs to, or `null` for anything that is not
 * one. People and agents both count: consecutive entries from the same voice
 * fold into one block. A system row (corner card, merge summary, archive
 * notice, permission card) belongs to nobody, so each of those ends the run and
 * makes the next entry re-announce itself.
 *
 * The agent test runs before the person test on purpose, so this agrees with
 * `renderItem`'s own `isAgent ? LedgerEntry : LedgerSteer` choice for the one case
 * where a message is both: an agent viewing its own Room messages, where
 * `isUser` and `isAgentAuthor` are true together. Deriving the two differently
 * would fold a run the renderer draws as two voices.
 */
function ledgerSpeakerKey(
  message: ChatDisplayMessage,
  agentByPubkey: Map<string, unknown>,
): string | null {
  if (message.corner || message.isMergeSummary || message.isArchivedNotice) return null;
  if (message.writePermission) return null;
  const isAgent =
    message.isAgentAuthor ||
    message.isAgentActivity ||
    Boolean(message.pubkey && (BODY_PUBKEYS.has(message.pubkey) || agentByPubkey.has(message.pubkey)));
  if (isAgent) return `agent:${message.pubkey ?? 'unknown-agent'}`;
  // An optimistic own message has no pubkey until it reconciles, so it keys on
  // the viewer rather than on a shared "unknown" bucket.
  return `person:${message.pubkey ?? (message.isUser ? 'self' : 'unknown-person')}`;
}

/**
 * One turn of the agent's work: its narration on the slab, its tools as
 * footnotes.
 *
 * The split lives in `ActivityTimeline`, and it is the whole point of this
 * row — the agent's own prose reads at the ledger's brightest tier, full
 * width, never behind a disclosure, while every read/search/list folds into
 * one counted note. An activity event carrying nothing but text is therefore
 * pure narration, which is exactly what the fallback below builds; treating it
 * as tool output is what buried an agent's words behind "tap to expand".
 *
 * A Room passes `handle` because several agents can be working there; a Corner
 * names its one agent in the top bar instead.
 */
function LedgerActivity({
  message,
  active,
  handle,
  marginalia,
}: {
  message: ChatDisplayMessage;
  active: boolean;
  handle?: string;
  marginalia?: React.ReactNode;
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
      {marginalia}
      <ActivityTimeline
        active={active}
        handle={handle}
        items={activity}
        testID="corner-activity-timeline"
      />
    </View>
  );
}

/**
 * Memoized: rendered once per agent transcript row inside FlatList's
 * renderItem, which is recreated on every presence tick — without this,
 * every row's presence dot re-renders even when only one other agent's
 * status actually changed. `online` is the only prop, so a shallow compare
 * bails correctly whenever this row's own agent status is unchanged.
 */
const AgentPresenceLight = React.memo(function AgentPresenceLight({
  online,
  testID,
}: {
  online: boolean;
  testID?: string;
}) {
  return (
    <View
      accessibilityLabel={online ? 'Agent online' : 'Agent offline'}
      accessibilityRole="image"
      style={[styles.agentPresenceLight, online ? styles.agentPresenceOnline : styles.agentPresenceOffline]}
      testID={testID}
    />
  );
});

function AttachmentCard({ attachment }: { attachment: AttachmentReference }) {
  const image = attachment.mimeType.startsWith('image/') && attachment.thumbnailUrl;
  const open = () => {
    void Linking.openURL(attachment.url).catch(() => {
      Alert.alert('Could not open attachment', 'The file link could not be opened on this device.');
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
  onReply,
}: {
  children: React.ReactNode;
  messageId: string;
  onReply: () => void;
}) {
  const swipeableRef = useRef<Swipeable | null>(null);

  if (Platform.OS === 'web') return <>{children}</>;

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
      {children}
    </Swipeable>
  );
}

export default function BuzzChat() {
  // `parent`/`title` are hints, not authority: every surface that opens a
  // corner already knows both, so passing them makes the header correct on the
  // first frame instead of one relay round trip later. The screen's own reads
  // still run and still win.
  const { channelId, notificationResponseId, parent, title } = useLocalSearchParams<{
    channelId: string;
    notificationResponseId?: string;
    parent?: string;
    title?: string;
  }>();
  const decodedId = channelId ? decodeURIComponent(channelId) : '';
  const initialCacheState = useBuzzLocalCache.getState();
  const initialViewerPubkey = initialCacheState.activeViewerPubkey;
  const initialChannelCache = initialViewerPubkey
    ? getCachedChannel(initialViewerPubkey, decodedId)
    : undefined;
  const routeParentChannelId = parent?.trim() || undefined;
  const routeChannelTitle = title?.trim() || undefined;
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const flatListRef = useRef<FlatList<ChatDisplayMessage>>(null);
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
  const sendInFlightRef = useRef(false);

  const [transport, setTransport] = useState<BuzzRigTransport | null>(null);
  const [inputText, setInputText] = useState('');
  const [replyTarget, setReplyTarget] = useState<MessageReplyTarget | null>(null);
  const [composerHeight, setComposerHeight] = useState(COMPOSER_MIN_HEIGHT);
  const [inputSelection, setInputSelection] = useState({ start: 0, end: 0 });
  const [highlightedMentionIndex, setHighlightedMentionIndex] = useState(0);
  const [dismissedMentionKey, setDismissedMentionKey] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [pendingAttachment, setPendingAttachment] = useState<PickedChatAttachment | null>(null);
  const [offlineQueuedIds, setOfflineQueuedIds] = useState<Set<string>>(new Set());
  const [isArchived, setIsArchived] = useState(initialChannelCache?.archived ?? false);
  const [userPubkey, setUserPubkey] = useState<string>('');
  const [mergeTarget, setMergeTarget] = useState<MergeTarget | null>(
    initialChannelCache?.mergeTarget ?? null,
  );
  // 'delivering' means the approval publish itself was accepted by the relay
  // — landing/confirming is still in progress or retrying, never "done".
  // 'failed' means a durable publish on the landing path (push, land, or
  // merge-gate attempt) failed or could not be confirmed; the underlying
  // operation keeps retrying automatically, so this is informational, not a
  // dead end requiring the user to resend the approval.
  const [approvalState, setApprovalState] = useState<
    'none' | 'sending' | 'delivering' | 'failed' | 'merged'
  >('none');
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [reviewFileCount, setReviewFileCount] = useState<number | null>(null);
  const [parentChannelId, setParentChannelId] = useState<string | undefined>(
    initialChannelCache?.parentChannelId ?? routeParentChannelId,
  );
  // Whether this transcript is a Room or a Corner, tracked separately from
  // `parentChannelId` because an absent parent means "room" only after the
  // channel's own read has landed — before that it means "not known yet", and
  // the header must not name either surface on a guess.
  const [channelKind, setChannelKind] = useState<ChannelKind>(() =>
    routeParentChannelId ? 'corner' : cachedChannelKind(initialChannelCache),
  );
  // The corner view's own status badge, sourced from the exact same
  // canonical CornerStatus (via listSubchannelLifecycle) that the Room-list
  // dropdown and the standalone Corners list already read, so all three
  // surfaces show identical primary status words for this corner.
  const [cornerLifecycleStatus, setCornerLifecycleStatus] = useState<CornerStatus | null>(null);
  // Every corner this transcript can name: a Corner reads its own siblings, a
  // Room reads its own corners. The pinned indicator needs the corner's real
  // name ("feat/ux-fix-now"), not an id — and this list is the one place that
  // name is canonical. It is served from `listSubchannelLifecycle`'s shared
  // short-TTL cache, which the Room list has usually already warmed.
  const [cornerLifecycle, setCornerLifecycle] = useState<CornerSummary[]>([]);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [activeCommunityId, setActiveCommunityId] = useState<string | null>(
    initialChannelCache?.communityId ?? null,
  );
  const [canManageWorkspace, setCanManageWorkspace] = useState(false);
  const [addingMemberPubkey, setAddingMemberPubkey] = useState<string | null>(null);
  const [viewerIsAgent, setViewerIsAgent] = useState(false);
  // `null` while the channel's own metadata read is still in flight; `''` once
  // it has landed and the channel genuinely carries no name.
  const [resolvedChannelName, setResolvedChannelName] = useState<string | null>(
    initialChannelCache?.roomName ?? routeChannelTitle ?? null,
  );
  const [viewerChannelRole, setViewerChannelRole] = useState<ChannelRole | null>(null);
  const [rosterVisible, setRosterVisible] = useState(false);
  const [roomActionsVisible, setRoomActionsVisible] = useState(false);
  const [cornerActionsVisible, setCornerActionsVisible] = useState(false);
  const [renameEditing, setRenameEditing] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [participantPickerVisible, setParticipantPickerVisible] = useState(false);
  const [membershipError, setMembershipError] = useState<string | null>(null);
  const [membershipActionPubkey, setMembershipActionPubkey] = useState<string | null>(null);
  const [roomLifecycleBusy, setRoomLifecycleBusy] = useState(false);
  const [directMessage, setDirectMessage] = useState<DirectMessage | null>(
    initialChannelCache?.directMessage ?? null,
  );
  const [composerFocused, setComposerFocused] = useState(false);
  const [permissionActionId, setPermissionActionId] = useState<string | null>(null);
  const [agentPresences, setAgentPresences] = useState<Record<string, RoomAgentPresence>>({});
  const [presenceResolved, setPresenceResolved] = useState(false);
  const [presenceReconnectGrace, setPresenceReconnectGrace] = useState<Record<string, number>>({});
  const [presenceNow, setPresenceNow] = useState(Date.now());
  const agentPresencesRef = useRef(agentPresences);
  const presenceReconnectGraceRef = useRef(presenceReconnectGrace);
  agentPresencesRef.current = agentPresences;
  presenceReconnectGraceRef.current = presenceReconnectGrace;
  const activeCacheViewer = useBuzzLocalCache((state) => state.activeViewerPubkey);
  const cacheViewerPubkey = userPubkey || activeCacheViewer || '';
  const channelCache = useBuzzLocalCache((state) =>
    cacheViewerPubkey ? state.channels[channelCacheKey(cacheViewerPubkey, decodedId)] : undefined,
  );
  // Seeded synchronously from the local cache so history is on screen on
  // first paint, before the async identity load resolves the live channelCache.
  const cachedMessages = channelCache?.messages ?? initialChannelCache?.messages ?? [];
  // Older pages loaded on demand via "scroll up" pagination. Kept out of the
  // shared cache (which bounds to the recent tail) and merged in only here.
  const [olderMessages, setOlderMessages] = useState<ChatDisplayMessage[]>([]);
  const [visibleMessageCount, setVisibleMessageCount] = useState(INITIAL_MESSAGE_WINDOW);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const hasMoreHistoryRef = useRef(true);
  const combinedMessages = useMemo(
    () => upsertChatMessages(olderMessages, cachedMessages),
    [olderMessages, cachedMessages],
  );
  // Open on the tail; older history reveals from what's already resident here
  // first, then pages in from the relay once that's exhausted.
  const messages = useMemo(
    () => combinedMessages.slice(-visibleMessageCount),
    [combinedMessages, visibleMessageCount],
  );

  const loadOlderTranscriptMessages = useCallback(() => {
    if (loadingOlderMessages) return;
    if (visibleMessageCount < combinedMessages.length) {
      setVisibleMessageCount((count) => Math.min(combinedMessages.length, count + OLDER_MESSAGES_PAGE_SIZE));
      return;
    }
    const oldest = combinedMessages[0];
    if (!hasMoreHistoryRef.current || !transport || !oldest) return;
    setLoadingOlderMessages(true);
    void loadOlderMessages(
      transport,
      cacheViewerPubkey,
      decodedId,
      oldest.timestamp,
      OLDER_MESSAGES_PAGE_SIZE,
    )
      .then((older) => {
        const fresh = older.filter((message) => message.id !== oldest.id);
        if (fresh.length < OLDER_MESSAGES_PAGE_SIZE - 1) hasMoreHistoryRef.current = false;
        if (fresh.length === 0) return;
        setOlderMessages((current) => upsertChatMessages(current, fresh));
        setVisibleMessageCount((count) => count + fresh.length);
      })
      .catch((err) => console.warn('Failed to load older messages:', err))
      .finally(() => setLoadingOlderMessages(false));
  }, [
    cacheViewerPubkey,
    combinedMessages,
    decodedId,
    loadingOlderMessages,
    transport,
    visibleMessageCount,
  ]);
  const availableAgents = channelCache?.availableAgents ?? [];
  const availablePeople = channelCache?.availablePeople ?? [];
  const roomMembers = channelCache?.roomMembers ?? [];
  const roomMemberPubkeys = useMemo(
    () => new Set(roomMembers.map((member) => member.pubkey)),
    [roomMembers],
  );
  const cachedPersonProfiles = useBuzzLocalCache((state) =>
    cacheViewerPubkey && activeCommunityId
      ? state.profiles[profileCacheKey(cacheViewerPubkey, activeCommunityId)]
      : undefined,
  );
  const personProfiles = cachedPersonProfiles ?? [];
  const participantsHydrated =
    channelCache?.roomMembers !== undefined &&
    channelCache.availablePeople !== undefined &&
    channelCache.availableAgents !== undefined;
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
    return [...options.values()].sort((a, b) => {
      if (a.pubkey === userPubkey) return -1;
      if (b.pubkey === userPubkey) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [availableAgents, availablePeople, personProfileByPubkey, userPubkey]);
  const participantPubkeys = useMemo(
    () =>
      roomParticipantPubkeys(
        roomMemberPubkeys,
        activeCommunityId ? availablePeople : undefined,
        activeCommunityId ? availableAgents : undefined,
      ),
    [activeCommunityId, availableAgents, availablePeople, roomMemberPubkeys],
  );
  const roomParticipants = useMemo(
    () => memberOptions.filter((option) => participantPubkeys.has(option.pubkey)),
    [memberOptions, participantPubkeys],
  );
  const roomRosterSections = useMemo(
    () => sectionRoomRoster(memberOptions, roomMemberPubkeys),
    [memberOptions, roomMemberPubkeys],
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
  const onlineAgentCount = roomAgents.filter((agent) =>
    isAgentPresenceOnlineWithReconnectGrace(
      agentPresences[agent.pubkey],
      presenceNow,
      presenceReconnectGrace[agent.pubkey],
    ),
  ).length;
  const knownAgentPresenceCount = roomAgents.filter((agent) => agentPresences[agent.pubkey]).length;
  const agentsOffline = isAgentOfflineAfterPresenceResolved(
    presenceResolved,
    roomAgents.length,
    knownAgentPresenceCount,
    onlineAgentCount,
  );
  const roomMemberByPubkey = useMemo(
    () => new Map(roomMembers.map((member) => [member.pubkey, member])),
    [roomMembers],
  );
  const viewerRoomRole = normalizedRoomRole(roomMemberByPubkey.get(userPubkey));
  const lifecycleAction = roomLifecycleAction(viewerRoomRole);
  const mentionableAgents = useMemo(
    () =>
      roomParticipants
        .filter((participant) => participant.kind === 'agent')
        .map((participant) => ({
          pubkey: participant.pubkey,
          name: participant.name,
          handle: participant.handle,
        })),
    [roomParticipants],
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
        ? filterMentionCandidates(roomParticipants, activeMention.query)
        : { matches: [], overflow: 0 },
    [activeMention, roomParticipants],
  );
  const mentionMenuVisible = Boolean(
    composerFocused &&
    mentionMenuKey &&
    mentionMenuKey !== dismissedMentionKey &&
    mentionSuggestions.matches.length > 0,
  );
  const isCorner = Boolean(parentChannelId);
  // `null` means "show a skeleton": the channel kind or its name is still
  // resolving and no honest word exists yet. A corner never renders the Room
  // label as a stand-in for its own slug.
  const headerTitle = channelHeaderTitle(
    resolvedChannelName,
    isCorner ? 'corner' : channelKind,
    decodedId,
  );
  // Room-lifecycle copy ("Delete <name>?") only ever runs on a Room, which by
  // then has a resolved name; the label is the safe fallback for the sentence.
  const roomName = headerTitle ?? ROOM_LABEL;
  const isDirectMessage = Boolean(directMessage);
  // A DM's title is its peer's identity. Derived from cached state rather
  // than resolved inside the enter-room fetch chain, so it is right on the
  // first painted frame of a warm cache instead of several relay reads later.
  // Deliberately not `directMessagePeer`, which throws when the viewer is not
  // a participant — a throw here would be a render-time crash, not a bad title.
  const dmPeerPubkey = userPubkey
    ? directMessage?.participants.find((pubkey) => pubkey !== userPubkey)
    : undefined;
  const dmPeerProfile = dmPeerPubkey ? personProfileByPubkey.get(dmPeerPubkey) : undefined;
  const dmPeerNip05Status = useVerifiedNip05Status(dmPeerPubkey ?? '', dmPeerProfile);
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
  const sessionState = isCorner ? cornerSessionState(messages) : 'idle';
  const cornerAgentPubkey = useMemo(
    () => resolveCornerViewAgentPubkey(messages, (pubkey) => agentByPubkey.has(pubkey)),
    [agentByPubkey, messages],
  );
  const turnSummary = isCorner ? latestCornerTurnSummary(messages, cornerAgentPubkey) : undefined;
  const cornerAgentDisplay = cornerAgentPubkey
    ? resolvePendingAgentDisplay(cornerAgentPubkey, agentByPubkey.get(cornerAgentPubkey), participantsHydrated)
    : undefined;
  const cornerAgentOnline = Boolean(
    cornerAgentPubkey &&
      isAgentPresenceOnlineWithReconnectGrace(
        agentPresences[cornerAgentPubkey],
        presenceNow,
        presenceReconnectGrace[cornerAgentPubkey],
      ),
  );
  const visibleMessages = useMemo(
    () => transcriptMessages(messages, isCorner),
    [isCorner, messages],
  );
  // Attribution is per run, not per entry: only the first entry of a voice's
  // run carries its mark and name (see `buzz/ledger-attribution.ts`). A corner
  // never attributes at all, so it never needs the set.
  const continuedAttributionIds = useMemo(
    () =>
      isCorner
        ? new Set<string>()
        : continuedSpeakerIds(
            visibleMessages.map((message) => ({
              id: message.id,
              speaker: ledgerSpeakerKey(message, agentByPubkey),
            })),
          ),
    [agentByPubkey, isCorner, visibleMessages],
  );
  // Newest-first for the inverted FlatList; chronological visibleMessages
  // above stays the source of truth for everything else that reads order.
  const invertedMessages = useMemo(() => [...visibleMessages].reverse(), [visibleMessages]);
  // A reconciled draft/final bubble keeps a stable display `id` across the
  // turn, so it also needs to resolve by its real relay event id — the id
  // any NIP-10 reply on another client actually references.
  const visibleMessageById = useMemo(() => {
    const map = new Map<string, ChatDisplayMessage>();
    for (const message of visibleMessages) {
      map.set(message.id, message);
      if (message.relayId) map.set(message.relayId, message);
    }
    return map;
  }, [visibleMessages]);
  // A corner that a permission ALLOW opened, before its own lifecycle card has
  // landed. The pinned live bar needs a destination from the instant the corner
  // exists, since the inline "corner open" note that used to carry that tap is
  // gone from the transcript.
  const permittedCornerId = useMemo(
    () =>
      [...messages]
        .reverse()
        .find(
          (message) =>
            message.writePermission?.status === 'allowed' && message.writePermission.subchannelId,
        )?.writePermission?.subchannelId,
    [messages],
  );
  // "Most recent active corner" is resolved once, from the same signal used
  // to pick which corner a tap on the ambient status strip opens, so the
  // status text and the destination it navigates to can never disagree.
  const mostRecentActiveCornerId = useMemo(
    () =>
      selectMostRecentActiveCornerId(
        messages.flatMap((message) =>
          message.corner
            ? [
                {
                  subchannelId: message.corner.subchannelId,
                  status: message.corner.status,
                  timestamp: message.timestamp,
                },
              ]
            : [],
        ),
      ),
    [messages],
  );
  const activeCorner = useMemo(
    () =>
      mostRecentActiveCornerId
        ? [...messages]
            .reverse()
            .find((message) => message.corner?.subchannelId === mostRecentActiveCornerId)
        : undefined,
    [messages, mostRecentActiveCornerId],
  );
  // cornerLifecycleStatus is a one-time snapshot fetched at mount; isArchived
  // is kept live by several independent update paths (live archive signal,
  // revalidated cache, fresh isChannelArchived check). A confirmed archive
  // that resolves after mount must never leave this badge showing a stale
  // non-terminal status.
  const displayedCornerStatus = useMemo(
    () => resolveCornerLifecycleStatus(cornerLifecycleStatus, isArchived),
    [cornerLifecycleStatus, isArchived],
  );
  // Only route the ambient status strip when the resolved id is genuinely
  // the active corner — never send a tap to a stale/unrelated corner that
  // merely happens to be the most recent one on record.
  const tappableCornerId =
    activeCorner?.corner && isCornerActive(activeCorner.corner.status)
      ? mostRecentActiveCornerId
      : undefined;
  const activeAgentTurn = useMemo(
    () =>
      [...messages]
        .reverse()
        .find(
          (message) =>
            message.agentTurn &&
            isAgentTurnActive(
              message.agentTurn,
              agentPresences[message.agentTurn.agentPubkey],
              presenceNow,
              presenceReconnectGrace[message.agentTurn.agentPubkey],
            ),
        ),
    [agentPresences, messages, presenceNow, presenceReconnectGrace],
  );
  /**
   * The pinned corner indicator's whole state, resolved in one place so the
   * words it shows and the corner a tap on it opens can never disagree.
   *
   * One line, and it names the two facts that matter: who is working, and what
   * on — `beebee active: feat/ux-fix-now`. Both surfaces get one, because both
   * have the same question to answer: a Room asks "is a corner running, and
   * where," a Corner asks "is this session still moving." `live` is what turns
   * the line gold and starts its breath; an open-but-idle corner keeps the same
   * line on the quiet tier, which is a real and distinct state the old
   * "working in corner…" strip could not express at all.
   */
  const cornerLiveBar = useMemo((): { label: string; live: boolean; cornerId?: string } | null => {
    const named = (subject: string, verb: string, target?: string) =>
      target ? `${subject} ${verb}: ${target}` : `${subject} ${verb}`;

    if (isCorner) {
      const subject = cornerAgentDisplay?.name ?? 'agent';
      // The branch is the truest name for what a corner is doing; the corner's
      // own slug is the fallback, and both beat an opaque id.
      const target = mergeTarget?.branch ?? headerTitle ?? undefined;
      if (sessionState === 'working') return { label: named(subject, 'active', target), live: true };
      if (displayedCornerStatus && isCornerActive(displayedCornerStatus)) {
        return { label: named(subject, 'idle', target), live: false };
      }
      return null;
    }

    // The bar reports the *corner*; the offline hint directly below it reports
    // the *agent*. Keeping those two facts in two places is what stops the bar
    // from claiming gold — which DESIGN.md assigns to live/online presence —
    // for a state that is neither.
    const working = Boolean(activeAgentTurn?.agentTurn) && !agentsOffline;
    const cornerId = tappableCornerId ?? permittedCornerId;
    const agentPubkey = cornerId
      ? resolveCornerCardAgentPubkey(
          activeCorner?.corner?.agentPubkey,
          activeCorner?.pubkey,
          (pubkey) => agentByPubkey.has(pubkey),
        )
      : activeAgentTurn?.agentTurn?.agentPubkey;
    const subject = agentPubkey
      ? resolveAgentDisplayIdentity(agentPubkey, agentByPubkey.get(agentPubkey)).name
      : 'agent';
    if (cornerId) {
      const target = cornerName(
        cornerLifecycle.find((corner) => corner.id === cornerId)?.name,
        cornerId,
      );
      return {
        label: named(subject, working ? 'active' : 'idle', target),
        live: working,
        cornerId,
      };
    }
    if (working) return { label: named(subject, 'active'), live: true };
    return null;
  }, [
    activeAgentTurn,
    activeCorner,
    agentByPubkey,
    agentsOffline,
    cornerAgentDisplay,
    cornerLifecycle,
    displayedCornerStatus,
    headerTitle,
    isCorner,
    mergeTarget,
    permittedCornerId,
    sessionState,
    tappableCornerId,
  ]);

  const activeActivityId = useMemo(() => {
    if (isCorner ? sessionState !== 'working' : !activeAgentTurn) return undefined;
    const latest = visibleMessages.at(-1);
    return isCorner && !isArchived && latest?.isAgentActivity ? latest.id : undefined;
  }, [activeAgentTurn, isArchived, isCorner, sessionState, visibleMessages]);

  useEffect(() => {
    setReviewFileCount(null);
    setApprovalError(null);
  }, [mergeTarget?.tip]);

  useEffect(() => {
    // Presence only changes at a lease/grace deadline. A five-second clock here
    // recreated FlatList's renderItem (and every visible message) while someone
    // was typing, which made the foreground intermittently unresponsive.
    const now = Date.now();
    const deadlines = [
      ...Object.values(agentPresences).map((presence) =>
        presence.observedAt + AGENT_PRESENCE_STALE_MS,
      ),
      ...Object.values(presenceReconnectGrace),
    ].filter((deadline) => Number.isFinite(deadline) && deadline > now);
    if (deadlines.length === 0) return;
    const delay = Math.max(1, Math.min(...deadlines) - now + 1);
    const timer = setTimeout(() => setPresenceNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [agentPresences, presenceReconnectGrace]);

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

  // Helper to add new messages, deduplicating by id.
  const addMessages = useCallback(
    (newMsgs: ChatDisplayMessage[]) => {
      const viewerPubkey = useBuzzLocalCache.getState().activeViewerPubkey;
      if (!viewerPubkey) return;
      useBuzzLocalCache.getState().upsertMessages(
        viewerPubkey,
        decodedId,
        newMsgs.map((message) => ({ ...message, isNew: true })),
      );
    },
    [decodedId],
  );

  useEffect(() => {
    if (!decodedId) return;

    let cancelled = false;
    const isCancelled = () => cancelled;
    let unsubscribe: (() => void) | undefined;
    let unsubscribePresence: (() => void) | undefined;
    let unsubscribeDraft: (() => void) | undefined;
    let appStateSubscription: ReturnType<typeof AppState.addEventListener> | undefined;
    const cancelDeferred: (() => void)[] = [];
    agentPresencesRef.current = {};
    presenceReconnectGraceRef.current = {};
    setAgentPresences({});
    setPresenceReconnectGrace({});
    setPresenceResolved(false);
    hasMoreHistoryRef.current = true;
    setOlderMessages([]);
    setVisibleMessageCount(INITIAL_MESSAGE_WINDOW);

    // The screen is already painted from the local cache by the time this
    // runs. The navigation transition owns the next few frames, so every
    // relay response is projected and committed behind it rather than inside
    // it — see defer-interaction.ts.
    const defer = (run: () => void) => {
      cancelDeferred.push(afterInteractions(run));
    };
    const patchChannelCache = (viewerPubkey: string, patch: Partial<ChannelCacheEntry>) => {
      useBuzzLocalCache.getState().patchChannel(viewerPubkey, decodedId, patch);
    };

    (async () => {
      try {
        // Identity and relay URL are local storage reads, never network.
        const identity = await loadBuzzIdentity();
        if (!identity) {
          router.replace('/buzz/onboarding');
          return;
        }
        if (cancelled) return;
        setActiveBuzzCacheViewer(identity.publicKey);
        setUserPubkey(identity.publicKey);

        const url = await getEffectiveRelayUrl();
        if (cancelled) return;
        const t = new BuzzRigTransport(identity, url);
        setTransport(t);
        // Constructs the shared authenticated client; the WebSocket is opened
        // lazily by the first live subscription, so this is not a round-trip.
        const client = await t.ensureClient();
        if (cancelled) return;

        // A corner's live agent-activity stream can deliver one raw event per
        // streamed token. Reprojecting + re-sorting the cache on every single
        // one saturates the JS thread and reads as a UI freeze during a send
        // or while the agent is actively working. Coalesce whatever arrives
        // within one animation frame into a single cache write instead.
        let pendingLiveEvents: Parameters<typeof cacheLiveSessionEvent>[2][] = [];
        let liveFlushScheduled = false;
        const flushLiveEvents = () => {
          liveFlushScheduled = false;
          if (cancelled || pendingLiveEvents.length === 0) return;
          const batch = pendingLiveEvents;
          pendingLiveEvents = [];
          const projections = cacheLiveSessionEvents(identity.publicKey, decodedId, batch);
          for (const projected of projections) {
            if (projected.mergeTarget) setMergeTarget(projected.mergeTarget);
            if (projected.clearMergeTarget) setMergeTarget(null);
            if (projected.archiveChannel) {
              setIsArchived(true);
              setApprovalState('merged');
            }
            // A durable publish on the landing path failed or could not be
            // confirmed — never keep showing a stale "sent"/"delivering"
            // state while nothing is actually landing. Ignored once merged.
            if (projected.deliveryFailed) {
              setApprovalState((current) => (current === 'merged' ? current : 'failed'));
            }
            applyAgentPresence(projected.agentPresence);
          }
        };
        const handleLiveMessage = (event: Parameters<typeof cacheLiveSessionEvent>[2]) => {
          if (cancelled) return;
          pendingLiveEvents.push(event);
          if (!liveFlushScheduled) {
            liveFlushScheduled = true;
            requestAnimationFrame(flushLiveEvents);
          }
        };

        // Presence grace across background/foreground needs no relay read, so
        // it is installed now instead of behind the hydration reads.
        let lastAppState = AppState.currentState;
        let onlineBeforeBackground = new Set<string>();
        appStateSubscription = AppState.addEventListener('change', (nextAppState) => {
          const previousAppState = lastAppState;
          lastAppState = nextAppState;

          if (nextAppState !== 'active') {
            if (previousAppState === 'active') {
              const now = Date.now();
              onlineBeforeBackground = new Set(
                Object.entries(agentPresencesRef.current)
                  .filter(([pubkey, presence]) =>
                    isAgentPresenceOnlineWithReconnectGrace(
                      presence,
                      now,
                      presenceReconnectGraceRef.current[pubkey],
                    ),
                  )
                  .map(([pubkey]) => pubkey),
              );
              const backgroundGrace = Object.fromEntries(
                [...onlineBeforeBackground].map((pubkey) => [pubkey, Number.MAX_SAFE_INTEGER]),
              );
              presenceReconnectGraceRef.current = backgroundGrace;
              setPresenceReconnectGrace(backgroundGrace);
            }
            return;
          }
          if (previousAppState === 'active' || cancelled) return;

          const now = Date.now();
          const graceUntil = now + AGENT_PRESENCE_STALE_MS;
          const foregroundGrace = Object.fromEntries(
            [...onlineBeforeBackground].map((pubkey) => [pubkey, graceUntil]),
          );
          presenceReconnectGraceRef.current = foregroundGrace;
          setPresenceReconnectGrace(foregroundGrace);
          setPresenceNow(now);

          // RelayWs owns reconnect and the session subscription resumes from
          // its last-seen cursor. Do not duplicate that work in the AppState
          // callback: disconnecting, backfilling, and cache projection here
          // previously starved the resumed composer.
        });

        const handleLivePresence = (event: Parameters<typeof projectChatEvent>[0]) => {
          if (cancelled) return;
          applyAgentPresence(projectChatEvent(event, identity.publicKey).agentPresence);
        };

        /**
         * Establish live delivery for this Room. Started by hydrateRoomEntry
         * and awaited by nothing a person can see — the WebSocket connect and
         * NIP-42 AUTH handshake behind these calls used to gate every other
         * read on the screen.
         */
        const installLiveDelivery = async ({
          parentChannelId,
        }: {
          parentChannelId: string | null;
        }) => {
          const presenceChannelId = parentChannelId ?? decodedId;
          const installMessages = (async () => {
            try {
              const stop = await t.sessionEventsSubscribeReady(decodedId, handleLiveMessage);
              if (cancelled) {
                stop();
                return;
              }
              unsubscribe = stop;
            } catch (error) {
              console.warn(`Failed to establish live Room subscription for ${decodedId}:`, error);
              if (!cancelled) unsubscribe = t.sessionEventsSubscribe(decodedId, handleLiveMessage);
            }
          })();
          const installPresence = (async () => {
            try {
              const stop = await t.agentPresenceSubscribeReady(presenceChannelId, handleLivePresence);
              if (cancelled) {
                stop();
                return;
              }
              unsubscribePresence = stop;
            } catch (error) {
              console.warn(
                `Failed to establish live agent presence for ${presenceChannelId}:`,
                error,
              );
              if (!cancelled) {
                unsubscribePresence = t.agentPresenceSubscribe(presenceChannelId, handleLivePresence);
              }
            }
            const presenceEvents = await t.agentPresenceBackfill(presenceChannelId);
            if (cancelled) return;
            defer(() => {
              if (cancelled) return;
              const initialPresences = presenceMapFromSessionEvents(presenceEvents);
              agentPresencesRef.current = initialPresences;
              setAgentPresences(initialPresences);
              setPresenceResolved(true);
              setPresenceNow(Date.now());
            });
          })();
          // Corners already stream their own reply text as durable, in-place
          // narrative bubbles (see openSubchannel/startAgentTask). Only a Room
          // or DM's own turn draft needs to flow into the transcript — the
          // draft/final reconciliation in buzz-event-projection.ts relies on
          // the final reply's NIP-10 reply-to, which corners never set.
          const installDraft = parentChannelId
            ? Promise.resolve()
            : (async () => {
                try {
                  const stop = await t.agentDraftSubscribeReady(decodedId, handleLiveMessage);
                  if (cancelled) {
                    stop();
                    return;
                  }
                  unsubscribeDraft = stop;
                } catch (error) {
                  console.warn(
                    `Failed to establish live agent draft subscription for ${decodedId}:`,
                    error,
                  );
                  if (!cancelled) {
                    unsubscribeDraft = t.agentDraftSubscribe(decodedId, handleLiveMessage);
                  }
                }
                const draftEvents = await t.agentDraftBackfill(decodedId);
                if (!cancelled) draftEvents.forEach(handleLiveMessage);
              })();
          await Promise.all([installMessages, installPresence, installDraft]);
        };

        await hydrateRoomEntry(
          {
            channelId: decodedId,
            viewerPubkey: identity.publicKey,
            client,
            transport: t,
            installLiveDelivery,
            revalidateTranscript: () =>
              revalidateCachedMessages(t, identity.publicKey, decodedId),
            isCancelled,
            afterInteractions: defer,
            viewerActiveCommunityId: () => loadActiveCommunityId(identity.publicKey),
          },
          {
            onCommunities: setCommunities,
            onViewerIsAgent: setViewerIsAgent,
            onChannelRole: setViewerChannelRole,
            // The channel's own name, never the generic Room label — a cached
            // label re-seeds the wrong header on the next cold open, and the
            // header derives its own fallback from the resolved channel kind.
            onRoomName: (name) => {
              setResolvedChannelName(name);
              patchChannelCache(identity.publicKey, { roomName: name });
            },
            // Called on both branches: an absent parent only means "room" once
            // this read has actually landed.
            onParentChannelId: (parentId) => {
              setChannelKind(parentId ? 'corner' : 'room');
              if (!parentId) return;
              setParentChannelId(parentId);
              patchChannelCache(identity.publicKey, { parentChannelId: parentId });
            },
            onDirectMessage: (dm) => {
              setDirectMessage(dm);
              patchChannelCache(identity.publicKey, { directMessage: dm });
            },
            onWorkspaceId: (communityId) => {
              setActiveCommunityId(communityId);
              patchChannelCache(identity.publicKey, { communityId });
              void Promise.all([
                saveActiveCommunityId(identity.publicKey, communityId),
                saveLastViewedChannel(identity.publicKey, communityId, decodedId),
              ]).catch(() => undefined);
            },
            onMembers: (roomMembers) => patchChannelCache(identity.publicKey, { roomMembers }),
            // Agent names are the union across every Workspace the viewer
            // belongs to, and land on their own — never behind the
            // person-profile read, whose failure used to leave the transcript
            // with no agent names at all until the screen remounted.
            onAgents: (agents) =>
              patchChannelCache(identity.publicKey, { availableAgents: agents }),
            onRoster: ({ people, profiles, canManageWorkspace, communityId }) => {
              setCanManageWorkspace(canManageWorkspace);
              patchChannelCache(identity.publicKey, { availablePeople: people });
              useBuzzLocalCache
                .getState()
                .replaceProfiles(identity.publicKey, communityId, profiles);
            },
            // revalidateCachedMessages already wrote archive/merge state into
            // the cache; only the screen's own state is left to publish.
            onTranscriptSynced: (sync) => {
              if (sync.mergeTarget !== undefined) setMergeTarget(sync.mergeTarget);
              if (sync.archiveChannel) setIsArchived(true);
            },
            onArchived: () => {
              setIsArchived(true);
              patchChannelCache(identity.publicKey, { archived: true });
            },
            onMergeTarget: (target) => {
              setMergeTarget(target);
              patchChannelCache(identity.publicKey, { mergeTarget: target });
            },
            onCornerStatus: setCornerLifecycleStatus,
            onCornerLifecycle: setCornerLifecycle,
            onStepFailed: (step, error) =>
              console.warn(`BuzzChat: ${step} failed for ${decodedId}:`, error),
          },
          '',
        );
      } catch (err) {
        console.warn('Failed to init BuzzChat:', err);
      }
    })();

    return () => {
      cancelled = true;
      cancelDeferred.forEach((cancel) => cancel());
      appStateSubscription?.remove();
      if (unsubscribe) unsubscribe();
      if (unsubscribePresence) unsubscribePresence();
      if (unsubscribeDraft) unsubscribeDraft();
    };
  }, [decodedId, notificationResponseId, applyAgentPresence]);

  const replyTargetForMessage = useCallback(
    (message: ChatDisplayMessage): MessageReplyTarget => {
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
        // Reply threading is a NIP-10 `e` tag lookup by real relay event id;
        // a reconciled draft/final bubble's display `id` is a synthetic
        // per-turn key, so prefer the real event id when one is recorded.
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
      setReplyTarget(replyTargetForMessage(message));
      setDismissedMentionKey(null);
      void Haptics.selectionAsync();
      requestAnimationFrame(() => composerRef.current?.focus());
    },
    [replyTargetForMessage],
  );

  const handleSend = useCallback(async () => {
    const rawText = inputTextRef.current.trim();
    // State updates are committed asynchronously. A ref closes the short
    // double-tap window before `sending` can disable the native control.
    if (sendInFlightRef.current || (!rawText && !pendingAttachment) || !transport || isArchived) return;
    const text = replyTarget ? replyMessageText(rawText, replyTarget) : rawText;

    sendInFlightRef.current = true;
    setSending(true);
    const sentWhileOffline = agentsOffline;

    try {
      const attachments = pendingAttachment
        ? [await uploadChatAttachment(await transport.ensureClient(), pendingAttachment)]
        : [];
      inputTextRef.current = '';
      setInputText('');
      setComposerHeight(COMPOSER_MIN_HEIGHT);
      setInputSelection({ start: 0, end: 0 });
      setPendingAttachment(null);
      setReplyTarget(null);
      const optimisticId = `optimistic-${Date.now()}`;
      if (sentWhileOffline) {
        setOfflineQueuedIds((current) => new Set(current).add(optimisticId));
      }
      addMessages([
        {
          id: optimisticId,
          text,
          isUser: true,
          timestamp: Date.now(),
          pubkey: userPubkey,
          ...(replyTarget ? { replyToId: replyTarget.messageId } : {}),
          ...(attachments.length ? { attachments } : {}),
        },
      ]);
      // `@noble/curves` signs the Nostr event synchronously. Give React Native
      // one native frame to commit the cleared composer and optimistic row
      // before that CPU work begins; the network publish itself remains async.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const normalizedText = text.normalize('NFKC').toLocaleLowerCase();
      const selectedMentionedAgent = [...selectedAgentMentionsRef.current.entries()]
        .sort(([left], [right]) => right.length - left.length)
        .find(([handle]) => {
          const mention = `@${handle.normalize('NFKC').toLocaleLowerCase()}`;
          const offset = normalizedText.indexOf(mention);
          if (offset < 0) return false;
          const trailing = normalizedText[offset + mention.length];
          return trailing === undefined || /[\s,.:;!?)}\]]/.test(trailing);
        })?.[1];
      const mentionedAgent = replyTarget?.isAgent
        ? replyTarget.authorPubkey
        : parentChannelId
          ? undefined
          : (selectedMentionedAgent ?? mentionedAgentPubkey(text, mentionableAgents));
      // Build and sign exactly once. publishPreparedMessage retries the same
      // id on a transient failure, so the relay can dedupe an ambiguous send.
      const eventId = replyTarget
        ? await transport.messageSubmitReply(
            decodedId,
            text,
            replyTarget.messageId,
            mentionedAgent,
            attachments,
          )
        : await transport.messageSubmitWithEventId(
            { sessionId: decodedId, text, attachments },
            mentionedAgent ? { mentionAgent: mentionedAgent } : undefined,
          );
      useBuzzLocalCache
        .getState()
        .updateMessages(cacheViewerPubkey, decodedId, (current) =>
          reconcileOptimisticMessage(current, optimisticId, eventId),
        );
      if (sentWhileOffline) {
        setOfflineQueuedIds((current) => {
          const next = new Set(current);
          next.delete(optimisticId);
          next.add(eventId);
          return next;
        });
      }
    } catch (err) {
      console.warn('Send failed:', err);
      Alert.alert('Attachment not sent', err instanceof Error ? err.message : String(err));
    } finally {
      sendInFlightRef.current = false;
      setSending(false);
    }
  }, [
    pendingAttachment,
    transport,
    decodedId,
    addMessages,
    isArchived,
    userPubkey,
    parentChannelId,
    mentionableAgents,
    cacheViewerPubkey,
    replyTarget,
    agentsOffline,
  ]);

  const pickPhoto = useCallback(async () => {
    if (Platform.OS === 'ios') {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (permission.status !== 'granted') {
        Alert.alert('Photo access needed', 'Allow photo access to attach an image.');
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
    Alert.alert('Attach to message', 'Choose a photo or a document.', [
      { text: 'Photo', onPress: () => void pickPhoto() },
      { text: 'Document', onPress: () => void pickDocument() },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [pickDocument, pickPhoto]);

  const selectMention = useCallback(
    (participant: RoomMemberOption) => {
      if (!activeMention) return;
      const inserted = replaceActiveMention(inputTextRef.current, activeMention, participant.handle);
      if (participant.kind === 'agent') {
        selectedAgentMentionsRef.current.set(participant.handle, participant.pubkey);
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
        viewerIsAgent
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
        useBuzzLocalCache.getState().updateMessages(cacheViewerPubkey, decodedId, (current) =>
          current.map((item) =>
            item.id === message.id && item.writePermission
              ? {
                  ...item,
                  writePermission: {
                    ...item.writePermission,
                    status: decision === 'allow' ? 'allowed' : 'denied',
                  },
                }
              : item,
          ),
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
    [cacheViewerPubkey, decodedId, transport, viewerIsAgent],
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
        useBuzzLocalCache.getState().patchChannel(cacheViewerPubkey, decodedId, {
          roomMembers: [
            ...roomMembers.filter((member) => member.pubkey !== option.pubkey),
            { pubkey: option.pubkey, role: 'member' },
          ],
        });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (err) {
        setMembershipError(`Could not add @${option.name}: ${String(err)}`);
      } finally {
        setAddingMemberPubkey(null);
      }
    },
    [
      activeCommunityId,
      addingMemberPubkey,
      cacheViewerPubkey,
      decodedId,
      roomMemberPubkeys,
      roomMembers,
      transport,
    ],
  );

  const handleRemoveRoomMember = useCallback(
    (participant: RoomMemberOption) => {
      const targetRole = normalizedRoomRole(roomMemberByPubkey.get(participant.pubkey));
      if (
        !transport ||
        !canRemoveRoomParticipant(viewerRoomRole, targetRole, participant.pubkey === userPubkey)
      )
        return;
      Alert.alert(
        `Remove ${participant.name}?`,
        `Their membership will be removed and this ${ROOM_LABEL} will disappear from their workspace list.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: () => {
              setMembershipActionPubkey(participant.pubkey);
              setMembershipError(null);
              void transport
                .removeRoomMember(decodedId, participant.pubkey)
                .then(() => {
                  useBuzzLocalCache.getState().patchChannel(cacheViewerPubkey, decodedId, {
                    roomMembers: roomMembers.filter(
                      (member) => member.pubkey !== participant.pubkey,
                    ),
                  });
                  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                })
                .catch((err) => {
                  setMembershipError(`Could not remove ${participant.name}: ${String(err)}`);
                })
                .finally(() => setMembershipActionPubkey(null));
            },
          },
        ],
      );
    },
    [
      cacheViewerPubkey,
      decodedId,
      roomMemberByPubkey,
      roomMembers,
      transport,
      userPubkey,
      viewerRoomRole,
    ],
  );

  const returnToRoomList = useCallback(() => {
    setRosterVisible(false);
    setRoomActionsVisible(false);
    router.replace({
      pathname: '/buzz/channels',
      ...(activeCommunityId ? { params: { communityId: activeCommunityId } } : {}),
    });
  }, [activeCommunityId]);

  const handleRoomLifecycle = useCallback(() => {
    if (!transport || !lifecycleAction || roomLifecycleBusy) return;
    const deleting = lifecycleAction === 'delete';
    Alert.alert(
      deleting ? `Delete ${displayRoomName}?` : `Leave ${displayRoomName}?`,
      deleting
        ? `This ${ROOM_LABEL} will disappear from the workspace list. Its messages and room data remain stored for future recovery.`
        : `You will lose access to this ${ROOM_LABEL}. Other members will keep their access.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: deleting ? `Delete ${ROOM_LABEL}` : `Leave ${ROOM_LABEL}`,
          style: 'destructive',
          onPress: () => {
            setRoomLifecycleBusy(true);
            setMembershipError(null);
            const operation = deleting
              ? transport.archiveRoom(decodedId)
              : transport.leaveRoom(decodedId);
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
          },
        },
      ],
    );
  }, [decodedId, displayRoomName, lifecycleAction, returnToRoomList, roomLifecycleBusy, transport]);

  const patchCachedRoomName = useCallback(
    (name: string) => {
      if (!cacheViewerPubkey) return;
      const cache = useBuzzLocalCache.getState();
      cache.patchChannel(cacheViewerPubkey, decodedId, { roomName: name });
      const list = selectChannelList(cache, cacheViewerPubkey, activeCommunityId ?? undefined);
      if (list) {
        cache.patchChannelList(cacheViewerPubkey, activeCommunityId, {
          channels: list.channels.map((channel) =>
            channel.id === decodedId ? { ...channel, title: name } : channel,
          ),
        });
      }
    },
    [activeCommunityId, cacheViewerPubkey, decodedId],
  );

  const handleRenameRoom = useCallback(async () => {
    const name = renameDraft.trim();
    if (!name) {
      setRenameError(`${ROOM_LABEL} name cannot be empty.`);
      return;
    }
    if (!transport || !canRenameRoom(viewerChannelRole) || renameBusy) return;

    const previousName = resolvedChannelName;
    setRenameBusy(true);
    setRenameError(null);
    setResolvedChannelName(name);
    patchCachedRoomName(name);
    try {
      const client = await transport.ensureClient();
      await client.renameChannel(decodedId, name);
      setRenameEditing(false);
      setRoomActionsVisible(false);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      setResolvedChannelName(previousName);
      patchCachedRoomName(previousName ?? '');
      setRenameError(`Could not rename ${ROOM_LABEL}: ${String(err)}`);
    } finally {
      setRenameBusy(false);
    }
  }, [
    decodedId,
    patchCachedRoomName,
    renameBusy,
    renameDraft,
    resolvedChannelName,
    transport,
    viewerChannelRole,
  ]);

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
   * Leave this transcript. A corner returns to its parent Room by id — see
   * `corner-navigation.ts` for why the route directly underneath cannot be
   * trusted to be that Room — and a transcript that is the only route on the
   * stack replaces itself with the Room list instead of calling a
   * `router.back()` that silently does nothing.
   */
  const handleBack = useCallback(() => {
    const routes = (navigation.getState()?.routes ?? []) as ChatStackRoute[];
    const action = chatBackAction(routes, parentChannelId);
    if (action.type === 'pop') router.dismiss(action.count);
    // The parent Room was never on this stack (the corner was opened straight
    // from the Room list, or from a notification cold start). Open it here
    // rather than popping into whatever happens to be underneath.
    else if (action.type === 'open-room') router.replace(roomHref(action.channelId));
    else if (action.type === 'back') router.back();
    else router.replace('/buzz/channels');
  }, [navigation, parentChannelId]);

  const handleCloseCorner = useCallback(async () => {
    if (!transport) return;
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

  const handleApprove = useCallback(async () => {
    if (!transport || !mergeTarget) return;
    setApprovalState('sending');
    setApprovalError(null);
    try {
      const result = await transport.submitMergeApproval(decodedId, mergeTarget);
      if (!result.success) throw new Error(result.message ?? 'Approval was not accepted by the relay');
      setApprovalState('delivering');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      console.warn('Approval failed:', err);
      setApprovalState('none');
      setApprovalError(err instanceof Error ? err.message : String(err));
    }
  }, [transport, mergeTarget, decodedId]);

  const handleReviewFilesLoaded = useCallback((files: readonly unknown[]) => {
    setReviewFileCount(files.length);
  }, []);

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


  const renderItem = useCallback(
    ({ item }: { item: ChatDisplayMessage }) => {
      if (item.writePermission) {
        const permission = item.writePermission;
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
                  {permission.repository
                    ? `${display.name} requests a new edit corner`
                    : `${display.name} needs to change repository files`}
                </Text>
                <Text style={styles.writePermissionIntent} numberOfLines={2}>
                  {describeWriteRequest(permission.tool)}
                </Text>
              </View>
            </View>
            {permission.repository && (
              <Text style={styles.writePermissionRepository} testID="write-permission-repository">
                EDIT CORNER ON {permission.repository}
              </Text>
            )}
            <Text style={styles.writePermissionBoundary}>
              {permission.repository
                ? `The write is refused here. Allowing grants isolated edit access to exactly ${permission.repository}; merge authority stays human-only.`
                : 'This write request is missing its repository target and cannot be allowed.'}
            </Text>
            {permission.status === 'failed' && (
              <Text style={styles.writePermissionFailure}>
                The requested edit could not start. This Room remains read-only.
              </Text>
            )}
            {pending && !viewerIsAgent && permission.repository ? (
              <View style={styles.writePermissionActions}>
                <MonoButton
                  label="Deny"
                  variant="secondary"
                  disabled={busy}
                  onPress={() => void handleWritePermission(item, 'deny')}
                  style={styles.writePermissionButton}
                />
                <MonoButton
                  label="Open edit corner"
                  loading={busy}
                  onPress={() => void handleWritePermission(item, 'allow')}
                  style={styles.writePermissionButton}
                />
              </View>
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

      if (item.corner) {
        // A corner's status never appears inline. A corner being open is
        // *state*, not an event — a note inscribed at the moment it opened
        // scrolls away and then lies, and a terminal one ("✕ FAILED",
        // "◇ OPEN") stamps a dead record across a live conversation. The
        // Room has exactly one active-corner affordance, the pinned gold
        // line above the composer, and every corner — live, failed, merged,
        // archived — is listed in the Room's corners view, which is where a
        // record belongs (`buzz/corners/[roomId].tsx`).
        return null;
      }

      // ── Merge summary ────────────────────────────────────────────
      if (item.isMergeSummary) {
        const mergeAgent = item.pubkey ? agentByPubkey.get(item.pubkey) : undefined;
        const mergeDisplay = mergeAgent
          ? resolveAgentDisplayIdentity(item.pubkey!, mergeAgent)
          : null;
        return (
          <View style={styles.mergeSummaryBubble}>
            <Text style={styles.mergeSummaryTitle}>✓ {CORNER_LABEL} merged</Text>
            <Text style={styles.mergeSummaryText}>{item.text}</Text>
            {item.pubkey && (
              <Text style={styles.mergeSummaryPubkey}>
                {mergeDisplay?.name ?? shortMemberNpub(item.pubkey)}
              </Text>
            )}
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

      // ── Ordinary message ─────────────────────────────────────────
      const isBody = item.pubkey && BODY_PUBKEYS.has(item.pubkey);
      const isOwn = item.isUser;
      const knownAgent = item.pubkey ? agentByPubkey.get(item.pubkey) : undefined;
      const isAgent = item.isAgentAuthor || item.isAgentActivity || isBody || Boolean(knownAgent);
      const display = isAgent
        ? resolvePendingAgentDisplay(item.pubkey ?? 'unknown-agent', knownAgent, participantsHydrated)
        : null;
      const personName = item.pubkey ? personProfileByPubkey.get(item.pubkey)?.name : undefined;

      const attachmentElements = item.attachments?.map((attachment) => (
        <AttachmentCard attachment={attachment} key={`${item.id}-${attachment.url}`} />
      ));

      // ── The ledger (§ DESIGN.md "The ledger") ────────────────────
      // One primitive, both surfaces. Two things differ, and each tracks a real
      // difference between them:
      //
      //   · A Corner has one administering agent, named in its top bar, so its
      //     agent turns carry no handle at all — pure flowing prophecy. A Room
      //     holds several voices, so a voice states a whisper-dim handle inline
      //     when it takes over, and only then (`continuedAttributionIds`).
      //   · Your own turn is inset right and one tone down on either surface.
      //     That geometry is the whole signal; there is no "YOU" caption.
      const attributionContinued = continuedAttributionIds.has(item.id);
      // An agent viewing its own Room messages is both `isUser` and an agent;
      // the agent test wins, matching `ledgerSpeakerKey`'s own ordering.
      const isSelfSteer = isOwn && !isAgent;
      // A Corner is exactly one administering agent plus you, so anything that
      // is not your own steer is that agent — by the surface's definition, not
      // by a roster lookup. Deriving it structurally is what keeps a Corner
      // correct when the roster is empty or still loading: `isAgent` goes false
      // there, and a Corner that trusted it printed the signer's bare npub as a
      // handle and dropped the agent's own words to the ordinary grey tier.
      const isCornerAgent = isCorner && !isSelfSteer;
      const speaksAsAgent = isAgent || isCornerAgent;
      const voiceName = speaksAsAgent
        ? (display ? display.name : (personName ?? shortMemberNpub(item.pubkey ?? '')))
        : (personName ?? (item.pubkey ? shortMemberNpub(item.pubkey) : 'SOMEONE'));
      // Zero handles in a Corner, full stop — its one agent is named in the top
      // bar. None on your own inset block, and none on a continuation of the
      // voice directly above.
      const handle = attributionContinued || isSelfSteer || isCorner ? undefined : voiceName;
      const marginalia = (
        <LedgerMarginalia
          stamp={ledgerStamp(item.timestamp)}
          detail={handle && !isAgent && item.pubkey ? ledgerFingerprint(item.pubkey) : null}
          testID={`chat-marginalia-${item.id}`}
        />
      );

      // Machine noise collapses the same way on both surfaces: one ghost line,
      // expandable, never a wall of output down the slab.
      if (item.isAgentActivity) {
        return (
          <LedgerActivity
            active={item.id === activeActivityId}
            handle={handle}
            marginalia={marginalia}
            message={item}
          />
        );
      }

      // The reply echo is deleted from agent turns: Body threads every Room/DM
      // reply to the request that triggered it, so the quoted text was always
      // the message directly above — pure noise on a linear log. A person's own
      // reply is a deliberate reach back up the transcript, so it keeps its
      // quote.
      const referencedMessage =
        !speaksAsAgent && item.replyToId ? visibleMessageById.get(item.replyToId) : undefined;
      const referencedTarget = referencedMessage
        ? replyTargetForMessage(referencedMessage)
        : undefined;
      const replyReference =
        !speaksAsAgent && item.replyToId ? (
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

      return (
        <SwipeToReply
          messageId={item.id}
          onReply={item.isAgentDraft ? () => undefined : () => beginReply(item)}
        >
          <NewMessageMaterialize enabled={Boolean(item.isNew)}>
            {isSelfSteer ? (
              <LedgerSteer
                itemId={item.id}
                continued={attributionContinued}
                bodyText={item.text}
                bodyTestID={`chat-message-text-${item.id}`}
                marginalia={marginalia}
                replyReference={replyReference}
                attachments={attachmentElements}
                offlineQueued={offlineQueuedIds.has(item.id)}
              />
            ) : (
              <LedgerEntry
                itemId={item.id}
                handle={handle}
                continued={attributionContinued}
                luminous={speaksAsAgent}
                bodyText={ledgerText ? ledgerText.prose : item.text}
                bodyTestID={`chat-message-text-${item.id}`}
                marginalia={marginalia}
                replyReference={replyReference}
                machineNoise={machineNoise}
                attachments={attachmentElements}
              />
            )}
          </NewMessageMaterialize>
        </SwipeToReply>
      );
    },
    [
      agentByPubkey,
      activeActivityId,
      continuedAttributionIds,
      handleWritePermission,
      isCorner,
      offlineQueuedIds,
      parentChannelId,
      participantsHydrated,
      permissionActionId,
      personProfileByPubkey,
      viewerIsAgent,
      agentPresences,
      presenceNow,
      presenceReconnectGrace,
      beginReply,
      replyTargetForMessage,
      visibleMessageById,
    ],
  );

  if (channelCache?.messages === undefined && initialChannelCache?.messages === undefined) {
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
        >
          <TouchableOpacity
            accessibilityLabel={isCorner ? `Back to this ${CORNER_LABEL}’s ${ROOM_LABEL}` : 'Back to Rooms'}
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
            <View style={styles.cornerHeaderMark} testID="corner-header-agent">
              <IdentityMark
                kind="agent"
                seed={cornerAgentDisplay?.avatarSeed ?? cornerAgentPubkey}
                avatarUrl={cornerAgentDisplay?.avatarUrl}
                name={cornerAgentDisplay?.name ?? 'Agent'}
                size={26}
                alive={sessionState === 'working'}
              />
            </View>
          )}
          <TouchableOpacity
            accessibilityLabel={
              isCorner
                ? `${cornerAgentDisplay?.name ?? 'Agent'}’s ${CORNER_LABEL}. View ${formatRoomParticipantTotal(roomParticipantTotal)}`
                : `View ${formatRoomParticipantTotal(roomParticipantTotal)} in this ${ROOM_LABEL}`
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
            {isCorner ? (
              <View style={styles.cornerHeaderStatusRow}>
                <Text numberOfLines={1} style={styles.cornerHeaderAgent}>
                  {(cornerAgentDisplay?.name ?? 'AGENT').toUpperCase()}
                </Text>
                {cornerAgentPubkey && (
                  <AgentPresenceLight
                    online={cornerAgentOnline}
                    testID="corner-header-presence"
                  />
                )}
                <Text
                  numberOfLines={1}
                  style={styles.cornerHeaderMeta}
                  testID="corner-view-status"
                >
                  {/*
                    Same canonical status word as the Room-list dropdown, the
                    Room chat card, and the standalone Corners list.
                  */}
                  {displayedCornerStatus
                    ? `·  ${cornerStatusPresentation(displayedCornerStatus).glyph} ${cornerStatusPresentation(displayedCornerStatus).label}`
                    : '·  …'}
                  {participantsHydrated ? `  ·  ${formatRoomParticipantTotal(roomParticipantTotal)}` : ''}
                </Text>
              </View>
            ) : (
              <Text style={styles.headerMeta} numberOfLines={1}>
                {participantsHydrated
                  ? `${formatRoomParticipantTotal(roomParticipantTotal)}  ·  IN THIS ROOM  ›`
                  : 'LOADING MEMBERS'}
              </Text>
            )}
          </TouchableOpacity>
          {!parentChannelId && !isDirectMessage && !viewerIsAgent && !isArchived && (
            <TouchableOpacity
              accessibilityLabel={`Add people or Agents to this ${ROOM_LABEL}`}
              onPress={() => {
                setMembershipError(null);
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

        <FlatList
          testID="chat-messages"
          ref={flatListRef}
          inverted
          data={invertedMessages}
          keyExtractor={(item: ChatDisplayMessage) => item.id}
          style={styles.messageList}
          contentContainerStyle={styles.messageListContent}
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
          onEndReached={loadOlderTranscriptMessages}
          onEndReachedThreshold={0.5}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={[styles.emptyText, isCorner && styles.cornerEmptyText]}>
                No messages yet
              </Text>
            </View>
          }
          ListFooterComponent={
            loadingOlderMessages ? (
              <View style={styles.olderMessagesLoading} testID="older-messages-loading">
                <PixelLoader compact />
              </View>
            ) : null
          }
          ListHeaderComponent={
            isCorner && !isArchived && sessionState === 'done' ? (
              <View style={styles.cornerReviewFooter}>
                {mergeTarget ? (
                  <HullSurface strength="raised" style={styles.approvalBar}>
                    <View style={styles.approvalInfo}>
                      <Text style={styles.prChip}>CHANGE READY FOR REVIEW</Text>
                      <Text style={styles.approvalBarText} numberOfLines={2}>
                        {turnSummary ?? `${cornerAgentDisplay?.name ?? 'The agent'} completed this turn.`}
                      </Text>
                      <Text style={styles.approvalStateText}>
                        {reviewFileCount === null
                          ? 'PREPARING YOUR REVIEW'
                          : `${reviewFileCount} ${reviewFileCount === 1 ? 'FILE' : 'FILES'} READY TO REVIEW`}
                      </Text>
                    </View>
                    {transport && (
                      <ChangeReviewPanel
                        transport={transport}
                        sessionId={decodedId}
                        tip={mergeTarget.tip}
                        onFilesLoaded={handleReviewFilesLoaded}
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
                        <Text style={styles.approveButtonText}>
                          APPROVE & MERGE {cornerAgentDisplay?.name ?? 'AGENT'}’S CHANGE
                        </Text>
                        <Text style={styles.approveButtonSupport}>
                          APPROVAL APPLIES ONLY TO THIS REVIEWED CHANGE
                        </Text>
                      </TouchableOpacity>
                    ) : approvalState === 'sending' ? (
                      <View style={styles.approvalPending}>
                        <PixelLoader compact />
                        <Text style={styles.approvalStateText}>SENDING APPROVAL</Text>
                      </View>
                    ) : approvalState === 'delivering' ? (
                      // Approval accepted by the relay — landing/confirming
                      // is still in progress. Must never read the same as
                      // MERGED: that word describes only a durably confirmed
                      // outcome (the archiveChannel projection below).
                      <View style={styles.approvalPending} testID="approve-corner-delivering">
                        <PixelLoader compact />
                        <Text style={styles.approvalStateText}>✓ APPROVAL SENT · DELIVERING…</Text>
                      </View>
                    ) : approvalState === 'failed' ? (
                      <View style={styles.approvalSent} testID="approve-corner-delivery-failed">
                        <Text style={styles.approvalStateText}>
                          ⚠ DELIVERY FAILED · RETRYING AUTOMATICALLY
                        </Text>
                      </View>
                    ) : (
                      <View style={styles.approvalSent}>
                        <Text style={styles.approvalSentText}>✓ MERGED</Text>
                      </View>
                    )}
                    {approvalError ? (
                      <Text style={styles.approvalStateText} testID="approve-corner-error">
                        APPROVAL FAILED · {approvalError}
                      </Text>
                    ) : null}
                  </HullSurface>
                ) : (
                  <HullSurface strength="quiet" style={styles.nothingReady}>
                    <Text style={styles.nothingReadyTitle}>NOTHING READY TO MERGE YET</Text>
                    <Text style={styles.nothingReadyText}>
                      A change appears here only after {cornerAgentDisplay?.name ?? 'the agent'} commits real work for review.
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
              cornerLiveBar.cornerId ? () => openCorner(cornerLiveBar.cornerId!) : undefined
            }
            testID="corner-live-bar"
          />
        )}
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
            {replyTarget && (
              <View style={styles.replyComposerBanner} testID="reply-composer-banner">
                <View style={styles.replyComposerCopy}>
                  <Text numberOfLines={1} style={styles.replyComposerLabel}>
                    ↩ REPLYING TO {replyTarget.authorName.toUpperCase()}
                    {replyTarget.isAgent ? ' · AGENT WILL BE TAGGED' : ''}
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
            <View
              style={[
                styles.composer,
                composerFocused && styles.composerFocused,
              ]}
            >
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
                  if (!mentionMenuVisible) return;
                  const key = event.nativeEvent.key;
                  if (key === 'Enter') {
                    event.preventDefault();
                    const selected = mentionSuggestions.matches[highlightedMentionIndex];
                    if (selected) selectMention(selected);
                  } else if (key === 'ArrowDown' || key === 'ArrowUp') {
                    event.preventDefault();
                    const direction = key === 'ArrowDown' ? 1 : -1;
                    setHighlightedMentionIndex((current) => {
                      const count = mentionSuggestions.matches.length;
                      return (current + direction + count) % count;
                    });
                  } else if (key === 'Escape' || key === 'Esc') {
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
                placeholder="Message"
                placeholderTextColor={groknight.dim}
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
                  ((!inputText.trim() && !pendingAttachment) || sending) &&
                    styles.sendButtonDisabled,
                ]}
                onPress={handleSend}
                disabled={(!inputText.trim() && !pendingAttachment) || sending}
                testID="chat-send"
              >
                <Text
                  style={[styles.sendButtonText, mergeTarget && styles.sendButtonTextQuiet]}
                >
                  ⏎
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </KeyboardAvoidingView>

      <RNModal
        animationType="fade"
        onRequestClose={() => setRosterVisible(false)}
        transparent
        visible={rosterVisible}
      >
        <View style={styles.rosterModalRoot}>
          <Pressable
            accessibilityLabel={`Close ${ROOM_LABEL} roster`}
            onPress={() => setRosterVisible(false)}
            style={StyleSheet.absoluteFill}
          />
          <HullSurface strength="raised" style={styles.rosterModal} testID="room-roster-sheet">
            <View style={styles.rosterModalHeading}>
              <View style={styles.rosterModalHeadingCopy}>
                <Text style={styles.rosterModalEyebrow}>IN THIS ROOM</Text>
                <Text style={styles.rosterModalTitle}>
                  {formatRoomParticipantTotal(roomParticipantTotal)}
                </Text>
              </View>
              <TouchableOpacity
                accessibilityLabel={`Close ${ROOM_LABEL} roster`}
                onPress={() => setRosterVisible(false)}
                style={styles.rosterModalClose}
              >
                <Text style={styles.rosterModalCloseText}>×</Text>
              </TouchableOpacity>
            </View>

            <ScrollView
              contentContainerStyle={styles.rosterContent}
              showsVerticalScrollIndicator={false}
            >
              {[
                { key: 'people', label: 'PEOPLE', options: visibleRosterSections.people },
                { key: 'agents', label: 'AGENTS', options: visibleRosterSections.agents },
              ].map((section, sectionIndex) =>
                section.options.length > 0 ? (
                  <View key={section.key}>
                    <Text
                      style={[
                        styles.rosterSectionLabel,
                        sectionIndex > 0 && styles.rosterSectionLabelSpaced,
                      ]}
                    >
                      {section.label} {section.options.length}
                    </Text>
                    {section.options.map((participant) => {
                      const display = participant.agent
                        ? resolveAgentDisplayIdentity(participant.pubkey, participant.agent)
                        : undefined;
                      const displayName = display
                        ? display.name
                        : participant.pubkey === userPubkey
                          ? 'You'
                          : participant.name;
                      const handle = display?.handle ?? shortMemberNpub(participant.pubkey);
                      const targetRole = normalizedRoomRole(
                        roomMemberByPubkey.get(participant.pubkey),
                      );
                      const canRemove =
                        !parentChannelId &&
                        !isDirectMessage &&
                        canRemoveRoomParticipant(
                          viewerRoomRole,
                          targetRole,
                          participant.pubkey === userPubkey,
                        );
                      const removing = membershipActionPubkey === participant.pubkey;
                      const agentOnline =
                        participant.kind === 'agent' &&
                        isAgentPresenceOnlineWithReconnectGrace(
                          agentPresences[participant.pubkey],
                          presenceNow,
                          presenceReconnectGrace[participant.pubkey],
                        );
                      return (
                        <View
                          accessibilityLabel={`${displayName}, ${participant.kind}${
                            participant.kind === 'agent'
                              ? agentOnline
                                ? ', online'
                                : ', offline'
                              : ''
                          }, at ${handle}`}
                          key={participant.pubkey}
                          style={styles.rosterRow}
                          testID={`room-roster-${participant.kind}-${participant.pubkey}`}
                        >
                          {display ? (
                            <IdentityMark
                              kind="agent"
                              seed={display.avatarSeed ?? participant.pubkey}
                              avatarUrl={display.avatarUrl}
                              name={display.name}
                              size={38}
                              alive={agentOnline}
                            />
                          ) : (
                            <IdentityMark
                              kind="human"
                              seed={participant.pubkey}
                              avatarUrl={personProfileByPubkey.get(participant.pubkey)?.avatar}
                              name={displayName}
                              size={38}
                            />
                          )}
                          <View style={styles.rosterIdentity}>
                            <View style={styles.rosterNameRow}>
                              {participant.kind === 'agent' ? (
                                <AgentPresenceLight
                                  online={agentOnline}
                                  testID={`agent-presence-light-${participant.pubkey}`}
                                />
                              ) : null}
                              <Text numberOfLines={1} style={styles.rosterName}>
                                {displayName}
                              </Text>
                            </View>
                            <Text numberOfLines={1} style={styles.rosterHandle}>
                              @{handle}
                            </Text>
                          </View>
                          <View style={styles.rosterActions}>
                            <Text style={styles.rosterKind}>
                              {participant.kind === 'agent' ? 'AGENT' : 'PERSON'}
                              {targetRole && targetRole !== 'member'
                                ? ` · ${targetRole.toUpperCase()}`
                                : ''}
                            </Text>
                            {canRemove && (
                              <TouchableOpacity
                                accessibilityLabel={`Remove ${displayName} from this ${ROOM_LABEL}`}
                                accessibilityRole="button"
                                disabled={Boolean(membershipActionPubkey)}
                                onPress={() => handleRemoveRoomMember(participant)}
                                style={styles.rosterRemoveButton}
                                testID={`remove-room-member-${participant.pubkey}`}
                              >
                                <Text style={styles.rosterRemoveText}>
                                  {removing ? 'REMOVING…' : 'REMOVE'}
                                </Text>
                              </TouchableOpacity>
                            )}
                          </View>
                        </View>
                      );
                    })}
                  </View>
                ) : null,
              )}
              {roomParticipantTotal === 0 && (
                <Text style={styles.rosterEmpty}>No visible participants</Text>
              )}
            </ScrollView>
            {membershipError && (
              <View accessibilityRole="alert" style={styles.membershipError}>
                <Text style={styles.membershipErrorText}>! {membershipError}</Text>
              </View>
            )}
          </HullSurface>
        </View>
      </RNModal>

      <RNModal
        animationType="fade"
        onRequestClose={() => {
          if (renameBusy) return;
          setRenameEditing(false);
          setRenameError(null);
          setRoomActionsVisible(false);
        }}
        transparent
        visible={roomActionsVisible}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'translate-with-padding'}
          style={[
            styles.roomActionsModalRoot,
            { paddingBottom: Math.max(insets.bottom, 18) },
          ]}
        >
          <Pressable
            accessibilityLabel={`Close ${ROOM_LABEL} actions`}
            disabled={renameBusy}
            onPress={() => {
              setRenameEditing(false);
              setRenameError(null);
              setRoomActionsVisible(false);
            }}
            style={StyleSheet.absoluteFill}
          />
          <HullSurface strength="raised" style={styles.roomActionsModal}>
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
                    setRenameDraft(roomName);
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
                  <Text style={styles.roomLifecycleTitle}>
                    {roomLifecycleBusy ? 'DELETING…' : `DELETE ${ROOM_LABEL.toUpperCase()}`}
                  </Text>
                  <Text style={styles.roomLifecycleHint}>Archive; relay data is retained.</Text>
                </View>
                <Text style={styles.roomLifecycleGlyph}>□</Text>
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
                  <Text style={styles.roomLifecycleTitle}>
                    {roomLifecycleBusy ? 'LEAVING…' : `LEAVE ${ROOM_LABEL.toUpperCase()}`}
                  </Text>
                  <Text style={styles.roomLifecycleHint}>Other members keep their access.</Text>
                </View>
                <Text style={styles.roomLifecycleGlyph}>↗</Text>
              </TouchableOpacity>
            ) : null}
            {(renameError || membershipError) && (
              <View accessibilityRole="alert" style={styles.membershipError}>
                <Text style={styles.membershipErrorText}>! {renameError ?? membershipError}</Text>
              </View>
            )}
          </HullSurface>
        </KeyboardAvoidingView>
      </RNModal>

      <RNModal
        animationType="fade"
        onRequestClose={() => setCornerActionsVisible(false)}
        transparent
        visible={cornerActionsVisible}
      >
        <View
          style={[styles.roomActionsModalRoot, { paddingBottom: Math.max(insets.bottom, 18) }]}
        >
          <Pressable
            accessibilityLabel={`Close ${CORNER_LABEL} actions`}
            onPress={() => setCornerActionsVisible(false)}
            style={StyleSheet.absoluteFill}
          />
          <HullSurface strength="raised" style={styles.roomActionsModal} testID="corner-actions-sheet">
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
                <Text style={styles.roomLifecycleTitle}>CLOSE {CORNER_LABEL.toUpperCase()}</Text>
                <Text style={styles.roomLifecycleHint}>
                  Ends the edit session and archives this {CORNER_LABEL}. Unmerged work is lost.
                </Text>
              </View>
              <Text style={styles.roomLifecycleGlyph}>■</Text>
            </TouchableOpacity>
          </HullSurface>
        </View>
      </RNModal>

      <RNModal
        animationType="fade"
        onRequestClose={() => setParticipantPickerVisible(false)}
        transparent
        visible={participantPickerVisible}
      >
        <View style={styles.memberModalRoot}>
          <Pressable
            accessibilityLabel="Close Room member picker"
            onPress={() => setParticipantPickerVisible(false)}
            style={StyleSheet.absoluteFill}
          />
          <HullSurface strength="raised" style={styles.memberModal}>
            <View style={styles.memberModalHeading}>
              <View style={styles.memberModalHeadingCopy}>
                <Text style={styles.memberModalTitle}>Add people</Text>
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
                { key: 'in-room', label: 'IN ROOM', options: roomRosterSections.inRoom },
                {
                  key: 'addable',
                  label: 'ADD',
                  options: roomRosterSections.addable,
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
              {memberOptions.length === 0 && (
                <Text style={styles.memberPickerEmpty}>Workspace roster is empty</Text>
              )}
            </ScrollView>

            {membershipError && (
              <View accessibilityRole="alert" style={styles.membershipError}>
                <Text style={styles.membershipErrorText}>! {membershipError}</Text>
              </View>
            )}
          </HullSurface>
        </View>
      </RNModal>
    </BuzzCommunityShell>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: groknight.bgTerminal,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
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
  // The single agent's faceted mark, stated once for the whole corner.
  cornerHeaderMark: {
    marginRight: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
  headerMeta: {
    ...Typography.default(),
    fontSize: 11,
    lineHeight: 15,
    color: groknight.textMuted,
    marginTop: 2,
  },
  cornerHeaderAgent: {
    ...Typography.mono('semiBold'),
    flexShrink: 0,
    color: groknight.textSecondary,
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 0.7,
  },
  cornerHeaderMeta: {
    ...Typography.mono(),
    flexShrink: 1,
    color: groknight.textMuted,
    fontSize: 10,
    lineHeight: 14,
  },
  cornerHeaderStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 3,
    minWidth: 0,
  },
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
    borderRadius: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  archivedBadgeText: {
    ...Typography.mono('semiBold'),
    color: groknight.textMuted,
    fontSize: 11,
    lineHeight: 15,
  },
  // ── Read-only Room roster ──────────────────────────────────────
  rosterModalRoot: {
    flex: 1,
    paddingHorizontal: 16,
    paddingBottom: 18,
    alignItems: 'center',
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(5, 5, 6, 0.84)',
  },
  rosterModal: {
    width: '100%',
    maxWidth: 460,
    maxHeight: '82%',
    padding: 16,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    backgroundColor: groknight.bgRaised,
  },
  rosterModalHeading: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  rosterModalHeadingCopy: { flex: 1, minWidth: 0 },
  rosterModalEyebrow: {
    ...Typography.mono('semiBold'),
    color: groknight.textMuted,
    fontSize: 9,
    lineHeight: 12,
    letterSpacing: 0.8,
  },
  rosterModalTitle: {
    ...Typography.default('semiBold'),
    marginTop: 4,
    color: groknight.textPrimary,
    fontSize: 19,
    lineHeight: 24,
  },
  rosterModalClose: {
    width: 44,
    height: 44,
    marginTop: -10,
    marginRight: -10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rosterModalCloseText: { ...Typography.default(), color: groknight.steel, fontSize: 24 },
  rosterContent: { paddingTop: 18, paddingBottom: 4 },
  rosterSectionLabel: {
    ...Typography.mono('semiBold'),
    marginBottom: 7,
    color: groknight.textMuted,
    fontSize: 9,
    lineHeight: 12,
    letterSpacing: 0.7,
  },
  rosterSectionLabelSpaced: { marginTop: 20 },
  rosterRow: {
    minHeight: 62,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderTopWidth: 1,
    borderColor: groknight.border,
    backgroundColor: groknight.bgBase,
  },
  rosterIdentity: { flex: 1, minWidth: 0 },
  rosterNameRow: { minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6 },
  rosterName: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 13,
    lineHeight: 17,
  },
  rosterHandle: {
    ...Typography.mono(),
    marginTop: 2,
    color: groknight.textMuted,
    fontSize: 10,
    lineHeight: 14,
  },
  rosterKind: {
    ...Typography.mono('semiBold'),
    color: groknight.steel,
    fontSize: 8,
    lineHeight: 12,
    letterSpacing: 0.7,
  },
  rosterActions: {
    flexShrink: 0,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  rosterRemoveButton: {
    minHeight: 44,
    paddingLeft: 12,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  rosterRemoveText: {
    ...Typography.mono('semiBold'),
    color: groknight.chrome,
    fontSize: 9,
    lineHeight: 13,
    letterSpacing: 0.4,
  },
  rosterEmpty: {
    ...Typography.default(),
    paddingVertical: 28,
    color: groknight.textMuted,
    fontSize: 12,
    textAlign: 'center',
  },
  // ── Room lifecycle menu ─────────────────────────────────────────
  roomActionsModalRoot: {
    flex: 1,
    paddingHorizontal: 16,
    paddingBottom: 18,
    alignItems: 'center',
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(5, 5, 6, 0.84)',
  },
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
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    color: groknight.textPrimary,
    backgroundColor: groknight.bgRaised,
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
    borderColor: groknight.textPrimary,
    backgroundColor: groknight.textPrimary,
  },
  roomRenameApplyDisabled: { opacity: 0.45 },
  roomRenameApplyText: {
    ...Typography.mono('semiBold'),
    color: groknight.bgBase,
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
  // ── Room membership picker ─────────────────────────────────────
  memberModalRoot: {
    flex: 1,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(5, 5, 6, 0.84)',
  },
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
    paddingRight: LEDGER_MARGINALIA_WIDTH,
  },

  agentPresenceLight: {
    width: 9,
    height: 9,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: groknight.textSecondary,
  },
  agentPresenceOnline: { backgroundColor: groknight.textSecondary },
  agentPresenceOffline: { backgroundColor: 'transparent' },
  // ── Merge summary ───────────────────────────────────────────────
  /* A system row is still a row of the ledger: no rule under it, no frame
   * around it. It is found by its glyph and by the luminance ladder. */
  mergeSummaryBubble: {
    paddingVertical: 6,
    marginBottom: 22,
  },
  mergeSummaryTitle: {
    ...Typography.mono(),
    fontSize: 12,
    lineHeight: 20,
    color: groknight.ledgerQuiet,
    marginBottom: 2,
  },
  mergeSummaryText: {
    ...Typography.mono(),
    fontSize: 12,
    color: groknight.ledgerQuiet,
    lineHeight: 18,
  },
  mergeSummaryPubkey: {
    ...Typography.mono(),
    fontSize: 10,
    lineHeight: 15,
    color: groknight.ledgerGhost,
    marginTop: 3,
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
    borderRadius: 3,
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
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 60,
  },
  emptyText: {
    ...Typography.default(),
    fontSize: 13,
    color: groknight.muted,
  },
  cornerEmptyText: { ...Typography.mono(), color: groknight.textMuted },
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
  writePermissionCard: {
    minWidth: 0,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    gap: 10,
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
    borderRadius: 3,
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
    borderRadius: 3,
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
});
